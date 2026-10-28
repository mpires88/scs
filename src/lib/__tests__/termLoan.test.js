import { describe, it, expect } from 'vitest'
import { addMonths, firstPaymentDate, levelPayment, buildTermLoan, buildLoanSeeds, maxOwnerPay } from '../termLoan'
import { buildBalanceSheet } from '../balanceSheet'

// $30k at 9% over 36 months, closing Nov 15: $6k of back taxes and $4k of
// cards settle at closing, the other $20k goes to the bank.
const BASE = {
  amount: 30000, aprPct: 9, termMonths: 36, amortMonths: 36, closingDate: '2026-11-15',
  backTaxes: 6000, cardPayoff: 4000, openingCash: 5000, monthlyFreeCash: 1500,
}

describe('addMonths', () => {
  it('rolls the year and clamps to the month end', () => {
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15')
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28')
    expect(addMonths('2026-12-01', 12)).toBe('2027-12-01')
  })
})

describe('firstPaymentDate', () => {
  it('is the first of next month when closing falls before the 15th', () => {
    expect(firstPaymentDate('2026-11-01')).toBe('2026-12-01')
    expect(firstPaymentDate('2026-11-14')).toBe('2026-12-01')
  })
  it('skips a month when closing falls on or after the 15th', () => {
    expect(firstPaymentDate('2026-11-15')).toBe('2027-01-01')
    expect(firstPaymentDate('2026-12-20')).toBe('2027-02-01')
  })
})

describe('levelPayment', () => {
  it('matches the standard annuity payment', () => {
    // 30,000 at 0.75%/mo over 36 → 953.99
    expect(levelPayment(30000, 0.09 / 12, 36)).toBeCloseTo(953.99, 2)
  })
  it('is straight-line at a zero rate', () => {
    expect(levelPayment(12000, 0, 24)).toBe(500)
  })
})

describe('buildTermLoan', () => {
  it('settles the taxes and cards and sends the rest to the bank', () => {
    const r = buildTermLoan(BASE)
    expect(r.taxes).toBe(6000)
    expect(r.cards).toBe(4000)
    expect(r.toBank).toBe(20000)
    expect(r.series[0].cash).toBe(25000) // opening cash + the remainder
  })

  it('nets an origination fee out of the proceeds', () => {
    const r = buildTermLoan({ ...BASE, originationPct: 2 })
    expect(r.fee).toBe(600)
    expect(r.toBank).toBe(19400)
    expect(r.lenderEarnings).toBeCloseTo(r.totalInterest + 600, 2)
  })

  it('fully amortizes when term equals amortization', () => {
    const r = buildTermLoan(BASE)
    expect(r.schedule).toHaveLength(36)
    expect(r.schedule[35].balance).toBe(0)
    expect(r.balloon).toBe(0)
    expect(r.maturityDate).toBe('2029-12-01')
    const principal = r.schedule.reduce((s, x) => s + x.principal, 0)
    expect(principal).toBeCloseTo(30000, 2)
    expect(r.totalInterest).toBeCloseTo(r.schedule.reduce((s, x) => s + x.interest, 0), 2)
    // Payments on the first: Nov 15 closing → Jan 1. The first payment carries
    // 16 odd days (Nov 15 → Dec 1) on top of its regular month of interest.
    const odd = Math.round(30000 * 0.09 * 16 / 365 * 100) / 100
    expect(r.oddInterest).toBe(odd)
    expect(r.schedule[0].date).toBe('2027-01-01')
    expect(r.schedule[0].interest).toBeCloseTo(225 + odd, 2)
    expect(r.schedule[0].payment).toBeCloseTo(r.payment + odd, 2)
    expect(r.schedule[1].date).toBe('2027-02-01')
    expect(r.schedule[1].payment).toBe(r.payment)
  })

  it('charges only the actual days when the first payment is under a month away', () => {
    const r = buildTermLoan({ ...BASE, closingDate: '2026-11-10' })
    expect(r.schedule[0].date).toBe('2026-12-01')
    expect(r.schedule[0].interest).toBeCloseTo(30000 * 0.09 * 21 / 365, 2)
    expect(buildTermLoan({ ...BASE, closingDate: '2026-11-01' }).oddInterest).toBe(0)
  })

  it('leaves a balloon when the term is shorter than the amortization', () => {
    const r = buildTermLoan({ ...BASE, termMonths: 12, amortMonths: 60 })
    expect(r.schedule).toHaveLength(12)
    expect(r.payment).toBeCloseTo(levelPayment(30000, 0.0075, 60), 2)
    expect(r.balloon).toBeGreaterThan(24000)
    expect(r.balloon).toBe(r.schedule[11].balance)
    // The balloon comes out of the bank at maturity.
    const before = r.series[11].cash
    expect(r.series[12].cash).toBeCloseTo(before + 1500 - r.payment - r.balloon, 2)
    expect(r.series[12].loanBalance).toBe(0)
  })

  it('ends early when the amortization is shorter than the term', () => {
    const r = buildTermLoan({ ...BASE, termMonths: 36, amortMonths: 24 })
    expect(r.months).toBe(24)
    expect(r.balloon).toBe(0)
    expect(r.schedule[23].balance).toBe(0)
  })

  it('tracks the bank balance and its low point', () => {
    const r = buildTermLoan({ ...BASE, monthlyFreeCash: 500 })
    expect(r.series[1].cash).toBeCloseTo(25000 + 500 - r.schedule[0].payment, 2)
    expect(r.minCash.amount).toBe(r.endingCash) // payment outruns free cash all the way
    expect(r.dscr).toBeCloseTo(500 / r.payment, 4)
  })

  it('shows a shortfall when the payoffs exceed the loan', () => {
    const r = buildTermLoan({ ...BASE, amount: 8000 })
    expect(r.toBank).toBe(-2000)
  })

  it('returns null without an amount, a term or a closing date', () => {
    expect(buildTermLoan({ ...BASE, amount: 0 })).toBeNull()
    expect(buildTermLoan({ ...BASE, termMonths: 0 })).toBeNull()
    expect(buildTermLoan({ ...BASE, closingDate: '' })).toBeNull()
  })
})

