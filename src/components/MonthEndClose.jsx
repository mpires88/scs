import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { supabase, fetchAll } from '../lib/supabase'
import { fetchSectionMap } from '../lib/chartOfAccounts'
import { getSetting, setSetting } from '../lib/settings'
import {
  buildMonthlyPL, computeCloseChecklist, computeCogsProposal,
  computeTaxAccrualProposal, computeSquareFeeProposal, ADJUSTMENTS_ACCOUNT,
} from '../lib/insights'
import { buildMonthEndRows } from '../lib/monthEnd'
import { T, MON, fmt2 } from '../lib/theme'
import InfoTip from './InfoTip'

const CLOSED_KEY = 'closed_months'

const ymLabel = ym => {
  const [y, m] = ym.split('-').map(Number)
  return `${MON[m]} ${y}`
}

// The month before the one containing `now` — the most recent one that can
// actually be closed.
const prevMonthOf = now => {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function MonthEndClose({ clientId }) {
  const [txns,       setTxns]       = useState([])
  const [squareReports, setSquare]  = useState([])
  const [sectionMap, setSectionMap] = useState({})
  const [accounts,   setAccounts]   = useState([]) // chart rows — booking resolves role names against it
  const [cogsMethod, setCogsMethod] = useState(null)
  const [invCounts,  setInvCounts]  = useState([])
  const [closed,     setClosed]     = useState([])
  const [uncatByMonth, setUncatByMonth] = useState({})
  const [month,      setMonth]      = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [busy,       setBusy]       = useState(false)
  const [msg,        setMsg]        = useState('')

  // ── Load ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        // Uncategorized rows matter here (a month isn't closed while any
        // remain), so unlike the dashboard this query keeps them.
        const [txnRes, sqRes, coaRes, methodVal, countsVal, closedVal] = await Promise.all([
          fetchAll(() => supabase.from('bank_transactions')
            .select('transaction_date, amount, category, account')
            .eq('client_id', clientId).order('transaction_date').order('id')),
          supabase.from('square_reports').select('period, gross_sales, tax_collected, fees, categories')
            .eq('client_id', clientId).order('period'),
          fetchSectionMap(clientId).then(r => ({ ...r, error: null })).catch(e => ({ map: {}, error: e })),
          getSetting(clientId, 'cogs_method', null).catch(() => null),
          getSetting(clientId, 'inventory_counts', []).catch(() => []),
          getSetting(clientId, CLOSED_KEY, []).catch(() => []),
        ])
        if (cancelled) return
        const rows = txnRes ?? []
        setTxns(rows)
        setSquare(sqRes.data ?? [])
        setSectionMap(coaRes.map)
        setAccounts(coaRes.accounts ?? [])
        setCogsMethod(methodVal)
        setInvCounts(Array.isArray(countsVal) ? countsVal : [])
        setClosed(Array.isArray(closedVal) ? closedVal : [])

        const uncat = {}
        rows.forEach(t => {
          if (t.category) return
          const ym = (t.transaction_date || '').slice(0, 7)
          if (ym) uncat[ym] = (uncat[ym] || 0) + 1
        })
        setUncatByMonth(uncat)
        setMonth(m => m ?? prevMonthOf(new Date()))
        if (coaRes.error) setError(coaRes.error.message)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [clientId])

  // ── Derived ────────────────────────────────────────────────────────────────

  // Only categorized rows belong in the P&L, matching the dashboard.
  const monthlyPL = useMemo(
    () => buildMonthlyPL({ txns: txns.filter(t => t.category), sectionMap }),
    [txns, sectionMap]
  )

  // Every month with any activity, newest first, plus the default close month
  // so it's always selectable even before its bank data lands.
  const months = useMemo(() => {
    const set = new Set(txns.map(t => (t.transaction_date || '').slice(0, 7)).filter(Boolean))
    squareReports.forEach(r => r.period && set.add(r.period))
    set.add(prevMonthOf(new Date()))
    return [...set].sort().reverse()
  }, [txns, squareReports])

  const checklist = useMemo(() => month ? computeCloseChecklist({
    txns, squareReports, uncatCount: uncatByMonth[month] ?? 0, counts: invCounts, month,
  }) : null, [txns, squareReports, uncatByMonth, invCounts, month])

  const cogsProposal = useMemo(
    () => month ? computeCogsProposal({ month, monthlyPL, squareReports, method: cogsMethod }) : null,
    [month, monthlyPL, squareReports, cogsMethod]
  )
  const taxProposal = useMemo(
    () => month ? computeTaxAccrualProposal({ month, squareReports, txns }) : null,
    [month, squareReports, txns]
  )
  const feeProposal = useMemo(
    () => month ? computeSquareFeeProposal({ month, squareReports, txns }) : null,
    [month, squareReports, txns]
  )

  const isClosed = !!month && closed.includes(month)
  const pending = useMemo(
    () => checklist ? buildMonthEndRows({
      month, cogsProposal, taxProposal, feeProposal, cogsBooked: checklist.cogsBooked, accounts,
    }) : [],
    [month, cogsProposal, taxProposal, feeProposal, checklist, accounts]
  )

  // ── Actions ────────────────────────────────────────────────────────────────

  const book = useCallback(async () => {
    if (busy || !pending.length) return
    setBusy(true); setMsg('')
    try {
      const withMeta = pending.map(r => ({
        ...r, account: ADJUSTMENTS_ACCOUNT, ...(clientId !== null ? { client_id: clientId } : {}),
      }))
      const { data, error: insErr } = await supabase.from('bank_transactions')
        .insert(withMeta).select('transaction_date, amount, category, description, account')
      if (insErr) throw insErr
      setTxns(prev => [...prev, ...(data ?? withMeta)])
      setMsg(`✓ Booked ${withMeta.length} entries for ${ymLabel(month)}`)
    } catch (e) { alert('Could not book month-end entries: ' + e.message) }
    setBusy(false)
  }, [busy, pending, clientId, month])

  const toggleClosed = useCallback(async () => {
    const next = isClosed ? closed.filter(m => m !== month) : [...closed, month].sort()
    setClosed(next); setMsg('')
    try { await setSetting(clientId, CLOSED_KEY, next) }
    catch (e) { alert('Could not save: ' + e.message); setClosed(closed) }
  }, [isClosed, closed, month, clientId])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:300, background:T.page }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={{ width:28, height:28, border:`2px solid ${T.border}`, borderTopColor:T.navy, borderRadius:'50%', animation:'spin .7s linear infinite' }} />
    </div>
  )

  const uncat = uncatByMonth[month] ?? 0

  // Each step: done, what it means, and where to go to resolve it.
  const steps = checklist ? [
    {
      done: checklist.bankImported,
      title: 'Bank activity imported',
      body: checklist.bankImported
        ? 'Transactions for this month are in the system.'
        : 'No transactions found for this month yet.',
      href: '/transactions', cta: 'Import CSV',
    },
    {
      done: checklist.squareUploaded,
      title: 'Square report uploaded',
      body: checklist.squareUploaded
        ? 'Sales and tax collected are known for this month.'
        : 'Without it, COGS and the sales-tax accrual cannot be proposed.',
      href: '/square', cta: 'Upload report',
    },
    {
      done: checklist.allCategorized,
      title: 'Everything categorized',
      body: uncat > 0
        ? `${uncat} transaction${uncat !== 1 ? 's' : ''} in this month still uncategorized.`
        : 'No uncategorized transactions this month.',
      href: '/transactions', cta: 'Categorize',
    },
    {
      done: checklist.cogsBooked,
      title: 'COGS estimate booked',
      body: checklist.cogsBooked
        ? 'The cost of what sold has been moved off the shelf into the P&L.'
        : cogsProposal
          ? `Proposed: ${fmt2(cogsProposal.amount)} (${cogsProposal.formula} method).`
          : cogsMethod
            ? 'Needs revenue for this month — import the bank activity first.'
            : 'Set a COGS method in Settings before this can be proposed.',
      action: !!cogsProposal && !checklist.cogsBooked,
    },
    ...(checklist.taxApplicable ? [{
      done: checklist.taxAccrued,
      title: 'Sales tax accrued',
      body: checklist.taxAccrued
        ? 'Tax collected has been moved to the Sales Tax Payable liability.'
        : taxProposal
          ? `Proposed: ${fmt2(taxProposal.amount)} moved out of revenue into the liability.`
          : 'No tax collected recorded for this month.',
      action: !!taxProposal && !taxProposal.booked,
    }] : []),
    ...(checklist.isQuarterEnd ? [{
      done: checklist.countEntered,
      title: 'Quarterly inventory count',
      body: checklist.countEntered
        ? 'A count has been recorded for this quarter.'
        : 'Quarter end — count the shelf and record it so COGS can be trued up.',
      href: '/', cta: 'Record count',
    }] : []),
    {
      done: null, // advisory: nothing to verify automatically
      title: 'Log any cash buys',
      body: 'Card-show or collection purchases paid in cash never touch the bank feed, so they have to be entered by hand.',
      href: '/buys', cta: 'Inventory Buys',
      optional: true,
    },
  ] : []

  const required = steps.filter(s => s.done !== null)
  const doneCount = required.filter(s => s.done).length

  return (
    <div style={{ background:T.page, minHeight:'100%', fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme:'light' }}>
      <header style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'14px 28px', background:T.card, borderBottom:`1px solid ${T.border}`, flexWrap:'wrap', gap:10 }}>
        <div>
          <h2 style={{ fontSize:14, fontWeight:600, color:T.navy, margin:'0 0 2px', display:'flex', alignItems:'center', gap:6 }}>
            Month-End Close
            <InfoTip title="Month-End Close">
              Everything the monthly routine needs, in order, for one month. Statuses are read
              live from your data — nothing here is a manual tick except marking the month closed.
            </InfoTip>
          </h2>
          <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:0 }}>
            {month ? `${ymLabel(month)} · ${doneCount}/${required.length} steps done` : ''}
          </p>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          {msg && <span style={{ fontSize:11, color:T.success, fontWeight:500 }}>{msg}</span>}
          <select
            value={month ?? ''} onChange={e => { setMonth(e.target.value); setMsg('') }}
            style={{ padding:'5px 9px', border:`1px solid ${T.border}`, borderRadius:5, fontSize:11, color:T.charcoal, background:'#fff', outline:'none' }}
          >
            {months.map(m => (
              <option key={m} value={m}>{ymLabel(m)}{closed.includes(m) ? ' · closed' : ''}</option>
            ))}
          </select>
        </div>
      </header>

      <div style={{ padding:'20px 28px 48px', maxWidth:860 }}>
        {error && (
          <div style={{ background:'#FDE8E8', border:'1px solid #F5C2C2', borderRadius:6, padding:'10px 14px', fontSize:11.5, color:'#991B1B', marginBottom:14 }}>
            {error}
          </div>
        )}

        {isClosed && (
          <div style={{ display:'flex', alignItems:'center', gap:10, background:'#E6F0E9', border:'1px solid #B8D4BE', borderRadius:7, padding:'11px 15px', marginBottom:16 }}>
            <span style={{ fontSize:14 }}>✓</span>
            <div style={{ flex:1, fontSize:12, color:'#12603A' }}>
              <strong>{ymLabel(month)} is marked closed.</strong> Reopen it if something needs to change.
            </div>
            <button onClick={toggleClosed} style={btnSec}>Reopen</button>
          </div>
        )}

        {/* Steps */}
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {steps.map((s, i) => (
            <div key={i} style={{
              display:'flex', gap:12, background:T.card, borderRadius:7, padding:'12px 15px',
              borderTop:`1px solid ${T.border}`, borderRight:`1px solid ${T.border}`, borderBottom:`1px solid ${T.border}`,
              borderLeft:`3px solid ${s.done === null ? T.border : s.done ? T.success : T.amber}`,
            }}>
              <span style={{
                flexShrink:0, width:19, height:19, borderRadius:'50%', display:'inline-flex',
                alignItems:'center', justifyContent:'center', fontSize:10.5, fontWeight:700, marginTop:1,
                background: s.done === null ? T.page : s.done ? '#D1E8D4' : '#FEF3C7',
                color:      s.done === null ? '#9ca3af' : s.done ? '#1A5C28' : '#92400E',
              }}>{s.done === null ? '·' : s.done ? '✓' : '!'}</span>

              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12.5, fontWeight:600, color:T.navy, marginBottom:3 }}>
                  {s.title}
                  {s.optional && <span style={{ marginLeft:7, fontSize:9.5, fontWeight:600, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'.05em' }}>optional</span>}
                </div>
                <div style={{ fontSize:11.5, color:T.charcoal, lineHeight:1.6, opacity:.9 }}>{s.body}</div>
              </div>

              <div style={{ flexShrink:0, display:'flex', alignItems:'center' }}>
                {s.href && !s.done && <Link href={s.href} style={{ ...btnSec, textDecoration:'none' }}>{s.cta} →</Link>}
                {s.href && s.done && <Link href={s.href} style={{ ...btnGhost, textDecoration:'none' }}>{s.cta}</Link>}
              </div>
            </div>
          ))}
        </div>

        {/* Booking */}
        {pending.length > 0 && (
          <div style={{ marginTop:16, background:'#FBF6E7', border:`1px solid ${T.gold}`, borderRadius:7, padding:'13px 16px' }}>
            <div style={{ fontSize:12, fontWeight:600, color:'#7A6829', marginBottom:5 }}>
              {pending.length / 2} month-end {pending.length === 2 ? 'entry' : 'entries'} ready to book
            </div>
            <div style={{ fontSize:11.5, color:T.charcoal, lineHeight:1.6, marginBottom:10 }}>
              Each is a balanced pair dated {ymLabel(month)}, filed under the{' '}
              <strong>{ADJUSTMENTS_ACCOUNT}</strong> account. No cash moves.
            </div>
            <ul style={{ margin:'0 0 11px', paddingLeft:18, fontSize:11.5, color:T.charcoal, lineHeight:1.75 }}>
              {pending.filter((_, i) => i % 2 === 0).map((r, i) => (
                <li key={i}>{r.description} — <strong>{fmt2(Math.abs(r.amount))}</strong></li>
              ))}
            </ul>
            <button onClick={book} disabled={busy} style={{ ...btnPri, ...(busy ? { opacity:.5, cursor:'not-allowed' } : {}) }}>
              {busy ? 'Booking…' : 'Book these entries'}
            </button>
          </div>
        )}

        {/* Close */}
        {!isClosed && (
          <div style={{ marginTop:16, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
            <button onClick={toggleClosed} style={btnPri}>Mark {ymLabel(month)} closed</button>
            {doneCount < required.length && (
              <span style={{ fontSize:11, color:T.amber }}>
                {required.length - doneCount} step{required.length - doneCount !== 1 ? 's' : ''} still outstanding — you can close anyway.
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const btnPri   = { padding:'6px 16px', background:T.navy, color:'#fff', border:'none', borderRadius:5, fontSize:11, fontWeight:500, cursor:'pointer' }
const btnSec   = { padding:'5px 12px', background:'#fff', color:T.charcoal, border:`1px solid ${T.border}`, borderRadius:5, fontSize:10.5, fontWeight:500, cursor:'pointer', whiteSpace:'nowrap' }
const btnGhost = { padding:'5px 12px', background:'transparent', color:'rgba(74,74,74,0.5)', border:'1px solid transparent', borderRadius:5, fontSize:10.5, cursor:'pointer', whiteSpace:'nowrap' }
