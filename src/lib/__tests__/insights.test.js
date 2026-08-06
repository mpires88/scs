import { describe, it, expect } from 'vitest'
import {
  computeCogsProposal, computeOpenToBuy, inventoryBookBalance, lastDayOfMonth,
  computeRecurring, computeSalesTax, computeCloseChecklist, computeYearEndProjection,
  computeTaxAccrualProposal, computeSquareReconciliation, resolveRoleName, ADJUSTMENTS_ACCOUNT,
} from '../insights'

const METHOD = { sealedCostRatio: 65, restPct: 55, blendedPct: 70 }
const PL = period => ({ period, year: +period.slice(0, 4), month: +period.slice(5), revenue: 40000, totalOpex: 5000, cogs: 0, grossProfit: 40000, netProfit: 35000 })

describe('lastDayOfMonth', () => {
  it('handles 31-day, 30-day, and leap February months', () => {
    expect(lastDayOfMonth('2026-07')).toBe('2026-07-31')
    expect(lastDayOfMonth('2026-06')).toBe('2026-06-30')
    expect(lastDayOfMonth('2024-02')).toBe('2024-02-29')
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28')
  })
})

describe('computeCogsProposal', () => {
  const squareReports = [{
    period: '2026-06', gross_sales: 44715.03,
    categories: [
      { name: 'Sealed Products', amount: 34596.25 },
      { name: 'Singles', amount: 5566.34 },
    ],
  }]

  it('uses the hybrid formula when a sealed breakdown exists', () => {
    const p = computeCogsProposal({ month: '2026-06', monthlyPL: [PL('2026-06')], squareReports, method: METHOD })
    expect(p.formula).toBe('hybrid')
    // sealed 34596.25 × .65 + (44715.03 − 34596.25) × .55
    expect(p.amount).toBeCloseTo(34596.25 * 0.65 + 10118.78 * 0.55, 2)
  })

  it('falls back to blended when the report has no sealed breakdown', () => {
    const noBreakdown = [{ period: '2026-06', gross_sales: 44715.03, categories: [{ name: 'Uncategorized', amount: 44715.03 }] }]
    const p = computeCogsProposal({ month: '2026-06', monthlyPL: [PL('2026-06')], squareReports: noBreakdown, method: METHOD })
    expect(p.formula).toBe('blended')
    expect(p.amount).toBeCloseTo(40000 * 0.7, 2)
  })

  it('falls back to blended when hybrid ratios are missing', () => {
    const p = computeCogsProposal({ month: '2026-06', monthlyPL: [PL('2026-06')], squareReports, method: { blendedPct: 70 } })
    expect(p.formula).toBe('blended')
  })

  it('returns null without a method, without ratios, or without revenue', () => {
    expect(computeCogsProposal({ month: '2026-06', monthlyPL: [PL('2026-06')], squareReports, method: null })).toBeNull()
    expect(computeCogsProposal({ month: '2026-06', monthlyPL: [PL('2026-06')], squareReports: [], method: {} })).toBeNull()
    expect(computeCogsProposal({ month: '2026-05', monthlyPL: [PL('2026-06')], squareReports, method: METHOD })).toBeNull()
  })
})

describe('inventoryBookBalance', () => {
  it('is minus the Inventory category sum, other categories ignored', () => {
    const txns = [
      { category: 'Inventory', amount: -1000 },
      { category: 'Inventory', amount: -500 },
      { category: 'Inventory', amount: 300 },      // relief entry
      { category: 'Product Costs', amount: -300 }, // not inventory
    ]
    expect(inventoryBookBalance(txns)).toBe(1200)
  })
})

