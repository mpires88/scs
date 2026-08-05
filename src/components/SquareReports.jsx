import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react'
import { supabase, fetchAll } from '../lib/supabase'
import { fetchSectionMap } from '../lib/chartOfAccounts'
import { ADJUSTMENTS_ACCOUNT, computeSquareReconciliation } from '../lib/insights'
import { squareFeeRows, taxRows, discountRows } from '../lib/monthEnd'
import { T, fmt2 as fmt, fmtPeriod } from '../lib/theme'

// ─── Quoted-printable decoder (handles multi-byte UTF-8) ──────────────────────

function decodeQP(str) {
  str = str.replace(/=\r?\n/g, '')
  let result = '', i = 0
  while (i < str.length) {
    if (str[i] === '=' && /[0-9A-Fa-f]/.test(str[i+1]||'') && /[0-9A-Fa-f]/.test(str[i+2]||'')) {
      const bytes = []
      while (str[i] === '=' && /[0-9A-Fa-f]/.test(str[i+1]||'') && /[0-9A-Fa-f]/.test(str[i+2]||'')) {
        bytes.push(parseInt(str.slice(i+1, i+3), 16)); i += 3
      }
      try { result += new TextDecoder('utf-8').decode(new Uint8Array(bytes)) }
      catch { result += bytes.map(b => String.fromCharCode(b)).join('') }
    } else { result += str[i++] }
  }
  return result
}

// ─── .eml parser ─────────────────────────────────────────────────────────────

function parseSquareEml(text) {
  // Period from header metadata
  const beginMatch = text.match(/X-Metadata-begin-time:\s*(\d{4}-\d{2}-\d{2})/)
  let period = beginMatch ? beginMatch[1].slice(0, 7) : null

  // Fallback: parse subject line "Square Sales Report: Apr 1 - Apr 30"
  if (!period) {
    const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' }
    const sub = text.match(/Subject:.*?Square Sales Report.*?(\w{3})\s+\d.*?(\d{4})/)
    if (sub && MONTHS[sub[1]]) period = `${sub[2]}-${MONTHS[sub[1]]}`
  }

  const htmlIdx = text.search(/<!DOCTYPE|<html/i)
  if (htmlIdx === -1) return { error: 'No HTML body found in file' }

  const html = decodeQP(text.slice(htmlIdx))
  const doc  = new DOMParser().parseFromString(html, 'text/html')

  const parseAmt = s => {
    s = (s || '').trim()
    const neg = s.startsWith('(') && s.endsWith(')')
    return parseFloat(s.replace(/[$,\s()]/g, '')) * (neg ? -1 : 1) || 0
  }

  const findVal = label => {
    for (const td of doc.querySelectorAll('td'))
      if (td.textContent.trim() === label && td.nextElementSibling)
        return parseAmt(td.nextElementSibling.textContent)
    return 0
  }

  const findPrefix = prefix => {
    for (const td of doc.querySelectorAll('td'))
      if (td.textContent.trim().startsWith(prefix) && td.nextElementSibling)
        return parseAmt(td.nextElementSibling.textContent)
    return 0
  }

  // Categories live between the "Category Sales" and "Item Sales" section headers
  const categories = []
  let inCat = false
  for (const td of doc.querySelectorAll('td')) {
    const t = td.textContent.trim().replace(/\u00A0/g, ' ')
    if (t === 'Category Sales') { inCat = true; continue }
    if (t === 'Item Sales')       { break }
    if (!inCat) continue
    const m = t.match(/^(.+?)\s*[××x]\s*(\d+)$/)
    if (m && td.nextElementSibling)
      categories.push({ name: m[1].trim(), count: parseInt(m[2]), amount: parseAmt(td.nextElementSibling.textContent) })
  }

  return {
    period,
    grossSales:   findVal('Gross Sales'),
    returns:      findVal('Returns'),
    discounts:    findVal('Discounts & Comps'),
    netSales:     findVal('Net Sales'),
    taxCollected: findVal('Tax'),
    fees:         Math.abs(findVal('Fees')),
    netTotal:     findVal('Net Total'),
    cashAmount:   findPrefix('Cash'),
    cardAmount:   findPrefix('Card'),
    categories,
  }
}

