import { normKey } from './merchantClustering'

// Business-insight computations for the dashboard. All pure functions.
// Sign convention: revenue positive, expenses negative (matches the DB).

// ─── Monthly P&L ──────────────────────────────────────────────────────────────
// The shape nearly everything else here consumes: one row per month with data,
// sorted by period. Categories with no section fall back to Operating Expenses,
// matching the rest of the app. Revenue is NET of Deductions to Income, and
// `cogs`/`totalOpex` are flipped positive because they read as "money spent".

export function buildMonthlyPL({ txns, sectionMap }) {
  const byMonth = {}
  txns.forEach(t => {
    const ym = (t.transaction_date || '').slice(0, 7)
    if (!ym || !t.category) return
    const section = sectionMap[t.category] ?? 'Operating Expenses'
    if (!byMonth[ym]) byMonth[ym] = {}
    byMonth[ym][section] = (byMonth[ym][section] ?? 0) + (Number(t.amount) || 0)
  })
  return Object.keys(byMonth).sort().map(ym => {
    const d = byMonth[ym]
    const [y, m] = ym.split('-')
    const revSum   = d['Revenue']                ?? 0
    const dedSum   = d['Deductions to Income']   ?? 0
    const cogsSum  = d['Cost of Goods Sold']     ?? 0
    const opexSum  = d['Operating Expenses']     ?? 0
    const nonOpInc = d['Non-Operating Income']   ?? 0
    const nonOpExp = d['Non-Operating Expenses'] ?? 0
    const netRev      = revSum + dedSum
    const grossProfit = netRev + cogsSum
    const netProfit   = grossProfit + opexSum + nonOpInc + nonOpExp
    return {
      period: ym, year: +y, month: +m,
      revenue: netRev,
      cogs: -cogsSum,
      grossProfit,
      grossMarginPct: netRev > 0 ? (grossProfit / netRev * 100) : null,
      totalOpex: -opexSum,
      netProfit,
    }
  })
}

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
    if (t.account === ADJUSTMENTS_ACCOUNT) return // COGS/true-up entries aren't bills
    // Cash pulled from the bank (here, mostly to buy collections) is regular
    // enough to pass the consistency filter, but there is no vendor behind it.
    if (/\b(ATM|CASH) WITHDRAWAL\b/i.test(t.description || '')) return
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

// ─── Year-end projection ──────────────────────────────────────────────────────
// Where the year lands if the rest of it behaves like the year so far.
//
// Each remaining month is projected from the SAME month last year, scaled by
// how this year is actually running against last year over the months both
// share. That keeps last year's seasonal shape (a card shop's December is not
// its February) while letting this year's trend set the level. Without a
// comparable prior month the month falls back to this year's own average.
//
// Only COMPLETE months count as actual: the in-progress month is projected
// along with the rest, because a month that is three days old would otherwise
// drag every average down. Complete months that were never imported are
// projected too — a year-end total has to cover all twelve either way — and
// counted in `gapMonths` so the dashboard can say so.

const PL_KEYS = ['revenue', 'cogs', 'totalOpex', 'nonOperating']

// netProfit = grossProfit − totalOpex + non-operating, so the residual is what
// the monthly P&L rows don't break out on their own.
const nonOperating = r => r.netProfit - r.grossProfit + r.totalOpex

const sumKey = (rows, key) =>
  rows.reduce((s, r) => s + (key === 'nonOperating' ? nonOperating(r) : (r[key] ?? 0)), 0)

// Revenue − COGS and the bottom line are derived, never projected directly, so
// the projected P&L still adds up the way the actual one does.
const derive = t => ({
  ...t,
  grossProfit: t.revenue - t.cogs,
  netProfit: t.revenue - t.cogs - t.totalOpex + t.nonOperating,
})

