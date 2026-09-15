import { describe, it, expect } from 'vitest'
import { vendorSpend, vendorYears } from '../vendorSpend'

const VENDORS = [
  { id: 'v-costco', name: 'Costco', notes: null },
  { id: 'v-uline',  name: 'Uline',  notes: 'shipping supplies' },
  { id: 'v-idle',   name: 'Idle Vendor', notes: null },
]
const tx = (date, amount, category, vendor_id = null) => ({ transaction_date: date, amount, category, vendor_id })

const txns = [
  tx('2026-01-10', -212.47, 'Supplies & Materials', 'v-costco'),
  tx('2026-02-14', -301.55, 'Supplies & Materials', 'v-costco'),
  tx('2026-02-20',   50.00, 'Supplies & Materials', 'v-costco'),   // refund
  tx('2026-03-01',  -88.10, 'Office Expense',       'v-costco'),
  tx('2025-11-02', -318.44, 'Supplies & Materials', 'v-uline'),
  tx('2026-01-20', -150.00, '',                     null),           // unassigned spend
  tx('2026-01-28', 1842.35, 'Sales',                null),           // a deposit, not spend
]

describe('vendorSpend', () => {
  const r = vendorSpend(txns, VENDORS)

  it('sums money out per vendor, netting refunds, and ranks by spend', () => {
    expect(r.rows.map(x => x.name)).toEqual(['Costco', 'Uline', 'Idle Vendor'])
    const costco = r.rows[0]
    expect(costco.spend).toBeCloseTo(212.47 + 301.55 - 50 + 88.10, 2)
    expect(costco.count).toBe(4)
    expect(costco.first).toBe('2026-01-10')
    expect(costco.last).toBe('2026-03-01')
    expect(costco.topCategory).toBe('Supplies & Materials')
    expect(r.rows[2]).toMatchObject({ name: 'Idle Vendor', spend: 0, count: 0, last: '', topCategory: '' })
  })

  it('reports unassigned money-out rows and ignores deposits', () => {
    expect(r.unassigned).toEqual({ count: 1, spend: 150 })
    expect(r.total).toBeCloseTo(552.12 + 318.44, 2)
  })

  it('restricts to a year when asked', () => {
    const y = vendorSpend(txns, VENDORS, { year: 2025 })
    expect(y.rows[0]).toMatchObject({ name: 'Uline', spend: 318.44 })
    expect(y.rows.find(x => x.name === 'Costco').spend).toBe(0)
    expect(y.unassigned).toEqual({ count: 0, spend: 0 })
  })

  it('lets the caller decide which unassigned rows are spend', () => {
    const only = vendorSpend(txns, VENDORS, { isSpendRow: t => t.category === 'Supplies & Materials' && t.amount < 0 })
    expect(only.unassigned).toEqual({ count: 0, spend: 0 })
  })
})

describe('vendorYears', () => {
  it('lists years newest first', () => {
    expect(vendorYears(txns)).toEqual([2026, 2025])
  })
})
