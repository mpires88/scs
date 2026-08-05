'use client'

// Balance Sheet — point-in-time balances at each month end of the selected
// year, assembled by lib/balanceSheet.js from the full transaction ledger
// (including uncategorized rows, so the sheet always balances).

import { useState, useEffect, useMemo, Fragment } from 'react'
import { supabase, fetchAll } from '../lib/supabase'
import { fetchAccounts } from '../lib/chartOfAccounts'
import { getSetting } from '../lib/settings'
import { buildBalanceSheet, balanceSheetYears } from '../lib/balanceSheet'
import { groupRowsByParent } from '../lib/plGrouping'
import { T, MON, fmtYm, STMT } from '../lib/theme'

const fmtCell = n => {
  if (n == null || n === 0) return '—'
  const neg = n < 0
  const str = Math.abs(Math.round(n)).toLocaleString()
  return neg ? `(${str})` : str
}

// `headerLeft` lets the combined Financial Statements page put its own title and
// tab switcher where the standalone title sits, so the two share one header
// bar instead of stacking a page header above a statement header.
// `shared` lets the combined page drive year / period / hide-zero across all
// three statements at once — those controls hide here when it does. `data` lets
// it read the ledger once and hand it down instead of each statement fetching
// the same rows again.
export default function ReportsBS({ clientId, headerLeft = null, shared = null, data = null, csvSink = null }) {
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
  const [periodLocal,   setPeriod]   = useState('monthly')  // 'monthly' | 'yearly'
  const year     = shared ? shared.year     : yearLocal
  const hideZero = shared ? shared.hideZero : hideZeroLocal
  const period   = shared ? shared.period   : periodLocal

  useEffect(() => {
    if (data) return   // the combined page supplied the ledger
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        // No category filter: uncategorized rows are still cash movements.
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
        const yrs = balanceSheetYears(rows)
        setYear(yrs[yrs.length - 1] ?? null)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [clientId, data])

  const years = useMemo(() => balanceSheetYears(txns), [txns])

  // Monthly: one sheet, a column per month end. Yearly: build a sheet per year
  // and keep only its final column, so each year shows its closing balance.
  // Reuses buildBalanceSheet rather than re-deriving balances a second way.
  const bs = useMemo(() => {
    if (period === 'monthly') return buildBalanceSheet({ txns, accounts, year, registry, columns: shared?.columns })

    const built = years
      .map(y => [y, buildBalanceSheet({ txns, accounts, year: y, registry })])
      .filter(([, b]) => b)
    if (!built.length) return null

    // All dates: every month of every year side by side — each year's sheet
    // contributes its monthly columns under 'YYYY-MM' keys. A row absent from
    // a year has a genuinely zero balance there (the builder carries balances
    // forward and drops rows only when they zero out), so ?? 0 is truthful.
    if (period === 'all') {
      const ymKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`
      const cols = built.flatMap(([y, b]) => b.months.map(m => ymKey(y, m)))
      const lastCol = cols[cols.length - 1]
      const secMap = new Map()
      ;[...built].reverse().forEach(([y, b]) => {
        b.sections.forEach(sec => {
          if (!secMap.has(sec.section)) secMap.set(sec.section, { section: sec.section, rowMap: new Map(), totals: {} })
          const s = secMap.get(sec.section)
          sec.rows.forEach(r => {
            if (!s.rowMap.has(r.name)) s.rowMap.set(r.name, { ...r, byMonth: {}, total: 0 })
            const row = s.rowMap.get(r.name)
            b.months.forEach(m => { row.byMonth[ymKey(y, m)] = r.byMonth[m] ?? 0 })
          })
          b.months.forEach(m => { s.totals[ymKey(y, m)] = sec.totals[m] ?? 0 })
        })
      })
      const sections = [...secMap.values()].map(s => ({
        section: s.section,
        rows: [...s.rowMap.values()].map(r => ({ ...r, total: r.byMonth[lastCol] ?? 0 })),
        totals: s.totals,
        total: s.totals[lastCol] ?? 0,
      }))
      const computed = {}
      ;['assets', 'liabilities', 'equity', 'liabEquity'].forEach(k => {
        const byMonth = {}
        built.forEach(([y, b]) => b.months.forEach(m => { byMonth[ymKey(y, m)] = b.computed[k].byMonth[m] ?? 0 }))
        computed[k] = { byMonth, total: byMonth[lastCol] ?? 0 }
      })
      return {
        months: cols, sections, computed, allDates: true,
        hasUncat: built.some(([, b]) => b.hasUncat),
        unmappedLabels: [...new Set(built.flatMap(([, b]) => b.unmappedLabels))],
      }
    }

    const cols = built.map(([y]) => y)
    const lastCol = cols[cols.length - 1]

    // Most recent year first so it sets section and row order (it has the most
    // lines); years that carry a line no longer present get appended after.
    const secMap = new Map()
    ;[...built].reverse().forEach(([y, b]) => {
      const endM = b.months[b.months.length - 1]
      b.sections.forEach(sec => {
        if (!secMap.has(sec.section)) secMap.set(sec.section, { section: sec.section, rowMap: new Map(), totals: {} })
        const s = secMap.get(sec.section)
        sec.rows.forEach(r => {
          if (!s.rowMap.has(r.name)) s.rowMap.set(r.name, { ...r, byMonth: {}, total: 0 })
          s.rowMap.get(r.name).byMonth[y] = r.byMonth[endM] ?? 0
        })
        s.totals[y] = sec.totals[endM] ?? 0
      })
    })
    const sections = [...secMap.values()].map(s => ({
      section: s.section,
      rows: [...s.rowMap.values()].map(r => ({ ...r, total: r.byMonth[lastCol] ?? 0 })),
      totals: s.totals,
      total: s.totals[lastCol] ?? 0,
    }))

    const computed = {}
    ;['assets', 'liabilities', 'equity', 'liabEquity'].forEach(k => {
      const byMonth = {}
      built.forEach(([y, b]) => { byMonth[y] = b.computed[k].byMonth[b.months[b.months.length - 1]] ?? 0 })
      computed[k] = { byMonth, total: byMonth[lastCol] ?? 0 }
    })

    const last = built[built.length - 1][1]
    return {
      months: cols, sections, computed, yearly: true,
      hasUncat: built.some(([, b]) => b.hasUncat),
      unmappedLabels: [...new Set(built.flatMap(([, b]) => b.unmappedLabels))],
      lastYear: last,
    }
  }, [txns, accounts, year, registry, period, years, shared?.columns])

  const entriesFor = useMemo(() => {
    if (!bs) return {}
    const cols = bs.months
    const flat = (by, tot) => cols.every(m => Math.abs(by[m] ?? 0) < 0.005) && Math.abs(tot ?? 0) < 0.005
    const zeroRow = r => flat(r.byMonth, r.total)
    const map = {}
    bs.sections.forEach(sec => {
      let entries = groupRowsByParent(sec.rows, accounts, sec.section)
      if (hideZero) {
        entries = entries.flatMap(en => {
          if (en.kind === 'row') return zeroRow(en) ? [] : [en]
          const children = en.children.filter(r => !zeroRow(r))
          const own = en.own && !zeroRow(en.own) ? en.own : null
          if (!children.length && !own && flat(en.totals, en.total)) return []
          return [{ ...en, children, own }]
        })
      }
      map[sec.section] = entries
    })
    return map
  }, [bs, accounts, hideZero])

  const buildCsvLines = () => {
    if (!bs) return null
    const { months, sections, computed } = bs
    const lines = [['Account', ...months.map(m => bs.yearly ? String(m) : bs.allDates ? fmtYm(m) : `${MON[m]} ${year}`)]]
    const rowLine = (label, r) => lines.push([label, ...months.map(m => (r.byMonth[m] ?? 0).toFixed(2))])
    sections.forEach(sec => {
      if (!entriesFor[sec.section]?.length) return
      lines.push([sec.section])
      entriesFor[sec.section].forEach(en => {
        if (en.kind === 'row') { rowLine(`  ${en.name}`, en); return }
        lines.push([`  ${en.name}`])
        en.children.forEach(r => rowLine(`    ${r.name}`, r))
        if (en.own) rowLine(`    ${en.name} (other)`, en.own)
        lines.push([`  Total ${en.name}`, ...months.map(m => (en.totals[m] ?? 0).toFixed(2))])
      })
      lines.push([`Total ${sec.section}`, ...months.map(m => (sec.totals[m] ?? 0).toFixed(2))])
      if (sec.section === 'Non-Current Assets')      lines.push(['TOTAL ASSETS',      ...months.map(m => computed.assets.byMonth[m].toFixed(2))])
      if (sec.section === 'Non-Current Liabilities') lines.push(['TOTAL LIABILITIES', ...months.map(m => computed.liabilities.byMonth[m].toFixed(2))])
      if (sec.section === 'Equity')                  lines.push(['TOTAL EQUITY',      ...months.map(m => computed.equity.byMonth[m].toFixed(2))])
    })
    lines.push(['LIABILITIES + EQUITY', ...months.map(m => computed.liabEquity.byMonth[m].toFixed(2))])
    return lines
  }

  // The combined Financial Statements page pulls lines through this sink so its
  // Export picker can bundle several statements into one file. Registered every
  // render so the closure always sees current data.
  // eslint-disable-next-line react-hooks/immutability -- csvSink is a ref; mutating .current is its contract
  useEffect(() => { if (csvSink) csvSink.current.bs = buildCsvLines })

  const exportCSV = () => {
    const lines = buildCsvLines()
    if (!lines) return
    const csv = lines.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `SCS-BalanceSheet-${bs.yearly ? 'all-years' : year}.csv`
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
          aside, .bs-controls { display: none !important; }
          body { background: #fff !important; }
        }
      `}</style>

      <header style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'8px 28px', background:T.card, borderBottom:`1px solid ${T.border}`, flexWrap:'wrap', gap:10 }}>
        {headerLeft ?? (
          <div>
            <h2 style={{ fontSize:12, fontWeight:600, color:T.navy, margin:'0 0 1px' }}>Balance Sheet</h2>
            <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:0 }}>
              Sports Card Station {bs?.yearly ? '· all years' : (year ? `· ${year}` : '')} · balances as of each {bs?.yearly ? 'year' : 'month'} end
            </p>
          </div>
        )}
        <div className="bs-controls" style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          {!shared && (<>
          <label
            style={{ display:'flex', alignItems:'center', gap:6, fontSize:11, color:T.charcoal, cursor:'pointer', userSelect:'none' }}
            title="Hide any line that is zero in every column. Section and computed totals are unchanged."
          >
            <input type="checkbox" checked={hideZero} onChange={e => setHideZero(e.target.checked)} />
            Hide $0 rows
          </label>
          <select
            style={{ fontSize:11, padding:'4px 8px', border:`1px solid ${T.border}`, borderRadius:5, color:T.charcoal, background:'#fff', outline:'none' }}
            value={period} onChange={e => setPeriod(e.target.value)}
            title="Monthly shows the selected year's month-end balances; Yearly shows each year's closing balance side by side."
          >
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly — all years</option>
          </select>
          <button style={btn.sec} onClick={exportCSV} disabled={!bs}>↓ Export CSV</button>
          <button style={btn.sec} onClick={() => window.print()} disabled={!bs}>🖨 Print / PDF</button>
          </>)}
        </div>
      </header>

      <div style={{ padding:'20px 28px' }}>

        {!shared && years.length > 1 && !bs?.yearly && (
          <div className="bs-controls" style={{ display:'flex', gap:4, marginBottom:16 }}>
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

        {/* The table shrinks to fit up to the full width, then scrolls — at
            width:100% it spreads its slack across the columns and pads every
            figure out. */}
        {!bs ? (
          <p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:'48px 0' }}>
            No transactions yet — import bank activity to build the balance sheet.
          </p>
        ) : (
          <div className="stmt-scroll" style={{ display:'inline-block', verticalAlign:'top', maxWidth:'100%', overflowX:'auto', background:T.card, border:`1px solid ${T.border}`, borderRadius:7 }}>
            <table style={{ borderCollapse:'collapse', width:'auto', tableLayout:'fixed', fontSize:11.5 }}>
              <thead>
                <tr>
                  <th style={{ ...cell.th, textAlign:'left', width:STMT.label, minWidth:STMT.label, maxWidth:STMT.label, position:'sticky', left:0, background:T.page, zIndex:1 }}>Account</th>
                  {bs.months.map(m => (
                    <th key={m} style={{ ...cell.th, textAlign:'right', width: bs.yearly ? STMT.numWide : STMT.num, minWidth: bs.yearly ? STMT.numWide : STMT.num }}>
                      {bs.yearly ? m : bs.allDates ? fmtYm(m) : <>{MON[m]} {String(year).slice(2)}</>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bs.sections.map(sec => {
                  const computedAfter = {
                    'Non-Current Assets':      ['TOTAL ASSETS',      bs.computed.assets],
                    'Non-Current Liabilities': ['TOTAL LIABILITIES', bs.computed.liabilities],
                    'Equity':                  ['TOTAL EQUITY',      bs.computed.equity],
                  }[sec.section]
                  return (
                    <Fragment key={sec.section}>
                      {entriesFor[sec.section].length > 0 && (
                        <>
                          <tr>
                            <td colSpan={999} style={{ padding:'7px 8px 3px', fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.07em', background:T.card }}>
                              {sec.section}
                            </td>
                          </tr>
                          {entriesFor[sec.section].map(en => {
                            if (en.kind === 'row') return <BsRow key={en.name} r={en} months={bs.months} />
                            return (
                              <Fragment key={en.name}>
                                <tr style={{ borderBottom:`1px solid #F0EEE9` }}>
                                  <td style={{ ...cell.td, paddingLeft:16, fontWeight:600, position:'sticky', left:0, background:T.card }}>{en.name}</td>
                                  {bs.months.map(m => <td key={m} style={cell.num}></td>)}
                                </tr>
                                {en.children.map(r => <BsRow key={r.name} r={r} months={bs.months} indent />)}
                                {en.own && <BsRow key={`${en.name} (other)`} r={en.own} label={`${en.name} (other)`} months={bs.months} indent />}
                                <tr style={{ borderBottom:`1px solid #F0EEE9` }}>
                                  <td style={{ ...cell.td, paddingLeft:16, fontWeight:600, color:T.navy, position:'sticky', left:0, background:T.card }}>Total {en.name}</td>
                                  {bs.months.map(m => (
                                    <td key={m} style={{ ...cell.num, fontWeight:600 }}>{fmtCell(en.totals[m] ?? 0)}</td>
                                  ))}
                                </tr>
                              </Fragment>
                            )
                          })}
                          <tr style={{ background:T.page, borderBottom:`1px solid ${T.border}` }}>
                            <td style={{ ...cell.td, fontWeight:600, color:T.navy, position:'sticky', left:0, background:T.page }}>Total {sec.section}</td>
                            {bs.months.map(m => (
                              <td key={m} style={{ ...cell.num, fontWeight:600, color:T.navy }}>{fmtCell(sec.totals[m])}</td>
                            ))}
                          </tr>
                        </>
                      )}
                      {computedAfter && (
                        <tr style={{ background:'#EBF1F7', borderBottom:`2px solid #B8CDE0` }}>
                          <td style={{ ...cell.td, fontWeight:700, color:T.navy, position:'sticky', left:0, background:'#EBF1F7' }}>{computedAfter[0]}</td>
                          {bs.months.map(m => {
                            const v = computedAfter[1].byMonth[m]
                            return <td key={m} style={{ ...cell.num, fontWeight:600, color: v < 0 ? T.danger : T.navy }}>{fmtCell(v)}</td>
                          })}
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
                <tr style={{ background:T.navy }}>
                  <td style={{ ...cell.td, position:'sticky', left:0, background:T.navy, color:'#fff', fontWeight:700, fontSize:11.5 }}>LIABILITIES + EQUITY</td>
                  {bs.months.map(m => {
                    const v = bs.computed.liabEquity.byMonth[m]
                    return <td key={m} style={{ ...cell.num, color:'#A7F3D0', fontWeight:600 }}>{fmtCell(v)}</td>
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {bs && (
          <p style={{ fontSize:10.5, color:'rgba(74,74,74,0.55)', marginTop:10, lineHeight:1.6 }}>
            Balances are as of each month end, accumulated from the full transaction history.
            Bank and card accounts come from the account registry (Chart of Accounts page); their
            balances fold in every mapped feed label plus bound transfer categories. Retained
            Earnings is cumulative net income from the P&amp;L. Total Assets equals Liabilities +
            Equity by construction.
            {bs.hasUncat && ' ⚠ Uncategorized transactions are shown as their own equity line — categorize them to clear it.'}
            {bs.unmappedLabels.length > 0 && ` ⚠ Unmapped account label${bs.unmappedLabels.length !== 1 ? 's' : ''}: ${bs.unmappedLabels.join(', ')} — map ${bs.unmappedLabels.length !== 1 ? 'them' : 'it'} on the Chart of Accounts page so the lines merge correctly.`}
          </p>
        )}
      </div>
    </div>
  )
}

function BsRow({ r, label, indent = false, months }) {
  return (
    <tr style={{ borderBottom:`1px solid #F0EEE9` }}>
      <td title={label ?? r.name} style={{
        ...cell.td, paddingLeft: indent ? 26 : 16, position:'sticky', left:0, background:T.card,
        ...(r.warn ? { color:'#92400E', fontWeight:600 } : {}),
        ...(r.derived && !r.warn && !r.unmapped ? { fontStyle:'italic' } : {}),
      }}>
        {label ?? r.name}
        {r.unmapped && (
          <span title="This feed label isn't in the account registry — map it on the Chart of Accounts page."
            style={{ marginLeft:8, fontSize:9.5, fontWeight:700, color:'#92400E', background:'#FEF3C7', borderRadius:3, padding:'1px 7px', whiteSpace:'nowrap' }}>
            ⚠ unmapped
          </span>
        )}
      </td>
      {months.map(m => (
        <td key={m} style={{ ...cell.num, ...(r.warn ? { color:'#92400E' } : {}) }}>{fmtCell(r.byMonth[m] ?? 0)}</td>
      ))}
    </tr>
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