describe('computeOpenToBuy', () => {
  const now = new Date('2026-08-03T12:00:00')
  const monthlyPL = [PL('2026-05'), PL('2026-06'), PL('2026-07'), { ...PL('2026-08'), revenue: 900, totalOpex: 10 }]
  const mk = (category, amount, ym, account) => ({ category, amount, transaction_date: `${ym}-15`, account })
  const txns = [
    mk('Credit Card Payment', -300, '2026-05'), mk('Credit Card Payment', -300, '2026-06'), mk('Credit Card Payment', -300, '2026-07'),
    mk('Inventory', -8660, '2026-06'), mk('Inventory', -4330, '2026-07'),
    mk('Inventory', 5000, '2026-07', ADJUSTMENTS_ACCOUNT), // relief entry must not offset buys
  ]
  const cash = { amount: 20000, asOf: '2026-08-03' }
  const budget = { cashFloor: 5000 }
  const salesTax = { owed: 2700 }

  it('builds the reserve from opex, card payments, tax set-aside, and the floor', () => {
    const o = computeOpenToBuy({ cash, txns, monthlyPL, salesTax, budget, now })
    expect(o.breakdown).toEqual({ avgOpex: 5000, ccMonthly: 300, taxOwed: 2700, floor: 5000 })
    expect(o.reserve).toBe(13000)
    expect(o.availableNow).toBe(7000)
    // weekly deposits: 40000 / 4.33 × 0.8, added on top
    expect(o.availableUpper).toBeCloseTo(7000 + (40000 / 4.33) * 0.8, 1)
    expect(o.state).toBe('healthy')
  })

  it('excludes the in-progress month from the trailing averages', () => {
    const o = computeOpenToBuy({ cash, txns, monthlyPL, salesTax, budget, now })
    expect(o.breakdown.avgOpex).toBe(5000) // not dragged down by August's 10
  })

  it('ignores Adjustments rows when computing the buying pace', () => {
    const o = computeOpenToBuy({ cash, txns, monthlyPL, salesTax, budget, now })
    // (8660 + 4330) / 3 months / 4.33 = 1000/wk — the +5000 relief is excluded
    expect(o.weeklyBuys).toBeCloseTo(1000, 0)
  })

  it('holds at $0 when cash is below the reserve', () => {
    const o = computeOpenToBuy({ cash: { amount: 9000, asOf: '2026-08-03' }, txns, monthlyPL, salesTax, budget, now })
    expect(o.availableNow).toBe(0)
    expect(o.state).toBe('hold')
  })

  it('prefers the liability balance over the YTD net for the tax reserve', () => {
    const o = computeOpenToBuy({ cash, txns, monthlyPL, salesTax: { owed: 2700, liability: 1200 }, budget, now })
    expect(o.breakdown.taxOwed).toBe(1200)
    const negative = computeOpenToBuy({ cash, txns, monthlyPL, salesTax: { owed: 2700, liability: -300 }, budget, now })
    expect(negative.breakdown.taxOwed).toBe(0)
  })

  it('flags a stale or undated cash entry', () => {
    expect(computeOpenToBuy({ cash: { amount: 20000, asOf: '2026-07-20' }, txns, monthlyPL, salesTax, budget, now }).stale).toBe(true)
    expect(computeOpenToBuy({ cash: { amount: 20000 }, txns, monthlyPL, salesTax, budget, now }).stale).toBe(true)
    expect(computeOpenToBuy({ cash, txns, monthlyPL, salesTax, budget, now }).stale).toBe(false)
  })

  it('returns null without a cash entry or without complete months', () => {
    expect(computeOpenToBuy({ cash: null, txns, monthlyPL, salesTax, budget, now })).toBeNull()
    expect(computeOpenToBuy({ cash, txns, monthlyPL: [], salesTax, budget, now })).toBeNull()
  })
})

describe('computeRecurring — adjustment entries', () => {
  it('never reports COGS entries as recurring bills', () => {
    const txns = [1, 2, 3, 4].map(m => ({
      description: `COGS ESTIMATE — 2026-0${m}`, amount: -20000,
      transaction_date: `2026-0${m}-28`, account: ADJUSTMENTS_ACCOUNT,
    }))
    expect(computeRecurring(txns)).toEqual([])
  })

  it('never reports cash withdrawals as recurring bills', () => {
    const txns = [1, 2, 3, 4].map(m => ({
      description: 'ATM WITHDRAWAL CASH WITHDRAWAL TERMINAL HG26431 158 MAIN STREET NORFOLK MA',
      amount: -200, transaction_date: `2026-0${m}-15`, account: 'FREEDOM CHECKING FOR BUSINESS',
    }))
    expect(computeRecurring(txns)).toEqual([])
  })
})

