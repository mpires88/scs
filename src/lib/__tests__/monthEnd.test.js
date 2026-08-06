import { describe, it, expect } from 'vitest'
import { cogsRows, taxRows, buildMonthEndRows, trueUpRows, quarterLabel, squareFeeRows, discountRows, staleDescriptions } from '../monthEnd'
import { computeSquareFeeProposal, ADJUSTMENTS_ACCOUNT } from '../insights'

describe('role resolution against a renamed chart', () => {
  const accounts = [
    { name: '3000 Product Costs' }, { name: 'Inventory' },
    { name: '2100 Sales Tax Collected' }, { name: 'Sales Tax Payable' },
  ]
  it('books entries under the chart-of-accounts CURRENT names', () => {
    expect(cogsRows('2026-07', 100, accounts).map(r => r.category))
      .toEqual(['3000 Product Costs', 'Inventory'])
    expect(taxRows('2026-07', 100, accounts).map(r => r.category))
      .toEqual(['2100 Sales Tax Collected', 'Sales Tax Payable'])
    expect(trueUpRows({ date: '2026-09-30', quarterLabel: 'Q3 2026', adjustment: 50, accounts })
      .map(r => r.category)).toEqual(['3000 Product Costs', 'Inventory'])
  })
  it('falls back to the plain role names without an accounts list', () => {
    expect(cogsRows('2026-07', 100).map(r => r.category)).toEqual(['Product Costs', 'Inventory'])
  })
})
import { computeCloseChecklist } from '../insights'

const sum = rows => rows.reduce((s, r) => s + r.amount, 0)

describe('month-end row builders', () => {
  it('dates entries to the last day of the month', () => {
    expect(cogsRows('2026-06', 100)[0].transaction_date).toBe('2026-06-30')
    expect(cogsRows('2026-02', 100)[0].transaction_date).toBe('2026-02-28')
    expect(cogsRows('2024-02', 100)[0].transaction_date).toBe('2024-02-29') // leap year
  })

  it('books COGS as a zero-net pair against Inventory', () => {
    const rows = cogsRows('2026-06', 1234.56)
    expect(rows.map(r => r.category)).toEqual(['Product Costs', 'Inventory'])
    expect(rows[0].amount).toBe(-1234.56)
    expect(sum(rows)).toBe(0)
  })

  it('books sales tax as a zero-net pair against the liability', () => {
    const rows = taxRows('2026-06', 800)
    expect(rows.map(r => r.category)).toEqual(['Sales Tax Collected', 'Sales Tax Payable'])
    expect(sum(rows)).toBe(0)
  })

  it('skips legs that are already booked', () => {
    const cogsProposal = { amount: 100 }
    const taxProposal = { amount: 50, booked: true }

    expect(buildMonthEndRows({ month: '2026-06', cogsProposal, taxProposal })).toHaveLength(2)
    expect(buildMonthEndRows({ month: '2026-06', cogsProposal, taxProposal, cogsBooked: true })).toHaveLength(0)
    expect(buildMonthEndRows({
      month: '2026-06', cogsProposal, taxProposal: { amount: 50, booked: false },
    })).toHaveLength(4)
  })

  it('returns nothing when there is no proposal', () => {
    expect(buildMonthEndRows({ month: '2026-06', cogsProposal: null, taxProposal: null })).toEqual([])
  })

  it('drops a true-up that rounds away to nothing', () => {
    expect(trueUpRows({ date: '2026-06-30', quarterLabel: 'Q2 2026', adjustment: 0.004 })).toEqual([])
    expect(trueUpRows({ date: '2026-06-30', quarterLabel: 'Q2 2026', adjustment: -250 })).toHaveLength(2)
    expect(sum(trueUpRows({ date: '2026-06-30', quarterLabel: 'Q2 2026', adjustment: -250 }))).toBe(0)
  })

  it('labels quarters from the date', () => {
    expect(quarterLabel(new Date(2026, 0, 15))).toBe('Q1 2026')
    expect(quarterLabel(new Date(2026, 5, 30))).toBe('Q2 2026')
    expect(quarterLabel(new Date(2026, 11, 1))).toBe('Q4 2026')
  })
})

describe('computeCloseChecklist month override', () => {
  const base = {
    txns: [
      { transaction_date: '2026-05-04', category: 'Sales' },
      { transaction_date: '2026-06-11', category: 'Product Costs' },
    ],
    squareReports: [{ period: '2026-05', tax_collected: 120 }],
    uncatCount: 0,
    now: new Date(2026, 6, 15), // July 2026 → default month is June
  }

  it('defaults to the most recent complete month', () => {
    const cl = computeCloseChecklist(base)
    expect(cl.month).toBe('2026-06')
    expect(cl.label).toBe('June 2026')
    expect(cl.cogsBooked).toBe(true)
    expect(cl.squareUploaded).toBe(false)
  })

  it('honours an explicit month', () => {
    const cl = computeCloseChecklist({ ...base, month: '2026-05' })
    expect(cl.month).toBe('2026-05')
    expect(cl.label).toBe('May 2026')
    expect(cl.bankImported).toBe(true)
    expect(cl.squareUploaded).toBe(true)
    expect(cl.taxApplicable).toBe(true)
    expect(cl.cogsBooked).toBe(false)
  })

  it('ignores prevMonthTxnCount for any month other than the default', () => {
    // The count describes June; asking about May must not borrow its answer.
    const cl = computeCloseChecklist({ ...base, txns: [], prevMonthTxnCount: 42, month: '2026-05' })
    expect(cl.bankImported).toBe(false)

    const dflt = computeCloseChecklist({ ...base, txns: [], prevMonthTxnCount: 42 })
    expect(dflt.bankImported).toBe(true)
  })

  it('flags quarter ends from the selected month', () => {
    expect(computeCloseChecklist({ ...base, month: '2026-03' }).isQuarterEnd).toBe(true)
    expect(computeCloseChecklist({ ...base, month: '2026-05' }).isQuarterEnd).toBe(false)
  })
})

