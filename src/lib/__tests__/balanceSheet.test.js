import { describe, it, expect } from 'vitest'
import { buildBalanceSheet, balanceSheetYears } from '../balanceSheet'
import { ADJUSTMENTS_ACCOUNT } from '../insights'

const BANK = 'FREEDOM CHECKING FOR BUSINESS'
const tx = (date, amount, category, account = BANK) => ({ transaction_date: date, amount, category, account })

const ACCOUNTS = [
  { name: 'Square Deposits',   pl_section: 'Revenue',             parent: null },
  { name: 'Rent',              pl_section: 'Operating Expenses',  parent: null },
  { name: 'Inventory',         pl_section: 'Current Assets',      parent: null },
  { name: 'Sales Tax Payable', pl_section: 'Current Liabilities', parent: null },
  { name: 'Owner Investment',  pl_section: 'Equity',              parent: null },
  { name: 'Owner Draw',        pl_section: 'Equity',              parent: null },
]

describe('buildBalanceSheet', () => {
  const txns = [
    tx('2026-01-05',  10000, 'Owner Investment'),                        // owner puts money in
    tx('2026-01-10',   5000, 'Square Deposits'),                        // revenue
    tx('2026-01-15',  -3000, 'Inventory'),                              // buys stock
    tx('2026-01-20',  -1000, 'Rent'),                                   // expense
    tx('2026-02-28',    300, 'Sales Tax Payable', ADJUSTMENTS_ACCOUNT), // accrual (+liability)
    tx('2026-02-28',   -300, 'Square Deposits',   ADJUSTMENTS_ACCOUNT), // its zero-net partner
    tx('2026-02-10',   -200, 'Sales Tax Payable'),                      // remittance
  ]
  const bs = buildBalanceSheet({ txns, accounts: ACCOUNTS, year: 2026 })

  const section = name => bs.sections.find(s => s.section === name)
  const row = (sec, name) => section(sec).rows.find(r => r.name === name)

  it('derives cash from the bank account, excluding adjustment rows', () => {
    const cash = row('Current Assets', `Cash — ${BANK}`)
    // Jan: 10000 + 5000 − 3000 − 1000 = 11000; Feb: − 200 remittance = 10800
    expect(cash.byMonth[1]).toBe(11000)
    expect(cash.byMonth[2]).toBe(10800)
  })

  it('shows asset and liability balances point-in-time with the right signs', () => {
    expect(row('Current Assets', 'Inventory').byMonth[1]).toBe(3000)
    expect(row('Current Assets', 'Inventory').byMonth[2]).toBe(3000)
    // liability: +300 accrual − 200 remittance = 100 owed at Feb
    expect(row('Current Liabilities', 'Sales Tax Payable').byMonth[1]).toBe(0)
    expect(row('Current Liabilities', 'Sales Tax Payable').byMonth[2]).toBe(100)
  })

  it('accumulates retained earnings from P&L activity, including adjustment rows', () => {
    const re = row('Equity', 'Retained Earnings')
    expect(re.byMonth[1]).toBe(4000)   // 5000 revenue − 1000 rent
    expect(re.byMonth[2]).toBe(3700)   // − 300 tax accrual (deduction side)
  })

  it('balances by construction: assets = liabilities + equity every month', () => {
    bs.months.forEach(m => {
      expect(bs.computed.assets.byMonth[m]).toBeCloseTo(bs.computed.liabEquity.byMonth[m], 2)
    })
  })

  it('clips the month columns to the data range', () => {
    expect(bs.months[0]).toBe(1)
    expect(bs.months[bs.months.length - 1]).toBe(2)
  })

  it('classifies a negative-balance account as owed, not cash', () => {
    const withCard = [...txns, tx('2026-01-12', -450, 'Rent', 'Capital One Credit Card')]
    const b = buildBalanceSheet({ txns: withCard, accounts: ACCOUNTS, year: 2026 })
    const owed = b.sections.find(s => s.section === 'Current Liabilities').rows
      .find(r => r.name === 'Owed on Capital One Credit Card')
    expect(owed.byMonth[1]).toBe(450)
    expect(b.sections.find(s => s.section === 'Current Assets').rows
      .some(r => r.name.includes('Capital One'))).toBe(false)
    b.months.forEach(m => {
      expect(b.computed.assets.byMonth[m]).toBeCloseTo(b.computed.liabEquity.byMonth[m], 2)
    })
  })

  it('keeps the sheet balanced when uncategorized rows exist, and flags them', () => {
    const withUncat = [...txns, tx('2026-02-14', -500, null)]
    const b = buildBalanceSheet({ txns: withUncat, accounts: ACCOUNTS, year: 2026 })
    expect(b.hasUncat).toBe(true)
    const u = b.sections.find(s => s.section === 'Equity').rows.find(r => r.name === 'Uncategorized activity')
    expect(u.byMonth[2]).toBe(-500)
    b.months.forEach(m => {
      expect(b.computed.assets.byMonth[m]).toBeCloseTo(b.computed.liabEquity.byMonth[m], 2)
    })
  })

  it('returns null with no data or an out-of-range year', () => {
    expect(buildBalanceSheet({ txns: [], accounts: ACCOUNTS, year: 2026 })).toBeNull()
    expect(buildBalanceSheet({ txns, accounts: ACCOUNTS, year: 2020 })).toBeNull()
  })
})