describe('computeSalesTax — live chart category name', () => {
  const squareReports = [{ period: '2026-01', tax_collected: 1000 }]
  it("counts payments categorized 'Sales Taxes' (live name) and the legacy name", () => {
    const txns = [
      { category: 'Sales Taxes', amount: -400, transaction_date: '2026-01-20' },
      { category: 'Sales Taxes Paid', amount: -100, transaction_date: '2026-02-05' },
    ]
    const t = computeSalesTax({ squareReports, txns, year: 2026 })
    expect(t.paid).toBe(500)
    expect(t.owed).toBe(500)
    expect(t.liability).toBeNull()
  })

  it('tracks the liability balance: accruals minus remittances, accrual rows never count as paid', () => {
    const txns = [
      { category: 'Sales Tax Payable', amount: 1000, transaction_date: '2026-01-31', account: ADJUSTMENTS_ACCOUNT },
      { category: 'Sales Tax Payable', amount: 800,  transaction_date: '2026-02-28', account: ADJUSTMENTS_ACCOUNT },
      { category: 'Sales Tax Payable', amount: -900, transaction_date: '2026-02-20', account: 'FREEDOM CHECKING FOR BUSINESS' },
    ]
    const t = computeSalesTax({ squareReports, txns, year: 2026 })
    expect(t.liability).toBe(900)   // 1000 + 800 − 900
    expect(t.paid).toBe(900)        // only the real remittance, not the +accruals
  })
})

describe('computeSquareReconciliation', () => {
  const dep = (ym, amount, category = '1100 Square Deposits', account = 'FREEDOM CHECKING FOR BUSINESS') =>
    ({ transaction_date: `${ym}-15`, amount, category, account })

  it('cancels month-boundary timing in the cumulative line', () => {
    const reports = [
      { period: '2026-05', card_amount: 1000, fees: 50, cash_amount: 0 },
      { period: '2026-06', card_amount: 0, fees: 0, cash_amount: 0 },
    ]
    // 900 of May's 950 expected lands in May; the last payout slips into June.
    const txns = [dep('2026-05', 900), dep('2026-06', 50)]
    const rec = computeSquareReconciliation({ reports, txns })
    expect(rec.rows[0].cardDelta).toBe(-50)
    expect(rec.rows[1].cardDelta).toBe(50)
    expect(rec.card.cumulative).toBe(0)
    expect(rec.card.state).toBe('ok')
  })

  it('keeps the lanes separate and excludes adjustment gross-ups', () => {
    const reports = [{ period: '2026-06', card_amount: 500, fees: 0, cash_amount: 300 }]
    const txns = [
      dep('2026-06', 500),
      dep('2026-06', 300, '1200 Cash Deposits'),
      dep('2026-06', 999, '1100 Square Deposits', ADJUSTMENTS_ACCOUNT), // fee gross-up: not a deposit
    ]
    const rec = computeSquareReconciliation({ reports, txns })
    expect(rec.rows[0].cardDelta).toBe(0)
    expect(rec.rows[0].cashDelta).toBe(0)
  })

  it('flags a partial-report month as an anomaly', () => {
    const reports = [{ period: '2026-02', card_amount: 14000, fees: 0, cash_amount: 6000 }]
    const txns = [dep('2026-02', 26900), dep('2026-02', 12595, '1200 Cash Deposits')]
    const rec = computeSquareReconciliation({ reports, txns })
    expect(rec.rows[0].anomaly).toBe(true)
  })

  it('reports drift when the cumulative escapes the tolerance', () => {
    const reports = [{ period: '2026-06', card_amount: 6000, fees: 0, cash_amount: 6000 }]
    const txns = [dep('2026-06', 6000), dep('2026-06', 2000, '1200 Cash Deposits')]
    const rec = computeSquareReconciliation({ reports, txns })
    expect(rec.cash.cumulative).toBe(-4000)
    expect(rec.cash.state).toBe('drift')  // tolerance = max(1000, 6000/30 × 5) = 1000
    expect(rec.card.state).toBe('ok')
  })

  it('returns null without reports', () => {
    expect(computeSquareReconciliation({ reports: [], txns: [] })).toBeNull()
  })
})