// ─── Saved-report detail ──────────────────────────────────────────────────────
// Everything the parser pulled but the summary row has no space for: the full
// sales waterfall (returns and discounts are stored yet never shown), the
// payment split, and every category rather than just the largest.

function ReportDetail({ r, cats }) {
  const num = v => (v == null ? null : Number(v))
  // The sales side ends at Total — net sales plus tax, i.e. what customers were
  // charged. Square's fees are not a sales number; they live on the payment
  // side below, where they reduce what was actually received.
  const netSales = num(r.net_sales), tax = num(r.tax_collected)
  const waterfall = [
    { label: 'Gross Sales',        value: num(r.gross_sales) },
    { label: 'Returns',            value: num(r.returns) },
    { label: 'Discounts & Comps',  value: num(r.discounts) },
    { label: 'Net Sales',          value: netSales,  rule: true },
    { label: 'Tax collected',      value: tax, color: '#D97706' },
    { label: 'Total',              value: netSales == null ? null : netSales + (tax ?? 0), rule: true },
  ]
  const cash = num(r.cash_amount), card = num(r.card_amount)
  const fees = num(r.fees)
  const paid = (cash ?? 0) + (card ?? 0)
  const catTotal   = cats.reduce((s, c) => s + (Number(c.amount) || 0), 0)
  const itemsTotal = cats.reduce((s, c) => s + (Number(c.count)  || 0), 0)
  const sorted = [...cats].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))

  const lbl = { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 7 }
  const th  = right => ({ textAlign: right ? 'right' : 'left', padding: '4px 8px', background: T.page, fontSize: 9, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' })
  const td  = { padding: '4px 8px', fontSize: 11.5, color: T.charcoal, fontVariantNumeric: 'tabular-nums' }

  return (
    <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', padding: '14px 16px 16px 34px', alignItems: 'flex-start' }}>

      <div style={{ flex: '1 1 250px', minWidth: 230 }}>
        <div style={lbl}>Sales Breakdown</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {waterfall.map(w => (
              <tr key={w.label} style={w.rule ? { borderTop: `1px solid ${T.border}` } : undefined}>
                <td style={{ ...td, color: w.rule ? T.navy : T.charcoal, fontWeight: w.rule ? 600 : 400 }}>{w.label}</td>
                <td style={{ ...td, textAlign: 'right', color: w.color ?? (w.rule ? T.navy : T.charcoal), fontWeight: w.rule ? 700 : 400 }}>
                  {w.value == null ? '—' : fmt(w.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(r.returns == null && r.discounts == null) && (
          <p style={{ fontSize: 10, color: '#9ca3af', margin: '7px 0 0', lineHeight: 1.5 }}>
            Returns and discounts weren’t captured for this month — re-upload the .eml to fill them in.
          </p>
        )}

        <div style={{ ...lbl, marginTop: 16 }}>Payment Methods</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td style={td}>Cash</td><td style={{ ...td, textAlign: 'right' }}>{cash == null ? '—' : fmt(cash)}</td></tr>
            <tr><td style={td}>Card</td><td style={{ ...td, textAlign: 'right' }}>{card == null ? '—' : fmt(card)}</td></tr>
            {(cash != null || card != null) && (
              <tr style={{ borderTop: `1px solid ${T.border}` }}>
                <td style={{ ...td, color: T.navy, fontWeight: 600 }}>Collected</td>
                <td style={{ ...td, textAlign: 'right', color: T.navy, fontWeight: 700 }}>{fmt(paid)}</td>
              </tr>
            )}
            {fees != null && (
              <tr>
                <td style={td}>Square fees</td>
                <td style={{ ...td, textAlign: 'right', color: T.danger }}>{fmt(-fees)}</td>
              </tr>
            )}
            {fees != null && (cash != null || card != null) && (
              <tr style={{ borderTop: `1px solid ${T.border}` }}>
                <td style={{ ...td, color: T.navy, fontWeight: 600 }}>Net payout</td>
                <td style={{ ...td, textAlign: 'right', color: T.success, fontWeight: 700 }}>{fmt(paid - fees)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ flex: '2 1 340px', minWidth: 300 }}>
        <div style={lbl}>Category Sales{cats.length ? ` · ${cats.length}` : ''}</div>
        {cats.length === 0 ? (
          <p style={{ fontSize: 11.5, color: '#9ca3af', margin: 0 }}>
            No category breakdown was found in this report.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th(false)}>Category</th>
                <th style={th(true)}>Items</th>
                <th style={th(true)}>Revenue</th>
                <th style={th(true)}>Share</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ ...td, fontVariantNumeric: 'normal' }}>{c.name}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{(Number(c.count) || 0).toLocaleString()}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmt(c.amount)}</td>
                  <td style={{ ...td, textAlign: 'right', color: '#9ca3af' }}>
                    {catTotal ? `${((Number(c.amount) || 0) / catTotal * 100).toFixed(1)}%` : '—'}
                  </td>
                </tr>
              ))}
              <tr style={{ background: T.page }}>
                <td style={{ ...td, color: T.navy, fontWeight: 600, fontVariantNumeric: 'normal' }}>Total</td>
                <td style={{ ...td, textAlign: 'right', color: T.navy, fontWeight: 600 }}>{itemsTotal.toLocaleString()}</td>
                <td style={{ ...td, textAlign: 'right', color: T.navy, fontWeight: 700 }}>{fmt(catTotal)}</td>
                <td style={{ ...td, textAlign: 'right', color: '#9ca3af' }}>100%</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Upload coverage ──────────────────────────────────────────────────────────
// One report per month, so coverage is a year-by-month grid running from the
// first uploaded period through the last completed month — a gap is a report
// still to chase down. Amber months were saved before the parser captured
// returns & discounts; re-uploading the .eml fills them in.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function CoveragePanel({ reports }) {
  const byPeriod = {}
  reports.forEach(r => { if (r.period) byPeriod[r.period.slice(0, 7)] = r })
  const periods = Object.keys(byPeriod).sort()
  if (!periods.length) return null

  const now = new Date()
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastComplete = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
  const first = periods[0]
  const last  = periods[periods.length - 1] > lastComplete ? periods[periods.length - 1] : lastComplete

  const years = []
  for (let y = +first.slice(0, 4); y <= +last.slice(0, 4); y++) years.push(y)

  const badge = { display: 'inline-block', minWidth: 26, borderRadius: 3, padding: '1px 0', fontWeight: 500, cursor: 'default' }

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: '12px 16px', marginBottom: 24, overflowX: 'auto' }}>
      <h3 style={{ fontSize: 10.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', margin: '0 0 10px' }}>
        Upload Coverage
      </h3>
      <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ padding: '4px 10px 4px 0', textAlign: 'left', color: T.charcoal, fontWeight: 600 }}>Year</th>
            {MONTH_ABBR.map(m => (
              <th key={m} style={{ padding: '4px 6px', textAlign: 'center', color: T.charcoal, fontWeight: 500 }}>{m}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map(y => (
            <tr key={y}>
              <td style={{ padding: '3px 10px 3px 0', color: T.charcoal, fontWeight: 500 }}>{y}</td>
              {MONTH_ABBR.map((label, i) => {
                const ym = `${y}-${String(i + 1).padStart(2, '0')}`
                if (ym < first || ym > last) return <td key={ym} style={{ padding: '3px 6px' }} />
                const r = byPeriod[ym]
                const partial = r && r.returns == null && r.discounts == null
                const [bg, fg, mark, note] = !r
                  ? [T.page, '#C0BDB7', '—', 'no report uploaded']
                  : partial
                    ? ['#FEF3C7', '#92400E', '✓', 'uploaded — re-upload the .eml to fill in returns & discounts']
                    : ['#D1E8D4', '#1A5C28', '✓', 'uploaded']
                return (
                  <td key={ym} style={{ padding: '3px 6px', textAlign: 'center' }} title={`${label} ${y} — ${note}`}>
                    <span style={{ ...badge, background: bg, color: fg }}>{mark}</span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Bank ↔ Square reconciliation panel ──────────────────────────────────────
// Fidelity check between what the reports say was collected and what the bank
// actually received. Monthly deltas are timing noise (a payout or a cash run
// crossing month-end); the cumulative line is the signal — see
// computeSquareReconciliation for the lane semantics.

const reconSigned = n => `${n > 0 ? '+' : ''}${fmt(n)}`

function ReconChip({ label, lane, positiveMeans, negativeMeans }) {
  const ok = lane.state === 'ok'
  return (
    <div style={{ flex: '1 1 250px', background: '#fff', border: `1px solid ${T.border}`, borderTop: `3px solid ${ok ? T.success : T.amber}`, borderRadius: 6, padding: '10px 12px' }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: ok ? T.navy : T.amber }}>{reconSigned(lane.cumulative)}</div>
      <div style={{ fontSize: 10, color: 'rgba(74,74,74,.6)', marginTop: 3, lineHeight: 1.5 }}>
        {ok
          ? <>within the ±{fmt(lane.tolerance)} timing tolerance</>
          : <>{lane.cumulative >= 0 ? positiveMeans : negativeMeans}</>}
      </div>
    </div>
  )
}

function ReconPanel({ recon }) {
  const th = right => ({ textAlign: right ? 'right' : 'left', padding: '5px 9px', background: T.page, fontSize: 9, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap', borderBottom: `2px solid ${T.border}`, position: 'sticky', top: 0 })
  const td = { padding: '4px 9px', fontSize: 11, color: T.charcoal, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
  const signed = reconSigned

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
        Bank ↔ Square Reconciliation
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <ReconChip
          label="Card · cumulative (bank − expected)" lane={recon.card}
          positiveMeans="bank received more than card sales minus fees — check for miscategorized deposits or a partial report month"
          negativeMeans="bank received less than card sales minus fees — instant-transfer fees, loan withholding, or chargebacks the reports don't show"
        />
        <ReconChip
          label="Cash · cumulative (deposited − collected)" lane={recon.cash}
          positiveMeans="more cash deposited than the register rang — unrung sales, or owner cash filed as revenue"
          negativeMeans="collected cash isn't reaching the bank — till spending or an unrecorded owner draw"
        />
      </div>
      <div style={{ overflow: 'auto', maxHeight: 320, background: T.card, border: `1px solid ${T.border}`, borderRadius: 7 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th(false)}>Month</th>
              <th style={th(true)}>Card expected</th>
              <th style={th(true)}>Received</th>
              <th style={th(true)}>Δ</th>
              <th style={th(true)}>Cash collected</th>
              <th style={th(true)}>Deposited</th>
              <th style={th(true)}>Δ</th>
              <th style={th(true)}>Cum card</th>
              <th style={th(true)}>Cum cash</th>
            </tr>
          </thead>
          <tbody>
            {recon.rows.map(r => (
              <tr key={r.period} style={{ borderBottom: `1px solid #F0EEE9`, background: r.anomaly ? '#FEF3C7' : 'transparent' }}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 500, color: r.anomaly ? '#92400E' : T.navy }}>
                  {r.anomaly && '⚠ '}{fmtPeriod(r.period)}
                </td>
                <td style={td}>{fmt(r.cardExpected)}</td>
                <td style={td}>{fmt(r.cardGot)}</td>
                <td style={{ ...td, color: Math.abs(r.cardDelta) < 0.005 ? td.color : r.cardDelta > 0 ? T.success : T.danger }}>{signed(r.cardDelta)}</td>
                <td style={td}>{fmt(r.cashCollected)}</td>
                <td style={td}>{fmt(r.cashGot)}</td>
                <td style={{ ...td, color: Math.abs(r.cashDelta) < 0.005 ? td.color : r.cashDelta > 0 ? T.success : T.danger }}>{signed(r.cashDelta)}</td>
                <td style={{ ...td, fontWeight: 600 }}>{signed(r.cardCum)}</td>
                <td style={{ ...td, fontWeight: 600 }}>{signed(r.cashCum)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 10, color: 'rgba(74,74,74,.55)', margin: '6px 2px 0', lineHeight: 1.5 }}>
        Card expected = the report's card collections − fees. Monthly Δs wobble when a payout or a
        cash run crosses month-end — judge the cumulative columns, not single months. Amber rows
        deviate too far to be timing; the usual cause is a partial report (re-export that month's
        .eml from Square) or a miscategorized deposit.
      </p>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

// `headerLeft` lets the combined Transactions hub put its title and tab
// switcher where the standalone title sits; the upload count line stays.
export default function SquareReports({ clientId, headerLeft = null }) {
  const [reports,  setReports]  = useState([])
  const [expanded, setExpanded] = useState({})   // report id → open
  const [loading,  setLoading]  = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [preview,  setPreview]  = useState(null)
  const [saving,   setSaving]   = useState(false)
  const [msg,      setMsg]      = useState('')
  const [revTxns,  setRevTxns]  = useState([])   // revenue-category bank rows, for reconciliation
  const fileRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('square_reports')
      .select('*')
      .eq('client_id', clientId)
      .order('period', { ascending: false })
    setReports(data ?? [])
    // Revenue-category bank rows feed the bank ↔ Square reconciliation. The
    // chart supplies current names (they get renumbered), fetchAll pages past
    // the 1,000-row cap.
    try {
      const { accounts } = await fetchSectionMap(clientId)
      const revNames = accounts.filter(a => a.pl_section === 'Revenue').map(a => a.name)
      const rows = revNames.length
        ? await fetchAll(() => supabase.from('bank_transactions')
            .select('transaction_date, amount, category, account')
            .eq('client_id', clientId).in('category', revNames)
            .order('transaction_date').order('id'))
        : []
      setRevTxns(rows)
    } catch { setRevTxns([]) } // reconciliation is an extra — never block the page
    setLoading(false)
  }, [clientId])

  useEffect(() => { load() }, [load])

  // Months with no report between the earliest upload and the last complete
  // month. Each is a hole in the books: no revenue gross-up, no tax accrual.
  const missingMonths = useMemo(() => {
    if (!reports.length) return []
    const have = new Set(reports.map(r => r.period))
    const now = new Date()
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
    const first = reports[reports.length - 1].period // list is period-descending
    const out = []
    let [y, m] = first.split('-').map(Number)
    for (let ym = first; ym <= end;) {
      if (!have.has(ym)) out.push(ym)
      m += 1
      if (m > 12) { m = 1; y += 1 }
      ym = `${y}-${String(m).padStart(2, '0')}`
    }
    return out
  }, [reports])

  // Reports and missing-month markers interleaved, newest first.
  const tableRows = useMemo(() => [
    ...reports.map(r => ({ kind: 'report', key: r.id, period: r.period, r })),
    ...missingMonths.map(p => ({ kind: 'missing', key: `missing-${p}`, period: p })),
  ].sort((a, b) => b.period.localeCompare(a.period)), [reports, missingMonths])

  const recon = useMemo(
    () => computeSquareReconciliation({ reports, txns: revTxns }),
    [reports, revTxns]
  )

  const handleFile = useCallback(file => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.eml')) { alert('Please select a .eml file'); return }
    const reader = new FileReader()
    reader.onload = e => {
      const parsed = parseSquareEml(e.target.result)
      if (parsed.error)  { alert('Could not parse email: ' + parsed.error); return }
      if (!parsed.period){ alert('Could not determine the month from this email.'); return }
      setPreview(parsed); setMsg('')
    }
    reader.readAsText(file)
  }, [])

  // Saving a report also books its adjustment pairs — the SQUARE FEES gross-up,
  // the SALES TAX accrual and the SQUARE DISCOUNTS gross-up (see monthEnd) — so
  // the P&L and the liability pick the month up at upload time instead of
  // waiting for month-end close. Matched by description: a re-upload corrects
  // the amounts rather than duplicating, and months already booked through the
  // close page are left alone. Square reports discounts as a negative, so the
  // magnitude is booked.
  const syncAdjustments = async ({ period, fees, taxCollected, discounts }) => {
    const round = v => Math.round((Number(v) || 0) * 100) / 100
    const feeAmt = round(fees), taxAmt = round(taxCollected)
    const discAmt = round(Math.abs(Number(discounts) || 0))
    if (feeAmt <= 0 && taxAmt <= 0 && discAmt <= 0) return null
    const { accounts } = await fetchSectionMap(clientId)
    const rows = [
      ...(feeAmt > 0 ? squareFeeRows(period, feeAmt, accounts)   : []),
      ...(taxAmt > 0 ? taxRows(period, taxAmt, accounts)         : []),
      ...(discAmt > 0 ? discountRows(period, discAmt, accounts)  : []),
    ]
    const { data: existing, error } = await supabase.from('bank_transactions')
      .select('id, description, amount')
      .eq('client_id', clientId)
      .in('description', rows.map(r => r.description))
    if (error) throw error
    const byDesc = {}
    ;(existing ?? []).forEach(t => { (byDesc[t.description] ??= []).push(t) })
    const inserts = rows.filter(r => !byDesc[r.description]?.length)
    const updates = rows.flatMap(r => (byDesc[r.description] ?? [])
      .filter(t => Math.abs(Number(t.amount) - r.amount) >= 0.005)
      .map(t => ({ id: t.id, amount: r.amount })))
    if (inserts.length) {
      const { error: insErr } = await supabase.from('bank_transactions')
        .insert(inserts.map(r => ({ ...r, account: ADJUSTMENTS_ACCOUNT, client_id: clientId })))
      if (insErr) throw insErr
    }
    for (const u of updates) {
      const { error: updErr } = await supabase.from('bank_transactions')
        .update({ amount: u.amount }).eq('client_id', clientId).eq('id', u.id)
      if (updErr) throw updErr
    }
    return inserts.length ? 'booked' : updates.length ? 'corrected' : null
  }

  const save = async () => {
    if (!preview) return
    setSaving(true)
    try {
      const { error } = await supabase.from('square_reports').upsert({
        client_id:    clientId,
        period:       preview.period,
        gross_sales:  preview.grossSales,
        returns:      preview.returns,
        discounts:    preview.discounts,
        net_sales:    preview.netSales,
        tax_collected: preview.taxCollected,
        fees:         preview.fees,
        net_total:    preview.netTotal,
        cash_amount:  preview.cashAmount,
        card_amount:  preview.cardAmount,
        categories:   preview.categories,
      }, { onConflict: 'client_id,period' })
      if (error) throw error
      let adjNote = ''
      try {
        const adj = await syncAdjustments(preview)
        if (adj) adjNote = ` · adjustments ${adj}`
      } catch (e) {
        alert('Report saved, but booking its adjustment entries failed: ' + e.message)
      }
      setMsg(`✓ ${fmtPeriod(preview.period)} saved${adjNote}`)
      setPreview(null)
      load()
    } catch (e) { alert('Save failed: ' + e.message) }
    finally { setSaving(false) }
  }

  const deleteReport = async id => {
    const period = reports.find(r => r.id === id)?.period
    if (!confirm('Delete this report? Its booked adjustment entries (fees, sales tax, discounts) are removed with it.')) return
    const { error } = await supabase.from('square_reports').delete()
      .eq('client_id', clientId).eq('id', id)
    if (error) { alert('Delete failed: ' + error.message); return }
    if (period) {
      const { error: adjErr } = await supabase.from('bank_transactions').delete()
        .eq('client_id', clientId).eq('account', ADJUSTMENTS_ACCOUNT)
        .in('description', [...squareFeeRows(period, 0), ...taxRows(period, 0), ...discountRows(period, 0)].map(r => r.description))
      if (adjErr) alert('Report deleted, but removing its adjustment entries failed: ' + adjErr.message)
    }
    load()
  }

  return (
    <div style={{ background: T.page, minHeight: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>

      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 28px', background: T.card, borderBottom: `1px solid ${T.border}` }}>
        <div>
          {headerLeft ?? <h2 style={{ fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 2px' }}>Square Reports</h2>}
          <p style={{ fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 }}>
            {reports.length} month{reports.length !== 1 ? 's' : ''} uploaded
            {missingMonths.length > 0 && <> · <span style={{ color: T.amber, fontWeight: 500 }}>{missingMonths.length} month{missingMonths.length !== 1 ? 's' : ''} missing</span></>}
            {msg && <> · <span style={{ color: T.success, fontWeight: 500 }}>{msg}</span></>}
          </p>
        </div>
        <button
          style={{ padding: '6px 14px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' }}
          onClick={() => fileRef.current?.click()}
        >
          ↑ Upload .eml
        </button>
        <input ref={fileRef} type="file" accept=".eml" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
      </header>

      <div style={{ padding: '20px 28px', maxWidth: 860 }}>

        {/* Drop zone */}
        {!preview && (
          <div
            style={{
              border: `2px dashed ${dragOver ? T.navy : T.border}`,
              borderRadius: 8, padding: '40px 24px', textAlign: 'center',
              background: dragOver ? '#EBF1F7' : T.card,
              cursor: 'pointer', marginBottom: 24,
              transition: 'border-color .2s, background .2s',
            }}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]) }}
            onClick={() => fileRef.current?.click()}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={T.gold} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              <line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 11 15 14"/>
            </svg>
            <p style={{ fontSize: 13, color: T.navy, fontWeight: 500, margin: '0 0 4px' }}>
              Drag &amp; drop your Square Sales Report email, or <strong>click to browse</strong>
            </p>
            <p style={{ fontSize: 11, color: T.charcoal, opacity: .6, margin: 0 }}>
              Save the email from your inbox as a .eml file, then upload it here each month
            </p>
          </div>
        )}

        {/* Preview */}
        {preview && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: '18px 20px', marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: T.navy, margin: 0 }}>
                Preview — {fmtPeriod(preview.period)}
              </h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ padding: '5px 14px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, cursor: 'pointer' }}
                  onClick={() => setPreview(null)}>Cancel</button>
                <button style={{ padding: '5px 16px', background: T.navy, color: '#fff', border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer', opacity: saving ? .6 : 1 }}
                  disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save Report'}</button>
              </div>
            </div>

            {/* Summary numbers */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {[
                { label: 'Gross Sales',   value: preview.grossSales,   color: T.navy   },
                { label: 'Tax Collected', value: preview.taxCollected, color: '#D97706' },
                { label: 'Square Fees',   value: preview.fees,         color: T.danger  },
                { label: 'Net Payout',    value: preview.netTotal,     color: T.success },
              ].map(c => (
                <div key={c.label} style={{ flex: '1 1 120px', background: '#fff', border: `1px solid ${T.border}`, borderTop: `3px solid ${c.color}`, borderRadius: 6, padding: '10px 12px' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{c.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: T.navy }}>{fmt(c.value)}</div>
                </div>
              ))}
            </div>

            {/* Payment methods */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 14, fontSize: 12, color: T.charcoal }}>
              <span>Cash: <strong>{fmt(preview.cashAmount)}</strong></span>
              <span>Card: <strong>{fmt(preview.cardAmount)}</strong></span>
            </div>

            {/* Category breakdown */}
            {preview.categories.length > 0 && (
              <div>
                <div style={{ fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Category Sales</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Category', 'Items Sold', 'Revenue'].map((h, i) => (
                        <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '4px 8px', background: T.page, fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.categories.map((c, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                        <td style={{ padding: '5px 8px', fontSize: 12, color: T.charcoal }}>{c.name}</td>
                        <td style={{ padding: '5px 8px', fontSize: 12, color: T.charcoal, textAlign: 'right' }}>{c.count.toLocaleString()}</td>
                        <td style={{ padding: '5px 8px', fontSize: 12, color: T.charcoal, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(c.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Upload coverage */}
        {!loading && reports.length > 0 && <CoveragePanel reports={reports} />}

        {/* Bank ↔ Square reconciliation */}
        {!loading && recon && <ReconPanel recon={recon} />}

        {/* Saved reports */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{ display: 'inline-block', width: 24, height: 24, border: `2px solid ${T.border}`, borderTopColor: T.navy, borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
          </div>
        ) : reports.length === 0 ? (
          !preview && (
            <p style={{ textAlign: 'center', color: '#9ca3af', fontSize: 13, padding: '20px 0' }}>
              No reports uploaded yet. Drop your first Square .eml above.
            </p>
          )
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['', 'Month', 'Gross Sales', 'Tax', 'Fees', 'Net Payout', 'Top Category', ''].map((h, i) => (
                  <th key={i} style={{ textAlign: i === 1 ? 'left' : i === 0 || i === 7 ? 'center' : 'right', padding: '7px 10px', background: T.page, fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', borderBottom: `2px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, i) => {
                const zebra = i % 2 === 0 ? '#fff' : '#f9fafb'
                if (row.kind === 'missing') return (
                  <tr key={row.key} style={{ background: zebra, borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: '8px 4px', textAlign: 'center', width: 28, color: T.amber, fontSize: 11 }}>⚠</td>
                    <td style={{ padding: '8px 10px', fontSize: 13, fontWeight: 600, color: T.amber }}>{fmtPeriod(row.period)}</td>
                    <td colSpan={5} style={{ padding: '8px 10px', fontSize: 11.5, color: T.amber }}>
                      No report uploaded — the revenue gross-up and sales-tax accrual are missing for this month.
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                      <button onClick={() => fileRef.current?.click()} title="Upload this month's Square .eml"
                        style={{ background: 'none', border: `1px solid ${T.border}`, borderRadius: 4, color: T.charcoal, cursor: 'pointer', fontSize: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                        ↑ Upload
                      </button>
                    </td>
                  </tr>
                )
                const r = row.r
                const cats = Array.isArray(r.categories) ? r.categories : []
                const top = [...cats].sort((a, b) => b.amount - a.amount)[0]
                const isOpen = !!expanded[r.id]
                const toggle = () => setExpanded(p => ({ ...p, [r.id]: !p[r.id] }))
                return (
                  <Fragment key={r.id}>
                    <tr style={{ background: zebra, borderBottom: `1px solid ${T.border}` }}>
                      <td style={{ padding: '8px 4px', textAlign: 'center', width: 28 }}>
                        <button onClick={toggle} title={isOpen ? 'Hide details' : 'Show everything pulled from this report'}
                          aria-expanded={isOpen}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 10, padding: '2px 4px', lineHeight: 1 }}>
                          {isOpen ? '▲' : '▼'}
                        </button>
                      </td>
                      <td onClick={toggle} style={{ padding: '8px 10px', fontSize: 13, fontWeight: 500, color: T.navy, cursor: 'pointer' }}>{fmtPeriod(r.period)}</td>
                      <td style={{ padding: '8px 10px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.charcoal }}>{fmt(r.gross_sales)}</td>
                      <td style={{ padding: '8px 10px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#D97706' }}>{fmt(r.tax_collected)}</td>
                      <td style={{ padding: '8px 10px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.danger }}>{fmt(r.fees)}</td>
                      <td style={{ padding: '8px 10px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.success }}>{fmt(r.net_total)}</td>
                      <td style={{ padding: '8px 10px', fontSize: 12, textAlign: 'right', color: T.charcoal }}>
                        {top ? `${top.name} (${fmt(top.amount)})` : '—'}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                        <button onClick={() => deleteReport(r.id)}
                          style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 13, padding: '2px 6px' }}
                          title="Delete">✕</button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={8} style={{ padding: 0, background: '#F7FAFC', borderBottom: `2px solid ${T.border}` }}>
                          <ReportDetail r={r} cats={cats} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
