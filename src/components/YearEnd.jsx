import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { supabase, fetchAll } from '../lib/supabase'
import { fetchSectionMap } from '../lib/chartOfAccounts'
import { buildMonthlyPL, computeYearEndProjection } from '../lib/insights'
import { T, MON, fmt, fmt2 } from '../lib/theme'
import InfoTip from './InfoTip'

// Where the year lands, and a bundle to hand the accountant. The projection
// itself is computeYearEndProjection — this page is presentation plus export.

const BASIS_COPY = {
  seasonal: 'Remaining months follow last year’s shape, scaled by this year’s growth.',
  runrate:  'Remaining months repeat this year’s average — there’s no comparable prior year to shape them.',
  mixed:    'Some remaining months follow last year’s shape; the rest repeat this year’s average.',
}

const CONFIDENCE_COPY = {
  high:   'Several months banked and a comparable prior year — this is a reasonable estimate.',
  medium: 'Only a few months banked. Treat the projection as a direction, not a number.',
  low:    'Very little banked yet. The projection is close to a guess.',
}

const csvEscape = v => `"${String(v ?? '').replace(/"/g, '""')}"`
const download = (name, lines) => {
  const blob = new Blob([lines.map(r => r.map(csvEscape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

export default function YearEnd({ clientId }) {
  const [txns,       setTxns]       = useState([])
  const [sectionMap, setSectionMap] = useState({})
  const [year,       setYear]       = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const [rows, coa] = await Promise.all([
          fetchAll(() => supabase.from('bank_transactions')
            .select('transaction_date, amount, category')
            .eq('client_id', clientId).not('category', 'is', null).neq('category', '')
            .order('transaction_date').order('id')),
          fetchSectionMap(clientId),
        ])
        if (cancelled) return
        setTxns(rows); setSectionMap(coa.map)
        const yrs = [...new Set(rows.map(t => +(t.transaction_date || '').slice(0, 4)).filter(Boolean))].sort()
        setYear(y => y ?? yrs[yrs.length - 1] ?? null)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [clientId])

  const monthlyPL = useMemo(() => buildMonthlyPL({ txns, sectionMap }), [txns, sectionMap])
  const years = useMemo(() => [...new Set(monthlyPL.map(r => r.year))].sort(), [monthlyPL])
  const projection = useMemo(() => computeYearEndProjection({ monthlyPL, year }), [monthlyPL, year])

  // A settled year: no projection, just what happened.
  const actualRows = useMemo(() => monthlyPL.filter(r => r.year === year), [monthlyPL, year])
  const actualTotal = useMemo(() => actualRows.reduce((a, r) => ({
    revenue: a.revenue + r.revenue, cogs: a.cogs + r.cogs,
    grossProfit: a.grossProfit + r.grossProfit, totalOpex: a.totalOpex + r.totalOpex,
    netProfit: a.netProfit + r.netProfit,
  }), { revenue: 0, cogs: 0, grossProfit: 0, totalOpex: 0, netProfit: 0 }), [actualRows])

  const rows = projection ? projection.monthly : actualRows.map(r => ({ ...r, projected: false }))
  const total = projection ? projection.yearEnd : actualTotal

  const exportPack = () => {
    const head = ['Month', 'Basis', 'Revenue', 'COGS', 'Gross Profit', 'Operating Expenses', 'Net Profit']
    const body = rows.map(r => [
      `${MON[r.month]} ${year}`,
      r.projected ? (r.basis === 'seasonal' ? 'projected (seasonal)' : 'projected (run rate)') : 'actual',
      r.revenue.toFixed(2), r.cogs.toFixed(2), r.grossProfit.toFixed(2),
      r.totalOpex.toFixed(2), r.netProfit.toFixed(2),
    ])
    const totalRow = ['TOTAL', projection ? 'actual + projected' : 'actual',
      total.revenue.toFixed(2), total.cogs.toFixed(2), total.grossProfit.toFixed(2),
      total.totalOpex.toFixed(2), total.netProfit.toFixed(2)]

    // Category detail, so the accountant can trace any line back to accounts.
    const byCat = {}
    txns.forEach(t => {
      if (!(t.transaction_date || '').startsWith(String(year))) return
      const sec = sectionMap[t.category] ?? 'Operating Expenses'
      const k = `${sec}||${t.category}`
      byCat[k] = (byCat[k] ?? 0) + (Number(t.amount) || 0)
    })
    const detail = [['Section', 'Account', `${year} Total`],
      ...Object.entries(byCat).sort().map(([k, v]) => [...k.split('||'), v.toFixed(2)])]

    download(`SCS-year-end-${year}.csv`, [head, ...body, totalRow])
    download(`SCS-account-detail-${year}.csv`, detail)
  }

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:300, background:T.page }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={{ width:28, height:28, border:`2px solid ${T.border}`, borderTopColor:T.navy, borderRadius:'50%', animation:'spin .7s linear infinite' }} />
    </div>
  )

  return (
    <div style={{ background:T.page, minHeight:'100%', fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme:'light' }}>
      <style>{`@media print { aside, .ye-controls { display:none !important } body { background:#fff !important } }`}</style>

      <header style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'14px 28px', background:T.card, borderBottom:`1px solid ${T.border}`, flexWrap:'wrap', gap:10 }}>
        <div>
          <h2 style={{ fontSize:14, fontWeight:600, color:T.navy, margin:'0 0 2px', display:'flex', alignItems:'center', gap:6 }}>
            Year-End
            <InfoTip title="Year-End">
              Banked months plus a projection for the ones still to come, and a CSV bundle for
              your accountant. Projected months are always labelled — nothing here pretends a
              forecast is a fact.
            </InfoTip>
          </h2>
          <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:0 }}>
            {year} · {projection
              ? `${projection.actualMonths.length} months banked, ${projection.projectedMonths.length} projected`
              : `${actualRows.length} months banked`}
          </p>
        </div>
        <div className="ye-controls" style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          <button style={btnSec} onClick={exportPack} disabled={!rows.length}>↓ Export pack</button>
          <button style={btnSec} onClick={() => window.print()} disabled={!rows.length}>🖨 Print / PDF</button>
        </div>
      </header>

      <div style={{ padding:'20px 28px 48px', maxWidth:1000 }}>
        {error && (
          <div style={{ background:'#FDE8E8', border:'1px solid #F5C2C2', borderRadius:6, padding:'10px 14px', fontSize:11.5, color:'#991B1B', marginBottom:14 }}>
            Failed to load: {error}
          </div>
        )}

        {years.length > 1 && (
          <div className="ye-controls" style={{ display:'flex', gap:4, marginBottom:16 }}>
            {years.map(y => (
              <button key={y} onClick={() => setYear(y)} style={{
                padding:'5px 14px', borderRadius:5, fontSize:11, cursor:'pointer',
                border:`1px solid ${year === y ? T.navy : T.border}`,
                background: year === y ? T.navy : '#fff',
                color: year === y ? '#fff' : T.charcoal, fontWeight: year === y ? 600 : 400,
              }}>{y}</button>
            ))}
          </div>
        )}

        {!rows.length ? (
          <p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:'48px 0' }}>
            No categorized transactions for {year}.
          </p>
        ) : (
          <>
            {/* Missing months are an import gap, not a forecast */}
            {projection?.gapMonths?.length > 0 && (
              <div style={{ background:'#FEF9EC', border:'1px solid #F5E3B8', borderRadius:7, padding:'11px 15px', marginBottom:14, fontSize:11.5, color:'#92400E', lineHeight:1.6 }}>
                <strong>{projection.gapMonths.map(m => MON[m]).join(', ')}</strong>{' '}
                {projection.gapMonths.length === 1 ? 'has' : 'have'} already happened but{' '}
                {projection.gapMonths.length === 1 ? 'has' : 'have'} no data — {projection.gapMonths.length === 1 ? 'it is' : 'they are'} being
                projected rather than counted. <Link href="/transactions" style={{ color:'#92400E' }}>Import the missing bank activity</Link> for a real number.
              </div>
            )}

            {/* Totals */}
            <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:16 }}>
              <Kpi label={projection ? `${year} Revenue (projected)` : `${year} Revenue`} value={fmt(total.revenue)} color={T.steel} />
              <Kpi label="Gross Profit" value={fmt(total.grossProfit)} color={T.gold}
                sub={total.revenue > 0 ? `${(total.grossProfit / total.revenue * 100).toFixed(1)}% margin` : undefined} />
              <Kpi label="Operating Expenses" value={fmt(total.totalOpex)} color={T.charcoal} />
              <Kpi label="Net Profit" value={fmt(total.netProfit)} color={total.netProfit >= 0 ? T.success : T.danger} />
              {projection?.prevTotal && (
                <Kpi label={`vs ${projection.prevYear}`} color={T.navy}
                  value={projection.revenueGrowthPct != null ? `${projection.revenueGrowthPct >= 0 ? '+' : ''}${projection.revenueGrowthPct.toFixed(1)}%` : '—'}
                  sub={`${fmt(projection.prevTotal.revenue)} over ${projection.prevTotal.months} months`} />
              )}
            </div>

            {projection && (
              <p style={{ fontSize:11, color:'rgba(74,74,74,0.7)', margin:'0 0 14px', lineHeight:1.65 }}>
                <strong style={{ color: projection.confidence === 'high' ? T.success : projection.confidence === 'medium' ? T.amber : T.danger }}>
                  {projection.confidence} confidence.
                </strong>{' '}
                {CONFIDENCE_COPY[projection.confidence]} {BASIS_COPY[projection.basis]}
              </p>
            )}

            {/* Monthly table */}
            <div style={{ overflowX:'auto', background:T.card, border:`1px solid ${T.border}`, borderRadius:7 }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11.5 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign:'left' }}>Month</th>
                    {['Revenue', 'COGS', 'Gross Profit', 'Op. Expenses', 'Net Profit'].map(h => (
                      <th key={h} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.month} style={{ borderTop:`1px solid ${T.border}`, background: r.projected ? '#FBFAF7' : 'transparent' }}>
                      <td style={{ padding:'6px 12px', color:T.charcoal, whiteSpace:'nowrap' }}>
                        {MON[r.month]}
                        {r.projected && (
                          <span title={r.basis === 'seasonal' ? "Shaped on last year's same month" : "This year's monthly average"}
                            style={{ marginLeft:7, fontSize:9, fontWeight:700, color:'#7A6829', background:'#FBF6E7', borderRadius:3, padding:'1px 6px', textTransform:'uppercase', letterSpacing:'.04em', cursor:'help' }}>
                            projected
                          </span>
                        )}
                      </td>
                      <td style={num}>{fmt2(r.revenue)}</td>
                      <td style={num}>{fmt2(r.cogs)}</td>
                      <td style={num}>{fmt2(r.grossProfit)}</td>
                      <td style={num}>{fmt2(r.totalOpex)}</td>
                      <td style={{ ...num, fontWeight:600, color: r.netProfit < 0 ? T.danger : T.navy }}>{fmt2(r.netProfit)}</td>
                    </tr>
                  ))}
                  <tr style={{ background:T.navy }}>
                    <td style={{ padding:'7px 12px', color:'#fff', fontWeight:700 }}>
                      {projection ? 'PROJECTED YEAR-END' : `${year} TOTAL`}
                    </td>
                    {['revenue', 'cogs', 'grossProfit', 'totalOpex'].map(k => (
                      <td key={k} style={{ ...num, color:'#fff', fontWeight:600 }}>{fmt2(total[k])}</td>
                    ))}
                    <td style={{ ...num, color: total.netProfit < 0 ? '#FCA5A5' : '#A7F3D0', fontWeight:700 }}>{fmt2(total.netProfit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p style={{ fontSize:10.5, color:'rgba(74,74,74,0.55)', marginTop:10, lineHeight:1.6 }}>
              COGS and Operating Expenses are shown as money spent. Gross Profit and Net Profit are
              derived from the other columns, so a projected month still adds up the way a real one does.
              Balance-sheet movements — inventory purchases, card payments, owner’s draw — are excluded.
              {' '}Export writes two CSVs: the monthly summary above and per-account detail for {year}.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, color }) {
  return (
    <div style={{ flex:'1 1 160px', minWidth:150, background:T.card, border:`1px solid ${T.border}`, borderTop:`3px solid ${color}`, borderRadius:7, padding:'12px 14px' }}>
      <div style={{ fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.07em', marginBottom:5 }}>{label}</div>
      <div style={{ fontSize:20, fontWeight:600, color:T.navy }}>{value}</div>
      {sub && <div style={{ fontSize:10, color:'rgba(74,74,74,0.6)', marginTop:3 }}>{sub}</div>}
    </div>
  )
}

const th  = { padding:'8px 12px', background:T.page, fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.06em', whiteSpace:'nowrap', textAlign:'right', borderBottom:`2px solid ${T.border}` }
const num = { padding:'6px 12px', textAlign:'right', fontVariantNumeric:'tabular-nums', color:T.charcoal, whiteSpace:'nowrap' }
const btnSec = { padding:'6px 14px', background:'#fff', color:T.charcoal, border:`1px solid ${T.border}`, borderRadius:5, fontSize:11, fontWeight:500, cursor:'pointer' }
