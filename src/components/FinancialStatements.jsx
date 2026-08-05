'use client'

// Financial Statements — the P&L, Balance Sheet and Cash Flow stacked in the
// order an accountant reads them: what was earned, what is owned and owed, then
// what actually moved through the bank.
//
// This page owns the three things all three statements share — which year, by
// month or by year, and whether to hide empty lines — so they always describe
// the same period. It also reads the ledger ONCE and hands it down; each
// statement still fetches for itself when used standalone.

import { useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { supabase, fetchAll } from '../lib/supabase'
import { fetchAccounts } from '../lib/chartOfAccounts'
import { getSetting } from '../lib/settings'
import ReportsKPI from './ReportsKPI'
import ReportsPL from './ReportsPL'
import ReportsBS from './ReportsBS'
import ReportsCF from './ReportsCF'
import { DisclosureBanner } from './Disclosure'
import { T } from '../lib/theme'

const SECTIONS = [
  { key: 'kpi', label: 'KPIs',          Comp: ReportsKPI, hint: 'Margins, breakeven, stock and cash health at a glance' },
  { key: 'pl',  label: 'Profit & Loss', Comp: ReportsPL,  hint: 'What the business earned over a period' },
  { key: 'bs',  label: 'Balance Sheet', Comp: ReportsBS,  hint: 'What it owns and owes at a point in time' },
  { key: 'cf',  label: 'Cash Flow',     Comp: ReportsCF,  hint: 'Money that actually moved through the bank' },
]

export default function FinancialStatements({ clientId }) {
  const [txns,     setTxns]     = useState([])
  const [accounts, setAccounts] = useState([])
  const [registry, setRegistry] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)

  const [year,     setYear]     = useState(null)
  const [period,   setPeriod]   = useState('monthly')
  const [hideZero, setHideZero] = useState(false)

  const [printOpen, setPrintOpen] = useState(false)
  const [printSel,  setPrintSel]  = useState({ kpi: true, pl: true, bs: true, cf: true })

  const [csvOpen, setCsvOpen] = useState(false)
  const [csvSel,  setCsvSel]  = useState({ kpi: true, pl: true, bs: true, cf: true })
  // Each statement registers its CSV line-builder here, so the Export picker
  // can bundle any selection of them into one file.
  const csvSink = useRef({})

  const refs = useRef({})
  const barRef = useRef(null)
  // The control bar wraps to two rows on narrower windows, so its height isn't
  // a constant. Sections offset their scroll target by the MEASURED height,
  // so a jump always lands with the section header just below the frozen bar.
  const [barH, setBarH] = useState(44)
  const jump = key => refs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        // The superset all three need: no category filter, because the balance
        // sheet and cash flow both count uncategorized rows as real money.
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
        setRegistry(Array.isArray(reg) ? reg : [])
        const yrs = [...new Set(rows.map(t => +(t.transaction_date || '').slice(0, 4)).filter(Boolean))].sort()
        setYear(yrs[yrs.length - 1] ?? null)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [clientId])

  const years = useMemo(
    () => [...new Set(txns.map(t => +(t.transaction_date || '').slice(0, 4)).filter(Boolean))].sort(),
    [txns]
  )

  // Re-measure whenever the window resizes or the bar's contents change
  // (year pills appear after load; monthly/yearly hides them).
  useEffect(() => {
    const measure = () => { if (barRef.current) setBarH(barRef.current.offsetHeight) }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [loading, years.length, period])
  const data   = useMemo(() => ({ txns, accounts, registry }), [txns, accounts, registry])
  // One column set for all three statements. Each would otherwise derive its
  // own from its own rows — the cash flow only sees months with bank activity,
  // the P&L only months with categorized rows — and a month missing from one
  // shifts every column after it out of line with the others. The union is
  // safe: a statement with nothing in a column simply shows a dash.
  const columns = useMemo(() => {
    const ymOf = t => (t.transaction_date || '').slice(0, 7)
    if (period === 'yearly') {
      return [...new Set(txns.map(t => +(t.transaction_date || '').slice(0, 4)).filter(Boolean))]
        .sort((a, b) => a - b)
    }
    if (period === 'all') {
      const yms = [...new Set(txns.map(ymOf).filter(Boolean))].sort()
      if (!yms.length) return []
      // Continuous, so a quiet month is a zero column rather than a gap.
      const out = []
      let [y, m] = yms[0].split('-').map(Number)
      for (let ym = yms[0]; ym <= yms[yms.length - 1];) {
        out.push(ym)
        m += 1; if (m > 12) { m = 1; y += 1 }
        ym = `${y}-${String(m).padStart(2, '0')}`
      }
      return out
    }
    if (!year) return []
    return [...new Set(
      txns.filter(t => (t.transaction_date || '').startsWith(String(year)))
          .map(t => +(t.transaction_date || '').slice(5, 7)).filter(Boolean)
    )].sort((a, b) => a - b)
  }, [txns, year, period])

  const shared = useMemo(
    () => ({ year, period, hideZero, columns }),
    [year, period, hideZero, columns])

  // Identical columns only line up while the three scroll together; each table
  // has its own horizontal scroller, so mirror them.
  useEffect(() => {
    const els = [...document.querySelectorAll('.stmt-scroll')]
    if (els.length < 2) return
    let syncing = false
    const onScroll = e => {
      if (syncing) return
      syncing = true
      els.forEach(el => { if (el !== e.currentTarget) el.scrollLeft = e.currentTarget.scrollLeft })
      requestAnimationFrame(() => { syncing = false })
    }
    els.forEach(el => el.addEventListener('scroll', onScroll))
    return () => els.forEach(el => el.removeEventListener('scroll', onScroll))
  }, [loading, columns, hideZero, period, year])

  const selectedCount = SECTIONS.filter(s => printSel[s.key]).length
  const doPrint = () => {
    if (!selectedCount) return
    setPrintOpen(false)
    // Let the data-print attributes flush before the dialog reads the DOM.
    setTimeout(() => window.print(), 0)
  }

  const csvCount = SECTIONS.filter(s => csvSel[s.key]).length
  const doExportCsv = () => {
    const parts = SECTIONS.filter(s => csvSel[s.key])
      .map(s => ({ label: s.label, lines: csvSink.current[s.key]?.() }))
      .filter(p => Array.isArray(p.lines) && p.lines.length)
    if (!parts.length) return
    setCsvOpen(false)
    const lines = parts.length === 1
      ? parts[0].lines
      : parts.flatMap((p, i) => [...(i ? [['']] : []), [p.label.toUpperCase()], ...p.lines])
    const csv = lines.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const suffix = period === 'yearly' ? 'all-years' : period === 'all' ? 'all-months' : year
    a.href = url
    a.download = parts.length === 1
      ? `SCS-${parts[0].label.replace(/[^A-Za-z]+/g, '')}-${suffix}.csv`
      : `SCS-Financial-Statements-${suffix}.csv`
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

  return (
    <div style={{ background:T.page, minHeight:'100%', fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme:'light' }}>
      <style>{`
        @media print {
          .fs-bar, aside { display: none !important; }
          body { background: #fff !important; }
          .fs-section[data-print="0"] { display: none !important; }
          /* A page break before every printed statement except the first — the
             general sibling selector skips over the ones being hidden. */
          .fs-section[data-print="1"] ~ .fs-section[data-print="1"] {
            break-before: page; page-break-before: always;
          }
        }
      `}</style>

      <div
        ref={barRef}
        className="fs-bar"
        style={{
          position:'sticky', top:0, zIndex:20, display:'flex', alignItems:'center',
          gap:14, flexWrap:'wrap', padding:'9px 28px', background:T.navy,
        }}
      >
        <span style={{ fontSize:13, fontWeight:600, color:'#fff' }}>Financial Statements</span>

        <div style={{ display:'flex', gap:4 }}>
          {SECTIONS.map(s => (
            <button key={s.key} onClick={() => jump(s.key)} title={s.hint} style={barBtn}>{s.label}</button>
          ))}
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:10, marginLeft:'auto', flexWrap:'wrap' }}>
          {period === 'monthly' && years.length > 1 && (
            <div style={{ display:'flex', gap:3 }}>
              {years.map(y => (
                <button key={y} onClick={() => setYear(y)}
                  style={{ ...barBtn, ...(year === y ? barBtnOn : {}) }}>{y}</button>
              ))}
            </div>
          )}
          <select
            value={period} onChange={e => setPeriod(e.target.value)}
            title="Monthly shows the selected year by month; Yearly puts every year side by side. Applies to all three."
            style={{ fontSize:11, padding:'3px 7px', borderRadius:5, border:'1px solid rgba(255,255,255,0.25)', background:'transparent', color:'#fff', outline:'none' }}
          >
            <option value="monthly" style={{ color:T.charcoal }}>Monthly</option>
            <option value="all"     style={{ color:T.charcoal }}>Monthly — all dates</option>
            <option value="yearly"  style={{ color:T.charcoal }}>Yearly — all years</option>
          </select>
          <label
            style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:'rgba(255,255,255,0.85)', cursor:'pointer', userSelect:'none' }}
            title="Hide any line that is zero in every column, on all three statements. Totals are unchanged."
          >
            <input type="checkbox" checked={hideZero} onChange={e => setHideZero(e.target.checked)} />
            Hide $0 rows
          </label>

          <div style={{ position:'relative' }}>
            <button onClick={() => setCsvOpen(o => !o)} style={barBtn} aria-expanded={csvOpen}>
              ↓ Export CSV ▾
            </button>
            {csvOpen && (
              <>
                <div onClick={() => setCsvOpen(false)} style={{ position:'fixed', inset:0, zIndex:30 }} />
                <div style={{
                  position:'absolute', right:0, top:'calc(100% + 6px)', zIndex:31, minWidth:212,
                  background:'#fff', border:`1px solid ${T.border}`, borderRadius:7,
                  boxShadow:'0 10px 30px rgba(0,0,0,.18)', padding:'10px 12px',
                }}>
                  <div style={{ fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:7 }}>
                    Export which statements
                  </div>
                  {SECTIONS.map(s => (
                    <label key={s.key} style={{ display:'flex', alignItems:'center', gap:7, fontSize:12, color:T.charcoal, padding:'3px 0', cursor:'pointer' }}>
                      <input
                        type="checkbox" checked={!!csvSel[s.key]}
                        onChange={e => setCsvSel(p => ({ ...p, [s.key]: e.target.checked }))}
                      />
                      {s.label}
                    </label>
                  ))}
                  <div style={{ display:'flex', gap:6, marginTop:9, paddingTop:9, borderTop:`1px solid ${T.border}` }}>
                    <button style={miniBtn} onClick={() => setCsvSel({ kpi:true, pl:true, bs:true, cf:true })}>All</button>
                    <button
                      style={{ ...miniBtn, flex:1, background:T.navy, color:'#fff', borderColor:T.navy, opacity: csvCount ? 1 : .5 }}
                      disabled={!csvCount} onClick={doExportCsv}
                    >Export {csvCount === SECTIONS.length ? 'all' : csvCount}</button>
                  </div>
                </div>
              </>
            )}
          </div>

          <div style={{ position:'relative' }}>
            <button onClick={() => setPrintOpen(o => !o)} style={barBtn} aria-expanded={printOpen}>
              🖨 Print / PDF ▾
            </button>
            {printOpen && (
              <>
                <div onClick={() => setPrintOpen(false)} style={{ position:'fixed', inset:0, zIndex:30 }} />
                <div style={{
                  position:'absolute', right:0, top:'calc(100% + 6px)', zIndex:31, minWidth:212,
                  background:'#fff', border:`1px solid ${T.border}`, borderRadius:7,
                  boxShadow:'0 10px 30px rgba(0,0,0,.18)', padding:'10px 12px',
                }}>
                  <div style={{ fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:7 }}>
                    Print which statements
                  </div>
                  {SECTIONS.map(s => (
                    <label key={s.key} style={{ display:'flex', alignItems:'center', gap:7, fontSize:12, color:T.charcoal, padding:'3px 0', cursor:'pointer' }}>
                      <input
                        type="checkbox" checked={!!printSel[s.key]}
                        onChange={e => setPrintSel(p => ({ ...p, [s.key]: e.target.checked }))}
                      />
                      {s.label}
                    </label>
                  ))}
                  <div style={{ display:'flex', gap:6, marginTop:9, paddingTop:9, borderTop:`1px solid ${T.border}` }}>
                    <button style={miniBtn} onClick={() => setPrintSel({ kpi:true, pl:true, bs:true, cf:true })}>All</button>
                    <button
                      style={{ ...miniBtn, flex:1, background:T.navy, color:'#fff', borderColor:T.navy, opacity: selectedCount ? 1 : .5 }}
                      disabled={!selectedCount} onClick={doPrint}
                    >Print {selectedCount === SECTIONS.length ? 'all' : selectedCount}</button>
                  </div>
                </div>
              </>
            )}
          </div>

          <Link
            href="/help"
            title="Plain-English guide to reading these statements — what each one says and when to look at it"
            style={{ fontSize:11, color:'rgba(255,255,255,0.55)', textDecoration:'underline', whiteSpace:'nowrap' }}
          >
            How to read these
          </Link>
        </div>
      </div>

      <DisclosureBanner />

      {SECTIONS.map(s => (
        <div
          key={s.key} id={s.key} className="fs-section"
          data-print={printSel[s.key] ? '1' : '0'}
          ref={el => { refs.current[s.key] = el }}
          style={{ scrollMarginTop: barH + 6 }}
        >
          <s.Comp clientId={clientId} data={data} shared={shared} csvSink={csvSink} />
        </div>
      ))}
    </div>
  )
}

const barBtn = {
  padding:'3px 11px', borderRadius:5, fontSize:11, cursor:'pointer', whiteSpace:'nowrap',
  border:'1px solid rgba(255,255,255,0.25)', background:'transparent', color:'rgba(255,255,255,0.85)',
}
const barBtnOn = { background:'#fff', color:T.navy, fontWeight:600, borderColor:'#fff' }
const miniBtn = {
  padding:'4px 10px', fontSize:11, borderRadius:5, cursor:'pointer', whiteSpace:'nowrap',
  border:`1px solid ${T.border}`, background:'#fff', color:T.charcoal,
}
