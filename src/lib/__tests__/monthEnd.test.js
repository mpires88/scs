import { describe, it, expect } from 'vitest'
import { cogsRows, taxRows, buildMonthEndRows, trueUpRows, quarterLabel } from '../monthEnd'
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
