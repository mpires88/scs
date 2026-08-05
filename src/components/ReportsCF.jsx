'use client'

// Cash Flow Statement — direct method, built by lib/cashFlow.js from the bank
// feed only. Card charges and journal entries are excluded there, so what this
// shows is money that actually moved.

import { useState, useEffect, useMemo, Fragment } from 'react'
import { supabase, fetchAll } from '../lib/supabase'
import { fetchAccounts } from '../lib/chartOfAccounts'
import { getSetting } from '../lib/settings'
import { buildCashFlow, cashFlowYears } from '../lib/cashFlow'
import { T, MON, fmtYm, STMT } from '../lib/theme'
import InfoTip from './InfoTip'

const fmtCell = n => {
  if (n == null || n === 0) return '—'
  const neg = n < 0
  const str = Math.abs(Math.round(n)).toLocaleString()
  return neg ? `(${str})` : str
}

const BLURB = {
  Operating:  'Trading — takings in, running costs and stock out',
  Investing:  'Buying or selling things the shop keeps long term',
  Financing:  'Owner money in and out, and borrowing',
}

const SECTION_INFO = {
  Operating: <>Cash from actually running the shop. It starts at the Profit &amp; Loss bottom line and
    then corrects for everything that makes profit and cash differ — sales tax passing through, money
    tied up in stock, and spending the credit card funded. The total is the real movement through the
    bank, not an estimate.</>,
  Investing: <>Cash spent on things the shop keeps for the long term — fixtures, equipment, a vehicle.
    Stock is <strong>not</strong> here; for a shop, inventory is working capital and sits under
    operating. This is usually empty unless something was capitalised.</>,
  Financing: <>Money from outside the trading itself: what you paid down on the credit card, what you
    drew out as the owner, and what you put in. The card sits here because it is a borrowing facility —
    charging it funds the shop, and paying it down is repaying that borrowing.</>,
}

const SUMMARY_INFO = {
  opening: <>The bank balance carried in at the start, worked out from every bank transaction before this
    period — not just the ones shown.</>,
  net:     <>The three activities added together: how much the bank balance moved over the period.</>,
  closing: <>Opening cash plus the net change. This is a real bank balance — it equals the sum of every
    bank transaction up to that date.</>,
}