describe('buildLoanSeeds', () => {
  const registry = [
    { key: 'chk', type: 'bank', label: 'Checking', matches: ['CHK'], boundCategories: [] },
    { key: 'card', type: 'card', label: 'Card', matches: ['CARD'], boundCategories: ['Card Payment'] },
    { key: 'sav', type: 'bank', label: 'Savings', matches: [], boundCategories: ['Savings'] },
  ]
  const accounts = [
    { name: 'Sales', pl_section: 'Revenue' },
    { name: 'Rent', pl_section: 'Operating Expenses' },
    { name: 'Card Payment', pl_section: 'Current Liabilities' },
    { name: 'Sales Tax Payable', pl_section: 'Current Liabilities' },
    { name: 'Savings', pl_section: 'Current Assets' },
  ]
  const txns = [
    { transaction_date: '2026-08-05', account: 'CHK', category: 'Sales', amount: 5000 },
    { transaction_date: '2026-08-06', account: 'CHK', category: 'Rent', amount: -2000 },
    { transaction_date: '2026-08-10', account: 'CARD', category: 'Rent', amount: -900 },
    { transaction_date: '2026-08-20', account: 'CHK', category: 'Card Payment', amount: -400 },
    { transaction_date: '2026-08-21', account: 'CHK', category: 'Savings', amount: -300 },
    { transaction_date: '2026-09-05', account: 'CHK', category: 'Sales', amount: 3000 },
    { transaction_date: '2026-09-30', account: 'Adjustments', category: 'Sales Tax Payable', amount: 250 },
    { transaction_date: '2026-09-30', account: 'Adjustments', category: 'Sales', amount: -250 },
    { transaction_date: '2026-10-02', account: 'CHK', category: 'Sales', amount: 900 }, // in-progress month
  ]
  const bs = buildBalanceSheet({ txns, accounts, year: 2026, registry })
  const seeds = buildLoanSeeds({ txns, registry, bs, now: new Date(2026, 9, 9) })

  it('reads cash, card debt and the tax liability off the balance sheet', () => {
    expect(seeds.cash).toBe(6500)        // 6200 checking + 300 in savings
    expect(seeds.cardBalance).toBe(500)  // 900 charged − 400 paid
    expect(seeds.taxPayable).toBe(250)
  })

  it('averages complete months of bank cash, before card payments and transfers', () => {
    expect(seeds.history).toEqual([
      { ym: '2026-08', freeCash: 3000, cardPayments: 400 },
      { ym: '2026-09', freeCash: 3000, cardPayments: 0 },
    ])
    expect(seeds.avgFreeCash).toBe(3000)
    expect(seeds.avgCardPayments).toBe(200)
    expect(seeds.asOf).toBe('2026-09')
  })

  it('annualizes earnings with interest and depreciation added back', () => {
    const accts = [...accounts,
      { name: 'Interest Expense', pl_section: 'Non-Operating Expenses' },
      { name: 'Depreciation - FF&E', pl_section: 'Operating Expenses' },
      { name: 'Owner Draw', pl_section: 'Equity' },
    ]
    const more = [...txns,
      { transaction_date: '2026-09-10', account: 'CARD', category: 'Interest Expense', amount: -60 },
      { transaction_date: '2026-09-30', account: 'Adjustments', category: 'Depreciation - FF&E', amount: -40 },
      { transaction_date: '2026-09-12', account: 'CHK', category: 'Owner Draw', amount: -500 },
    ]
    const e = buildLoanSeeds({ txns: more, accounts: accts, registry, bs, now: new Date(2026, 9, 9) }).earnings
    // Two months: 5000 − 2000 − 900 + 3000 − 250 − 60 − 40 = 4750, ×6.
    expect(e.months).toBe(2)
    expect(e.netIncome).toBe(28500)
    expect(e.interest).toBe(360)
    expect(e.depAmort).toBe(240)
    expect(e.ebitda).toBe(29100)
    expect(e.ownerDraws).toBe(3000)
    expect(e.afterDraws).toBe(26100)
  })
})