describe('computeTaxAccrualProposal', () => {
  const squareReports = [{ period: '2026-07', tax_collected: 1890.5 }, { period: '2026-06', tax_collected: 0 }]
  it('proposes the report month tax and flags whether it is booked', () => {
    const p = computeTaxAccrualProposal({ month: '2026-07', squareReports, txns: [] })
    expect(p).toEqual({ amount: 1890.5, booked: false, bookedAmount: null, stale: false })
    const booked = computeTaxAccrualProposal({
      month: '2026-07', squareReports,
      txns: [{ category: 'Sales Tax Collected', transaction_date: '2026-07-31', amount: -1890.5 }],
    })
    expect(booked).toMatchObject({ booked: true, stale: false, bookedAmount: 1890.5 })
  })

  // Re-uploading a corrected Square report changes the figure the entry was
  // built from; the entry itself does not follow, so it has to be spotted.
  it('flags an entry booked at an amount the report no longer agrees with', () => {
    const stale = computeTaxAccrualProposal({
      month: '2026-07', squareReports,
      txns: [{ category: 'Sales Tax Collected', transaction_date: '2026-07-31', amount: -1500 }],
    })
    expect(stale).toMatchObject({ amount: 1890.5, bookedAmount: 1500, booked: false, stale: true })
  })

  it('tolerates rounding rather than calling a penny a mismatch', () => {
    const p = computeTaxAccrualProposal({
      month: '2026-07', squareReports,
      txns: [{ category: 'Sales Tax Collected', transaction_date: '2026-07-31', amount: -1890.499 }],
    })
    expect(p.booked).toBe(true)
    expect(p.stale).toBe(false)
  })
  it('returns null without a report or with zero tax', () => {
    expect(computeTaxAccrualProposal({ month: '2026-06', squareReports, txns: [] })).toBeNull()
    expect(computeTaxAccrualProposal({ month: '2026-05', squareReports, txns: [] })).toBeNull()
  })
})

describe('role matching survives numbered account renames', () => {
  it('recognizes booked COGS and tax accruals under renamed categories', () => {
    const now = new Date('2026-08-10T12:00:00') // checklist month = 2026-07
    const base = { squareReports: [{ period: '2026-07', tax_collected: 500 }], uncatCount: 0, prevMonthTxnCount: 5 }
    const txns = [
      { category: '3000 Product Costs', transaction_date: '2026-07-31' },
      { category: '2100 Sales Tax Collected', transaction_date: '2026-07-31', amount: -500 },
    ]
    const cl = computeCloseChecklist({ ...base, txns, now })
    expect(cl.cogsBooked).toBe(true)
    expect(cl.taxAccrued).toBe(true)
    expect(computeTaxAccrualProposal({ month: '2026-07', squareReports: base.squareReports, txns }).booked).toBe(true)
  })

  it('computes the inventory balance across renamed Inventory categories', () => {
    expect(inventoryBookBalance([
      { category: 'Inventory', amount: -1000 },
      { category: '1500 Inventory', amount: -500 },
    ])).toBe(1500)
  })

  it('resolveRoleName finds the chart-of-account name for a role', () => {
    const accounts = [{ name: '3000 Product Costs' }, { name: 'Inventory' }]
    expect(resolveRoleName(accounts, 'Product Costs')).toBe('3000 Product Costs')
    expect(resolveRoleName(accounts, 'Inventory')).toBe('Inventory')
    expect(resolveRoleName(accounts, 'Sales Tax Payable')).toBe('Sales Tax Payable') // fallback
  })
})