describe('balanceSheetYears', () => {
  it('lists the years present in the ledger', () => {
    expect(balanceSheetYears([tx('2024-02-29', 1, 'X'), tx('2026-01-01', 1, 'X')])).toEqual([2024, 2026])
  })
})

describe('buildBalanceSheet — ledger-account registry', () => {
  const CARD_ACCOUNTS = [
    ...ACCOUNTS,
    { name: 'Credit Card Payment', pl_section: 'Current Liabilities', parent: null },
    { name: 'Business Expenses',   pl_section: 'Operating Expenses',  parent: null },
  ]
  const REGISTRY = [
    { key: 'checking', label: 'Freedom Checking', type: 'bank',
      matches: [BANK], boundCategories: [], opening: null },
    { key: 'card', label: 'Credit Card — Capital One', type: 'card',
      matches: ['Capital One Credit Card', 'Capital One ...3877'],
      boundCategories: ['Credit Card Payment'], opening: null },
  ]
  const txns = [
    tx('2026-01-05', 10000, 'Owner Investment'),
    tx('2026-01-12', -36, 'Business Expenses', 'Capital One Credit Card'),   // card charge, old label
    tx('2026-02-03', -50, 'Business Expenses', 'Capital One ...3877'),       // card charge, new label
    tx('2026-02-10', -400, 'Credit Card Payment'),                           // payment from checking
    tx('2026-02-11', 400, 'Credit Card Payment', 'Capital One Credit Card'), // card-feed echo of the same payment
  ]
  const bs = buildBalanceSheet({ txns, accounts: CARD_ACCOUNTS, year: 2026, registry: REGISTRY })
  const rows = sec => bs.sections.find(s => s.section === sec).rows

  it('merges both feed labels and the bound category into ONE card line', () => {
    const liab = rows('Current Liabilities')
    expect(liab.map(r => r.name)).toEqual(['Credit Card — Capital One'])
    const card = liab[0]
    expect(card.byMonth[1]).toBe(36)          // charge
    // + 50 new-label charge − 400 payment; the card-feed echo cancels itself
    expect(card.byMonth[2]).toBe(-314)
  })

  it('names the bank line from the registry and drops the raw feed label', () => {
    const names = rows('Current Assets').map(r => r.name)
    expect(names).toContain('Cash — Freedom Checking')
    expect(names.some(n => n.includes('FREEDOM CHECKING FOR BUSINESS'))).toBe(false)
  })

  it('leaves no standalone bound-category line and keeps the identity', () => {
    expect(rows('Current Liabilities').some(r => r.name === 'Credit Card Payment')).toBe(false)
    bs.months.forEach(m => {
      expect(bs.computed.assets.byMonth[m]).toBeCloseTo(bs.computed.liabEquity.byMonth[m], 2)
    })
  })

  it('flags unmapped feed labels and still balances', () => {
    const withStray = [...txns, tx('2026-02-14', -75, 'Business Expenses', 'NEW BANK 9921')]
    const b = buildBalanceSheet({ txns: withStray, accounts: CARD_ACCOUNTS, year: 2026, registry: REGISTRY })
    expect(b.unmappedLabels).toEqual(['NEW BANK 9921'])
    const stray = b.sections.flatMap(s => s.rows).find(r => r.name.includes('NEW BANK 9921'))
    expect(stray.unmapped).toBe(true)
    b.months.forEach(m => {
      expect(b.computed.assets.byMonth[m]).toBeCloseTo(b.computed.liabEquity.byMonth[m], 2)
    })
  })

  it('applies opening balances with an Opening Balance Equity offset, identity intact', () => {
    const reg = [
      { ...REGISTRY[0], opening: { date: '2025-12-31', balance: 5000 } },
      { ...REGISTRY[1], opening: { date: '2025-12-31', balance: 700 } }, // owed at cutover
    ]
    const b = buildBalanceSheet({ txns, accounts: CARD_ACCOUNTS, year: 2026, registry: reg })
    expect(b.sections.find(s => s.section === 'Current Assets').rows
      .find(r => r.name === 'Cash — Freedom Checking').byMonth[1]).toBe(15000) // 5000 opening + 10000 investment
    const card = b.sections.find(s => s.section === 'Current Liabilities').rows[0]
    expect(card.byMonth[1]).toBe(736) // 700 opening + 36 charge
    const obe = b.sections.find(s => s.section === 'Equity').rows.find(r => r.name === 'Opening Balance Equity')
    expect(obe.byMonth[1]).toBe(4300) // 5000 bank − 700 card
    b.months.forEach(m => {
      expect(b.computed.assets.byMonth[m]).toBeCloseTo(b.computed.liabEquity.byMonth[m], 2)
    })
  })
})
