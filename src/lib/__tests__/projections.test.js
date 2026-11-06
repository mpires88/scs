import { describe, it, expect } from 'vitest'
import { buildProjectionBase, buildProjection, projectedFreeCash } from '../projections'
import { buildTermLoan, addMonths } from '../termLoan'

const accounts = [
  { name: 'Sales', pl_section: 'Revenue' },
  { name: 'Sales Tax', pl_section: 'Deductions to Income' },
  { name: 'Product', pl_section: 'Cost of Goods Sold' },
  { name: 'Rent', pl_section: 'Operating Expenses' },
  { name: 'Payroll & Wages', pl_section: 'Operating Expenses' },
  { name: 'Owner Draw', pl_section: 'Equity' },
]

// Twelve months, Nov 2025 – Oct 2026: $10k net revenue ($20k in December),
// 80% cost of goods except October (not booked yet), $2,000 of expenses that
// include $700 of owner payroll, and $900 of draws.
const txns = []
for (let i = 0; i < 12; i++) {
  const y = i < 2 ? 2025 : 2026, m = ((10 + i) % 12) + 1
  const ym = `${y}-${String(m).padStart(2, '0')}`
  const rev = m === 12 ? 20000 : 10000
  txns.push({ transaction_date: `${ym}-05`, category: 'Sales', amount: rev + 600 })
  txns.push({ transaction_date: `${ym}-05`, category: 'Sales Tax', amount: -600 })
  if (m !== 10) txns.push({ transaction_date: `${ym}-28`, category: 'Product', amount: -rev * 0.8 })
  txns.push({ transaction_date: `${ym}-01`, category: 'Rent', amount: -1300 })
  txns.push({ transaction_date: `${ym}-15`, category: 'Payroll & Wages', amount: -700 })
  txns.push({ transaction_date: `${ym}-20`, category: 'Owner Draw', amount: -900 })
}
txns.push({ transaction_date: '2026-11-02', category: 'Sales', amount: 99999 }) // in-progress month
const NOW = new Date(2026, 10, 5)

describe('buildProjectionBase', () => {
  it('reads the last twelve complete months', () => {
    const b = buildProjectionBase({ txns, accounts, now: NOW })
    expect(b.months).toHaveLength(12)
    expect(b.startYm).toBe('2025-11')
    expect(b.endYm).toBe('2026-10')
    expect(b.netRevByCal[12]).toBe(20000)
    expect(b.netRevByCal[11]).toBe(10000)
    expect(b.cogsPct).toBe(80) // October's missing COGS doesn't drag it down
    expect(b.opexAvg).toBe(2000)
    expect(b.drawsAvg).toBe(900)
  })
})

describe('buildProjection', () => {
  const base = buildProjectionBase({ txns, accounts, now: NOW })
  const opts = {
    growthFirstPct: 10, growthAfterPct: 5, cogsPct: 80, expenseGrowthPct: 3, years: 2,
    ownerPayCurrent: 700, ownerPayNow: 1210, ownerPayTarget: 4000, payrollTaxPct: 10,
    drawsNow: 900, drawsAfter: 900, dscrTarget: 1.25,
  }

  it('grows revenue by year and keeps the seasonality', () => {
    const p = buildProjection(base, opts)
    expect(p.rows).toHaveLength(24)
    expect(p.rows[0].ym).toBe('2026-11')
    expect(p.rows[0].netRev).toBe(11000)
    expect(p.rows[1].netRev).toBe(22000)          // December
    expect(p.rows[12].netRev).toBeCloseTo(11550, 2) // year two: +10% then +5%
    expect(p.rows[0].cogs).toBe(8800)
  })

  it('pulls the owner out of expenses and charges pay plus payroll tax', () => {
    const p = buildProjection(base, opts)
    expect(p.opexExOwner).toBe(2000 - 770)
    const r = p.rows[0]
    expect(r.opex).toBeCloseTo(1230 * 1.03, 2)
    expect(r.ownerPay).toBe(1210)
    expect(r.payrollTax).toBe(121)
    expect(r.ownerCost).toBe(1331)
    expect(r.netIncome).toBeCloseTo(r.grossProfit - r.opex - 1331, 2)
    // Draws come out of cash, not net income.
    expect(r.cashLeft).toBeCloseTo(r.netIncome - 900, 2)
  })

  it('finds no sustainable month when the margin is too thin, and the revenue it would take', () => {
    const p = buildProjection(base, opts)
    expect(p.earliest).toBeNull()
    expect(p.rows.every(r => r.ownerPay === 1210)).toBe(true)
    const y1 = p.years[0]
    expect(p.revenueNeeded).toBeCloseTo((4000 * 12 * 1.1 + 900 * 12 + y1.opex) / 0.2, 2)
  })

  it('steps up at the earliest month the next twelve average enough', () => {
    const p = buildProjection(base, { ...opts, growthFirstPct: 100, growthAfterPct: 50, years: 3 })
    expect(p.earliest).not.toBeNull()
    const i = p.rows.findIndex(r => r.ym === p.earliest)
    expect(p.rows[i].capacity12).toBeGreaterThanOrEqual(4000)
    if (i > 0) expect(p.rows[i - 1].capacity12).toBeLessThan(4000)
    expect(p.rows[i].ownerPay).toBe(4000)
    if (i > 0) expect(p.rows[i - 1].ownerPay).toBe(1210)
  })

  it('honors a scheduled step-up and lower draws after it', () => {
    const p = buildProjection(base, { ...opts, stepYm: '2027-03', drawsAfter: 200 })
    const mar = p.rows.find(r => r.ym === '2027-03'), feb = p.rows.find(r => r.ym === '2027-02')
    expect(feb.ownerPay).toBe(1210)
    expect(feb.draws).toBe(900)
    expect(mar.ownerPay).toBe(4000)
    expect(mar.draws).toBe(200)
  })

  it('takes the loan payment out of cash and sets capacity against coverage', () => {
    const loan = buildTermLoan({ amount: 30000, aprPct: 9, termMonths: 36, amortMonths: 36, closingDate: '2026-11-03' })
    const p = buildProjection(base, { ...opts, loan })
    const dec = p.rows.find(r => r.ym === '2026-12')
    expect(dec.payment).toBe(loan.schedule[0].payment)
    expect(dec.capacity).toBeCloseTo((dec.beforeOwner - 900 - 1.25 * dec.payment) / 1.1, 2)
    expect(dec.cashLeft).toBeCloseTo(dec.beforeOwner - dec.ownerCost - 900 - dec.payment, 2)
  })
})