describe('computeCloseChecklist — COGS and quarterly count items', () => {
  const base = { squareReports: [], uncatCount: 0, prevMonthTxnCount: 5 }

  it('reports whether COGS is booked for the checklist month', () => {
    const now = new Date('2026-08-10T12:00:00') // checklist month = 2026-07
    const booked = [{ category: 'Product Costs', transaction_date: '2026-07-31' }]
    expect(computeCloseChecklist({ ...base, txns: booked, now }).cogsBooked).toBe(true)
    expect(computeCloseChecklist({ ...base, txns: [], now }).cogsBooked).toBe(false)
  })

  it('tracks the sales-tax accrual only when the month has tax collected', () => {
    const now = new Date('2026-08-10T12:00:00') // checklist month = 2026-07
    const squareReports = [{ period: '2026-07', tax_collected: 1890 }]
    const none = computeCloseChecklist({ ...base, txns: [], now })
    expect(none.taxApplicable).toBe(false)

    const pending = computeCloseChecklist({ ...base, squareReports, txns: [], now })
    expect(pending.taxApplicable).toBe(true)
    expect(pending.taxAccrued).toBe(false)

    const accrued = computeCloseChecklist({
      ...base, squareReports,
      txns: [{ category: 'Sales Tax Collected', transaction_date: '2026-07-31' }], now,
    })
    expect(accrued.taxAccrued).toBe(true)
  })

  it('requires a quarterly count only after quarter-end months', () => {
    const july = computeCloseChecklist({ ...base, txns: [], now: new Date('2026-08-10T12:00:00') })
    expect(july.isQuarterEnd).toBe(false)
    expect(july.countEntered).toBe(true) // not applicable → not blocking

    const sept = computeCloseChecklist({ ...base, txns: [], counts: [], now: new Date('2026-10-05T12:00:00') })
    expect(sept.isQuarterEnd).toBe(true)
    expect(sept.countEntered).toBe(false)
  })

  it('accepts a count entered a few days into the next month', () => {
    const cl = computeCloseChecklist({
      ...base, txns: [],
      counts: [{ date: '2026-10-02', counted: 120000 }],
      now: new Date('2026-10-05T12:00:00'),
    })
    expect(cl.countEntered).toBe(true)
  })
})

// ─── Year-end projection ──────────────────────────────────────────────────────

// A monthlyPL row exactly as Dashboard's memo builds it.
const plRow = (year, month, revenue, cogs = 0, totalOpex = 0, nonOp = 0) => ({
  period: `${year}-${String(month).padStart(2, '0')}`, year, month,
  revenue, cogs,
  grossProfit: revenue - cogs,
  grossMarginPct: revenue > 0 ? ((revenue - cogs) / revenue) * 100 : null,
  totalOpex,
  netProfit: revenue - cogs - totalOpex + nonOp,
})

const spanMonths = (year, from, to, fn) =>
  Array.from({ length: to - from + 1 }, (_, i) => fn(year, from + i))

