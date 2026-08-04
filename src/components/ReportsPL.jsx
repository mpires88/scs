import { useState, useEffect, useMemo, useCallback, Fragment } from 'react'
import { supabase, fetchAll } from '../lib/supabase'
import { PL_SECTIONS, fetchAccounts } from '../lib/chartOfAccounts'
import { groupRowsByParent } from '../lib/plGrouping'
import { getSetting, setSetting } from '../lib/settings'
import { T, MON } from '../lib/theme'

// Expense-like sections are displayed as positive "money spent" numbers.
const EXPENSE_SECTIONS = new Set(['Deductions to Income', 'Cost of Goods Sold', 'Operating Expenses', 'Non-Operating Expenses'])

const fmtCell = n => {
  if (n == null || n === 0) return '—'
  const neg = n < 0
  const str = Math.abs(Math.round(n)).toLocaleString()
  return neg ? `(${str})` : str
}

export default function ReportsPL({ clientId }) {
  const [txns,       setTxns]       = useState([])
  const [accounts,   setAccounts]   = useState([])
  const [budgets,    setBudgets]    = useState({})     // account → monthly budget
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [year,       setYear]       = useState(null)
  const [showBudget, setShowBudget] = useState(false)
  const [showAll,    setShowAll]    = useState(true)
  const [drafts,     setDrafts]     = useState({})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const [rows, coa, budgetVal] = await Promise.all([
          fetchAll(() => supabase.from('bank_transactions')
            .select('transaction_date, amount, category')
            .eq('client_id', clientId).not('category', 'is', null).neq('category', '')
            .order('transaction_date').order('id')),
          fetchAccounts(clientId),
          getSetting(clientId, 'budgets', {}).catch(() => ({})),
        ])
        if (cancelled) return
        setTxns(rows)
        setAccounts(coa.accounts)
        setBudgets(budgetVal || {})
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

  const sectionMap = useMemo(() => {
    const map = {}
    accounts.forEach(a => { map[a.name] = a.pl_section })
    return map
  }, [accounts])

  // ── Build statement: section → account → month sums ────────────────────────

  const statement = useMemo(() => {
    if (!year) return null

    const months = [...new Set(
      txns.filter(t => (t.transaction_date || '').startsWith(String(year)))
          .map(t => +(t.transaction_date || '').slice(5, 7))
    )].sort((a, b) => a - b)
    if (!months.length) return null

    // account → { [month]: sum }
    const acctMonth = {}
    txns.forEach(t => {
      if (!(t.transaction_date || '').startsWith(String(year))) return
      const m = +(t.transaction_date || '').slice(5, 7)
      if (!acctMonth[t.category]) acctMonth[t.category] = {}
      acctMonth[t.category][m] = (acctMonth[t.category][m] ?? 0) + (Number(t.amount) || 0)
    })

    // Section rows, in chart-of-accounts order. With "all accounts" on, every
    // account in the chart appears even with no activity — otherwise a whole
    // section can vanish (Cost of Goods Sold does exactly that here) while the
    // computed line that depends on it still prints.
    const acctOrder = new Map(accounts.map((a, i) => [a.name, i]))
    const secOfAcct = new Map(accounts.map(a => [a.name, a.pl_section]))
    // Parents are represented by their group label + subtotal, so an empty
    // parent needs no row of its own — it would render as all-dashes "(other)".
    const hasChildren = new Set(
      accounts.filter(a => a.parent && secOfAcct.get(a.parent) === a.pl_section).map(a => a.parent)
    )

    const sections = PL_SECTIONS.map(section => {
      const names = Object.keys(acctMonth)
        .filter(name => (sectionMap[name] ?? 'Operating Expenses') === section)
      if (showAll) {
        accounts.forEach(a => {
          if (a.pl_section !== section) return
          if (acctMonth[a.name]) return          // already present with activity
          if (hasChildren.has(a.name)) return    // covered by its group label
          names.push(a.name)
        })
      }
      const rows = [...new Set(names)]
        .sort((a, b) => (acctOrder.get(a) ?? 1e9) - (acctOrder.get(b) ?? 1e9))
        .map(name => {
          const byMonth = acctMonth[name] ?? {}
          const total = months.reduce((s, m) => s + (byMonth[m] ?? 0), 0)
          return { name, byMonth, total }
        })
      const totals = {}
      months.forEach(m => { totals[m] = rows.reduce((s, r) => s + (r.byMonth[m] ?? 0), 0) })
      const total = rows.reduce((s, r) => s + r.total, 0)
      // Display entries: sub-accounts fold under their parent with a subtotal.
      // Section totals stay computed from the flat rows above.
      return { section, rows, entries: groupRowsByParent(rows, accounts, section), totals, total }
    })

    const secBy = name => sections.find(s => s.section === name)
    const combine = (names, m) => names.reduce((s, n) => s + (secBy(n)?.totals[m] ?? 0), 0)
    const combineTotal = names => names.reduce((s, n) => s + (secBy(n)?.total ?? 0), 0)

    // Computed lines (signed: positive = profit)
    const computed = {}
    const defs = [
      ['netRevenue',   ['Revenue', 'Deductions to Income']],
      ['grossProfit',  ['Revenue', 'Deductions to Income', 'Cost of Goods Sold']],
      ['opIncome',     ['Revenue', 'Deductions to Income', 'Cost of Goods Sold', 'Operating Expenses']],
      ['netIncome',    PL_SECTIONS],
    ]
    defs.forEach(([key, secs]) => {
      computed[key] = { byMonth: {}, total: combineTotal(secs) }
      months.forEach(m => { computed[key].byMonth[m] = combine(secs, m) })
    })

    return { year, months, sections, computed }
  }, [txns, sectionMap, accounts, year, showAll])

  // ── Budget helpers ─────────────────────────────────────────────────────────

  const saveBudget = useCallback(async (name, val) => {
    const next = { ...budgets }
    const n = parseFloat(String(val).replace(/[$,\s]/g, ''))
    if (val === '' || isNaN(n)) delete next[name]
    else next[name] = n
    setBudgets(next)
    try { await setSetting(clientId, 'budgets', next) } catch (e) { alert('Could not save budget: ' + e.message) }
  }, [clientId, budgets])

  // ── Export ─────────────────────────────────────────────────────────────────

  const exportCSV = () => {
    if (!statement) return
    const { months, sections, computed } = statement
    const head = ['Account', ...months.map(m => `${MON[m]} ${year}`), 'Total']
    const lines = [head]
    const displaySign = section => EXPENSE_SECTIONS.has(section) ? -1 : 1

    sections.forEach(sec => {
      if (sec.rows.length) {
        lines.push([sec.section])
        const sign = displaySign(sec.section)
        const rowLine = (label, r) =>
          lines.push([label, ...months.map(m => ((r.byMonth[m] ?? 0) * sign).toFixed(2)), (r.total * sign).toFixed(2)])
        sec.entries.forEach(en => {
          if (en.kind === 'row') { rowLine(`  ${en.name}`, en); return }
          lines.push([`  ${en.name}`])
          en.children.forEach(r => rowLine(`    ${r.name}`, r))
          if (en.own) rowLine(`    ${en.name} (other)`, en.own)
          lines.push([`  Total ${en.name}`, ...months.map(m => ((en.totals[m] ?? 0) * sign).toFixed(2)), (en.total * sign).toFixed(2)])
        })
        lines.push([`Total ${sec.section}`, ...months.map(m => (sec.totals[m] * sign).toFixed(2)), (sec.total * sign).toFixed(2)])
      }
      // Computed lines belong to the statement, not the section — emit them
      // even when the section itself has no activity
      if (sec.section === 'Deductions to Income')
        lines.push(['NET REVENUE', ...months.map(m => computed.netRevenue.byMonth[m].toFixed(2)), computed.netRevenue.total.toFixed(2)])
      if (sec.section === 'Cost of Goods Sold')
        lines.push(['GROSS PROFIT', ...months.map(m => computed.grossProfit.byMonth[m].toFixed(2)), computed.grossProfit.total.toFixed(2)])
      if (sec.section === 'Operating Expenses')
        lines.push(['OPERATING INCOME', ...months.map(m => computed.opIncome.byMonth[m].toFixed(2)), computed.opIncome.total.toFixed(2)])
    })
    lines.push(['NET INCOME', ...months.map(m => computed.netIncome.byMonth[m].toFixed(2)), computed.netIncome.total.toFixed(2)])

    const csv = lines.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `SCS-PL-${year}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

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
          aside, .pl-controls { display: none !important; }
          body { background: #fff !important; }
        }
      `}</style>

      <header style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'14px 28px', background:T.card, borderBottom:`1px solid ${T.border}`, flexWrap:'wrap', gap:10 }}>
        <div>
          <h2 style={{ fontSize:14, fontWeight:600, color:T.navy, margin:'0 0 2px' }}>Profit &amp; Loss Statement</h2>
          <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:0 }}>
            Sports Card Station {year ? `· ${year}` : ''} · built from categorized bank transactions
          </p>
        </div>
        <div className="pl-controls" style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          <label
            style={{ display:'flex', alignItems:'center', gap:6, fontSize:11, color:T.charcoal, cursor:'pointer', userSelect:'none' }}
            title="Show every account in your chart of accounts, including ones with no activity this year. Turn off for a compact statement to print or send."
          >
            <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
            All accounts
          </label>
          <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:11, color:T.charcoal, cursor:'pointer', userSelect:'none' }}>
            <input type="checkbox" checked={showBudget} onChange={e => setShowBudget(e.target.checked)} />
            Budget vs. actual
          </label>
          <button style={btn.sec} onClick={exportCSV} disabled={!statement}>↓ Export CSV</button>
          <button style={btn.sec} onClick={() => window.print()} disabled={!statement}>🖨 Print / PDF</button>
        </div>
      </header>

      <div style={{ padding:'20px 28px' }}>

        {/* Year tabs */}
        {years.length > 1 && (
          <div className="pl-controls" style={{ display:'flex', gap:4, marginBottom:16 }}>
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

        {!statement ? (
          <p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:'48px 0' }}>
            No categorized transactions yet — import and categorize bank activity to build the P&amp;L.
          </p>
        ) : (
          <div style={{ overflowX:'auto', background:T.card, border:`1px solid ${T.border}`, borderRadius:7 }}>
            <table style={{ borderCollapse:'collapse', width:'100%', fontSize:11.5 }}>
              <thead>
                <tr>
                  <th style={{ ...cell.th, textAlign:'left', minWidth:210, position:'sticky', left:0, background:T.page, zIndex:1 }}>Account</th>
                  {statement.months.map(m => (
                    <th key={m} style={{ ...cell.th, textAlign:'right', minWidth:72 }}>{MON[m]}</th>
                  ))}
                  <th style={{ ...cell.th, textAlign:'right', minWidth:84, borderLeft:`2px solid ${T.border}` }}>Total</th>
                  {showBudget && <>
                    <th style={{ ...cell.th, textAlign:'right', minWidth:84, borderLeft:`2px solid ${T.border}` }}>Budget/mo</th>
                    <th style={{ ...cell.th, textAlign:'right', minWidth:90 }}>Avg vs Budget</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {statement.sections.map(sec => {
                  const isExpense = EXPENSE_SECTIONS.has(sec.section)
                  const sign = isExpense ? -1 : 1
                  const computedAfter = {
                    'Deductions to Income': ['NET REVENUE',      statement.computed.netRevenue],
                    'Cost of Goods Sold':   ['GROSS PROFIT',     statement.computed.grossProfit],
                    'Operating Expenses':   ['OPERATING INCOME', statement.computed.opIncome],
                  }[sec.section]
                  return (
                    <Fragment key={sec.section}>
                      {sec.rows.length > 0 && (
                        <SectionRows
                          sec={sec} sign={sign} months={statement.months}
                          showBudget={showBudget} budgets={budgets} drafts={drafts} setDrafts={setDrafts} saveBudget={saveBudget}
                          isExpense={isExpense}
                        />
                      )}
                      {computedAfter && (
                        <ComputedRow label={computedAfter[0]} data={computedAfter[1]} months={statement.months} showBudget={showBudget} />
                      )}
                    </Fragment>
                  )
                })}
                {/* Net income */}
                <tr style={{ background:T.navy }}>
                  <td style={{ ...cell.td, position:'sticky', left:0, background:T.navy, color:'#fff', fontWeight:700, fontSize:11.5 }}>NET INCOME</td>
                  {statement.months.map(m => {
                    const v = statement.computed.netIncome.byMonth[m]
                    return <td key={m} style={{ ...cell.num, color: v < 0 ? '#FCA5A5' : '#A7F3D0', fontWeight:600 }}>{fmtCell(v)}</td>
                  })}
                  <td style={{ ...cell.num, borderLeft:`2px solid rgba(255,255,255,0.2)`, color: statement.computed.netIncome.total < 0 ? '#FCA5A5' : '#A7F3D0', fontWeight:700 }}>
                    {fmtCell(statement.computed.netIncome.total)}
                  </td>
                  {showBudget && <><td style={cell.num}></td><td style={cell.num}></td></>}
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {statement && (
          <p style={{ fontSize:10.5, color:'rgba(74,74,74,0.55)', marginTop:10, lineHeight:1.6 }}>
            Amounts in parentheses are negative. A dash means no activity. Expense sections show money
            spent as positive numbers; computed lines (Net Revenue, Gross Profit, Operating Income,
            Net Income) are signed.
            {showAll
              ? ' Every account in your chart of accounts is listed — untick “All accounts” for a compact statement.'
              : ' Only accounts with activity this year are listed — tick “All accounts” to see the full chart.'}
            {showBudget && ' Budgets are monthly targets — variance compares this year’s monthly average against them.'}
          </p>
        )}
      </div>
    </div>
  )
}

// One P&L section: header, account rows, subtotal.
function SectionRows({ sec, sign, months, showBudget, budgets, drafts, setDrafts, saveBudget, isExpense }) {
  const monthCount = months.length

  return (
    <>
      <tr>
        <td colSpan={999} style={{ padding:'9px 12px 4px', fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.07em', background:T.card }}>
          {sec.section}
        </td>
      </tr>
      {sec.entries.map(en => {
        const rowProps = { sign, months, monthCount, showBudget, budgets, drafts, setDrafts, saveBudget, isExpense }
        if (en.kind === 'row') return <AccountRow key={en.name} r={en} {...rowProps} />
        return (
          <Fragment key={en.name}>
            {/* Parent label — figures live on the children and the subtotal */}
            <tr style={{ borderBottom:`1px solid #F0EEE9` }}>
              <td style={{ ...cell.td, paddingLeft:22, fontWeight:600, position:'sticky', left:0, background:T.card }}>{en.name}</td>
              {months.map(m => <td key={m} style={cell.num}></td>)}
              <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}` }}></td>
              {showBudget && <><td style={{ ...cell.num, borderLeft:`2px solid ${T.border}` }}></td><td style={cell.num}></td></>}
            </tr>
            {en.children.map(r => <AccountRow key={r.name} r={r} indent {...rowProps} />)}
            {en.own && <AccountRow key={`${en.name} (other)`} r={en.own} label={`${en.name} (other)`} indent {...rowProps} />}
            <tr style={{ borderBottom:`1px solid #F0EEE9` }}>
              <td style={{ ...cell.td, paddingLeft:22, fontWeight:600, color:T.navy, position:'sticky', left:0, background:T.card }}>Total {en.name}</td>
              {months.map(m => (
                <td key={m} style={{ ...cell.num, fontWeight:600 }}>{fmtCell((en.totals[m] ?? 0) * sign)}</td>
              ))}
              <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}`, fontWeight:700 }}>{fmtCell(en.total * sign)}</td>
              {showBudget && <><td style={{ ...cell.num, borderLeft:`2px solid ${T.border}` }}></td><td style={cell.num}></td></>}
            </tr>
          </Fragment>
        )
      })}
      {/* Section subtotal */}
      <tr style={{ background:T.page, borderBottom:`1px solid ${T.border}` }}>
        <td style={{ ...cell.td, fontWeight:600, color:T.navy, position:'sticky', left:0, background:T.page }}>Total {sec.section}</td>
        {months.map(m => (
          <td key={m} style={{ ...cell.num, fontWeight:600, color:T.navy }}>{fmtCell(sec.totals[m] * sign)}</td>
        ))}
        <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}`, fontWeight:700, color:T.navy }}>{fmtCell(sec.total * sign)}</td>
        {showBudget && <><td style={cell.num}></td><td style={cell.num}></td></>}
      </tr>
    </>
  )
}

// One account line. `indent` marks a sub-account row nested under a parent;
// budgets stay keyed by the real account name even when the label is
// overridden (the parent's "(other)" row).
function AccountRow({ r, label, indent = false, sign, months, monthCount, showBudget, budgets, drafts, setDrafts, saveBudget, isExpense }) {
  const avg = (r.total * sign) / monthCount
  const budget = budgets[r.name]
  const variance = budget != null ? avg - budget : null
  // For expenses, over budget is bad; for revenue, under budget is bad
  const bad = variance != null && (isExpense ? variance > 0 : variance < 0)
  const draft = drafts[r.name]
  return (
    <tr style={{ borderBottom:`1px solid #F0EEE9` }}>
      <td style={{ ...cell.td, paddingLeft: indent ? 38 : 22, position:'sticky', left:0, background:T.card }}>{label ?? r.name}</td>
      {months.map(m => (
        <td key={m} style={cell.num}>{fmtCell((r.byMonth[m] ?? 0) * sign)}</td>
      ))}
      <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}`, fontWeight:600 }}>{fmtCell(r.total * sign)}</td>
      {showBudget && <>
        <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}` }}>
          <input
            style={{ width:70, padding:'2px 5px', border:`1px solid ${T.border}`, borderRadius:4, fontSize:10.5, textAlign:'right', outline:'none', background:'#fff' }}
            value={draft ?? (budget ?? '')}
            placeholder="—"
            onChange={e => setDrafts(p => ({ ...p, [r.name]: e.target.value }))}
            onBlur={() => {
              if (draft === undefined) return
              saveBudget(r.name, draft)
              setDrafts(p => { const c = { ...p }; delete c[r.name]; return c })
            }}
            onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </td>
        <td style={{ ...cell.num, color: variance == null ? '#c0bdb7' : bad ? T.danger : T.success, fontWeight: variance != null ? 600 : 400 }}>
          {variance == null ? '—' : `${variance > 0 ? '+' : ''}${Math.round(variance).toLocaleString()}`}
        </td>
      </>}
    </tr>
  )
}

