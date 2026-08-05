import { describe, it, expect } from 'vitest'
import { buildCashFlow, cashFlowYears, isCashRow, GROUP_BY_SECTION } from '../cashFlow'
import { ADJUSTMENTS_ACCOUNT } from '../insights'

const REGISTRY = [
  { key: 'chk',  type: 'bank', label: 'Checking', matches: ['CHECKING'] },
  { key: 'card', type: 'card', label: 'Card',     matches: ['CARD'],
    boundCategories: ['Credit Card Payment'] },
]
const ACCOUNTS = [
  { name: '1100 Square Deposits', pl_section: 'Revenue' },
  { name: 'Sales Tax Collected',  pl_section: 'Deductions to Income' },
  { name: 'Product Costs',        pl_section: 'Cost of Goods Sold' },
  { name: '4100 Occupancy',       pl_section: 'Operating Expenses' },
  { name: 'Inventory',            pl_section: 'Current Assets' },
  { name: 'Sales Tax Payable',    pl_section: 'Current Liabilities' },
  { name: 'Credit Card Payment',  pl_section: 'Current Liabilities' },
  { name: 'Equipment',            pl_section: 'Non-Current Assets' },
  { name: 'Owner Draw',           pl_section: 'Equity' },
  { name: 'Owner Investment',     pl_section: 'Equity' },
]
const tx = (date, amount, category, account = 'CHECKING') =>
  ({ transaction_date: date, amount, category, account })

const cfOf = txns => buildCashFlow({ txns, accounts: ACCOUNTS, registry: REGISTRY, year: 2026 })
const sec = (cf, n) => cf.sections.find(s => s.section === n)
const rowNamed = (cf, s, n) => sec(cf, s).rows.find(r => r.name === n)

describe('isCashRow', () => {
  it('counts bank rows only', () => {
    expect(isCashRow(tx('2026-01-05', 100, 'x', 'CHECKING'), REGISTRY)).toBe(true)
    expect(isCashRow(tx('2026-01-05', 100, 'x', 'CARD'), REGISTRY)).toBe(false)
    expect(isCashRow(tx('2026-01-05', 100, 'x', ADJUSTMENTS_ACCOUNT), REGISTRY)).toBe(false)
    expect(isCashRow(tx('2026-01-05', 100, 'x', ''), REGISTRY)).toBe(false)
  })
})