export function computeYearEndProjection({ monthlyPL, year, now = new Date() }) {
  // Only the live year can be projected; a past year is simply what it was.
  if (!year || year !== now.getFullYear()) return null

  const curMonth = now.getMonth() + 1
  const actual = monthlyPL.filter(r => r.year === year && r.month < curMonth)
  if (!actual.length) return null

  const actualMonths = actual.map(r => r.month)
  const missing = Array.from({ length: 12 }, (_, i) => i + 1).filter(m => !actualMonths.includes(m))
  if (!missing.length) return null // year already fully banked

  const prevYear = year - 1
  const prev = monthlyPL.filter(r => r.year === prevYear)

  // Growth is measured only over months BOTH years completed, so a part-year
  // is never scored against a full one.
  const overlap = actualMonths.filter(m => prev.some(p => p.month === m))
  const growth = {}
  PL_KEYS.forEach(key => {
    // Non-operating items are small, lumpy and can be negative — ratio-scaling
    // them produces nonsense, so they always run off this year's average.
    if (key === 'nonOperating' || overlap.length < 2) { growth[key] = null; return }
    const curSum = sumKey(actual.filter(r => overlap.includes(r.month)), key)
    const prevSum = sumKey(prev.filter(r => overlap.includes(r.month)), key)
    if (!(prevSum > 0) || !(curSum > 0)) { growth[key] = null; return }
    // Guard against a thin prior year turning into an implausible multiplier.
    growth[key] = Math.min(5, Math.max(0.2, curSum / prevSum))
  })

  const avg = {}
  PL_KEYS.forEach(key => { avg[key] = sumKey(actual, key) / actual.length })

  const monthly = []
  const seasonal = []
  for (let m = 1; m <= 12; m++) {
    const row = actual.find(r => r.month === m)
    if (row) {
      monthly.push(derive({
        month: m, projected: false,
        revenue: row.revenue, cogs: row.cogs, totalOpex: row.totalOpex, nonOperating: nonOperating(row),
      }))
      continue
    }
    const prevRow = prev.find(p => p.month === m)
    const vals = {}
    let usedSeasonal = false
    PL_KEYS.forEach(key => {
      const g = growth[key]
      if (prevRow && g != null) {
        vals[key] = sumKey([prevRow], key) * g
        usedSeasonal = true
      } else {
        vals[key] = avg[key]
      }
    })
    if (usedSeasonal) seasonal.push(m)
    monthly.push(derive({ month: m, projected: true, basis: usedSeasonal ? 'seasonal' : 'runrate', ...vals }))
  }

  const totalsOf = rows => derive(Object.fromEntries(PL_KEYS.map(k => [k, sumKey(rows, k)])))
  const actualTotals = totalsOf(actual)
  const projectedTotals = totalsOf(monthly.filter(r => r.projected))
  const yearEnd = derive(Object.fromEntries(PL_KEYS.map(k => [k, actualTotals[k] + projectedTotals[k]])))

  return {
    year, prevYear: prev.length ? prevYear : null,
    actualMonths, projectedMonths: missing,
    // Complete months with no data at all — projected here, but really they
    // just need importing, so the dashboard nudges rather than pretends.
    gapMonths: missing.filter(m => m < curMonth),
    basis: seasonal.length === missing.length ? 'seasonal' : (seasonal.length ? 'mixed' : 'runrate'),
    seasonalMonths: seasonal,
    growth,
    revenueGrowthPct: growth.revenue != null ? (growth.revenue - 1) * 100 : null,
    actual: actualTotals,
    projected: projectedTotals,
    yearEnd,
    prevTotal: prev.length ? { ...totalsOf(prev), months: prev.length } : null,
    monthly,
    prevMonthly: prev.map(r => ({ month: r.month, revenue: r.revenue })),
    confidence: actual.length >= 6 && overlap.length >= 2 ? 'high'
      : actual.length >= 3 ? 'medium' : 'low',
  }
}

// ─── Sales tax set-aside ──────────────────────────────────────────────────────
// Since the liability migration (2026-08), collected tax accrues to the
// 'Sales Tax Payable' account and remittances reduce it; `liability` is that
// account's running balance (negative = paid ahead of accruals). Pre-cutover
// payments live in 'Sales Taxes'/'Sales Taxes Paid' (revenue-deduction era).

const TAX_PAYMENT_CATS = new Set(['Sales Taxes', 'Sales Taxes Paid', 'Sales Tax Payable'])

export function computeSalesTax({ squareReports, txns, year }) {
  const collected = squareReports
    .filter(r => (r.period || '').startsWith(String(year)))
    .reduce((s, r) => s + (Number(r.tax_collected) || 0), 0)

  // Real remittances only: negative cash rows, never the accrual journal rows.
  const paid = txns
    .filter(t => TAX_PAYMENT_CATS.has(stripAcctNum(t.category))
      && t.account !== ADJUSTMENTS_ACCOUNT
      && (Number(t.amount) || 0) < 0
      && (t.transaction_date || '').startsWith(String(year)))
    .reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0)

  const liabilityRows = txns.filter(t => hasRole(t.category, 'Sales Tax Payable'))
  const liability = liabilityRows.length
    ? Math.round(liabilityRows.reduce((s, t) => s + (Number(t.amount) || 0), 0) * 100) / 100
    : null

  if (!collected && !paid && liability == null) return null
  return { collected, paid, owed: collected - paid, liability }
}

