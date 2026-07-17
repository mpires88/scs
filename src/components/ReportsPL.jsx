import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase, fetchAll } from '../lib/supabase'
import { PL_SECTIONS, fetchAccounts } from '../lib/chartOfAccounts'
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
            .order('transaction_date')),
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

    // Section rows (only accounts with activity this year, in COA order)
    const acctOrder = new Map(accounts.map((a, i) => [a.name, i]))
    const sections = PL_SECTIONS.map(section => {
      const rows = Object.keys(acctMonth)
        .filter(name => (sectionMap[name] ?? 'Operating Expenses') === section)
        .sort((a, b) => (acctOrder.get(a) ?? 1e9) - (acctOrder.get(b) ?? 1e9))
        .map(name => {
          const byMonth = acctMonth[name]
          const total = months.reduce((s, m) => s + (byMonth[m] ?? 0), 0)
          return { name, byMonth, total }
        })
      const totals = {}
      months.forEach(m => { totals[m] = rows.reduce((s, r) => s + (r.byMonth[m] ?? 0), 0) })
      const total = rows.reduce((s, r) => s + r.total, 0)
      return { section, rows, totals, total }
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
  }, [txns, sectionMap, accounts, year])

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
      if (!sec.rows.length) return
      lines.push([sec.section])
      const sign = displaySign(sec.section)
      sec.rows.forEach(r => {
        lines.push([`  ${r.name}`, ...months.map(m => ((r.byMonth[m] ?? 0) * sign).toFixed(2)), (r.total * sign).toFixed(2)])
      })
      lines.push([`Total ${sec.section}`, ...months.map(m => (sec.totals[m] * sign).toFixed(2)), (sec.total * sign).toFixed(2)])
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
                  if (!sec.rows.length) return null
                  const isExpense = EXPENSE_SECTIONS.has(sec.section)
                  const sign = isExpense ? -1 : 1
                  return (
                    <SectionRows
                      key={sec.section}
                      sec={sec} sign={sign} months={statement.months} computed={statement.computed}
                      showBudget={showBudget} budgets={budgets} drafts={drafts} setDrafts={setDrafts} saveBudget={saveBudget}
                      isExpense={isExpense}
                    />
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
            Amounts in parentheses are negative. Expense sections show money spent as positive numbers;
            computed lines (Net Revenue, Gross Profit, Operating Income, Net Income) are signed.
            {showBudget && ' Budgets are monthly targets — variance compares this year’s monthly average against them.'}
          </p>
        )}
      </div>
    </div>
  )
}

// One P&L section: header, account rows, subtotal, plus any computed line that follows it.
function SectionRows({ sec, sign, months, computed, showBudget, budgets, drafts, setDrafts, saveBudget, isExpense }) {
  const monthCount = months.length

  const computedAfter = {
    'Deductions to Income': ['NET REVENUE',      computed.netRevenue],
    'Cost of Goods Sold':   ['GROSS PROFIT',     computed.grossProfit],
    'Operating Expenses':   ['OPERATING INCOME', computed.opIncome],
  }[sec.section]

  return (
    <>
      <tr>
        <td colSpan={999} style={{ padding:'9px 12px 4px', fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.07em', background:T.card }}>
          {sec.section}
        </td>
      </tr>
      {sec.rows.map(r => {
        const avg = (r.total * sign) / monthCount
        const budget = budgets[r.name]
        const variance = budget != null ? avg - budget : null
        // For expenses, over budget is bad; for revenue, under budget is bad
        const bad = variance != null && (isExpense ? variance > 0 : variance < 0)
        const draft = drafts[r.name]
        return (
          <tr key={r.name} style={{ borderBottom:`1px solid #F0EEE9` }}>
            <td style={{ ...cell.td, paddingLeft:22, position:'sticky', left:0, background:T.card }}>{r.name}</td>
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
      {/* Computed line following this section */}
      {computedAfter && (
        <tr style={{ background:'#EBF1F7', borderBottom:`2px solid #B8CDE0` }}>
          <td style={{ ...cell.td, fontWeight:700, color:T.navy, position:'sticky', left:0, background:'#EBF1F7' }}>{computedAfter[0]}</td>
          {months.map(m => {
            const v = computedAfter[1].byMonth[m]
            return <td key={m} style={{ ...cell.num, fontWeight:600, color: v < 0 ? T.danger : T.navy }}>{fmtCell(v)}</td>
          })}
          <td style={{ ...cell.num, borderLeft:`2px solid ${T.border}`, fontWeight:700, color: computedAfter[1].total < 0 ? T.danger : T.navy }}>
            {fmtCell(computedAfter[1].total)}
          </td>
          {showBudget && <><td style={cell.num}></td><td style={cell.num}></td></>}
        </tr>
      )}
    </>
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