describe('computeYearEndProjection', () => {
  const AUG_3 = new Date(2026, 7, 3) // curMonth = 8, so Jan–Jul are complete
  // Last year flat at 1,000/mo except a 5,000 December — the seasonal spike a
  // card shop actually has, which the projection must carry forward.
  const LAST_YEAR = spanMonths(2025, 1, 12, (y, m) => plRow(y, m, m === 12 ? 5000 : 1000))
  const THIS_YEAR = spanMonths(2026, 1, 7, (y, m) => plRow(y, m, 2000)) // running at 2×

  it("scales last year's seasonal shape by this year's growth", () => {
    const p = computeYearEndProjection({ monthlyPL: [...LAST_YEAR, ...THIS_YEAR], year: 2026, now: AUG_3 })
    expect(p.revenueGrowthPct).toBe(100)     // 14,000 vs 7,000 over Jan–Jul
    expect(p.actual.revenue).toBe(14000)
    expect(p.projected.revenue).toBe(18000)  // Aug–Nov at 2,000, December at 10,000
    expect(p.yearEnd.revenue).toBe(32000)
    expect(p.monthly.find(m => m.month === 12)).toMatchObject({ projected: true, revenue: 10000 })
    expect(p.basis).toBe('seasonal')
  })

  it("falls back to this year's run rate with no prior year", () => {
    const p = computeYearEndProjection({ monthlyPL: THIS_YEAR, year: 2026, now: AUG_3 })
    expect(p.basis).toBe('runrate')
    expect(p.growth.revenue).toBeNull()
    expect(p.projected.revenue).toBe(10000)  // 5 remaining months at the 2,000 average
    expect(p.prevTotal).toBeNull()
  })

  it('reports mixed basis when only some months have a prior-year match', () => {
    const partialPrev = spanMonths(2025, 1, 9, (y, m) => plRow(y, m, 1000)) // no Oct–Dec
    const p = computeYearEndProjection({ monthlyPL: [...partialPrev, ...THIS_YEAR], year: 2026, now: AUG_3 })
    expect(p.basis).toBe('mixed')
    expect(p.seasonalMonths).toEqual([8, 9])
    expect(p.monthly.find(m => m.month === 11).basis).toBe('runrate')
  })

  it('treats the in-progress month as projected, not actual', () => {
    const p = computeYearEndProjection({
      monthlyPL: [...LAST_YEAR, ...THIS_YEAR, plRow(2026, 8, 50)], year: 2026, now: AUG_3,
    })
    expect(p.actualMonths).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(p.projectedMonths).toContain(8)
    // Three days of August must not stand in for the month, nor dilute actuals.
    expect(p.monthly.find(m => m.month === 8)).toMatchObject({ projected: true, revenue: 2000 })
    expect(p.actual.revenue).toBe(14000)
  })

  it('projects complete months that were never imported and flags them', () => {
    const gappy = THIS_YEAR.filter(r => r.month !== 6)
    const p = computeYearEndProjection({ monthlyPL: [...LAST_YEAR, ...gappy], year: 2026, now: AUG_3 })
    expect(p.gapMonths).toEqual([6])
    expect(p.projectedMonths).toEqual([6, 8, 9, 10, 11, 12])
  })

  it('keeps gross and net profit consistent with the projected lines', () => {
    const prev = spanMonths(2025, 1, 12, (y, m) => plRow(y, m, 1000, 400, 300, -20))
    const cur = spanMonths(2026, 1, 7, (y, m) => plRow(y, m, 2000, 900, 500, -50))
    const p = computeYearEndProjection({ monthlyPL: [...prev, ...cur], year: 2026, now: AUG_3 })
    expect(p.yearEnd.grossProfit).toBeCloseTo(p.yearEnd.revenue - p.yearEnd.cogs, 6)
    expect(p.yearEnd.netProfit).toBeCloseTo(
      p.yearEnd.revenue - p.yearEnd.cogs - p.yearEnd.totalOpex + p.yearEnd.nonOperating, 6)
    expect(p.yearEnd.netProfit).toBeCloseTo(p.actual.netProfit + p.projected.netProfit, 6)
  })

  it('runs non-operating items off the average rather than ratio-scaling them', () => {
    // Last year positive, this year negative: a ratio would flip the sign.
    const prev = spanMonths(2025, 1, 12, (y, m) => plRow(y, m, 1000, 0, 0, 100))
    const cur = spanMonths(2026, 1, 7, (y, m) => plRow(y, m, 2000, 0, 0, -80))
    const p = computeYearEndProjection({ monthlyPL: [...prev, ...cur], year: 2026, now: AUG_3 })
    expect(p.growth.nonOperating).toBeNull()
    expect(p.monthly.find(m => m.month === 9).nonOperating).toBeCloseTo(-80, 6)
  })

  it('clamps an implausible multiplier from a thin prior year', () => {
    const thinPrev = spanMonths(2025, 1, 7, (y, m) => plRow(y, m, 1))
    const p = computeYearEndProjection({ monthlyPL: [...thinPrev, ...THIS_YEAR], year: 2026, now: AUG_3 })
    expect(p.growth.revenue).toBe(5) // 14,000 / 7 would otherwise be 2,000×
  })

  it('needs two overlapping months before trusting a growth rate', () => {
    const p = computeYearEndProjection({ monthlyPL: [plRow(2025, 1, 1000), ...THIS_YEAR], year: 2026, now: AUG_3 })
    expect(p.growth.revenue).toBeNull()
    expect(p.basis).toBe('runrate')
  })

  it('grades confidence on months of actuals and prior-year overlap', () => {
    const conf = cur =>
      computeYearEndProjection({ monthlyPL: [...LAST_YEAR, ...cur], year: 2026, now: AUG_3 }).confidence
    expect(conf(THIS_YEAR)).toBe('high')
    expect(conf(spanMonths(2026, 1, 4, (y, m) => plRow(y, m, 2000)))).toBe('medium')
    expect(conf(spanMonths(2026, 1, 2, (y, m) => plRow(y, m, 2000)))).toBe('low')
  })

  it('returns null when there is nothing to project', () => {
    const full = spanMonths(2026, 1, 12, (y, m) => plRow(y, m, 2000))
    expect(computeYearEndProjection({ monthlyPL: LAST_YEAR, year: 2025, now: AUG_3 })).toBeNull()          // past year
    expect(computeYearEndProjection({ monthlyPL: full, year: 2026, now: new Date(2027, 0, 5) })).toBeNull() // year over
    expect(computeYearEndProjection({ monthlyPL: LAST_YEAR, year: 2026, now: AUG_3 })).toBeNull()          // no actuals
  })
})