// ─── Square fee gross-up ──────────────────────────────────────────────────────

describe('squareFeeRows / buildMonthEndRows fee leg', () => {
  const ACCOUNTS = [
    { name: '1100 Square Deposits', pl_section: 'Revenue' },
    { name: 'Processing Fees',      pl_section: 'Operating Expenses' },
  ]

  it('books the fee as an expense and grosses revenue back up, netting zero', () => {
    const rows = squareFeeRows('2026-06', 1037.91, ACCOUNTS)
    expect(rows).toHaveLength(2)
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(0, 6)
    expect(rows[0]).toMatchObject({
      transaction_date: '2026-06-30', amount: -1037.91, category: 'Processing Fees',
    })
    expect(rows[1]).toMatchObject({
      transaction_date: '2026-06-30', amount: 1037.91, category: '1100 Square Deposits',
    })
  })

  it('resolves the revenue role to whatever the chart currently calls it', () => {
    expect(squareFeeRows('2026-06', 10, ACCOUNTS)[1].category).toBe('1100 Square Deposits')
    expect(squareFeeRows('2026-06', 10, [])[1].category).toBe('Square Deposits')
  })

  it('is skipped once booked, and when there is no fee', () => {
    const base = { month: '2026-06', accounts: ACCOUNTS, cogsBooked: true }
    expect(buildMonthEndRows({ ...base, feeProposal: { amount: 500, booked: true } })).toEqual([])
    expect(buildMonthEndRows({ ...base, feeProposal: { amount: 0, booked: false } })).toEqual([])
    expect(buildMonthEndRows({ ...base, feeProposal: null })).toEqual([])
    expect(buildMonthEndRows({ ...base, feeProposal: { amount: 500, booked: false } })).toHaveLength(2)
  })
})

// ─── Square discount gross-up ─────────────────────────────────────────────────

describe('discountRows', () => {
  const ACCOUNTS = [
    { name: '1100 Square Deposits', pl_section: 'Revenue' },
    { name: '2200 Discounts',       pl_section: 'Deductions to Income' },
  ]

  it('books the giveaway as a deduction and grosses revenue up, netting zero', () => {
    const rows = discountRows('2026-06', 45.5, ACCOUNTS)
    expect(rows).toHaveLength(2)
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(0, 6)
    expect(rows[0]).toMatchObject({
      transaction_date: '2026-06-30', amount: -45.5, category: '2200 Discounts',
    })
    expect(rows[1]).toMatchObject({
      transaction_date: '2026-06-30', amount: 45.5, category: '1100 Square Deposits',
    })
  })

  it('resolves roles against the chart, falling back to plain names', () => {
    expect(discountRows('2026-06', 10, ACCOUNTS)[0].category).toBe('2200 Discounts')
    expect(discountRows('2026-06', 10, [])[0].category).toBe('Discounts')
  })
})


// ─── Re-booking a corrected Square report ─────────────────────────────────────

describe('stale month-end entries', () => {
  const REPORTS = [{ period: '2026-06', fees: 1037.91, tax_collected: 2528.90 }]
  const feeRows = amt => [
    { description: 'SQUARE FEES — 2026-06', amount: -amt, account: ADJUSTMENTS_ACCOUNT },
    { description: 'SQUARE FEE GROSS-UP — 2026-06', amount: amt, account: ADJUSTMENTS_ACCOUNT },
  ]

  it('treats a fee entry matching the report as booked', () => {
    const p = computeSquareFeeProposal({ month: '2026-06', squareReports: REPORTS, txns: feeRows(1037.91) })
    expect(p).toMatchObject({ booked: true, stale: false })
    expect(staleDescriptions({ month: '2026-06', feeProposal: p })).toEqual([])
  })

  it('flags a fee entry the report has moved away from, and names what to clear', () => {
    const p = computeSquareFeeProposal({ month: '2026-06', squareReports: REPORTS, txns: feeRows(900) })
    expect(p).toMatchObject({ amount: 1037.91, bookedAmount: 900, booked: false, stale: true })
    expect(staleDescriptions({ month: '2026-06', feeProposal: p }))
      .toEqual(['SQUARE FEES — 2026-06', 'SQUARE FEE GROSS-UP — 2026-06'])
  })

  it('re-proposes the pair at the corrected amount', () => {
    const p = computeSquareFeeProposal({ month: '2026-06', squareReports: REPORTS, txns: feeRows(900) })
    const rows = buildMonthEndRows({ month: '2026-06', feeProposal: p, cogsBooked: true })
    expect(rows).toHaveLength(2)
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(0, 6)
    expect(Math.abs(rows[0].amount)).toBe(1037.91)
  })

  it('leaves an entry alone when it still agrees, so re-booking never churns', () => {
    const ok = computeSquareFeeProposal({ month: '2026-06', squareReports: REPORTS, txns: feeRows(1037.91) })
    expect(buildMonthEndRows({ month: '2026-06', feeProposal: ok, cogsBooked: true })).toEqual([])
  })
})