describe('projectedFreeCash', () => {
  const base = buildProjectionBase({ txns, accounts, now: NOW })
  const sc = { growthFirstPct: 0, growthAfterPct: 0, cogsPct: 80, expenseGrowthPct: 0, drawsNow: 900, drawsAfter: 300 }

  it('is profit before owner pay, less current pay with tax and draws', () => {
    const f = projectedFreeCash(base, sc, { ownerPayCurrent: 700, payrollTaxPct: 10, fromYm: '2027-01' })
    // Nov: $10k × 20% = $2,000 gross profit, $1,230 of other expenses.
    expect(f.byYm['2026-11']).toBeCloseTo(2000 - 1230 - 770 - 900, 2)
    expect(f.byYm['2026-12']).toBeCloseTo(4000 - 1230 - 770 - 900, 2)
    expect(Object.keys(f.byYm).length).toBe(120) // ten years, for any loan term
    expect(f.avg).toBeCloseTo((11 * -900 + 1100) / 12, 2)
  })

  it('switches to the after-step draws from the step-up month', () => {
    const f = projectedFreeCash(base, sc, { ownerPayCurrent: 700, payrollTaxPct: 10, stepYm: '2027-06' })
    expect(f.byYm['2027-05']).toBeCloseTo(-900, 2)
    expect(f.byYm['2027-06']).toBeCloseTo(-300, 2)
  })

  it('drives the loan page’s bank balance month by month', () => {
    const f = projectedFreeCash(base, sc, { ownerPayCurrent: 700, payrollTaxPct: 10 })
    const loanIn = { amount: 30000, aprPct: 9, termMonths: 12, amortMonths: 12, closingDate: '2026-11-03', ownerPayCurrent: 700, payrollTaxPct: 10 }
    const flat = buildTermLoan({ ...loanIn, monthlyFreeCash: 0 })
    const byMonth = buildTermLoan({ ...loanIn, monthlyFreeCash: 0, freeCashByYm: f.byYm })
    // Each payment is met by the month before it.
    const earned = r => addMonths(r.date, -1).slice(0, 7)
    const expected = flat.endingCash + flat.schedule.reduce((s, r) => s + f.byYm[earned(r)], 0)
    expect(byMonth.endingCash).toBeCloseTo(expected, 1)
  })

  it('counts the month between closing and the first payment — December, here', () => {
    const f = projectedFreeCash(base, sc, { ownerPayCurrent: 700, payrollTaxPct: 10 })
    // Closes Nov 30, first payment Jan 1: that point carries December.
    const loan = buildTermLoan({ amount: 30000, aprPct: 0, termMonths: 12, amortMonths: 12, closingDate: '2026-11-30',
      ownerPayCurrent: 700, payrollTaxPct: 10, freeCashByYm: f.byYm })
    expect(loan.schedule[0].date).toBe('2027-01-01')
    expect(loan.series[1].cash - loan.series[0].cash).toBeCloseTo(f.byYm['2026-12'] - loan.schedule[0].payment, 2)
  })
})

describe('SSDI in what reaches the owner', () => {
  const base = buildProjectionBase({ txns, accounts, now: NOW })
  const opts = { cogsPct: 80, years: 1, ownerPayCurrent: 700, ownerPayNow: 1210, ownerPayTarget: 4000, payrollTaxPct: 10, drawsNow: 900, drawsAfter: 900 }

  it('counts the check until the step-up and never in the shop’s cash', () => {
    const on = buildProjection(base, { ...opts, ssdiBenefit: 1600, stepYm: '2027-03' })
    const off = buildProjection(base, { ...opts, stepYm: '2027-03' })
    const feb = i => i.rows.find(r => r.ym === '2027-02'), mar = i => i.rows.find(r => r.ym === '2027-03')
    expect(feb(on).ssdi).toBe(1600)
    expect(feb(on).toOwner).toBe(1210 + 900 + 1600)
    expect(mar(on).ssdi).toBe(0)
    expect(mar(on).toOwner).toBe(4000 + 900)
    expect(feb(off).toOwner).toBe(1210 + 900)
    expect(feb(on).cashLeft).toBe(feb(off).cashLeft)
    expect(on.years[0].ssdi).toBe(1600 * 4) // Nov–Feb
  })
})