// ─── Card payment categories per account ──────────────────────────────────────
// A shared payment category can only reduce one account, so a second card needs
// its own — and the reserve has to count both.

describe('computeOpenToBuy — multiple cards', () => {
  const now = new Date('2026-08-03T12:00:00')
  const monthlyPL = [PL('2026-05'), PL('2026-06'), PL('2026-07')]
  const mk = (category, amount, ym) => ({ category, amount, transaction_date: `${ym}-15` })
  const cash = { amount: 20000, asOf: '2026-08-03' }
  const base = { cash, monthlyPL, salesTax: { owed: 0 }, budget: {}, now }

  const REGISTRY = [
    { key: 'chk',  type: 'bank', label: 'Checking', matches: ['CHK'], boundCategories: [] },
    { key: 'visa', type: 'card', label: 'Visa',     matches: ['VISA'],
      boundCategories: ['2100 Credit Card Payment - Capital One'] },
    { key: 'amex', type: 'card', label: 'Amex',     matches: ['AMEX'],
      boundCategories: ['2200 Credit Card Payment - Chase'] },
  ]
  const txns = [
    mk('2100 Credit Card Payment - Capital One', -300, '2026-05'),
    mk('2100 Credit Card Payment - Capital One', -300, '2026-06'),
    mk('2200 Credit Card Payment - Chase',       -600, '2026-06'),
    mk('2200 Credit Card Payment - Chase',       -600, '2026-07'),
  ]

  it('counts every card’s payment category toward the reserve', () => {
    const o = computeOpenToBuy({ ...base, txns, registry: REGISTRY })
    expect(o.breakdown.ccMonthly).toBeCloseTo(1800 / 3, 2) // both cards, 3 months
  })

  it('ignores categories bound to a bank account, which are not card debt', () => {
    const withBank = REGISTRY.map(e =>
      e.key === 'chk' ? { ...e, boundCategories: ['4100 Occupancy'] } : e)
    const o = computeOpenToBuy({ ...base, txns: [...txns, mk('4100 Occupancy', -900, '2026-05')], registry: withBank })
    expect(o.breakdown.ccMonthly).toBeCloseTo(1800 / 3, 2)
  })

  it('falls back to the default category when no registry is configured', () => {
    const legacy = [mk('Credit Card Payment', -300, '2026-05'), mk('Credit Card Payment', -300, '2026-06')]
    expect(computeOpenToBuy({ ...base, txns: legacy, registry: [] }).breakdown.ccMonthly).toBeCloseTo(200, 2)
    expect(computeOpenToBuy({ ...base, txns: legacy }).breakdown.ccMonthly).toBeCloseTo(200, 2)
  })

  it('matches the payment category regardless of its account number', () => {
    const renumbered = [mk('9999 Credit Card Payment - Capital One', -300, '2026-05')]
    const o = computeOpenToBuy({ ...base, txns: renumbered, registry: REGISTRY })
    expect(o.breakdown.ccMonthly).toBeCloseTo(100, 2)
  })
})
