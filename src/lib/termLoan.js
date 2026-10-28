// Term loan planner — pure math for a LEAF term loan to the shop.
//
// One advance at closing. The proceeds settle the back taxes, the credit
// cards and the accountant's bill first and whatever is left lands in the shop's bank account as working
// capital. The loan then repays in level monthly payments sized on the
// amortization period; when the term is shorter than the amortization, the
// balance still owed at maturity is a balloon. buildTermLoan prices the loan
// and walks the bank balance alongside it; buildLoanSeeds reads the starting
// figures off the ledger so the scenario begins from what the books say.

import { isCashRow } from './cashFlow'
import { stripAcctNum } from './insights'
import { isPLSection } from './sections'

const round2 = n => Math.round(n * 100) / 100
const pad2 = n => String(n).padStart(2, '0')
const num = v => Number(v) || 0

// 'YYYY-MM-DD' plus k months, clamped to the month's last day (Jan 31 + 1 →
// Feb 28). String math throughout — a Date round-trip would shift the day in
// timezones behind UTC.
export function addMonths(iso, k) {
  const [y, m, d] = String(iso).split('-').map(Number)
  const idx = (y * 12 + (m - 1)) + k
  const ny = Math.floor(idx / 12), nm = idx % 12 + 1
  const last = new Date(ny, nm, 0).getDate()
  return `${ny}-${pad2(nm)}-${pad2(Math.min(d, last))}`
}

// Whole days from one 'YYYY-MM-DD' to another.
const daysBetween = (from, to) => {
  const utc = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  return Math.round((utc(to) - utc(from)) / 86400000)
}

// Payments fall on the first of the month. A loan that closes before the 15th
// starts paying on the first of the next month; one that closes on or after
// the 15th skips that one and starts a month later (Nov 15 → Jan 1). Closing
// on the 1st itself is simply a full month to the first payment.
export function firstPaymentDate(closingDate) {
  const day = Number(closingDate.slice(8, 10))
  return addMonths(`${closingDate.slice(0, 8)}01`, day >= 15 ? 2 : 1)
}

// Level payment that retires `principal` over `months` at a monthly rate.
export function levelPayment(principal, monthlyRate, months) {
  if (!(principal > 0) || !(months > 0)) return 0
  if (!(monthlyRate > 0)) return round2(principal / months)
  return round2(principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -months)))
}