// Sales-tax accrual proposal for one month: the Square report's tax_collected,
// flagged booked once the accrual pair exists. Null when there's no report or
// no tax that month.
// Square's processing fee for a month, as a gross-up proposal. `booked` keys on
// the description rather than the category, because Bank & Credit Card Fees
// holds ordinary bank charges too — a month with an ATM fee is not a month
// whose Square fee has been booked.
// ─── Square ↔ bank reconciliation ────────────────────────────────────────────
// Two lanes. CARD: the report's card collections minus fees is what Square
// eventually deposits; the bank's Square Deposits rows are what arrived.
// CASH: the register knows what was collected; the bank knows what was
// deposited. Monthly deltas are timing noise — a payout or a drive to the
// bank crossing month-end — so the CUMULATIVE line carries the signal. Card
// cumulative should hover near a few days of card volume (the in-transit
// float). Cash cumulative should hover near zero: persistently negative means
// collected cash isn't reaching the bank (an unrecorded owner draw, or till
// cash spent directly); persistently positive means the bank receives cash
// the register never rang.

export function computeSquareReconciliation({ reports, txns }) {
  if (!reports?.length) return null

  const lanes = { card: {}, cash: {} }
  txns.forEach(t => {
    if (t.account === ADJUSTMENTS_ACCOUNT) return // gross-ups aren't deposits
    const role = stripAcctNum(t.category)
    const lane = role === 'Square Deposits' ? 'card' : role === 'Cash Deposits' ? 'cash' : null
    if (!lane) return
    const ym = (t.transaction_date || '').slice(0, 7)
    if (ym) lanes[lane][ym] = (lanes[lane][ym] ?? 0) + (Number(t.amount) || 0)
  })

  const sorted = [...reports]
    .filter(r => r.period)
    .sort((a, b) => a.period.localeCompare(b.period))
  let cardCum = 0, cashCum = 0
  const r2 = n => Math.round(n * 100) / 100
  const rows = sorted.map(r => {
    const cardExpected  = r2((Number(r.card_amount) || 0) - (Number(r.fees) || 0))
    const cashCollected = r2(Number(r.cash_amount) || 0)
    const cardGot  = r2(lanes.card[r.period] ?? 0)
    const cashGot  = r2(lanes.cash[r.period] ?? 0)
    const cardDelta = r2(cardGot - cardExpected)
    const cashDelta = r2(cashGot - cashCollected)
    cardCum = r2(cardCum + cardDelta)
    cashCum = r2(cashCum + cashDelta)
    // A month whose delta dwarfs normal timing float is its own signal —
    // usually a partial report (both lanes spike) or a miscategorized deposit.
    const anomaly = Math.abs(cardDelta) > Math.max(500, Math.abs(cardExpected) * 0.2)
      || Math.abs(cashDelta) > Math.max(500, Math.abs(cashCollected) * 0.2)
    return { period: r.period, cardExpected, cardGot, cardDelta, cardCum, cashCollected, cashGot, cashDelta, cashCum, anomaly }
  })

  // Tolerance per lane: five days of recent average daily volume, floored.
  const recent = sorted.slice(-3)
  const daily = key => recent.reduce((s, r) => s + (Number(r[key]) || 0), 0) / ((recent.length || 1) * 30)
  const tol = key => r2(Math.max(1000, daily(key) * 5))
  const cardTolerance = tol('card_amount')
  const cashTolerance = tol('cash_amount')
  return {
    rows,
    card: { cumulative: cardCum, tolerance: cardTolerance, state: Math.abs(cardCum) <= cardTolerance ? 'ok' : 'drift' },
    cash: { cumulative: cashCum, tolerance: cashTolerance, state: Math.abs(cashCum) <= cashTolerance ? 'ok' : 'drift' },
  }
}

// Sum of an already-booked leg, or null when nothing is booked. Distinguishing
// "not booked" from "booked as zero" is what lets a re-upload be detected.
const bookedLeg = (txns, match) => {
  const rows = txns.filter(match)
  return rows.length ? round2(-rows.reduce((s, t) => s + (Number(t.amount) || 0), 0)) : null
}