describe('annual debt service', () => {
  it('is twelve payments on a longer loan', () => {
    const r = buildTermLoan(BASE)
    expect(r.annualDebtService).toBeCloseTo(r.payment * 12 + r.oddInterest, 2)
  })
  it('includes the balloon when the loan matures within the year', () => {
    const r = buildTermLoan({ ...BASE, termMonths: 12, amortMonths: 60 })
    expect(r.annualDebtService).toBeCloseTo(r.payment * 12 + r.oddInterest + r.balloon, 2)
  })
})

describe('accountant payable and owner pay', () => {
  it('pays the accountant out of the proceeds', () => {
    const r = buildTermLoan({ ...BASE, accountantPayable: 4500 })
    expect(r.accountant).toBe(4500)
    expect(r.toBank).toBe(15500)
  })

  it('takes only the raise, plus employer tax, out of free cash', () => {
    const r = buildTermLoan({ ...BASE, ownerPayCurrent: 700, ownerPayProposed: 1000, payrollTaxPct: 10 })
    expect(r.raise).toBe(300)
    expect(r.raiseCost).toBe(330)
    expect(r.freeCash).toBe(1170)
    expect(r.dscr).toBeCloseTo(1170 / r.payment, 6)
    // Unchanged pay leaves the free cash alone.
    expect(buildTermLoan({ ...BASE, ownerPayCurrent: 700, payrollTaxPct: 10 }).freeCash).toBe(1500)
  })

  it('solves the pay that holds the coverage target exactly', () => {
    const inputs = { ...BASE, ownerPayCurrent: 700, payrollTaxPct: 7.65 }
    const m = maxOwnerPay(inputs, { dscrTarget: 1.25 })
    const at = buildTermLoan({ ...inputs, ownerPayProposed: m.byCoverage })
    expect(at.dscr).toBeCloseTo(1.25, 2)
  })

  it('caps pay at the SSDI line and prices replacing the benefit', () => {
    const inputs = { ...BASE, ownerPayCurrent: 700, payrollTaxPct: 0 }
    const m = maxOwnerPay(inputs, { dscrTarget: 1, benefitLimit: 1210, ssdiBenefit: 1500 })
    expect(m.binding).toBe('benefit')
    expect(m.max).toBe(1210)
    expect(m.withoutBenefit).toBeGreaterThan(1210)
    // $1,500 of untaxed benefit takes $1,500 / (1 − 7.65%) of wages to match.
    expect(m.replacement.pay).toBeCloseTo(1210 + 1500 / 0.9235, 2)
    // At that pay the shop falls short of covering the payment by the shortfall.
    expect(m.replacement.ready).toBe(false)
    const at = buildTermLoan({ ...inputs, ownerPayProposed: m.replacement.pay })
    expect(at.freeCash + m.replacement.shortfall).toBeCloseTo(at.payment, 0)
    expect(m.replacement.freeNeeded).toBeCloseTo(1500 + m.replacement.shortfall, 2)
  })

  it('solves the pay that keeps the bank balance at the floor', () => {
    const inputs = { ...BASE, ownerPayCurrent: 700, payrollTaxPct: 0 }
    const m = maxOwnerPay(inputs, { dscrTarget: 0, cashFloor: 2000 })
    expect(m.binding).toBe('cash')
    const at = buildTermLoan({ ...inputs, ownerPayProposed: m.byCash })
    expect(at.minCash.amount).toBeCloseTo(2000, 0)
  })
})
