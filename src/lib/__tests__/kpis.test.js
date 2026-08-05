import { describe, it, expect } from 'vitest'
import { buildKpis } from '../kpis'

const ACCOUNTS = [
  { name: 'Sales',                    pl_section: 'Revenue' },
  { name: '1100 Square Deposits',     pl_section: 'Revenue' },
  { name: '2200 Discounts',           pl_section: 'Deductions to Income' },
  { name: '3000 Product Costs',       pl_section: 'Cost of Goods Sold' },
  { name: 'Rent or Lease',            pl_section: 'Operating Expenses', cost_type: 'fixed' },
  { name: 'Supplies & Materials',     pl_section: 'Operating Expenses', cost_type: 'variable' },
]

const t = (date, amount, category, account = 'Checking') =>
  ({ transaction_date: date, amount, category, account })

// June: $1,000 revenue, $50 discounts given (booked pair grosses revenue up by
// the same $50, so the Revenue section total already includes it), $400 COGS,
// $200 fixed rent.
const JUNE = [
  t('2026-06-10',  950, '1100 Square Deposits'),
  t('2026-06-30',   50, '1100 Square Deposits'),      // SQUARE DISCOUNT GROSS-UP
  t('2026-06-30',  -50, '2200 Discounts'),            // SQUARE DISCOUNTS
  t('2026-06-30', -400, '3000 Product Costs'),
  t('2026-06-05', -200, 'Rent or Lease'),
]
const JUNE_LAST_YEAR = [
  t('2025-06-15', 760, 'Sales'),
]

const build = (txns, over = {}) => buildKpis({
  txns, accounts: ACCOUNTS, registry: [],
  columns: [6], period: 'monthly', year: 2026, ...over,
})

const row = (kpis, key) => kpis.rows.find(r => r.key === key)

describe('buildKpis', () => {
  it('derives margins from the same section math as the P&L', () => {
    const k = build([...JUNE, ...JUNE_LAST_YEAR])
    // Net revenue 1000 − 50 = 950; gross profit 950 − 400 = 550.
    expect(row(k, 'gm').byCol[6]).toBeCloseTo(550 / 950 * 100, 6)
    // Operating income 550 − 200 = 350.
    expect(row(k, 'om').byCol[6]).toBeCloseTo(350 / 950 * 100, 6)
  })

  it('computes breakeven coverage from fixed-tagged costs', () => {
    const k = build(JUNE)
    // Breakeven revenue = 200 / (550/950); coverage = 950 / that.
    const breakeven = 200 / (550 / 950)
    expect(row(k, 'be').byCol[6]).toBeCloseTo(950 / breakeven * 100, 6)
  })

  it('compares revenue with the same month a year earlier', () => {
    const k = build([...JUNE, ...JUNE_LAST_YEAR])
    expect(row(k, 'yoy').byCol[6]).toBeCloseTo((950 - 760) / 760 * 100, 6)
    // No prior year → dash, not zero.
    expect(row(build(JUNE), 'yoy').byCol[6]).toBeNull()
  })

  it('reports discounts given and their share of gross revenue', () => {
    const k = build(JUNE)
    expect(row(k, 'disc').byCol[6]).toBe(50)
    expect(row(k, 'discRate').byCol[6]).toBeCloseTo(50 / 1000 * 100, 6)
  })

  it('spans years in yearly mode and keeps the Period column revenue-weighted', () => {
    const k = buildKpis({
      txns: [...JUNE, ...JUNE_LAST_YEAR], accounts: ACCOUNTS, registry: [],
      columns: [2025, 2026], period: 'yearly', year: null,
    })
    expect(row(k, 'yoy').byCol[2026]).toBeCloseTo((950 - 760) / 760 * 100, 6)
    // Period gross margin = total gross profit / total net revenue, not an
    // average of the two years' percentages.
    expect(row(k, 'gm').total).toBeCloseTo((760 + 550) / (760 + 950) * 100, 6)
  })

  it('returns null without columns', () => {
    expect(build(JUNE, { columns: [] })).toBeNull()
  })
})
