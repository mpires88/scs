import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  BarChart, Bar, LineChart, Line, ComposedChart, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine, Cell, PieChart, Pie,
} from 'recharts'
import { supabase, fetchAll } from '../lib/supabase'
import { fetchSectionMap, isPLSection } from '../lib/chartOfAccounts'
import { getSetting, setSetting } from '../lib/settings'
import {
  computeBreakeven, computeSalesTax,
  computeRunway, computeCloseChecklist, computeCategoryMargins,
  computeCogsProposal, computeOpenToBuy, inventoryBookBalance,
  computeTaxAccrualProposal, computeSquareFeeProposal, computeYearEndProjection, ADJUSTMENTS_ACCOUNT,
  buildMonthlyPL, stripAcctNum,
} from '../lib/insights'
import { buildMonthEndRows, staleDescriptions, trueUpRows, quarterLabel } from '../lib/monthEnd'
import { CogsCard, InventoryCard, OpenToBuyCard } from './InventoryOps'
import { T as D, PIE_COLORS, MON, fmt, fmtK, fmtPct } from '../lib/theme'
import InfoTip from './InfoTip'
import BooksGuide from './BooksGuide'

// ─── Shared small components ──────────────────────────────────────────────────

function KpiCard({ label, value, sub, color = D.navy, warn = false, flag = null, info = null }) {
  return (
    <div style={{ flex:'1 1 170px', minWidth:150, background:D.card, border:`1px solid ${D.border}`, borderTop:`3px solid ${warn ? D.danger : color}`, borderRadius:7, padding:'14px 16px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:9.5, fontWeight:700, color:D.gold, textTransform:'uppercase', letterSpacing:'.07em', marginBottom:6 }}>
        <span>{label}</span>
        {info && <InfoTip title={typeof label === 'string' ? label : undefined}>{info}</InfoTip>}
      </div>
      <div style={{ fontSize:22, fontWeight:600, color: warn ? D.danger : D.navy }}>{value}</div>
      {sub && <div style={{ fontSize:10, color:'rgba(74,74,74,0.6)', marginTop:4 }}>{sub}</div>}
      {flag && <div style={{ marginTop:6 }}>{flag}</div>}
    </div>
  )
}

// Amber badge for figures computed without COGS entries: inventory purchases
// sit on the balance sheet, so until COGS is booked these numbers read high.
const NO_COGS_TITLE = 'No Cost of Goods Sold entries are recorded — inventory purchases sit on the balance-sheet Inventory account until COGS is booked, so this figure overstates profit.'

function CogsFlag({ children = 'no COGS recorded', title = NO_COGS_TITLE }) {
  return (
    <span title={title} style={{ fontSize:9.5, fontWeight:700, color:'#92400E', background:'#FEF3C7', borderRadius:3, padding:'1px 7px', whiteSpace:'nowrap', cursor:'help' }}>
      ⚠ {children}
    </span>
  )
}

function SectionTitle({ children, info = null }) {
  return (
    <h3 style={{ display:'flex', alignItems:'center', gap:6, fontSize:9.5, fontWeight:700, color:D.gold, textTransform:'uppercase', letterSpacing:'.07em', margin:'28px 0 12px', borderBottom:`1px solid ${D.border}`, paddingBottom:7 }}>
      <span>{children}</span>
      {info && <InfoTip>{info}</InfoTip>}
    </h3>
  )
}

// Label + ⓘ for the Path-to-Profitability cards, which use cardLabel rather
// than the KpiCard shell.
function CardLabel({ children, info = null }) {
  return (
    <div style={{ ...cardLabel, display:'flex', alignItems:'center', gap:5 }}>
      <span>{children}</span>
      {info && <InfoTip>{info}</InfoTip>}
    </div>
  )
}

const ttStyle = { background:D.navy, border:'none', borderRadius:5, color:'#fff', fontSize:11, padding:'8px 12px' }

// Shared by the year-over-year tables (month comparison, year-end projection).
const tblTh = right => ({ textAlign: right ? 'right' : 'left', padding:'7px 12px', background:D.page, fontSize:9.5, fontWeight:700, color:D.gold, textTransform:'uppercase', letterSpacing:'.06em', whiteSpace:'nowrap', borderBottom:`2px solid ${D.border}` })
const tblTd = { padding:'6px 12px', fontSize:11.5, textAlign:'right', fontVariantNumeric:'tabular-nums', color:D.charcoal }
const deltaColor = (d, goodUp) => Math.abs(d) < 0.005 ? D.charcoal : ((d > 0) === goodUp ? D.success : D.danger)

function CustomTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={ttStyle}>
      <div style={{ fontWeight:600, marginBottom:4, color:'rgba(255,255,255,0.7)', fontSize:10 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color:'#fff' }}>{p.name}: {p.value != null ? fmt(p.value) : '—'}</div>
      ))}
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard({ clientId }) {
  const [txns,          setTxns]          = useState([])
  const [squareReports, setSquareReports] = useState([])
  const [accounts,      setAccounts]      = useState([])
  const [sectionMap,    setSectionMap]    = useState({})
  const [buys,          setBuys]          = useState([])
  const [uncatCount,    setUncatCount]    = useState(0)
  const [prevMonthTxnCount, setPrevMonthTxnCount] = useState(null)
  const [cash,          setCash]          = useState(null)   // { amount, asOf }
  const [cogsPct,       setCogsPct]       = useState({})     // squareCategory → %
  const [cogsMethod,    setCogsMethod]    = useState(null)   // { sealedCostRatio, restPct, blendedPct }
  const [purchaseBudget, setPurchaseBudget] = useState({})   // { cashFloor, depositHaircut }
  const [registry,      setRegistry]      = useState([])     // client_settings 'ledger_accounts'
  const [invCounts,     setInvCounts]     = useState([])     // [{ date, counted, bookBefore, adjustment }]
  const [cogsBusy,      setCogsBusy]      = useState(false)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [guideOpen,     setGuideOpen]     = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      // Previous calendar month bounds for the close checklist (must include
      // uncategorized rows, which the main txn query filters out)
      const monthStart = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
      const now = new Date()
      const prevMonthStart = monthStart(new Date(now.getFullYear(), now.getMonth() - 1, 1))
      const curMonthStart  = monthStart(now)
      const [txnRes, sqRes, coaRes, buysRes, uncatNull, uncatEmpty, prevMonthRes, cashVal, cogsVal, methodVal, budgetVal, countsVal, ledgerVal] = await Promise.all([
        fetchAll(() => supabase.from('bank_transactions').select('transaction_date, amount, category, description, account')
          .eq('client_id', clientId).not('category', 'is', null).neq('category', '')
          .order('transaction_date').order('id'))
          .then(data => ({ data, error: null }))
          .catch(e => ({ data: null, error: e })),
        supabase.from('square_reports').select('period, gross_sales, net_sales, tax_collected, fees, net_total, categories')
          .eq('client_id', clientId).order('period'),
        fetchSectionMap(clientId).then(r => ({ ...r, error: null }))
          .catch(e => ({ map: {}, accounts: [], error: e })),
        supabase.from('inventory_buys').select('buy_date, category, cost').eq('client_id', clientId),
        supabase.from('bank_transactions').select('id', { count: 'exact', head: true })
          .eq('client_id', clientId).is('category', null),
        supabase.from('bank_transactions').select('id', { count: 'exact', head: true })
          .eq('client_id', clientId).eq('category', ''),
        supabase.from('bank_transactions').select('id', { count: 'exact', head: true })
          .eq('client_id', clientId).gte('transaction_date', prevMonthStart).lt('transaction_date', curMonthStart),
        getSetting(clientId, 'cash_balance', null).catch(() => null),
        getSetting(clientId, 'cogs_pct', {}).catch(() => ({})),
        getSetting(clientId, 'cogs_method', null).catch(() => null),
        getSetting(clientId, 'purchase_budget', {}).catch(() => ({})),
        getSetting(clientId, 'inventory_counts', []).catch(() => []),
        getSetting(clientId, 'ledger_accounts', []).catch(() => []),
      ])
      if (!cancelled) {
        setTxns(txnRes.error ? [] : (txnRes.data ?? []))
        setSquareReports(sqRes.data ?? [])
        setAccounts(coaRes.accounts)
        setSectionMap(coaRes.map)
        setBuys(buysRes.error ? [] : (buysRes.data ?? []))   // table may not exist yet
        setUncatCount((uncatNull.count ?? 0) + (uncatEmpty.count ?? 0))
        setPrevMonthTxnCount(prevMonthRes.error ? null : (prevMonthRes.count ?? 0))
        setCash(cashVal)
        setCogsPct(cogsVal || {})
        setCogsMethod(methodVal)
        setPurchaseBudget(budgetVal || {})
        setInvCounts(Array.isArray(countsVal) ? countsVal : [])
        setRegistry(Array.isArray(ledgerVal) ? ledgerVal : [])
        // A failed section map silently reclassifies everything as OpEx — surface it
        const loadErr = txnRes.error || coaRes.error
        if (loadErr) setError(loadErr.message)
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [clientId])

  // ── Compute monthly P&L ────────────────────────────────────────────────────
  // Sign convention in DB: revenue = positive amounts, expenses = negative amounts.

  const monthlyPL = useMemo(() => buildMonthlyPL({ txns, sectionMap }), [txns, sectionMap])

  const years    = useMemo(() => [...new Set(monthlyPL.map(r => r.year))].sort(), [monthlyPL])
  const curYear  = years[years.length - 1] ?? null
  const prevYear = years.length >= 2 ? years[years.length - 2] : null

  // Months whose profit figures are overstated: revenue exists but no COGS was
  // booked (inventory purchases live on the balance sheet, outside the P&L).
  // Flags clear automatically month by month once COGS entries are recorded.
  const noCogsMonths = useMemo(
    () => monthlyPL.filter(r => r.revenue > 0 && r.cogs === 0).map(r => r.period),
    [monthlyPL]
  )

  // ── Expense breakdown by category (Operating Expenses, CURRENT YEAR only) ──

  const expenseByCategory = useMemo(() => {
    if (!curYear) return []
    const byCat = {}
    txns.forEach(t => {
      if (!t.category) return
      if ((t.transaction_date || '').slice(0, 4) !== String(curYear)) return
      const section = sectionMap[t.category] ?? 'Operating Expenses'
      if (section !== 'Operating Expenses') return
      byCat[t.category] = (byCat[t.category] ?? 0) + (Number(t.amount) || 0)
    })
    return Object.entries(byCat)
      .map(([name, sum]) => ({ name, value: Math.round(-sum) }))
      .filter(e => e.value > 0)
      .sort((a, b) => b.value - a.value)
  }, [txns, sectionMap, curYear])

  // ── Insights ───────────────────────────────────────────────────────────────

  const breakeven = useMemo(
    () => curYear ? computeBreakeven({ txns, accounts, sectionMap, monthlyPL, year: curYear }) : null,
    [txns, accounts, sectionMap, monthlyPL, curYear]
  )
  const salesTax  = useMemo(
    () => curYear ? computeSalesTax({ squareReports, txns, year: curYear }) : null,
    [squareReports, txns, curYear]
  )
  const runway    = useMemo(() => computeRunway({ cash, monthlyPL }), [cash, monthlyPL])
  const checklist = useMemo(
    () => computeCloseChecklist({ txns, squareReports, uncatCount, prevMonthTxnCount, counts: invCounts }),
    [txns, squareReports, uncatCount, prevMonthTxnCount, invCounts]
  )
  const cogsProposal = useMemo(
    () => computeCogsProposal({ month: checklist.month, monthlyPL, squareReports, method: cogsMethod }),
    [checklist.month, monthlyPL, squareReports, cogsMethod]
  )
  const taxProposal = useMemo(
    () => computeTaxAccrualProposal({ month: checklist.month, squareReports, txns }),
    [checklist.month, squareReports, txns]
  )
  const feeProposal = useMemo(
    () => computeSquareFeeProposal({ month: checklist.month, squareReports, txns }),
    [checklist.month, squareReports, txns]
  )
  const projection = useMemo(
    () => curYear ? computeYearEndProjection({ monthlyPL, year: curYear }) : null,
    [monthlyPL, curYear]
  )
  const invBalance = useMemo(() => inventoryBookBalance(txns), [txns])
  const hasInventoryTxns = useMemo(() => txns.some(t => stripAcctNum(t.category) === 'Inventory'), [txns])
  const openToBuy = useMemo(
    () => computeOpenToBuy({ cash, txns, monthlyPL, salesTax, budget: purchaseBudget, registry }),
    [cash, txns, monthlyPL, salesTax, purchaseBudget, registry]
  )
  // Booked COGS as % of revenue, current quarter to date — recalibration hint
  const impliedCogsPct = useMemo(() => {
    const d = new Date()
    const qMonths = new Set([0, 1, 2].map(i => {
      const q0 = Math.floor(d.getMonth() / 3) * 3 + i
      return `${d.getFullYear()}-${String(q0 + 1).padStart(2, '0')}`
    }))
    const inQ = f => txns.reduce((s, t) =>
      (f(t) && qMonths.has((t.transaction_date || '').slice(0, 7))) ? s + (Number(t.amount) || 0) : s, 0)
    const cogs = -inQ(t => stripAcctNum(t.category) === 'Product Costs')
    const rev = monthlyPL.filter(r => qMonths.has(r.period)).reduce((s, r) => s + r.revenue, 0)
    return cogs > 0 && rev > 0 ? (cogs / rev) * 100 : null
  }, [txns, monthlyPL])
  // Margins come from Square data, which may cover a different year than the
  // bank transactions — use the latest year that actually has Square reports.
  const marginYear = useMemo(() => {
    const yrs = squareReports.map(r => +(r.period || '').slice(0, 4)).filter(Boolean)
    return yrs.length ? Math.max(...yrs) : (curYear ?? new Date().getFullYear())
  }, [squareReports, curYear])
  const margins   = useMemo(
    () => computeCategoryMargins({ squareReports, buys, cogsPct, year: marginYear }),
    [squareReports, buys, cogsPct, marginYear]
  )

  const saveCash = useCallback(async amount => {
    const val = { amount, asOf: new Date().toISOString().slice(0, 10) }
    setCash(val)
    try { await setSetting(clientId, 'cash_balance', val) } catch (e) { alert('Could not save: ' + e.message) }
  }, [clientId])

  const saveCogsPct = useCallback(async (cat, pct) => {
    const next = { ...cogsPct }
    if (pct == null || isNaN(pct)) delete next[cat]
    else next[cat] = pct
    setCogsPct(next)
    try { await setSetting(clientId, 'cogs_pct', next) } catch (e) { alert('Could not save: ' + e.message) }
  }, [clientId, cogsPct])

  const saveCogsMethod = useCallback(async next => {
    setCogsMethod(next)
    try { await setSetting(clientId, 'cogs_method', next) } catch (e) { alert('Could not save: ' + e.message) }
  }, [clientId])

  const savePurchaseBudget = useCallback(async next => {
    setPurchaseBudget(next)
    try { await setSetting(clientId, 'purchase_budget', next) } catch (e) { alert('Could not save: ' + e.message) }
  }, [clientId])

  // Inserts a zero-net adjustment pair (see COGS_PLAN.md §1) and mirrors it
  // into local state so the P&L, flags, and checklist react without a reload.
  const insertAdjustmentPair = useCallback(async rows => {
    const withClient = rows.map(r => ({ ...r, account: ADJUSTMENTS_ACCOUNT, ...(clientId !== null ? { client_id: clientId } : {}) }))
    const { data, error: insErr } = await supabase.from('bank_transactions')
      .insert(withClient).select('transaction_date, amount, category, description, account')
    if (insErr) throw insErr
    setTxns(prev => [...prev, ...(data ?? withClient)])
  }, [clientId])

  // Books whatever month-end pairs are still pending: the COGS estimate and
  // the sales-tax accrual (tax portion of Square deposits → liability).
  const bookMonthEnd = useCallback(async () => {
    if (cogsBusy) return
    const month = checklist.month
    const rows = buildMonthEndRows({
      month, cogsProposal, taxProposal, feeProposal, cogsBooked: checklist.cogsBooked, accounts,
    })
    if (!rows.length) return
    // A re-uploaded Square report can leave an entry booked at a figure the
    // report no longer agrees with. Clear those first, or booking would stack a
    // second pair on top of the stale one and double the month.
    const stale = staleDescriptions({ month, taxProposal, feeProposal })
    setCogsBusy(true)
    try {
      if (stale.length) {
        const { error: delErr } = await supabase.from('bank_transactions')
          .delete().eq('account', ADJUSTMENTS_ACCOUNT).in('description', stale)
          .match(clientId !== null ? { client_id: clientId } : {})
        if (delErr) throw delErr
        setTxns(prev => prev.filter(t =>
          !(t.account === ADJUSTMENTS_ACCOUNT && stale.includes(t.description))))
      }
      await insertAdjustmentPair(rows)
    } catch (e) { alert('Could not book month-end entries: ' + e.message) }
    setCogsBusy(false)
  }, [cogsProposal, taxProposal, feeProposal, checklist, cogsBusy, insertAdjustmentPair, accounts, clientId])

  const trueUpInventory = useCallback(async counted => {
    if (counted == null || cogsBusy) return
    const adjustment = Math.round((invBalance - counted) * 100) / 100
    const d = new Date()
    const date = d.toISOString().slice(0, 10)
    setCogsBusy(true)
    try {
      const rows = trueUpRows({ date, quarterLabel: quarterLabel(d), adjustment, accounts })
      if (rows.length) await insertAdjustmentPair(rows)
      const nextCounts = [...invCounts, { date, counted, bookBefore: invBalance, adjustment }]
      setInvCounts(nextCounts)
      await setSetting(clientId, 'inventory_counts', nextCounts)
    } catch (e) { alert('Could not record the count: ' + e.message) }
    setCogsBusy(false)
  }, [invBalance, invCounts, cogsBusy, insertAdjustmentPair, clientId, accounts])

  // ── Loading / error / empty states ────────────────────────────────────────

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:300, background:D.page, fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={{ width:28, height:28, border:`2px solid ${D.border}`, borderTopColor:D.navy, borderRadius:'50%', animation:'spin .7s linear infinite' }} />
    </div>
  )

  if (error) return (
    <div style={{ padding:28, fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ background:'#FDE8E8', border:'1px solid #F5C2C2', borderRadius:6, padding:'10px 14px', fontSize:12, color:'#991B1B' }}>
        Failed to load: {error}
      </div>
    </div>
  )

  if (!txns.length && !squareReports.length) return (
    <div style={{ background:D.page, minHeight:'100%', fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <header style={{ display:'flex', alignItems:'flex-start', padding:'14px 28px', background:D.card, borderBottom:`1px solid ${D.border}` }}>
        <div>
          <h2 style={{ fontSize:14, fontWeight:600, color:D.navy, margin:'0 0 2px' }}>Business Dashboard</h2>
          <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:0 }}>Sports Card Station · Norfolk, MA</p>
        </div>
      </header>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:400, padding:40, textAlign:'center' }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={D.border} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom:16 }}>
          <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
          <line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>
        </svg>
        <h3 style={{ fontSize:15, fontWeight:600, color:D.navy, margin:'0 0 8px' }}>No data yet</h3>
        <p style={{ fontSize:12, color:D.charcoal, opacity:.7, maxWidth:380, lineHeight:1.7, margin:0 }}>
          Import your bank transactions or upload a Square Sales Report email to get started.
        </p>
      </div>
    </div>
  )

  // ── Derived stats ──────────────────────────────────────────────────────────

  const hasTxnData = monthlyPL.length > 0

  const byYear = yr => monthlyPL.filter(r => r.year === yr)
  const sumF   = (rows, f) => rows.reduce((s, r) => s + (r[f] ?? 0), 0)

  const curRows  = curYear ? byYear(curYear) : []
  const prevRows = prevYear ? byYear(prevYear) : []

  const curRevenue     = sumF(curRows, 'revenue')
  const prevRevenue    = sumF(prevRows, 'revenue')
  const curGrossProfit = sumF(curRows, 'grossProfit')
  const curNetProfit   = sumF(curRows, 'netProfit')
  const totalOpexCur   = sumF(curRows, 'totalOpex')

  const curYearNoCogs = curRows.filter(r => r.revenue > 0 && r.cogs === 0).length
  const recentNoCogs  = monthlyPL.slice(-6).some(r => r.revenue > 0 && r.cogs === 0)

  // Like-for-like YoY: compare only the months both years actually have. The
  // current year is normally still in progress while the prior year holds all
  // 12, so comparing the raw totals is part-year vs full-year.
  const prevMonthNums = prevRows.map(r => r.month)
  const cmpMonths = curRows.map(r => r.month).filter(m => prevMonthNums.includes(m))
  const ytdCur    = sumF(curRows.filter(r => cmpMonths.includes(r.month)), 'revenue')
  const ytdPrev   = sumF(prevRows.filter(r => cmpMonths.includes(r.month)), 'revenue')
  const ytdGrowth = ytdPrev ? ((ytdCur - ytdPrev) / ytdPrev * 100).toFixed(1) : null

  // Only call out the window when one of the years is missing months the other has.
  const partialYear = !!prevYear &&
    (curRows.length !== cmpMonths.length || prevRows.length !== cmpMonths.length)
  const ytdLabel = cmpMonths.length
    ? `${MON[Math.min(...cmpMonths)]}–${MON[Math.max(...cmpMonths)]}`
    : ''

  const bestMonth = hasTxnData ? [...monthlyPL].sort((a, b) => b.revenue - a.revenue)[0] : null

  const avgGrossMargin = curRows.length
    ? curRows.filter(r => r.grossMarginPct != null)
        .reduce((s, r, _, a) => s + r.grossMarginPct / a.length, 0)
    : 0

  // ── Chart data ─────────────────────────────────────────────────────────────

  const monthlyComparison = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1
    const row = { month: MON[m] }
    years.forEach(yr => {
      const r = monthlyPL.find(d => d.year === yr && d.month === m)
      row[String(yr)] = r?.revenue ?? null
    })
    return row
  })

  const plChart = curRows.map(r => ({
    label: MON[r.month],
    'Gross Profit':       r.grossProfit,
    'Operating Expenses': r.totalOpex,
    'Net Profit':         r.netProfit,
  }))

  const revTrend = monthlyPL.map(r => ({
    label:   `${MON[r.month]} '${String(r.year).slice(2)}`,
    revenue: r.revenue,
  }))

  // ── Dynamic takeaways ──────────────────────────────────────────────────────

  const takeaways = [
    noCogsMonths.length > 0 && {
      warn: true,
      title: `COGS not recorded — profit figures read high`,
      body:  `${noCogsMonths.length} month${noCogsMonths.length !== 1 ? 's' : ''} with revenue ${noCogsMonths.length !== 1 ? 'have' : 'has'} no Cost of Goods Sold booked; inventory purchases sit on the balance sheet. Gross profit, margin, net P&L, breakeven, and runway all overstate performance until COGS entries exist.`,
    },
    breakeven?.breakevenRevenue && {
      warn: curYearNoCogs > 0,
      title: breakeven.avgRevenue >= breakeven.breakevenRevenue
        ? `Running above breakeven`
        : `${fmt(breakeven.breakevenRevenue - breakeven.avgRevenue)}/month short of breakeven`,
      body:  `Breakeven is ${fmt(breakeven.breakevenRevenue)}/month at your ${fmtPct(breakeven.avgMarginPct)} margin; you're averaging ${fmt(breakeven.avgRevenue)}.`
             + (curYearNoCogs > 0 ? ' COGS is missing from the margin, so the real breakeven is higher.' : ''),
    },
    ytdGrowth && {
      title: `Revenue ${+ytdGrowth >= 0 ? 'grew' : 'declined'} ${Math.abs(ytdGrowth)}% ${partialYear ? 'vs the same period last year' : 'year over year'}`,
      body:  partialYear
        ? `${ytdLabel} ${curYear} revenue is ${fmt(ytdCur)} vs ${fmt(ytdPrev)} for ${ytdLabel} ${prevYear}.`
        : `${curYear} revenue is ${fmt(curRevenue)} vs ${fmt(prevRevenue)} in ${prevYear}.`,
    },
    avgGrossMargin > 0 && curYearNoCogs === 0 && {
      title: `Gross margin averaging ${fmtPct(avgGrossMargin)}`,
      body:  avgGrossMargin < 20
        ? `For every $1 in sales, ~${(100 - avgGrossMargin).toFixed(0)} cents goes back into inventory. Buying at better prices or pricing higher will improve this.`
        : `Healthy gross margin. Keep monitoring your cost of goods to maintain this level.`,
    },
    expenseByCategory.length > 0 && totalOpexCur > 0 && {
      title: `${expenseByCategory[0].name} is your largest expense`,
      body:  `${fmt(expenseByCategory[0].value)} in ${curYear} — ${fmtPct(expenseByCategory[0].value / totalOpexCur * 100)} of total operating expenses.`,
    },
    bestMonth && {
      title: `${MON[bestMonth.month]} ${bestMonth.year} was your best month`,
      body:  `${fmt(bestMonth.revenue)} in revenue${bestMonth.grossMarginPct != null ? ` at ${fmtPct(bestMonth.grossMarginPct)} gross margin` : ''}.`,
    },
    hasTxnData && {
      warn: curYearNoCogs > 0,
      title: curYearNoCogs > 0
        ? `${curYear} net P&L: ${fmt(curNetProfit)} — before product costs`
        : (curNetProfit >= 0 ? `Profitable in ${curYear}` : `Near breakeven on net profit`),
      body:  curYearNoCogs > 0
        ? `No COGS is recorded for ${curYear}, so true net profit is lower than ${fmt(curNetProfit)} once product costs are booked.`
        : `${curYear} net P&L: ${fmt(curNetProfit)} after all expenses.${curNetProfit < 0 ? ' Continued revenue growth should tip into consistent profitability.' : ''}`,
    },
  ].filter(Boolean)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ background:D.page, minHeight:'100%', fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme:'light' }}>

      <header style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', padding:'14px 28px', background:D.card, borderBottom:`1px solid ${D.border}` }}>
        <div>
          <h2 style={{ fontSize:14, fontWeight:600, color:D.navy, margin:'0 0 2px' }}>Business Dashboard</h2>
          <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:0 }}>
            Sports Card Station · Norfolk, MA · {monthlyPL.length} months of data
          </p>
        </div>
        <button style={guideBtn} onClick={() => setGuideOpen(true)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          How your books work
        </button>
      </header>

      <BooksGuide open={guideOpen} onClose={() => setGuideOpen(false)} noCogs={noCogsMonths.length > 0} />

      <div style={{ padding:'20px 28px', maxWidth:1160 }}>

        {/* ── Path to profitability ── */}
        {hasTxnData && (
          <>
            <SectionTitle>Path to Profitability</SectionTitle>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(250px,1fr))', gap:10 }}>
              <BreakevenCard be={breakeven} noCogs={curYearNoCogs > 0} />
              <RunwayCard runway={runway} cash={cash} onSave={saveCash} noCogs={recentNoCogs} />
              <SalesTaxCard tax={salesTax} year={curYear} />
              <ChecklistCard cl={checklist} />
              <CogsCard cl={checklist} proposal={cogsProposal} method={cogsMethod} taxProposal={taxProposal} busy={cogsBusy} onBook={bookMonthEnd} onSaveMethod={saveCogsMethod} />
              <OpenToBuyCard otb={openToBuy} budget={purchaseBudget} onSaveBudget={savePurchaseBudget} />
              {hasInventoryTxns && (
                <InventoryCard
                  balance={invBalance} counts={invCounts} busy={cogsBusy} onTrueUp={trueUpInventory}
                  impliedPct={impliedCogsPct} method={cogsMethod} onSaveMethod={saveCogsMethod}
                />
              )}
            </div>
          </>
        )}

        {/* ── KPIs + P&L (only when bank transactions exist) ── */}
        {hasTxnData && <><SectionTitle
          info={<>Every figure here is built from the bank transactions you&apos;ve imported and
            categorized. Money that only moves between accounts — inventory buys, credit-card
            payments, owner&apos;s draw — is deliberately left out, because it doesn&apos;t earn
            or lose anything.</>}
        >Key Metrics · {curYear}</SectionTitle>
        <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:4 }}>
          <KpiCard
            label={partialYear ? `${curYear} Revenue · ${ytdLabel}` : `${curYear} Revenue`}
            value={fmt(partialYear ? ytdCur : curRevenue)}
            sub={ytdGrowth
              ? `${+ytdGrowth >= 0 ? '↑' : '↓'} ${Math.abs(ytdGrowth)}% vs ${partialYear ? `same period ${prevYear}` : prevYear}`
              : `${curRows.length} months`}
            color={D.steel}
            info={<>Every transaction filed under a <strong>Revenue</strong> account, less
              &ldquo;Deductions to Income&rdquo; such as sales tax collected.
              {partialYear ? ` Covers ${ytdLabel} only, so it lines up with last year.` : ''}</>}
          />
          {prevYear && (
            <KpiCard
              label={partialYear ? `${prevYear} Revenue · ${ytdLabel}` : `${prevYear} Revenue`}
              value={fmt(partialYear ? ytdPrev : prevRevenue)}
              sub={partialYear && prevRevenue !== ytdPrev
                ? `Full year: ${fmt(prevRevenue)}`
                : `${prevRows.length} months`}
              color={D.charcoal}
              info={partialYear
                ? <>The same Revenue accounts for {prevYear}, trimmed to {ytdLabel} so the two
                  years cover the same months. {prevYear}&apos;s full-year total is on the line below.</>
                : <>The same Revenue accounts, totalled for {prevYear}.</>}
            />
          )}
          <KpiCard
            label={`${curYear} Gross Profit`}
            value={fmt(curGrossProfit)}
            sub={avgGrossMargin > 0 ? `${fmtPct(avgGrossMargin)} avg margin` : undefined}
            color={D.gold}
            flag={curYearNoCogs > 0 && <CogsFlag />}
            info={<>Revenue minus <strong>Cost of Goods Sold</strong> — what the selling earned
              before rent, payroll and the other costs of keeping the doors open. Buying
              inventory never lands here; only the cost of cards that actually sold does.</>}
          />
          {ytdGrowth && (
            <KpiCard
              label="YTD Growth" value={`${+ytdGrowth >= 0 ? '+' : ''}${ytdGrowth}%`}
              sub={`vs same period ${prevYear}`} color={+ytdGrowth >= 0 ? D.success : D.danger}
              info={<>This year&apos;s revenue against the same months last year
                {ytdLabel ? ` (${ytdLabel} on both sides)` : ''}, so a part-finished year is
                never scored against a full one.</>}
            />
          )}
          <KpiCard
            label="Best Month"
            value={fmt(bestMonth?.revenue)}
            sub={bestMonth ? `${MON[bestMonth.month]} ${bestMonth.year}` : undefined}
            color={D.success}
            info={<>The highest-revenue single month across everything you&apos;ve imported —
              all years, not just {curYear}.</>}
          />
          <KpiCard
            label={`${curYear} Net P&L`}
            value={fmt(curNetProfit)}
            sub="After all expenses"
            warn={curNetProfit < 0}
            flag={curYearNoCogs > 0 && <CogsFlag />}
            info={<>Gross Profit minus Operating Expenses, plus or minus anything non-operating.
              The bottom line. This is profit, not cash — a profitable month can still leave the
              bank balance lower if you bought heavily.</>}
          />
        </div>

        {/* ── Year-end projection ── */}
        <YearEndProjection p={projection} noCogs={curYearNoCogs > 0} />

        {/* ── Month comparison (same month, year over year) ── */}
        <MonthComparison monthlyPL={monthlyPL} txns={txns} sectionMap={sectionMap} />

        {/* ── Revenue Comparison ── */}
        {years.length >= 2 && (
          <>
            <SectionTitle
              info={<>Each month&apos;s revenue with one bar per year, so the same month lines
                up across years. Months you haven&apos;t imported yet simply have no bar.</>}
            >Monthly Revenue — Year over Year</SectionTitle>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={monthlyComparison} barCategoryGap="25%" barGap={3}>
                <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
                <XAxis dataKey="month" tick={{ fontSize:11, fill:D.charcoal }} />
                <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize:10, fill:D.charcoal }} width={52} />
                <Tooltip content={<CustomTip />} />
                <Legend wrapperStyle={{ fontSize:11 }} />
                {years.map((yr, i) => (
                  <Bar key={yr} dataKey={String(yr)} fill={[D.border, D.steel, D.navy][i] ?? PIE_COLORS[i % PIE_COLORS.length]} radius={[3,3,0,0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </>
        )}

        {/* ── Monthly P&L ── */}
        {plChart.length > 0 && (
          <>
            <SectionTitle
              info={<>Three bars a month. <strong>Gross Profit</strong> is revenue less the cost
                of what sold; <strong>Operating Expenses</strong> is the cost of being open;{' '}
                <strong>Net Profit</strong> is what&apos;s left. Inventory purchases aren&apos;t
                in any of them — they sit on the balance sheet until the cards sell.</>}
            >{curYear} Monthly Profit & Loss</SectionTitle>
            {curYearNoCogs > 0 && (
              <p style={{ fontSize:11, color:'#92400E', margin:'-8px 0 12px' }}>
                ⚠ No COGS recorded for {curYearNoCogs} of {curRows.length} months — Gross Profit and Net Profit exclude product costs and read high.
              </p>
            )}
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={plChart} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
                <XAxis dataKey="label" tick={{ fontSize:11, fill:D.charcoal }} />
                <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize:10, fill:D.charcoal }} width={56} />
                <Tooltip content={<CustomTip />} />
                <Legend wrapperStyle={{ fontSize:11 }} />
                <ReferenceLine y={0} stroke={D.charcoal} strokeWidth={1} />
                <Bar dataKey="Gross Profit"        fill={D.gold}  radius={[3,3,0,0]} />
                <Bar dataKey="Operating Expenses"  fill="#C4B8A0" radius={[3,3,0,0]} />
                <Bar dataKey="Net Profit"          fill={D.success} radius={[3,3,0,0]}>
                  {plChart.map((entry, i) => (
                    <Cell key={i} fill={entry['Net Profit'] >= 0 ? D.success : D.danger} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </>
        )}

        </>}{/* end hasTxnData */}

        {/* ── Margin by product category ── */}
        {margins.length > 0 && (
          <MarginTable margins={margins} year={marginYear} cogsPct={cogsPct} onSavePct={saveCogsPct} />
        )}

        {/* ── Square: Revenue by Category ── */}
        {squareReports.length > 0 && (() => {
          const allCats = [...new Set(squareReports.flatMap(r => (r.categories || []).map(c => c.name)))]

          const chartData = squareReports.map(r => {
            const row = { label: (() => { const [y,m] = r.period.split('-'); return `${MON[+m]} '${String(y).slice(2)}` })() }
            ;(r.categories || []).forEach(c => { row[c.name] = c.amount })
            return row
          })

          const fmtAmt = n => '$' + Math.round(n).toLocaleString()

          return (
            <>
              <SectionTitle>Revenue by Product Category (Square)</SectionTitle>
              <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:'-8px 0 14px' }}>
                Breakdown from your monthly Square sales reports — Sealed Products, Singles, Supplies.
              </p>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={chartData} barCategoryGap="25%" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
                  <XAxis dataKey="label" tick={{ fontSize:11, fill:D.charcoal }} />
                  <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize:10, fill:D.charcoal }} width={52} />
                  <Tooltip
                    formatter={(v, name) => [fmtAmt(v), name]}
                    contentStyle={ttStyle}
                    labelStyle={{ color: 'rgba(255,255,255,0.7)', fontWeight: 600, marginBottom: 4, fontSize: 10 }}
                    itemStyle={{ color: '#fff' }}
                  />
                  <Legend wrapperStyle={{ fontSize:11 }} />
                  {allCats.map((cat, i) => (
                    <Bar key={cat} dataKey={cat} fill={PIE_COLORS[i % PIE_COLORS.length]} radius={[3,3,0,0]} stackId="a" />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </>
          )
        })()}

        {/* ── Expenses + Revenue Trend (transaction data only) ── */}
        {hasTxnData && <>
        <div style={{ display:'flex', gap:24, flexWrap:'wrap', marginTop:4 }}>

          {expenseByCategory.length > 0 && (
            <div style={{ flex:'1 1 380px' }}>
              <SectionTitle
                info={<>Operating expenses only — the cost of keeping the shop open. Cost of
                  Goods Sold and inventory purchases are excluded, so this is rent, payroll,
                  utilities, fees and the like.</>}
              >{curYear} Expense Breakdown</SectionTitle>
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={expenseByCategory} cx="45%" cy="50%" outerRadius={95} dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    labelLine={false} fontSize={10}
                  >
                    {expenseByCategory.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={v => fmt(v)} contentStyle={ttStyle} />
                </PieChart>
              </ResponsiveContainer>
              <table style={{ width:'100%', borderCollapse:'collapse', marginTop:8 }}>
                <thead>
                  <tr>
                    {['Category', `${curYear} Total`, 'Monthly Avg'].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding:'5px 8px', background:D.page, fontSize:9.5, fontWeight:700, color:D.gold, textTransform:'uppercase', letterSpacing:'.06em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {expenseByCategory.map((e, i) => (
                    <tr key={i} style={{ borderBottom:`1px solid ${D.border}` }}>
                      <td style={{ padding:'5px 8px', display:'flex', alignItems:'center', gap:6, fontSize:11, color:D.charcoal }}>
                        <span style={{ width:8, height:8, borderRadius:'50%', background:PIE_COLORS[i % PIE_COLORS.length], flexShrink:0, display:'inline-block' }} />
                        {e.name}
                      </td>
                      <td style={{ padding:'5px 8px', textAlign:'right', fontVariantNumeric:'tabular-nums', fontSize:11, color:D.charcoal }}>{fmt(e.value)}</td>
                      <td style={{ padding:'5px 8px', textAlign:'right', fontVariantNumeric:'tabular-nums', fontSize:11, color:'rgba(74,74,74,0.55)' }}>{fmt(e.value / curRows.length)}</td>
                    </tr>
                  ))}
                  <tr style={{ background:D.page, fontWeight:600 }}>
                    <td style={{ padding:'6px 8px', fontSize:11, color:D.navy }}>Total</td>
                    <td style={{ padding:'6px 8px', textAlign:'right', fontSize:11, color:D.navy }}>{fmt(totalOpexCur)}</td>
                    <td style={{ padding:'6px 8px', textAlign:'right', fontSize:11, color:'rgba(74,74,74,0.55)' }}>{fmt(totalOpexCur / curRows.length)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {revTrend.length > 1 && (
            <div style={{ flex:'1 1 380px' }}>
              <SectionTitle>Revenue Trend — All Months</SectionTitle>
              <ResponsiveContainer width="100%" height={expenseByCategory.length > 0 ? 240 : 200}>
                <LineChart data={revTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
                  <XAxis dataKey="label" tick={{ fontSize:10, fill:D.charcoal }} interval={Math.max(0, Math.floor(revTrend.length / 8))} />
                  <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize:10, fill:D.charcoal }} width={52} />
                  <Tooltip content={<CustomTip />} />
                  <Line type="monotone" dataKey="revenue" stroke={D.steel} strokeWidth={2} dot={{ r:2.5, fill:D.steel }} name="Revenue" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

        </div>

        {/* ── Key Takeaways ── */}
        {takeaways.length > 0 && (
          <>
            <SectionTitle>Key Takeaways</SectionTitle>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:10, marginBottom:24 }}>
              {takeaways.map((c, i) => (
                <div key={i} style={{ background:D.card, border:`1px solid ${D.border}`, borderLeft:`3px solid ${c.warn ? D.amber : PIE_COLORS[i % PIE_COLORS.length]}`, borderRadius:7, padding:'12px 14px' }}>
                  <div style={{ fontWeight:600, fontSize:11, marginBottom:5, color:D.navy }}>{c.title}</div>
                  <div style={{ fontSize:11, color:D.charcoal, lineHeight:1.6, opacity:.85 }}>{c.body}</div>
                </div>
              ))}
            </div>
          </>
        )}
        </>}{/* end hasTxnData */}

      </div>
    </div>
  )
}

// ─── Year-end projection ──────────────────────────────────────────────────────
// Actuals for the months already closed, plus a projection for the rest built
// from last year's seasonal shape scaled to this year's run rate. See
// computeYearEndProjection in lib/insights.js for the method.

function YearEndProjection({ p, noCogs = false }) {
  if (!p) return null

  const actualLabel = `${MON[p.actualMonths[0]]}–${MON[p.actualMonths[p.actualMonths.length - 1]]}`
  const n = p.projectedMonths.length
  // Revenue can lack a growth rate while another line has one, so the wording
  // has to survive a null.
  const scaled = p.revenueGrowthPct != null
    ? `scaled by this year's ${p.revenueGrowthPct >= 0 ? '+' : ''}${p.revenueGrowthPct.toFixed(0)}% run rate vs ${p.prevYear}`
    : `scaled to this year's run rate`

  const method = {
    seasonal: `${n} remaining month${n !== 1 ? 's' : ''} projected from the same months in ${p.prevYear}, ${scaled}.`,
    mixed:    `${p.seasonalMonths.length} of ${n} remaining months projected from ${p.prevYear}'s same months (${scaled}); the rest at this year's ${actualLabel} average.`,
    runrate:  `${n} remaining month${n !== 1 ? 's' : ''} projected at this year's ${actualLabel} average — no comparable ${p.year - 1} months to read seasonality from.`,
  }[p.basis]

  const prev = p.prevTotal
  const lines = [
    { label: 'Revenue',            key: 'revenue',     goodUp: true  },
    { label: 'COGS',               key: 'cogs',        goodUp: false, cogsDep: true },
    { label: 'Gross Profit',       key: 'grossProfit', goodUp: true,  cogsDep: true },
    { label: 'Operating Expenses', key: 'totalOpex',   goodUp: false },
    { label: 'Net P&L',            key: 'netProfit',   goodUp: true,  cogsDep: true },
  ]

  const prevByMonth = Object.fromEntries((p.prevMonthly ?? []).map(r => [r.month, r.revenue]))
  const chart = p.monthly.map(r => ({
    label: MON[r.month],
    Actual:    r.projected ? null : r.revenue,
    Projected: r.projected ? r.revenue : null,
    ...(prev ? { [String(p.prevYear)]: prevByMonth[r.month] ?? null } : {}),
  }))

  return (
    <>
      <SectionTitle
        info={<>Where the year lands if the rest of it behaves like the year so far. Months
          already closed are real; the remainder is estimated from the same months last year,
          scaled by how this year is actually running against last year. That keeps the shape of
          your season — December is not February — instead of smearing one flat average across
          the calendar. It is an estimate, not a forecast: one unusual month moves it.</>}
      >Year-End Projection · {p.year}</SectionTitle>

      <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:'-8px 0 12px', lineHeight:1.6 }}>
        <strong>{actualLabel} actual</strong> · {method}
        {p.confidence === 'low' && <> Only {p.actualMonths.length} month{p.actualMonths.length !== 1 ? 's' : ''} of actuals so far, so treat this as a rough marker.</>}
      </p>

      {p.gapMonths.length > 0 && (
        <p style={{ fontSize:11, color:'#92400E', margin:'-6px 0 12px' }}>
          ⚠ {p.gapMonths.map(m => MON[m]).join(', ')} {p.gapMonths.length !== 1 ? 'are' : 'is'} closed but has no imported data — projected here.
          Import {p.gapMonths.length !== 1 ? 'those months' : 'that month'} to firm this up.
        </p>
      )}

      <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:16 }}>
        <KpiCard
          label={`Projected ${p.year} Revenue`}
          value={fmt(p.yearEnd.revenue)}
          sub={`${fmt(p.actual.revenue)} banked + ${fmt(p.projected.revenue)} projected`}
          color={D.steel}
        />
        <KpiCard
          label={`Projected ${p.year} Gross Profit`}
          value={fmt(p.yearEnd.grossProfit)}
          sub={prev ? `${fmt(prev.grossProfit)} in ${p.prevYear}` : undefined}
          color={D.gold}
          flag={noCogs && <CogsFlag />}
        />
        <KpiCard
          label={`Projected ${p.year} Net P&L`}
          value={fmt(p.yearEnd.netProfit)}
          sub={prev ? `${fmt(prev.netProfit)} in ${p.prevYear}` : 'After all expenses'}
          warn={p.yearEnd.netProfit < 0}
          flag={noCogs && <CogsFlag />}
        />
        {prev && (
          <KpiCard
            label={`vs ${p.prevYear} Full Year`}
            value={prev.revenue > 0
              ? `${p.yearEnd.revenue >= prev.revenue ? '+' : ''}${((p.yearEnd.revenue - prev.revenue) / prev.revenue * 100).toFixed(1)}%`
              : '—'}
            sub={prev.months < 12
              ? `${p.prevYear} has ${prev.months} of 12 months imported`
              : `${fmt(p.yearEnd.revenue - prev.revenue)} more revenue`}
            color={p.yearEnd.revenue >= prev.revenue ? D.success : D.danger}
          />
        )}
      </div>

      <div style={{ display:'flex', gap:24, flexWrap:'wrap', alignItems:'flex-start' }}>
        <div style={{ flex:'1 1 430px' }}>
          <div style={{ overflowX:'auto', background:D.card, border:`1px solid ${D.border}`, borderRadius:7 }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr>
                  <th style={tblTh(false)}>Metric</th>
                  <th style={tblTh(true)}>{actualLabel} Actual</th>
                  <th style={tblTh(true)}>Rest of Year</th>
                  <th style={tblTh(true)}>{p.year} Projected</th>
                  {prev && <th style={tblTh(true)}>{p.prevYear} Actual</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map(({ label, key, goodUp, cogsDep }) => {
                  const d = prev ? p.yearEnd[key] - prev[key] : null
                  return (
                    <tr key={key} style={{ borderBottom:`1px solid ${D.border}` }}>
                      <td style={{ ...tblTd, textAlign:'left', fontWeight:500, color:D.navy, whiteSpace:'nowrap' }}>
                        {label}{cogsDep && noCogs && <> <CogsFlag>no COGS</CogsFlag></>}
                      </td>
                      <td style={tblTd}>{fmt(p.actual[key])}</td>
                      <td style={{ ...tblTd, color:'rgba(74,74,74,0.6)', fontStyle:'italic' }}>{fmt(p.projected[key])}</td>
                      <td style={{ ...tblTd, fontWeight:600, color:D.navy }}>{fmt(p.yearEnd[key])}</td>
                      {prev && (
                        <td style={{ ...tblTd, color: d != null ? deltaColor(d, goodUp) : D.charcoal }}>
                          {fmt(prev[key])}
                          {d != null && prev[key] !== 0 && (
                            <span style={{ fontSize:10, marginLeft:5 }}>
                              ({d >= 0 ? '+' : ''}{(d / Math.abs(prev[key]) * 100).toFixed(0)}%)
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {prev && prev.months < 12 && (
            <p style={{ fontSize:10, color:'rgba(74,74,74,0.55)', margin:'6px 2px 0', lineHeight:1.5 }}>
              {p.prevYear} totals cover the {prev.months} month{prev.months !== 1 ? 's' : ''} imported, not a full year — the comparison understates it.
            </p>
          )}
        </div>

        <div style={{ flex:'1 1 380px' }}>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chart} barCategoryGap="25%">
              <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
              <XAxis dataKey="label" tick={{ fontSize:10, fill:D.charcoal }} />
              <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize:10, fill:D.charcoal }} width={52} />
              <Tooltip content={<CustomTip />} />
              <Legend wrapperStyle={{ fontSize:11 }} />
              <Bar dataKey="Actual"    stackId="a" fill={D.steel} radius={[3,3,0,0]} />
              <Bar dataKey="Projected" stackId="a" fill={D.steel} fillOpacity={0.32}
                stroke={D.steel} strokeDasharray="3 2" radius={[3,3,0,0]} />
              {prev && (
                <Line type="monotone" dataKey={String(p.prevYear)} stroke={D.charcoal}
                  strokeWidth={1.5} dot={{ r:2 }} strokeDasharray="4 3" connectNulls />
              )}
            </ComposedChart>
          </ResponsiveContainer>
          <p style={{ fontSize:10, color:'rgba(74,74,74,0.55)', margin:'2px 2px 0', textAlign:'center' }}>
            Monthly revenue — solid bars are banked, faded bars are projected.
          </p>
        </div>
      </div>
    </>
  )
}

// ─── Month comparison ─────────────────────────────────────────────────────────
// Same-month year-over-year: defaults to the most recent complete month with
// data (e.g. this July) against the same month last year.

function MonthComparison({ monthlyPL, txns, sectionMap = {} }) {
  const now = new Date()
  const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const periods = monthlyPL.map(r => r.period)
  const complete = periods.filter(p => p < curYM)
  const [ym, setYm] = useState(complete[complete.length - 1] ?? periods[periods.length - 1])

  const [y, m] = ym.split('-').map(Number)
  const prevYm = `${y - 1}-${String(m).padStart(2, '0')}`
  const cur  = monthlyPL.find(r => r.period === ym)
  const prev = monthlyPL.find(r => r.period === prevYm)

  // Per-category deltas between the two months. Amounts keep the DB sign
  // convention (revenue +, expenses −), so delta > 0 always means "helped
  // net profit" — more income or less spending — regardless of category type.
  const catChanges = useMemo(() => {
    const sum = {}
    txns.forEach(t => {
      const p = (t.transaction_date || '').slice(0, 7)
      if (p !== ym && p !== prevYm) return
      if (!t.category) return
      // Δ Profit only makes sense for P&L categories — balance-sheet moves
      // (inventory buys, credit-card payments, owner draws) aren't profit.
      if (!isPLSection(sectionMap[t.category] ?? 'Operating Expenses')) return
      if (!sum[t.category]) sum[t.category] = { cur: 0, prev: 0 }
      sum[t.category][p === ym ? 'cur' : 'prev'] += Number(t.amount) || 0
    })
    return Object.entries(sum)
      .map(([name, v]) => ({ name, ...v, delta: v.cur - v.prev }))
      .filter(r => Math.abs(r.delta) >= 1)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 6)
  }, [txns, ym, prevYm, sectionMap])

  if (!cur) return null

  const curNoCogs  = cur.revenue > 0 && cur.cogs === 0
  const prevNoCogs = !!prev && prev.revenue > 0 && prev.cogs === 0
  const noCogsLabel = [curNoCogs && `${MON[m]} ${y}`, prevNoCogs && `${MON[m]} ${y - 1}`]
    .filter(Boolean).join(' and ')

  const metrics = [
    { label: 'Revenue',            cur: cur.revenue,        prev: prev?.revenue,        goodUp: true  },
    { label: 'COGS',               cur: cur.cogs,           prev: prev?.cogs,           goodUp: false, cogsDep: true },
    { label: 'Gross Profit',       cur: cur.grossProfit,    prev: prev?.grossProfit,    goodUp: true,  cogsDep: true },
    { label: 'Gross Margin',       cur: cur.grossMarginPct, prev: prev?.grossMarginPct, goodUp: true,  cogsDep: true, isPct: true },
    { label: 'Operating Expenses', cur: cur.totalOpex,      prev: prev?.totalOpex,      goodUp: false },
    { label: 'Net Profit',         cur: cur.netProfit,      prev: prev?.netProfit,      goodUp: true,  cogsDep: true },
  ]

  const th = tblTh
  const td = tblTd

  return (
    <>
      <h3 style={{ fontSize:9.5, fontWeight:700, color:D.gold, textTransform:'uppercase', letterSpacing:'.07em', margin:'28px 0 12px', borderBottom:`1px solid ${D.border}`, paddingBottom:7, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span style={{ display:'flex', alignItems:'center', gap:6 }}>
          Month Comparison · {MON[m]} {y} vs {MON[m]} {y - 1}
          <InfoTip title="Month comparison">
            The same calendar month against itself a year earlier — the fairest comparison for a
            shop with a seasonal rhythm. <strong>Δ Profit</strong> counts only Profit &amp; Loss
            categories, so inventory buys, credit-card payments and owner&apos;s draw are left
            out; they move money without earning or losing it.
          </InfoTip>
        </span>
        <select
          value={ym}
          onChange={e => setYm(e.target.value)}
          style={{ fontSize:10.5, padding:'2px 6px', border:`1px solid ${D.border}`, borderRadius:4, color:D.charcoal, background:'#fff', outline:'none', fontWeight:400, textTransform:'none', letterSpacing:'normal' }}
        >
          {[...periods].reverse().map(p => {
            const [py, pm] = p.split('-').map(Number)
            return <option key={p} value={p}>{MON[pm]} {py}</option>
          })}
        </select>
      </h3>

      {!prev && (
        <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:'-4px 0 12px' }}>
          No data for {MON[m]} {y - 1} yet — showing {MON[m]} {y} on its own.
        </p>
      )}

      <div style={{ display:'flex', gap:24, flexWrap:'wrap', alignItems:'flex-start' }}>
        <div style={{ flex:'1 1 420px' }}>
        <div style={{ overflowX:'auto', background:D.card, border:`1px solid ${D.border}`, borderRadius:7 }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>
                <th style={th(false)}>Metric</th>
                <th style={th(true)}>{MON[m]} {y - 1}</th>
                <th style={th(true)}>{MON[m]} {y}</th>
                <th style={th(true)}>Change</th>
                <th style={th(true)}>%</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map(({ label, cur: c, prev: p, goodUp, isPct, cogsDep }) => {
                const has = p != null && c != null
                const d = has ? c - p : null
                const flagged = cogsDep && (curNoCogs || prevNoCogs)
                return (
                  <tr key={label} style={{ borderBottom:`1px solid ${D.border}` }}>
                    <td style={{ ...td, textAlign:'left', fontWeight:500, color:D.navy, whiteSpace:'nowrap' }}>
                      {label}{flagged && <> <CogsFlag>no COGS</CogsFlag></>}
                    </td>
                    <td style={td}>{p != null ? (isPct ? fmtPct(p) : fmt(p)) : '—'}</td>
                    <td style={td}>{c != null ? (isPct ? fmtPct(c) : fmt(c)) : '—'}</td>
                    <td style={{ ...td, fontWeight:600, color: d != null ? deltaColor(d, goodUp) : '#9ca3af' }}>
                      {d != null ? (isPct ? `${d >= 0 ? '+' : ''}${d.toFixed(1)} pp` : `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}`) : '—'}
                    </td>
                    <td style={{ ...td, color: d != null ? deltaColor(d, goodUp) : '#9ca3af' }}>
                      {has && !isPct && p !== 0 ? `${d >= 0 ? '+' : ''}${(d / Math.abs(p) * 100).toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {(curNoCogs || prevNoCogs) && (
          <p style={{ fontSize:10, color:'#92400E', margin:'6px 2px 0', lineHeight:1.5 }}>
            ⚠ No COGS entries recorded for {noCogsLabel} — gross profit, margin, and net profit read high.
          </p>
        )}
        </div>

        {prev && catChanges.length > 0 && (
          <div style={{ flex:'1 1 340px' }}>
            <div style={{ overflowX:'auto', background:D.card, border:`1px solid ${D.border}`, borderRadius:7 }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr>
                    <th style={th(false)}>Biggest Category Changes</th>
                    <th style={th(true)}>{MON[m]} {y - 1}</th>
                    <th style={th(true)}>{MON[m]} {y}</th>
                    <th style={th(true)}>Δ Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {catChanges.map(r => (
                    <tr key={r.name} style={{ borderBottom:`1px solid ${D.border}` }}>
                      <td style={{ ...td, textAlign:'left', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.name}</td>
                      <td style={td}>{fmt(r.prev)}</td>
                      <td style={td}>{fmt(r.cur)}</td>
                      <td style={{ ...td, fontWeight:600, color: deltaColor(r.delta, true) }}>
                        {r.delta >= 0 ? '+' : '−'}{fmt(Math.abs(r.delta))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize:10, color:'rgba(74,74,74,0.55)', margin:'6px 2px 0', lineHeight:1.5 }}>
              Δ Profit is each category's effect on net profit vs {MON[m]} {y - 1}: green = more income or less spending, red = the opposite.
            </p>
          </div>
        )}
      </div>
    </>
  )
}

// ─── Profitability cards ──────────────────────────────────────────────────────

const guideBtn = {
  display:'flex', alignItems:'center', gap:6, flexShrink:0, padding:'6px 13px',
  background:'transparent', color:D.navy, border:`1px solid ${D.border}`, borderRadius:5,
  fontSize:11, fontWeight:500, cursor:'pointer', whiteSpace:'nowrap',
}

const cardStyle = { background:D.card, border:`1px solid ${D.border}`, borderRadius:7, padding:'14px 16px', display:'flex', flexDirection:'column' }
const cardLabel = { fontSize:9.5, fontWeight:700, color:D.gold, textTransform:'uppercase', letterSpacing:'.07em', marginBottom:6 }
const cardBig   = { fontSize:22, fontWeight:600, color:D.navy, lineHeight:1.2 }
const cardSub   = { fontSize:10, color:'rgba(74,74,74,0.6)', marginTop:4, lineHeight:1.5 }

function BreakevenCard({ be, noCogs = false }) {
  if (!be) return null
  const onTarget = be.breakevenRevenue != null && be.avgRevenue >= be.breakevenRevenue
  return (
    <div style={{ ...cardStyle, borderTop:`3px solid ${onTarget && !noCogs ? D.success : D.amber}` }}>
      <CardLabel info={<>Your fixed monthly costs divided by your gross margin — the sales you
        need in a month just to cover the shop. Because it leans on margin, it&apos;s only as
        accurate as your COGS records.</>}>Breakeven Sales Target</CardLabel>
      <div style={cardBig}>{be.breakevenRevenue != null ? fmt(be.breakevenRevenue) + '/mo' : '—'}</div>
      <div style={cardSub}>
        {fmt(be.fixedMonthly)}/mo {be.usingTags ? 'fixed costs' : 'operating costs'} ÷ {fmtPct(be.avgMarginPct)} gross margin
        {!be.usingTags && <> · tag expenses fixed/variable in Chart of Accounts to sharpen this</>}
      </div>
      {be.breakevenRevenue != null && (
        <div style={{ marginTop:10 }}>
          <div style={{ height:6, background:'#EAE7E0', borderRadius:3, overflow:'hidden' }}>
            <div style={{ width:`${Math.min(100, be.gapPct)}%`, height:'100%', background: onTarget ? D.success : D.amber, borderRadius:3 }} />
          </div>
          <div style={{ fontSize:10, marginTop:5, color: onTarget ? D.success : D.amber, fontWeight:600 }}>
            {onTarget
              ? `Above breakeven — averaging ${fmt(be.avgRevenue)}/mo`
              : `Averaging ${fmt(be.avgRevenue)}/mo — ${fmt(be.breakevenRevenue - be.avgRevenue)} to go`}
          </div>
        </div>
      )}
      {noCogs && (
        <div style={{ marginTop:8 }}>
          <CogsFlag>no COGS — real breakeven is higher</CogsFlag>
        </div>
      )}
    </div>
  )
}

function RunwayCard({ runway, cash, onSave, noCogs = false }) {
  const [editing, setEditing] = useState(!cash)
  const [val, setVal] = useState(cash?.amount ?? '')
  const save = () => {
    const n = parseFloat(String(val).replace(/[$,\s]/g, ''))
    if (!isNaN(n)) { onSave(n); setEditing(false) }
  }
  return (
    <div style={{ ...cardStyle, borderTop:`3px solid ${runway?.weeks != null && runway.weeks < 8 ? D.danger : D.steel}` }}>
      <CardLabel info={<>The bank balance you typed in, divided by your average monthly spend.
        This is the one number the app can&apos;t read for itself — it stays as you left it, so
        update it whenever you check. A low balance right after a big inventory buy is normal;
        the money is on the shelf, not gone.</>}>Cash Runway</CardLabel>
      {editing ? (
        <div>
          <div style={{ fontSize:10.5, color:D.charcoal, marginBottom:6 }}>Enter your current bank balance:</div>
          <div style={{ display:'flex', gap:6 }}>
            <input
              style={{ flex:1, minWidth:0, padding:'5px 8px', border:`1px solid ${D.border}`, borderRadius:5, fontSize:12, outline:'none' }}
              value={val} onChange={e => setVal(e.target.value)} placeholder="$12,500"
              onKeyDown={e => e.key === 'Enter' && save()}
            />
            <button onClick={save} style={{ padding:'5px 12px', background:D.navy, color:'#fff', border:'none', borderRadius:5, fontSize:11, cursor:'pointer' }}>Save</button>
          </div>
        </div>
      ) : (
        <>
          <div style={cardBig}>
            {runway?.weeks != null ? `${runway.weeks.toFixed(0)} weeks` : fmt(cash?.amount)}
          </div>
          <div style={cardSub}>
            {fmt(cash?.amount)} on hand as of {cash?.asOf}
            {runway?.avgMonthlyExpense > 0 && <> · burning ~{fmt(runway.avgMonthlyExpense)}/mo</>}
            {' · '}
            <button onClick={() => { setVal(cash?.amount ?? ''); setEditing(true) }}
              style={{ background:'none', border:'none', color:D.steel, fontSize:10, cursor:'pointer', padding:0, textDecoration:'underline' }}>
              update
            </button>
          </div>
          {noCogs && runway?.weeks != null && (
            <div style={{ marginTop:8 }}>
              <CogsFlag>burn excludes inventory buys — runway reads long</CogsFlag>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SalesTaxCard({ tax, year }) {
  if (!tax) return (
    <div style={{ ...cardStyle, borderTop:`3px solid ${D.border}` }}>
      <CardLabel info={<>Sales tax you collected (from your Square reports) minus sales tax
        you&apos;ve already paid (from bank transactions). Upload a Square report to switch
        this on.</>}>Sales Tax Set-Aside</CardLabel>
      <div style={{ fontSize:11, color:'rgba(74,74,74,0.6)', lineHeight:1.6 }}>
        Upload Square reports to track tax collected vs. paid.
      </div>
    </div>
  )
  // Prefer the liability account's running balance (accruals − remittances)
  // over the YTD collected-vs-paid net once accrual entries exist.
  const owed = tax.liability ?? tax.owed
  const prepaid = tax.liability != null && tax.liability < 0
  return (
    <div style={{ ...cardStyle, borderTop:`3px solid ${owed > 0 ? D.amber : D.success}` }}>
      <CardLabel info={<>Sales tax collected belongs to the state, not the business. Each Square
        report&apos;s tax portion accrues to the Sales Tax Payable liability; remittance payments
        reduce it. This is the balance still owed — park it for the next filing.</>}>
        {tax.liability != null ? 'Sales Tax Liability' : `Sales Tax Set-Aside · ${year}`}
      </CardLabel>
      <div style={{ ...cardBig, color: owed > 0 ? D.amber : D.success }}>{fmt(Math.max(0, owed))}</div>
      <div style={cardSub}>
        {tax.liability != null
          ? (prepaid
              ? `Remitted ${fmt(-tax.liability)} ahead of accruals — advance payments, or a Square report not yet uploaded and accrued.`
              : owed > 0
                ? 'Accrued from Square reports minus remittances. Keep this parked for the next filing.'
                : 'Accruals fully remitted.')
          : <>{fmt(tax.collected)} collected − {fmt(tax.paid)} paid.{owed > 0 ? ' Keep this amount parked for the next filing.' : ' Fully remitted.'}</>}
      </div>
    </div>
  )
}

function ChecklistCard({ cl }) {
  const items = [
    { ok: cl.bankImported,   label: `Bank transactions imported` },
    { ok: cl.squareUploaded, label: `Square report uploaded` },
    { ok: cl.allCategorized, label: cl.allCategorized ? 'Everything categorized' : `${cl.uncatCount} uncategorized transaction${cl.uncatCount !== 1 ? 's' : ''}` },
    { ok: cl.cogsBooked,     label: cl.cogsBooked ? 'COGS booked' : 'COGS not booked' },
    ...(cl.taxApplicable ? [{ ok: cl.taxAccrued, label: cl.taxAccrued ? 'Sales tax accrued' : 'Sales tax not accrued' }] : []),
    ...(cl.isQuarterEnd ? [{ ok: cl.countEntered, label: cl.countEntered ? 'Quarterly count entered' : 'Quarterly count due' }] : []),
  ]
  const done = items.filter(i => i.ok).length
  return (
    <div style={{ ...cardStyle, borderTop:`3px solid ${done === items.length ? D.success : D.amber}` }}>
      <CardLabel info={<>A month is finished when its bank activity is imported, the Square
        report is uploaded, and nothing is left uncategorized. Until all three are done, every
        other figure on this page is working from incomplete data.</>}>Monthly Close · {cl.label}</CardLabel>
      <div style={{ display:'flex', flexDirection:'column', gap:5, marginTop:2 }}>
        {items.map((it, i) => (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:7, fontSize:11, color: it.ok ? D.charcoal : D.amber, fontWeight: it.ok ? 400 : 600 }}>
            <span style={{
              flexShrink:0, width:14, height:14, borderRadius:'50%', display:'inline-flex', alignItems:'center', justifyContent:'center',
              background: it.ok ? '#D1E8D4' : '#FEF3C7', color: it.ok ? '#1A5C28' : '#92400E', fontSize:9, fontWeight:700,
            }}>{it.ok ? '✓' : '!'}</span>
            {it.label}
          </div>
        ))}
      </div>
      <div style={{ ...cardSub, marginTop:8 }}>{done}/{items.length} done for {cl.label}</div>
    </div>
  )
}

// ─── Category margin table ────────────────────────────────────────────────────

function MarginTable({ margins, year, cogsPct, onSavePct }) {
  const [drafts, setDrafts] = useState({})
  return (
    <>
      <SectionTitle
        info={<>Square tells us what each product line sold for; your logged inventory buys (or
          an estimated COGS %) tell us what it cost. The gap is the margin. This is the clearest
          read on whether inventory is turning at a healthy price.</>}
      >Margin by Product Line · {year}</SectionTitle>
      <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:'-8px 0 12px' }}>
        Square revenue per category with cost of goods from your logged buys — or set an estimated COGS %
        until buys are logged. This shows which lines actually pay the rent.
      </p>
      <div style={{ overflowX:'auto', background:D.card, border:`1px solid ${D.border}`, borderRadius:7, marginBottom:8 }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr>
              {['Category', 'Revenue', 'COGS', 'COGS Source', 'Margin $', 'Margin %'].map((h, i) => (
                <th key={h} style={{ textAlign: i === 0 || i === 3 ? 'left' : 'right', padding:'7px 12px', background:D.page, fontSize:9.5, fontWeight:700, color:D.gold, textTransform:'uppercase', letterSpacing:'.06em', whiteSpace:'nowrap', borderBottom:`2px solid ${D.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {margins.map(m => {
              const draft = drafts[m.name]
              return (
                <tr key={m.name} style={{ borderBottom:`1px solid ${D.border}` }}>
                  <td style={{ padding:'7px 12px', fontSize:12, fontWeight:500, color:D.navy }}>{m.name}</td>
                  <td style={{ padding:'7px 12px', fontSize:11.5, textAlign:'right', fontVariantNumeric:'tabular-nums', color:D.charcoal }}>{fmt(m.revenue)}</td>
                  <td style={{ padding:'7px 12px', fontSize:11.5, textAlign:'right', fontVariantNumeric:'tabular-nums', color:D.charcoal }}>{m.cogs != null ? fmt(m.cogs) : '—'}</td>
                  <td style={{ padding:'7px 12px', fontSize:10.5 }}>
                    {m.cogsSource === 'buys' ? (
                      <span style={{ color:D.success, fontWeight:600 }}>logged buys</span>
                    ) : (
                      <span style={{ display:'inline-flex', alignItems:'center', gap:4, color:'rgba(74,74,74,0.7)' }}>
                        est.
                        <input
                          style={{ width:44, padding:'2px 5px', border:`1px solid ${D.border}`, borderRadius:4, fontSize:10.5, textAlign:'right', outline:'none' }}
                          value={draft ?? (cogsPct[m.name] ?? '')}
                          placeholder="%"
                          onChange={e => setDrafts(p => ({ ...p, [m.name]: e.target.value }))}
                          onBlur={() => {
                            if (draft === undefined) return
                            const n = parseFloat(draft)
                            onSavePct(m.name, isNaN(n) ? null : Math.max(0, Math.min(100, n)))
                            setDrafts(p => { const c = { ...p }; delete c[m.name]; return c })
                          }}
                          onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
                        />%
                      </span>
                    )}
                  </td>
                  <td style={{ padding:'7px 12px', fontSize:11.5, textAlign:'right', fontVariantNumeric:'tabular-nums', fontWeight:600, color: m.margin == null ? '#9ca3af' : m.margin >= 0 ? D.success : D.danger }}>
                    {m.margin != null ? fmt(m.margin) : '—'}
                  </td>
                  <td style={{ padding:'7px 12px', fontSize:11.5, textAlign:'right', fontVariantNumeric:'tabular-nums', color: m.marginPct == null ? '#9ca3af' : D.charcoal }}>
                    {m.marginPct != null ? fmtPct(m.marginPct) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