// Mechanics: interest accrues monthly at APR/12 on the opening balance and
// payments fall on the first of the month (see firstPaymentDate). The first
// period is rarely a whole month, so the first payment carries the odd days:
// actual/365 interest from closing to one month before the first payment, on
// top of the regular month — or, when closing is less than a month ahead of it,
// just the actual days. The fee (if any) is netted from the proceeds rather
// than added to the loan. `monthlyFreeCash` is what
// the shop's bank account gains in an ordinary month BEFORE card payments and
// before this loan's payment — the cards are paid off at closing, so the cash
// that was servicing them is what now services the loan. That history already
// paid the owner `ownerPayCurrent` through payroll, so only a raise above it —
// grossed up by the employer's share of payroll tax — comes out of it.
export function buildTermLoan({
  amount,
  aprPct = 0,
  termMonths,
  amortMonths,
  closingDate,
  originationPct = 0,
  backTaxes = 0,
  cardPayoff = 0,
  accountantPayable = 0,
  openingCash = 0,
  monthlyFreeCash = 0,
  ownerPayCurrent = 0,
  ownerPayProposed = ownerPayCurrent,
  payrollTaxPct = 0,
}) {
  const principal = num(amount)
  const term = Math.round(num(termMonths))
  if (!(principal > 0) || !(term > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(closingDate || '')) return null
  // An amortization shorter than the term just means the loan is gone early.
  const amort = Math.max(1, Math.round(num(amortMonths)) || term)
  const months = Math.min(term, amort)
  const rate = Math.max(0, num(aprPct)) / 100 / 12
  const payment = levelPayment(principal, rate, amort)

  const fee     = round2(principal * Math.max(0, num(originationPct)) / 100)
  const taxes   = round2(Math.max(0, num(backTaxes)))
  const cards   = round2(Math.max(0, num(cardPayoff)))
  const accountant = round2(Math.max(0, num(accountantPayable)))
  const toBank  = round2(principal - fee - taxes - cards - accountant)

  const firstDate = firstPaymentDate(closingDate)
  const anchor = addMonths(firstDate, -1) // where a regular first month would begin
  const daily = principal * rate * 12 / 365
  const oddInterest = anchor >= closingDate
    ? round2(daily * daysBetween(closingDate, anchor))
    : round2(daily * daysBetween(closingDate, firstDate) - principal * rate)

  const schedule = []
  let balance = principal
  let totalInterest = 0
  for (let k = 1; k <= months; k++) {
    const regular = round2(balance * rate)
    const interest = k === 1 ? round2(regular + oddInterest) : regular
    let princ = round2(payment - regular)
    // The last payment of a fully amortizing loan absorbs the rounding cents.
    if (princ > balance || (k === months && amort <= term)) princ = balance
    const pmt = round2(princ + interest)
    balance = round2(balance - princ)
    totalInterest = round2(totalInterest + interest)
    schedule.push({ n: k, date: addMonths(firstDate, k - 1), payment: pmt, interest, principal: princ, balance })
  }
  const balloon = balance > 0.005 ? balance : 0
  const maturityDate = addMonths(firstDate, months - 1)

  // The shop's bank balance alongside the loan. Month 0 is closing day.
  const freeBefore = num(monthlyFreeCash)
  const raise = round2(num(ownerPayProposed) - num(ownerPayCurrent))
  const raiseCost = round2(raise * (1 + Math.max(0, num(payrollTaxPct)) / 100))
  const free = round2(freeBefore - raiseCost)
  let cash = round2(num(openingCash) + toBank)
  const series = [{ n: 0, date: closingDate, loanBalance: principal, cash }]
  let minCash = { amount: cash, date: closingDate }
  schedule.forEach(row => {
    cash = round2(cash + free - row.payment - (row.n === months ? balloon : 0))
    if (cash < minCash.amount) minCash = { amount: cash, date: row.date }
    series.push({ n: row.n, date: row.date, loanBalance: row.n === months ? 0 : row.balance, cash })
  })

  return {
    payment, months, fee, taxes, cards, accountant, toBank, oddInterest,
    freeBefore, raise, raiseCost, freeCash: free,
    schedule, balloon, maturityDate,
    totalInterest,
    lenderEarnings: round2(totalInterest + fee),
    totalRepaid: round2(principal + totalInterest),
    // The first twelve months of payments — plus the balloon when the loan
    // matures inside that year, since that is debt service too.
    annualDebtService: round2(
      schedule.slice(0, 12).reduce((s, r) => s + r.payment, 0) + (months <= 12 ? balloon : 0)),
    dscr: payment > 0 ? free / payment : null,
    series, minCash,
    endingCash: cash,
  }
}

// Employee share of Social Security and Medicare, withheld from wages but not
// from an SSDI check — so a dollar of benefit takes more than a dollar of pay
// to replace.
const EMPLOYEE_FICA = 0.0765

// The most the owner can be paid through payroll on this loan. Up to three
// ceilings:
//   • coverage — the free cash left after the raise still covers the regular
//     payment `dscrTarget` times over, month in, month out (sustainable)
//   • cash — the bank balance never dips below `cashFloor` before maturity,
//     balloon included; this one can spend the working capital down, so it
//     is only the limit while the loan's cash lasts
//   • benefit — gross pay that keeps his SSDI intact (`benefitLimit`, the
//     trial-work or SGA line); none when it is 0
// The first two are solved for the monthly cost of the raise, then backed out
// of the employer's payroll tax. The answer is the lowest ceiling.
//
// With `ssdiBenefit` (his monthly check) it also prices giving the benefit up:
// the gross pay that matches benefit plus capped pay after FICA, and the free
// cash the shop would need to carry that pay at the coverage target.
export function maxOwnerPay(inputs, { dscrTarget = 1.25, cashFloor = 0, benefitLimit = 0, ssdiBenefit = 0 } = {}) {
  const base = buildTermLoan({ ...inputs, ownerPayProposed: inputs.ownerPayCurrent })
  if (!base) return null
  const gross = 1 + Math.max(0, num(inputs.payrollTaxPct)) / 100
  const current = num(inputs.ownerPayCurrent)
  const toPay = cost => round2(Math.max(0, current + cost / gross))

  const coverageCost = base.freeCash - num(dscrTarget) * base.payment
  // Each month k of extra cost x lowers that month's balance by k·x.
  const floor = num(cashFloor)
  const cashCost = base.series[0].cash < floor ? -Infinity : Math.min(
    ...base.series.slice(1).map(p => (p.cash - floor) / p.n))

  const byCoverage = toPay(coverageCost)
  const byCash = Number.isFinite(cashCost) ? toPay(cashCost) : 0
  const byBenefit = num(benefitLimit) > 0 ? round2(num(benefitLimit)) : null
  const ceilings = { coverage: byCoverage, cash: byCash, ...(byBenefit != null && { benefit: byBenefit }) }
  const binding = Object.keys(ceilings).reduce((a, b) => ceilings[b] < ceilings[a] ? b : a)

  let replacement = null
  if (byBenefit != null && num(ssdiBenefit) > 0) {
    const pay = round2(byBenefit + num(ssdiBenefit) / (1 - EMPLOYEE_FICA))
    const freeNeeded = round2(num(dscrTarget) * base.payment + (pay - current) * gross)
    replacement = {
      pay, freeNeeded,
      ready: byCoverage >= pay && byCash >= pay,
      shortfall: round2(Math.max(0, freeNeeded - base.freeCash)),
    }
  }

  return {
    byCoverage, byCash, byBenefit,
    max: ceilings[binding],
    withoutBenefit: Math.min(byCoverage, byCash),
    binding, replacement,
  }
}

// Starting figures from the ledger. `bs` is lib/balanceSheet's sheet for the
// latest year; the rest comes straight off the bank rows:
//   • cash, card balances and the sales-tax liability as the books carry them
//   • the last 12 complete months of what the bank account actually gained,
//     leaving out card payments (the loan retires the cards) and transfers to
//     the shop's own savings (the money didn't leave the business)
export function buildLoanSeeds({ txns, accounts = [], registry = [], bs = null, now = new Date() }) {
  const lastCol = bs?.months?.[bs.months.length - 1]
  const rowsOf = section => bs?.sections.find(s => s.section === section)?.rows ?? []
  const at = r => r.byMonth?.[lastCol] ?? 0

  const cash = bs ? round2(rowsOf('Current Assets').filter(r => r.registry).reduce((s, r) => s + at(r), 0)) : null
  const cardRows = rowsOf('Current Liabilities').filter(r => r.registry)
  const cardBalance = bs ? round2(cardRows.reduce((s, r) => s + at(r), 0)) : null
  const taxRow = rowsOf('Current Liabilities').find(r => stripAcctNum(r.name) === 'Sales Tax Payable')
  const taxPayable = taxRow ? round2(at(taxRow)) : null

  const bound = type => new Set(
    registry.filter(e => e.type === type).flatMap(e => e.boundCategories || []).map(stripAcctNum))
  const cardCats = bound('card'), transferCats = bound('bank')

  const byMonth = new Map() // ym → { net, cardPayments }
  const nowYm = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`
  txns.forEach(t => {
    if (!isCashRow(t, registry)) return // bank rows only — no card feed, no journal entries
    const ym = (t.transaction_date || '').slice(0, 7)
    if (!ym || ym >= nowYm) return // the in-progress month would understate
    const role = stripAcctNum((t.category || '').trim())
    if (transferCats.has(role)) return
    if (!byMonth.has(ym)) byMonth.set(ym, { net: 0, cardPayments: 0 })
    const m = byMonth.get(ym)
    const amt = num(t.amount)
    if (cardCats.has(role)) m.cardPayments -= amt
    else m.net += amt
  })
  const history = [...byMonth.keys()].sort().slice(-12).map(ym => {
    const m = byMonth.get(ym)
    return { ym, freeCash: round2(m.net), cardPayments: round2(m.cardPayments) }
  })
  const avg = key => history.length
    ? round2(history.reduce((s, h) => s + h[key], 0) / history.length)
    : null

  // Earnings over the same months, for the lender's coverage test: the P&L
  // bottom line (every account, accrual) with interest and depreciation added
  // back, and what the owner took out. Annualized when the ledger is short.
  const window = new Set(history.map(h => h.ym))
  const sectionOf = new Map(accounts.map(a => [a.name, a.pl_section]))
  let netIncome = 0, interest = 0, depAmort = 0, ownerDraws = 0
  txns.forEach(t => {
    const cat = (t.category || '').trim()
    if (!cat || !window.has((t.transaction_date || '').slice(0, 7))) return
    const section = sectionOf.get(cat) ?? 'Operating Expenses'
    const amt = num(t.amount)
    if (isPLSection(section)) {
      netIncome += amt
      if (section !== 'Non-Operating Income' && /\binterest\b/i.test(cat)) interest -= amt
      if (/depreciation|amortization/i.test(cat)) depAmort -= amt
    } else if (section === 'Equity' && /\bdraws?\b/i.test(cat)) ownerDraws -= amt
  })
  const annualize = v => history.length ? round2(v * 12 / history.length) : null
  const earnings = history.length ? {
    months: history.length,
    netIncome: annualize(netIncome),
    interest: annualize(interest),
    depAmort: annualize(depAmort),
    ebitda: annualize(netIncome + interest + depAmort),
    ownerDraws: annualize(ownerDraws),
    afterDraws: annualize(netIncome + interest + depAmort - ownerDraws),
  } : null

  return {
    cash, cardBalance, taxPayable,
    cardLabels: cardRows.map(r => r.name),
    history, earnings,
    avgFreeCash: avg('freeCash'),
    avgCardPayments: avg('cardPayments'),
    asOf: history.length ? history[history.length - 1].ym : null,
  }
}
