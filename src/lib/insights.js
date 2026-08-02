import { normKey } from './merchantClustering'

// Business-insight computations for the dashboard. All pure functions.
// Sign convention: revenue positive, expenses negative (matches the DB).

// ─── Breakeven ────────────────────────────────────────────────────────────────
// Monthly revenue needed to cover fixed costs at the current gross margin.
// Fixed costs come from accounts tagged cost_type='fixed'; if nothing is
// tagged yet, all operating expenses are treated as fixed (conservative).

export function computeBreakeven({ txns, accounts, sectionMap, monthlyPL, year }) {
  const yearRows = monthlyPL.filter(r => r.year === year)
  if (!yearRows.length) return null

  const monthCount = yearRows.length
  const marginRows = yearRows.filter(r => r.grossMarginPct != null)
  const avgMarginPct = marginRows.length
    ? marginRows.reduce((s, r) => s + r.grossMarginPct, 0) / marginRows.length
    : null

  const fixedNames = new Set(accounts.filter(a => a.cost_type === 'fixed').map(a => a.name))
  const usingTags = fixedNames.size > 0

  let fixedTotal = 0
  txns.forEach(t => {
    if (!t.category) return
    if ((t.transaction_date || '').slice(0, 4) !== String(year)) return
    if (usingTags) {
      if (fixedNames.has(t.category)) fixedTotal += Number(t.amount) || 0
    } else {
      if ((sectionMap[t.category] ?? 'Operating Expenses') === 'Operating Expenses')
        fixedTotal += Number(t.amount) || 0
    }
  })
  const fixedMonthly = -fixedTotal / monthCount // expenses are negative

  const avgRevenue = yearRows.reduce((s, r) => s + r.revenue, 0) / monthCount

  const breakevenRevenue = (avgMarginPct && avgMarginPct > 0)
    ? fixedMonthly / (avgMarginPct / 100)
    : null

  return {
    fixedMonthly,
    avgMarginPct,
    avgRevenue,
    breakevenRevenue,
    usingTags,
    gapPct: breakevenRevenue ? (avgRevenue / breakevenRevenue) * 100 : null,
  }
}

// ─── Recurring expenses ───────────────────────────────────────────────────────
// Merchant groups that hit in 3+ distinct months with consistent amounts.
// Flags a "spike" when the latest charge is 25%+ above the running average.

export function computeRecurring(txns, { minMonths = 3, maxItems = 8 } = {}) {
  const groups = {}
  txns.forEach(t => {
    const amt = Number(t.amount) || 0
    if (amt >= 0) return // bills only
    const key = normKey(t.description)
    if (!key) return
    if (!groups[key]) groups[key] = { key, displayDesc: t.description, items: [] }
    groups[key].items.push({ date: t.transaction_date || '', amount: -amt })
  })

  const recurring = []
  Object.values(groups).forEach(g => {
    const months = new Set(g.items.map(i => i.date.slice(0, 7)).filter(Boolean))
    if (months.size < minMonths) return
    const amounts = g.items.map(i => i.amount)
    const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length
    if (avg < 5) return // ignore trivial charges
    const sd = Math.sqrt(amounts.reduce((s, a) => s + (a - avg) ** 2, 0) / amounts.length)
    if (sd / avg > 0.6) return // too erratic to be a "bill"
    const sorted = [...g.items].sort((a, b) => a.date.localeCompare(b.date))
    const last = sorted[sorted.length - 1]
    recurring.push({
      desc: g.displayDesc,
      months: months.size,
      avgAmount: avg,
      lastAmount: last.amount,
      lastDate: last.date,
      monthlyEstimate: avg * (g.items.length / months.size),
      spike: last.amount > avg * 1.25,
    })
  })

  return recurring
    .sort((a, b) => b.monthlyEstimate - a.monthlyEstimate)
    .slice(0, maxItems)
}

// ─── Sales tax set-aside ──────────────────────────────────────────────────────

export function computeSalesTax({ squareReports, txns, year }) {
  const collected = squareReports
    .filter(r => (r.period || '').startsWith(String(year)))
    .reduce((s, r) => s + (Number(r.tax_collected) || 0), 0)

  const paid = txns
    .filter(t => t.category === 'Sales Taxes Paid' && (t.transaction_date || '').startsWith(String(year)))
    .reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0)

  if (!collected && !paid) return null
  return { collected, paid, owed: collected - paid }
}

// ─── Cash runway ──────────────────────────────────────────────────────────────
// cash: { amount, asOf } manually entered. Burn = average monthly expenses.

export function computeRunway({ cash, monthlyPL }) {
  if (!cash?.amount) return null
  const recent = monthlyPL.slice(-6)
  if (!recent.length) return { ...cash, weeks: null }
  const avgMonthlyExpense = recent.reduce((s, r) => s + r.cogs + r.totalOpex, 0) / recent.length
  const weekly = avgMonthlyExpense / 4.33
  return {
    ...cash,
    avgMonthlyExpense,
    weeks: weekly > 0 ? cash.amount / weekly : null,
  }
}

// ─── Monthly close checklist ──────────────────────────────────────────────────
// Checks the most recent COMPLETE month: bank data imported, Square uploaded,
// and nothing left uncategorized. `prevMonthTxnCount` must count ALL of last
// month's bank rows (the dashboard's txns list excludes uncategorized ones);
// the txns fallback exists only for callers that don't have that count.

export function computeCloseChecklist({ txns, squareReports, uncatCount, prevMonthTxnCount = null }) {
  const now = new Date()
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const ym = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
  const label = prev.toLocaleString('default', { month: 'long', year: 'numeric' })

  return {
    month: ym,
    label,
    bankImported: prevMonthTxnCount != null
      ? prevMonthTxnCount > 0
      : txns.some(t => (t.transaction_date || '').startsWith(ym)),
    squareUploaded: squareReports.some(r => r.period === ym),
    allCategorized: uncatCount === 0,
    uncatCount,
  }
}

// ─── Margin by product category ───────────────────────────────────────────────
// Revenue per Square category + COGS from inventory buys (matched by category
// name) with a fallback COGS% estimate → contribution margin per line.

export function computeCategoryMargins({ squareReports, buys, cogsPct, year }) {
  const reports = squareReports.filter(r => (r.period || '').startsWith(String(year)))
  if (!reports.length) return []

  const revenue = {}
  reports.forEach(r => {
    (Array.isArray(r.categories) ? r.categories : []).forEach(c => {
      revenue[c.name] = (revenue[c.name] || 0) + (Number(c.amount) || 0)
    })
  })

  const buyCost = {}
  ;(buys || []).forEach(b => {
    if ((b.buy_date || '').slice(0, 4) !== String(year)) return
    const cat = b.category || 'Uncategorized'
    buyCost[cat] = (buyCost[cat] || 0) + (Number(b.cost) || 0)
  })

  return Object.entries(revenue)
    .map(([name, rev]) => {
      const bought = buyCost[name] || 0
      const pct = cogsPct?.[name]
      const estCogs = bought > 0 ? bought : (pct != null ? rev * (pct / 100) : null)
      return {
        name,
        revenue: rev,
        cogs: estCogs,
        cogsSource: bought > 0 ? 'buys' : (pct != null ? 'estimate' : null),
        margin: estCogs != null ? rev - estCogs : null,
        marginPct: estCogs != null && rev > 0 ? ((rev - estCogs) / rev) * 100 : null,
      }
    })
    .sort((a, b) => b.revenue - a.revenue)
}