// Computed statement line (Net Revenue, Gross Profit, Operating Income) —
// rendered even when the section it follows has no activity.
function ComputedRow({ label, data, months, showBudget }) {
  return (
    <tr style={{ background:'#EBF1F7', borderBottom:`2px solid #B8CDE0` }}>
      <td style={{ ...cell.td, fontWeight:700, color:T.navy, position:'sticky', left:0, background:'#EBF1F7' }}>{label}</td>
      {months.map(m => {
        const v = data.byMonth[m]
        return <td key={m} style={{ ...cell.num, fontWeight:600, color: v < 0 ? T.danger : T.navy }}>{fmtCell(v)}</td>
      })}
      <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}`, fontWeight:700, color: data.total < 0 ? T.danger : T.navy }}>
        {fmtCell(data.total)}
      </td>
      {showBudget && <><td style={cell.num}></td><td style={cell.num}></td></>}
    </tr>
  )
}

const cell = {
  th:  { padding:'8px 12px', background:T.page, fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.06em', whiteSpace:'nowrap', borderBottom:`2px solid ${T.border}` },
  td:  { padding:'5px 12px', fontSize:11.5, color:T.charcoal, whiteSpace:'nowrap' },
  num: { padding:'5px 12px', fontSize:11.5, color:T.charcoal, textAlign:'right', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' },
}

const btn = {
  sec: { padding:'6px 14px', background:'#fff', color:T.charcoal, border:`1px solid ${T.border}`, borderRadius:5, fontSize:11, fontWeight:500, cursor:'pointer' },
}