// A proposal is `booked` only when the ledger AGREES with the report. Re-upload
// a Square report with corrected figures and the old entry is now wrong — it is
// reported as `stale` so the close screen can offer to replace it, rather than
// silently leaving the books disagreeing with the report they came from.
const proposal = (amount, booked) => ({
  amount,
  bookedAmount: booked,
  booked: booked != null && Math.abs(booked - amount) < 0.005,
  stale:  booked != null && Math.abs(booked - amount) >= 0.005,
})

export function computeSquareFeeProposal({ month, squareReports, txns }) {
  if (!month) return null
  const fees = Number(squareReports.find(r => r.period === month)?.fees) || 0
  if (fees <= 0) return null
  return proposal(
    round2(fees),
    bookedLeg(txns, t => (t.description || '').startsWith(`SQUARE FEES — ${month}`)))
}

export function computeTaxAccrualProposal({ month, squareReports, txns }) {
  if (!month) return null
  const tax = Number(squareReports.find(r => r.period === month)?.tax_collected) || 0
  if (tax <= 0) return null
  return proposal(
    round2(tax),
    bookedLeg(txns, t => hasRole(t.category, 'Sales Tax Collected')
      && (t.transaction_date || '').startsWith(month)))
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

// `month` ('YYYY-MM') overrides the default for callers that close an arbitrary
// month; omitting it keeps the original "most recent complete month" behaviour.

export function computeCloseChecklist({ txns, squareReports, uncatCount, prevMonthTxnCount = null, counts = [], month = null, now = new Date() }) {
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const defaultYm = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
  const ym = month || defaultYm
  const [yNum, mNum] = ym.split('-').map(Number)
  const label = new Date(yNum, mNum - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' })
  const isQuarterEnd = [3, 6, 9, 12].includes(mNum)

  // prevMonthTxnCount describes the DEFAULT month only — for any other month it
  // would be the wrong answer, so fall back to scanning the rows we were given.
  const useProvidedCount = prevMonthTxnCount != null && ym === defaultYm

  return {
    month: ym,
    label,
    bankImported: useProvidedCount
      ? prevMonthTxnCount > 0
      : txns.some(t => (t.transaction_date || '').startsWith(ym)),
    squareUploaded: squareReports.some(r => r.period === ym),
    allCategorized: uncatCount === 0,
    uncatCount,
    cogsBooked: txns.some(t => hasRole(t.category, 'Product Costs') && (t.transaction_date || '').startsWith(ym)),
    taxApplicable: squareReports.some(r => r.period === ym && (Number(r.tax_collected) || 0) > 0),
    taxAccrued: txns.some(t => hasRole(t.category, 'Sales Tax Collected') && (t.transaction_date || '').startsWith(ym)),
    isQuarterEnd,
    // The count is typically entered a few days into the next month (count
    // Sep 30, type it in Oct 2) — accept any count from the quarter's final
    // month onward.
    countEntered: !isQuarterEnd || (counts || []).some(c => (c.date || '') >= `${ym}-01`),
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

// ─── COGS booking + Open to Buy (gross margin method — see COGS_PLAN.md) ──────
// Adjustment entries are zero-net pairs in bank_transactions marked with this
// account value; everything below treats them as journal entries, not cash.

export const ADJUSTMENTS_ACCOUNT = 'Adjustments'

// Chart accounts get renamed with numbering prefixes ("3000 Product Costs",
// "2100 Sales Tax Collected"). Role hooks — COGS booking, tax accrual, the
// inventory balance — match with any leading number stripped so renames don't
// orphan them, and resolve the chart's actual current name when inserting.
export const stripAcctNum = name => String(name || '').replace(/^\d+\s+/, '')
const hasRole = (category, role) => stripAcctNum(category) === role
export const resolveRoleName = (accounts, role) =>
  accounts.find(a => stripAcctNum(a.name) === role)?.name ?? role

const round2 = n => Math.round(n * 100) / 100
const pctToRatio = p => {
  const n = Number(p)
  return Number.isFinite(n) && n > 0 ? n / 100 : null
}

export const lastDayOfMonth = ym => {
  const [y, m] = ym.split('-').map(Number)
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
}

// Proposed COGS entry for one month. Hybrid when the month's Square report has
// a real Sealed Products breakdown and both hybrid ratios are set; blended
// fallback otherwise. Ratios are stored as percents (0–100) in `cogs_method`.
export function computeCogsProposal({ month, monthlyPL, squareReports, method }) {
  if (!month || !method) return null
  const revenue = monthlyPL.find(r => r.period === month)?.revenue ?? 0
  if (revenue <= 0) return null

  const report = squareReports.find(r => r.period === month)
  const cats = Array.isArray(report?.categories) ? report.categories : []
  const sealed = Number(cats.find(c => c.name === 'Sealed Products')?.amount) || 0
  const sealedRatio = pctToRatio(method.sealedCostRatio)
  const restRatio = pctToRatio(method.restPct)
  const blendedRatio = pctToRatio(method.blendedPct)

  if (sealed > 0 && sealedRatio != null && restRatio != null) {
    const other = Math.max(0, (Number(report.gross_sales) || 0) - sealed)
    return {
      formula: 'hybrid',
      amount: round2(sealed * sealedRatio + other * restRatio),
      parts: { sealed, other, sealedPct: Number(method.sealedCostRatio), restPct: Number(method.restPct) },
    }
  }
  if (blendedRatio == null) return null
  return {
    formula: 'blended',
    amount: round2(revenue * blendedRatio),
    parts: { revenue, blendedPct: Number(method.blendedPct) },
  }
}

// Positive book value of the Inventory asset (purchases are negative amounts,
// relief entries positive, so the balance is minus the category sum).
export function inventoryBookBalance(txns) {
  return round2(-txns
    .filter(t => hasRole(t.category, 'Inventory'))
    .reduce((s, t) => s + (Number(t.amount) || 0), 0))
}

// ─── Open to Buy ──────────────────────────────────────────────────────────────
// "How much can we spend on inventory this week without endangering the fixed
// obligations?" Reserve = trailing avg monthly OpEx + avg credit-card payment
// + sales-tax set-aside + cash floor. Deliberately conservative: a full
// month-sized obligation window, even if some bills already cleared (the cash
// entry already reflects them, so any double-count errs toward caution).

export function computeOpenToBuy({ cash, txns, monthlyPL, salesTax, budget, registry = [], now = new Date() }) {
  if (cash?.amount == null) return null

  // Card payments come from whatever categories the ledger registry binds to a
  // card, so a second card with its own payment category still counts toward
  // the reserve. Falls back to the single default when no registry is set up.
  const cardRoles = new Set(
    (registry || [])
      .filter(e => e.type === 'card')
      .flatMap(e => e.boundCategories || [])
      .map(stripAcctNum)
  )
  if (!cardRoles.size) cardRoles.add('Credit Card Payment')

  // Trailing 3 COMPLETE months — the in-progress month would drag averages down.
  const nowYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const recent = monthlyPL.filter(r => r.period < nowYM).slice(-3)
  if (!recent.length) return null
  const months = new Set(recent.map(r => r.period))
  const n = recent.length

  // Cash movements only — Adjustments rows are journal entries, not spending.
  const sumCat = role => txns.reduce((s, t) =>
    (hasRole(t.category, role) && t.account !== ADJUSTMENTS_ACCOUNT
      && months.has((t.transaction_date || '').slice(0, 7)))
      ? s + (Number(t.amount) || 0) : s, 0)

  const avgOpex = recent.reduce((s, r) => s + r.totalOpex, 0) / n
  const ccMonthly = Math.max(0, -[...cardRoles].reduce((s, role) => s + sumCat(role), 0) / n)
  // Prefer the liability balance (what's actually owed) over the YTD net.
  const taxOwed = Math.max(0, salesTax?.liability ?? salesTax?.owed ?? 0)
  const floor = Math.max(0, Number(budget?.cashFloor) || 0)
  const haircut = Number(budget?.depositHaircut) > 0 ? Number(budget.depositHaircut) : 0.8

  const reserve = round2(avgOpex + ccMonthly + taxOwed + floor)
  const availableNow = Math.max(0, round2(cash.amount - reserve))
  const weeklyDeposits = round2((recent.reduce((s, r) => s + r.revenue, 0) / n) / 4.33 * haircut)
  const availableUpper = round2(availableNow + weeklyDeposits)
  const weeklyBuys = round2(Math.max(0, -sumCat('Inventory')) / n / 4.33)

  const staleDays = cash.asOf
    ? Math.floor((now - new Date(`${cash.asOf}T00:00:00`)) / 86400000)
    : null
  return {
    reserve,
    breakdown: { avgOpex: round2(avgOpex), ccMonthly: round2(ccMonthly), taxOwed: round2(taxOwed), floor },
    availableNow,
    availableUpper,
    weeklyDeposits,
    weeklyBuys,
    state: availableNow <= 0 ? 'hold' : (weeklyBuys > 0 && availableNow < weeklyBuys ? 'tight' : 'healthy'),
    stale: staleDays == null || staleDays > 7,
    staleDays,
  }
}