describe('buildCashFlow', () => {
  // A month with every moving part: a deposit, a cash expense, a card-funded
  // expense, the card payment, stock bought, the month-end COGS + tax journals,
  // a tax remittance, equipment, and owner money both directions.
  const txns = [
    tx('2025-12-20', 500, '1100 Square Deposits'),                        // opening cash
    tx('2026-01-10', 1000, '1100 Square Deposits'),
    tx('2026-01-11', -300, '4100 Occupancy'),
    tx('2026-01-12', -120, '4100 Occupancy', 'CARD'),                     // card-funded cost
    tx('2026-01-13', -80,  'Credit Card Payment'),                        // paying the card
    tx('2026-01-14', -400, 'Inventory'),                                  // stock bought
    tx('2026-01-31', -250, 'Product Costs',       ADJUSTMENTS_ACCOUNT),   // COGS journal
    tx('2026-01-31',  250, 'Inventory',           ADJUSTMENTS_ACCOUNT),   // inventory relief
    tx('2026-01-31', -60,  'Sales Tax Collected', ADJUSTMENTS_ACCOUNT),   // tax accrual
    tx('2026-01-31',  60,  'Sales Tax Payable',   ADJUSTMENTS_ACCOUNT),   // liability
    tx('2026-01-20', -45,  'Sales Tax Payable'),                          // remitted to state
    tx('2026-01-21', -700, 'Equipment'),                                  // investing
    tx('2026-01-22', -200, 'Owner Draw'),
    tx('2026-01-23', 900,  'Owner Investment'),
  ]
  const cf = cfOf(txns)

  it('shows operating as net income reconciled to cash', () => {
    expect(sec(cf, 'Operating').rows.map(r => r.name)).toEqual([
      'Net income',
      'Sales tax collected',
      'Sales tax paid',
      'Change in inventory',
      'Add back: bought on the card',
    ])
  })

  it('computes each operating line from the right rows', () => {
    // NI: 1000 deposit − 300 cash rent − 120 card rent − 250 COGS − 60 tax accrual
    expect(rowNamed(cf, 'Operating', 'Net income').total).toBe(270)
    expect(rowNamed(cf, 'Operating', 'Sales tax collected').total).toBe(60)
    expect(rowNamed(cf, 'Operating', 'Sales tax paid').total).toBe(-45)
    expect(rowNamed(cf, 'Operating', 'Change in inventory').total).toBe(-150) // −400 bought + 250 relieved
    expect(rowNamed(cf, 'Operating', 'Add back: bought on the card').total).toBe(120)
  })

  it('ties the operating lines to operating cash exactly, with no residual', () => {
    const rows = sec(cf, 'Operating').rows
    expect(rows.reduce((s, r) => s + r.total, 0)).toBeCloseTo(sec(cf, 'Operating').total, 2)
    // 1000 deposit − 300 rent − 400 stock − 45 tax = 255
    expect(sec(cf, 'Operating').total).toBe(255)
    expect(cf.unexplained).toBe(0)
    expect(rows.some(r => r.name === 'Other timing differences')).toBe(false)
  })

  it('puts the credit card and owner money in financing', () => {
    expect(sec(cf, 'Financing').rows.map(r => r.name))
      .toEqual(['Credit Card Payment', 'Owner Draw', 'Owner Investment'])
    expect(sec(cf, 'Financing').total).toBe(-80 - 200 + 900)
  })

  it('keeps capital purchases in investing', () => {
    expect(sec(cf, 'Investing').rows.map(r => r.name)).toEqual(['Equipment'])
    expect(sec(cf, 'Investing').total).toBe(-700)
  })

  it('reconciles and closes on the bank balance', () => {
    expect(cf.reconciles).toBe(true)
    // every bank row for January: 1000 −300 −80 −400 −45 −700 −200 +900
    expect(cf.netChange.total).toBe(175)
    expect(cf.opening[1]).toBe(500)
    expect(cf.closing[1]).toBe(675)
  })

  it('backs out stock bought on the card, not just costs', () => {
    const withCardStock = [...txns, tx('2026-01-18', -28.11, 'Inventory', 'CARD')]
    const r = cfOf(withCardStock)
    expect(rowNamed(r, 'Operating', 'Change in inventory').total).toBeCloseTo(-178.11, 2)
    expect(rowNamed(r, 'Operating', 'Add back: bought on the card').total)
      .toBeCloseTo(120 + 28.11, 2)
    expect(r.unexplained).toBe(0)          // no residual — the gap this closed
    expect(r.reconciles).toBe(true)
  })

  it('surfaces a residual rather than hiding it', () => {
    // A cash row in a section the chart doesn't know lands in operating cash
    // but no named line explains it.
    const odd = [...txns, tx('2026-01-25', -33, 'Mystery Account')]
    const r = cfOf(odd)
    const other = rowNamed(r, 'Operating', 'Other timing differences')
    expect(other.total).toBe(-33)
    expect(r.unexplained).toBe(-33)
    expect(r.reconciles).toBe(true)
  })

  it('still reconciles across years side by side', () => {
    const y = buildCashFlow({ txns, accounts: ACCOUNTS, registry: REGISTRY, period: 'yearly' })
    expect(y.months).toEqual([2025, 2026])
    expect(y.reconciles).toBe(true)
    expect(y.opening[2025]).toBe(0)
    expect(y.closing[2026]).toBe(675)
    y.months.forEach(m => {
      const rows = sec(y, 'Operating').rows.reduce((s, r) => s + r.byMonth[m], 0)
      expect(rows).toBeCloseTo(sec(y, 'Operating').totals[m], 2)
    })
  })

  it('flags uncategorized cash', () => {
    expect(cfOf([...txns, tx('2026-01-26', -5, '')]).unclassified).toBe(true)
    expect(cf.unclassified).toBe(false)
  })

  it('matches roles whatever account number the chart gives them', () => {
    const renumbered = txns.map(t =>
      t.category === 'Inventory' ? { ...t, category: '1500 Inventory' } : t)
    expect(rowNamed(cfOf(renumbered), 'Operating', 'Change in inventory').total).toBe(-150)
  })

  it('returns null with no cash rows', () => {
    expect(cfOf([tx('2026-01-05', 10, 'x', 'CARD')])).toBeNull()
    expect(buildCashFlow({ txns, accounts: ACCOUNTS, registry: REGISTRY, year: 2099 })).toBeNull()
  })
})

describe('cashFlowYears', () => {
  it('lists only years with bank activity', () => {
    expect(cashFlowYears([
      tx('2024-05-01', 10, 'x'),
      tx('2026-05-01', 10, 'x'),
      tx('2025-05-01', 10, 'x', 'CARD'),
    ], REGISTRY)).toEqual([2024, 2026])
  })
})

describe('GROUP_BY_SECTION', () => {
  it('covers every section the chart can produce', () => {
    ['Revenue', 'Deductions to Income', 'Cost of Goods Sold', 'Operating Expenses',
     'Non-Operating Income', 'Non-Operating Expenses', 'Current Assets', 'Non-Current Assets',
     'Current Liabilities', 'Non-Current Liabilities', 'Equity']
      .forEach(s => expect(GROUP_BY_SECTION[s]).toBeTruthy())
  })
})