// `headerLeft` lets the combined Financial Statements page supply the shared
// title and tab switcher in place of this statement's own title.
// `shared` lets the combined page drive year / period / hide-zero across all
// three statements at once — those controls hide here when it does. `data` lets
// it read the ledger once and hand it down instead of each statement fetching
// the same rows again.
export default function ReportsCF({ clientId, headerLeft = null, shared = null, data = null, csvSink = null }) {
  const [txnsLocal,     setTxns]     = useState([])
  const [accountsLocal, setAccounts] = useState([])
  const [registryLocal, setRegistry] = useState([])
  const [loadingLocal,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  // Injected data is read straight through rather than copied into state —
  // one source of truth, and no state writes during render.
  const txns     = data ? data.txns          : txnsLocal
  const accounts = data ? data.accounts      : accountsLocal
  const registry = useMemo(() => (data ? (data.registry ?? []) : registryLocal), [data, registryLocal])
  const loading  = data ? false              : loadingLocal
  const [yearLocal,     setYear]     = useState(null)
  const [hideZeroLocal, setHideZero] = useState(false)
  const [periodLocal,   setPeriod]   = useState('monthly')
  const year     = shared ? shared.year     : yearLocal
  const hideZero = shared ? shared.hideZero : hideZeroLocal
  const period   = shared ? shared.period   : periodLocal

  useEffect(() => {
    if (data) return   // the combined page supplied the ledger
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        // Uncategorized rows are still cash, so no category filter here.
        const [rows, coa, reg] = await Promise.all([
          fetchAll(() => supabase.from('bank_transactions')
            .select('transaction_date, amount, category, account')
            .eq('client_id', clientId)
            .order('transaction_date').order('id')),
          fetchAccounts(clientId),
          getSetting(clientId, 'ledger_accounts', []).catch(() => []),
        ])
        if (cancelled) return
        setTxns(rows)
        setAccounts(coa.accounts)
        const r = Array.isArray(reg) ? reg : []
        setRegistry(r)
        const yrs = cashFlowYears(rows, r)
        setYear(yrs[yrs.length - 1] ?? null)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [clientId, data])

  const years = useMemo(() => cashFlowYears(txns, registry), [txns, registry])
  const cf = useMemo(
    () => buildCashFlow({ txns, accounts, registry, year, period, columns: shared?.columns }),
    [txns, accounts, registry, year, period, shared?.columns]
  )

  const rowsFor = useMemo(() => {
    if (!cf) return {}
    const zero = r => cf.months.every(m => Math.abs(r.byMonth[m] ?? 0) < 0.005) && Math.abs(r.total) < 0.005
    const map = {}
    cf.sections.forEach(s => { map[s.section] = hideZero ? s.rows.filter(r => !zero(r)) : s.rows })
    return map
  }, [cf, hideZero])

  const buildCsvLines = () => {
    if (!cf) return null
    const { months } = cf
    const col = m => cf.yearly ? String(m) : cf.allDates ? fmtYm(m) : `${MON[m]} ${year}`
    const lines = [['Line', ...months.map(col), 'Total']]
    const push = (label, byMonth, total) =>
      lines.push([label, ...months.map(m => (byMonth[m] ?? 0).toFixed(2)), (total ?? 0).toFixed(2)])
    lines.push(['Cash at beginning', ...months.map(m => cf.opening[m].toFixed(2)), cf.opening[months[0]].toFixed(2)])
    cf.sections.forEach(s => {
      lines.push([`${s.section} activities`])
      rowsFor[s.section].forEach(r => push(`  ${r.name}`, r.byMonth, r.total))
      push(`Net cash from ${s.section.toLowerCase()} activities`, s.totals, s.total)
    })
    push('NET CHANGE IN CASH', cf.netChange.byMonth, cf.netChange.total)
    lines.push(['Cash at end', ...months.map(m => cf.closing[m].toFixed(2)), cf.closing[months[months.length - 1]].toFixed(2)])
    return lines
  }

  // The combined Financial Statements page pulls lines through this sink so its
  // Export picker can bundle several statements into one file. Registered every
  // render so the closure always sees current data.
  // eslint-disable-next-line react-hooks/immutability -- csvSink is a ref; mutating .current is its contract
  useEffect(() => { if (csvSink) csvSink.current.cf = buildCsvLines })

  const exportCSV = () => {
    const lines = buildCsvLines()
    if (!lines) return
    const csv = lines.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `SCS-CashFlow-${cf.yearly ? 'all-years' : year}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:300, background:T.page }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={{ width:28, height:28, border:`2px solid ${T.border}`, borderTopColor:T.navy, borderRadius:'50%', animation:'spin .7s linear infinite' }} />
    </div>
  )

  if (error) return (
    <div style={{ padding:28 }}>
      <div style={{ background:'#FDE8E8', border:'1px solid #F5C2C2', borderRadius:6, padding:'10px 14px', fontSize:12, color:'#991B1B' }}>
        Failed to load: {error}
      </div>
    </div>
  )

  const lastM = cf?.months[cf.months.length - 1]

  return (
    <div style={{ background:T.page, minHeight:'100%', fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme:'light' }}>
      <style>{`
        @media print {
          aside, .cf-controls { display: none !important; }
          body { background: #fff !important; }
        }
      `}</style>

      <header style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'8px 28px', background:T.card, borderBottom:`1px solid ${T.border}`, flexWrap:'wrap', gap:10 }}>
        {headerLeft ?? (
          <div>
            <h2 style={{ fontSize:12, fontWeight:600, color:T.navy, margin:'0 0 1px' }}>Cash Flow Statement</h2>
            <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:0 }}>
              Sports Card Station {cf?.yearly ? '· all years' : (year ? `· ${year}` : '')} · money actually in and out of the bank
            </p>
          </div>
        )}
        <div className="cf-controls" style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          {!shared && (<>
          <label
            style={{ display:'flex', alignItems:'center', gap:6, fontSize:11, color:T.charcoal, cursor:'pointer', userSelect:'none' }}
            title="Hide any line that is zero in every column. Activity subtotals are unchanged."
          >
            <input type="checkbox" checked={hideZero} onChange={e => setHideZero(e.target.checked)} />
            Hide $0 rows
          </label>
          <select
            style={{ fontSize:11, padding:'4px 8px', border:`1px solid ${T.border}`, borderRadius:5, color:T.charcoal, background:'#fff', outline:'none' }}
            value={period} onChange={e => setPeriod(e.target.value)}
            title="Monthly shows the selected year by month; Yearly puts every year side by side."
          >
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly — all years</option>
          </select>
          <button style={btn.sec} onClick={exportCSV} disabled={!cf}>↓ Export CSV</button>
          <button style={btn.sec} onClick={() => window.print()} disabled={!cf}>🖨 Print / PDF</button>
          </>)}
        </div>
      </header>

      <div style={{ padding:'20px 28px' }}>

        {!shared && years.length > 1 && !cf?.yearly && (
          <div className="cf-controls" style={{ display:'flex', gap:4, marginBottom:16 }}>
            {years.map(y => (
              <button key={y} onClick={() => setYear(y)}
                style={{
                  padding:'5px 14px', borderRadius:5, fontSize:11, cursor:'pointer',
                  border:`1px solid ${year === y ? T.navy : T.border}`,
                  background: year === y ? T.navy : '#fff',
                  color: year === y ? '#fff' : T.charcoal,
                  fontWeight: year === y ? 600 : 400,
                }}>{y}</button>
            ))}
          </div>
        )}

        {!cf ? (
          <p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:'48px 0' }}>
            No bank activity yet. Cash flow is built from accounts marked as banks on the
            Chart of Accounts page — map your checking account there and import its transactions.
          </p>
        ) : (
          <div className="stmt-scroll" style={{ display:'inline-block', verticalAlign:'top', maxWidth:'100%', overflowX:'auto', background:T.card, border:`1px solid ${T.border}`, borderRadius:7 }}>
            <table style={{ borderCollapse:'collapse', width:'auto', tableLayout:'fixed', fontSize:11.5 }}>
              <thead>
                <tr>
                  <th style={{ ...cell.th, textAlign:'left', width:STMT.label, minWidth:STMT.label, maxWidth:STMT.label, position:'sticky', left:0, background:T.page, zIndex:1 }}>Line</th>
                  {cf.months.map(m => (
                    <th key={m} style={{ ...cell.th, textAlign:'right', width: cf.yearly ? STMT.numWide : STMT.num, minWidth: cf.yearly ? STMT.numWide : STMT.num }}>
                      {cf.yearly ? m : cf.allDates ? fmtYm(m) : <>{MON[m]} {String(year).slice(2)}</>}
                    </th>
                  ))}
                  <th style={{ ...cell.th, textAlign:'right', width:STMT.total, minWidth:STMT.total, borderLeft:`2px solid ${T.border}` }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {/* Opening cash */}
                <tr style={{ background:T.page, borderBottom:`1px solid ${T.border}` }}>
                  <td style={{ ...cell.td, fontWeight:600, color:T.navy, position:'sticky', left:0, background:T.page }}>
                    <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
                      Cash at beginning<InfoTip title="Cash at beginning">{SUMMARY_INFO.opening}</InfoTip>
                    </span>
                  </td>
                  {cf.months.map(m => <td key={m} style={{ ...cell.num, color:T.charcoal }}>{fmtCell(cf.opening[m])}</td>)}
                  <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}`, fontWeight:600 }}>{fmtCell(cf.opening[cf.months[0]])}</td>
                </tr>

                {cf.sections.map(sec => (
                  <Fragment key={sec.section}>
                    <tr>
                      <td colSpan={999} style={{ padding:'8px 8px 3px', fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.07em', background:T.card }}>
                        <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
                          {sec.section} Activities
                          <InfoTip title={`${sec.section} activities`}>{SECTION_INFO[sec.section]}</InfoTip>
                        </span>
                        <span style={{ marginLeft:8, fontWeight:400, textTransform:'none', letterSpacing:0, color:'#b6b2a8' }}>{BLURB[sec.section]}</span>
                      </td>
                    </tr>
                    {rowsFor[sec.section].map(r => (
                      <tr key={r.name} style={{ borderBottom:'1px solid #F0EEE9' }}>
                        <td style={{ ...cell.td, paddingLeft:16, position:'sticky', left:0, background:T.card }}>
                          {/* Truncate the TEXT, not the cell: the cell clips, and
                              the icon has to stay visible on a long label. */}
                          <span style={{ display:'inline-flex', alignItems:'center', gap:5, maxWidth:'100%' }}>
                            <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.name}</span>
                            {r.note && <InfoTip title={r.name}>{r.note}</InfoTip>}
                          </span>
                        </td>
                        {cf.months.map(m => (
                          <td key={m} style={{ ...cell.num, color: r.byMonth[m] < 0 ? T.charcoal : T.success }}>{fmtCell(r.byMonth[m])}</td>
                        ))}
                        <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}`, fontWeight:600 }}>{fmtCell(r.total)}</td>
                      </tr>
                    ))}
                    <tr style={{ background:T.page, borderBottom:`1px solid ${T.border}` }}>
                      <td style={{ ...cell.td, fontWeight:600, color:T.navy, position:'sticky', left:0, background:T.page }}>
                        Net cash from {sec.section.toLowerCase()}
                      </td>
                      {cf.months.map(m => (
                        <td key={m} style={{ ...cell.num, fontWeight:600, color: sec.totals[m] < 0 ? T.danger : T.navy }}>{fmtCell(sec.totals[m])}</td>
                      ))}
                      <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}`, fontWeight:700, color: sec.total < 0 ? T.danger : T.navy }}>{fmtCell(sec.total)}</td>
                    </tr>
                  </Fragment>
                ))}

                {/* Net change */}
                <tr style={{ background:'#EBF1F7', borderBottom:`2px solid #B8CDE0` }}>
                  <td style={{ ...cell.td, fontWeight:700, color:T.navy, position:'sticky', left:0, background:'#EBF1F7' }}>
                    <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
                      NET CHANGE IN CASH<InfoTip title="Net change in cash">{SUMMARY_INFO.net}</InfoTip>
                    </span>
                  </td>
                  {cf.months.map(m => (
                    <td key={m} style={{ ...cell.num, fontWeight:600, color: cf.netChange.byMonth[m] < 0 ? T.danger : T.navy }}>{fmtCell(cf.netChange.byMonth[m])}</td>
                  ))}
                  <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}`, fontWeight:700, color: cf.netChange.total < 0 ? T.danger : T.navy }}>{fmtCell(cf.netChange.total)}</td>
                </tr>

                {/* Closing cash */}
                <tr style={{ background:T.navy }}>
                  <td style={{ ...cell.td, position:'sticky', left:0, background:T.navy, color:'#fff', fontWeight:700 }}>
                    <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
                      CASH AT END<InfoTip title="Cash at end">{SUMMARY_INFO.closing}</InfoTip>
                    </span>
                  </td>
                  {cf.months.map(m => (
                    <td key={m} style={{ ...cell.num, color: cf.closing[m] < 0 ? '#FCA5A5' : '#A7F3D0', fontWeight:600 }}>{fmtCell(cf.closing[m])}</td>
                  ))}
                  <td style={{ ...cell.num, borderLeft:'2px solid rgba(255,255,255,0.2)', color: cf.closing[lastM] < 0 ? '#FCA5A5' : '#A7F3D0', fontWeight:700 }}>
                    {fmtCell(cf.closing[lastM])}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {cf && (
          <p style={{ fontSize:10.5, color:'rgba(74,74,74,0.55)', marginTop:10, lineHeight:1.6, maxWidth:900 }}>
            Direct method, built from {cf.cashAccounts.length ? cf.cashAccounts.join(' and ') : 'your bank accounts'}.
            Only money that actually moved through a bank account counts — a card purchase appears when the
            card bill is paid, not when the charge is made, and month-end journal entries (COGS, sales-tax
            accrual, the Square fee gross-up) are excluded because no cash moves. Inventory sits in operating,
            since stock is working capital for a shop. Amounts in parentheses are cash out.
            {!cf.reconciles && ' ⚠ This statement does not tie to the sum of the period’s bank rows — please report this.'}
            {cf.unclassified && ' ⚠ Some cash has no category and is shown as Uncategorized — categorize it on the Transactions page.'}
          </p>
        )}
      </div>
    </div>
  )
}

const cell = {
  th:  { padding:'6px 8px', background:T.page, fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.06em', whiteSpace:'nowrap', borderBottom:`2px solid ${T.border}` },
  td:  { padding:'3px 8px', fontSize:11.5, color:T.charcoal, whiteSpace:'nowrap', maxWidth:STMT.label, overflow:'hidden', textOverflow:'ellipsis' },
  num: { padding:'3px 8px', fontSize:11.5, color:T.charcoal, textAlign:'right', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap', overflow:'hidden' },
}

const btn = {
  sec: { padding:'6px 14px', background:'#fff', color:T.charcoal, border:`1px solid ${T.border}`, borderRadius:5, fontSize:11, fontWeight:500, cursor:'pointer' },
}
