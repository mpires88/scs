// Projections — pure math for the "what if the shop grows" page.
//
// The baseline is the last twelve complete months of the P&L. Each projected
// month takes the same calendar month's net revenue, grown x% in the first
// projected year and y% a year after that, so the shop's seasonality (the
// December spike) carries forward. Cost of goods is a flat share of net
// revenue. Operating expenses are the baseline's monthly average, rising a%
// a year. The owner's pay is pulled out of the baseline expenses and modeled
// on its own — gross pay plus the employer's payroll tax on it — so the page
// can ask how much of it the shop can carry.
//
// Owner draws (Equity — the car, its insurance, gas) are not an expense and
// carry no payroll tax, but they leave the bank all the same, so they come out
// of the cash line and out of what is left for pay.
//
// "Capacity" is the most gross owner pay a month could carry: what is left of
// gross profit after operating expenses, owner draws and the term loan's
// payment (times the coverage target), divided by 1 + the employer's
// payroll-tax rate. It uses the draws he'd take after the step-up, since that
// is the pay level it tests.
// Single months swing with the season, so the test for "sustainable from here"
// is the average capacity over the twelve months starting at that month.

import { isPLSection } from './sections'
import { addMonths } from './termLoan'

const round2 = n => Math.round(n * 100) / 100
const pad2 = n => String(n).padStart(2, '0')
const num = v => Number(v) || 0
const nextYm = (ym, k = 1) => addMonths(`${ym}-01`, k).slice(0, 7)

// The Projections page's starting assumptions, before anything is saved.
// Shared so the Term Loan Planner reads the same scenario the same way.
export const projectionDefaults = base => ({
  growthFirstPct:   10,
  growthAfterPct:   5,
  cogsPct:          base?.cogsPct ?? 80,
  expenseGrowthPct: 3,
  years:            3,
  includeLoan:      true,
  // Owner draws (car payment, its insurance, gas) — the ledger's average.
  drawsNow:         Math.round(base?.drawsAvg ?? 0),
  drawsAfter:       Math.round(base?.drawsAvg ?? 0),
})

// The last twelve complete months of the ledger's P&L, by section.
//   netRev — Revenue plus Deductions to Income (sales tax collected comes off)
//   cogs, opex — positive dollars spent
// `cogsPct` is measured only over months whose cost of goods has been booked;
// the newest month's estimate is often still missing.
export function buildProjectionBase({ txns, accounts, now = new Date() }) {
  const sectionOf = new Map(accounts.map(a => [a.name, a.pl_section]))
  const nowYm = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`
  const byYm = new Map()
  txns.forEach(t => {
    const cat = (t.category || '').trim()
    const ym = (t.transaction_date || '').slice(0, 7)
    if (!cat || !ym || ym >= nowYm) return
    const sec = sectionOf.get(cat) ?? 'Operating Expenses'
    if (!isPLSection(sec)) return
    if (!byYm.has(ym)) byYm.set(ym, { ym, netRev: 0, cogs: 0, opex: 0 })
    const m = byYm.get(ym), amt = num(t.amount)
    if (sec === 'Revenue' || sec === 'Deductions to Income') m.netRev += amt
    else if (sec === 'Cost of Goods Sold') m.cogs -= amt
    else if (sec === 'Operating Expenses') m.opex -= amt
  })
  const draws = new Map()
  txns.forEach(t => {
    const cat = (t.category || '').trim()
    const ym = (t.transaction_date || '').slice(0, 7)
    if (!ym || ym >= nowYm || sectionOf.get(cat) !== 'Equity' || !/\bdraws?\b/i.test(cat)) return
    draws.set(ym, (draws.get(ym) ?? 0) - num(t.amount))
  })
  const months = [...byYm.keys()].sort().slice(-12).map(ym => {
    const m = byYm.get(ym)
    return { ym, netRev: round2(m.netRev), cogs: round2(m.cogs), opex: round2(m.opex) }
  })
  if (!months.length) return null

  const withCogs = months.filter(m => m.cogs > 0 && m.netRev > 0)
  const cogsPct = withCogs.length
    ? round2(withCogs.reduce((s, m) => s + m.cogs, 0) / withCogs.reduce((s, m) => s + m.netRev, 0) * 100)
    : null
  const netRevByCal = {}
  months.forEach(m => { netRevByCal[+m.ym.slice(5, 7)] = m.netRev })
  const opexAvg = round2(months.reduce((s, m) => s + m.opex, 0) / months.length)
  const drawsAvg = round2(months.reduce((s, m) => s + (draws.get(m.ym) ?? 0), 0) / months.length)
  return {
    months, cogsPct, netRevByCal, opexAvg, drawsAvg,
    netRevTotal: round2(months.reduce((s, m) => s + m.netRev, 0)),
    startYm: months[0].ym,
    endYm: months[months.length - 1].ym,
  }
}

// The projection itself. `loan` is buildTermLoan's result (or null for none);
// its schedule supplies each month's payment, interest and any balloon.
//
// Owner pay is `ownerPayNow` until the step-up month, `ownerPayTarget` from
// then on. The step-up month is `stepYm` when given; otherwise the earliest
// month the target is sustainable (null when it never is inside the horizon).
export function buildProjection(base, {
  growthFirstPct = 0,
  growthAfterPct = 0,
  cogsPct = 0,
  expenseGrowthPct = 0,
  years = 3,
  ownerPayCurrent = 0,   // what the baseline's payroll already carries
  ownerPayNow = ownerPayCurrent,
  ownerPayTarget = 0,
  drawsNow = 0,
  drawsAfter = drawsNow,
  ssdiBenefit = 0,       // his monthly check, paid until the step-up; 0 = not counted
  payrollTaxPct = 0,
  dscrTarget = 1,
  stepYm = null,
  loan = null,
} = {}) {
  if (!base) return null
  const horizon = Math.max(1, Math.min(10, Math.round(num(years)))) * 12
  const gross = 1 + Math.max(0, num(payrollTaxPct)) / 100
  const cogsShare = Math.max(0, num(cogsPct)) / 100
  const cover = Math.max(0, num(dscrTarget))
  // The baseline's expenses already include the owner's current payroll and
  // the employer's tax on it; take that out so it is modeled on its own.
  const opexExOwner = Math.max(0, base.opexAvg - num(ownerPayCurrent) * gross)

  const loanByYm = new Map((loan?.schedule ?? []).map(r => [r.date.slice(0, 7), r]))
  const maturityYm = loan?.maturityDate?.slice(0, 7)

  // Twelve extra months past the horizon so the last months still get a full
  // forward-looking average.
  const rows = []
  const first = nextYm(base.endYm)
  for (let i = 0; i < horizon + 12; i++) {
    const ym = nextYm(first, i)
    const yr = Math.floor(i / 12) // projection year, 0-based
    const revFactor = (1 + num(growthFirstPct) / 100) * Math.pow(1 + num(growthAfterPct) / 100, yr)
    const netRev = round2((base.netRevByCal[+ym.slice(5, 7)] ?? 0) * revFactor)
    const cogs = round2(netRev * cogsShare)
    const grossProfit = round2(netRev - cogs)
    const opex = round2(opexExOwner * Math.pow(1 + num(expenseGrowthPct) / 100, yr + 1))
    const beforeOwner = round2(grossProfit - opex)
    const lr = loanByYm.get(ym)
    const payment = lr?.payment ?? 0
    const interest = lr?.interest ?? 0
    const balloon = lr && ym === maturityYm ? num(loan.balloon) : 0
    const capacity = round2((beforeOwner - num(drawsAfter) - cover * payment) / gross)
    rows.push({ ym, yr, netRev, cogs, grossProfit, opex, beforeOwner, payment, interest, balloon, capacity })
  }
  rows.forEach((r, i) => {
    const win = rows.slice(i, i + 12)
    r.capacity12 = round2(win.reduce((s, x) => s + x.capacity, 0) / win.length)
  })

  const target = num(ownerPayTarget)
  const shown = rows.slice(0, horizon)
  const earliest = target > 0 ? shown.find(r => r.capacity12 >= target)?.ym ?? null : null
  const step = stepYm || earliest

  let cash = 0
  shown.forEach(r => {
    const stepped = !!(step && r.ym >= step && target > 0)
    r.ownerPay = stepped ? target : num(ownerPayNow)
    r.draws = round2(stepped ? num(drawsAfter) : num(drawsNow))
    // Everything that reaches him: payroll (what SSDI looks at), draws, and
    // the SSDI check itself while it lasts.
    r.ssdi = stepped ? 0 : Math.max(0, num(ssdiBenefit))
    r.toOwner = round2(r.ownerPay + r.draws + r.ssdi)
    r.payrollTax = round2(r.ownerPay * (gross - 1))
    r.ownerCost = round2(r.ownerPay + r.payrollTax)
    r.netIncome = round2(r.beforeOwner - r.ownerCost - r.interest)
    r.cashLeft = round2(r.beforeOwner - r.ownerCost - r.draws - r.payment - r.balloon)
    cash = round2(cash + r.cashLeft)
    r.cumCash = cash
  })

  const sum = (list, k) => round2(list.reduce((s, r) => s + r[k], 0))
  const yearsOut = []
  for (let y = 0; y < horizon / 12; y++) {
    const list = shown.filter(r => r.yr === y)
    yearsOut.push({
      yr: y, from: list[0].ym, to: list[list.length - 1].ym,
      netRev: sum(list, 'netRev'), cogs: sum(list, 'cogs'), grossProfit: sum(list, 'grossProfit'),
      opex: sum(list, 'opex'), beforeOwner: sum(list, 'beforeOwner'),
      ownerPay: sum(list, 'ownerPay'), draws: sum(list, 'draws'), ssdi: sum(list, 'ssdi'), toOwner: sum(list, 'toOwner'), payrollTax: sum(list, 'payrollTax'), ownerCost: sum(list, 'ownerCost'),
      payment: sum(list, 'payment'), balloon: sum(list, 'balloon'), interest: sum(list, 'interest'),
      netIncome: sum(list, 'netIncome'), cashLeft: sum(list, 'cashLeft'),
      capacity: round2(sum(list, 'capacity') / list.length),
    })
  }

  // Revenue the first projected year would need for the target to be
  // sustainable at these margins, with the draws and year-one loan payments.
  let revenueNeeded = null
  if (target > 0 && yearsOut.length) {
    const y1 = yearsOut[0]
    const margin = 1 - cogsShare
    if (margin > 0) {
      revenueNeeded = round2((target * 12 * gross + num(drawsAfter) * 12 + y1.opex + cover * y1.payment) / margin)
    }
  }

  return {
    rows: shown, years: yearsOut, opexExOwner: round2(opexExOwner),
    earliest, stepYm: step, target, revenueNeeded,
    baselineRev: base.netRevTotal,
  }
}

// The Term Loan Planner's free cash, month by month, from a projection: what
// the bank gains before the loan payment, at the owner's CURRENT pay (the loan
// page adds any raise or step-up itself). That is the month's profit before
// owner pay, less the current pay and its payroll tax, less draws — the
// after-step-up draws from `stepYm` on.
//
// It runs ten years out so any loan term is covered, and `avg` is the
// average of the twelve months from `fromYm` — the figure the loan page's
// coverage and pay-ceiling tests use.
export function projectedFreeCash(base, scenario, {
  ownerPayCurrent = 0, payrollTaxPct = 0, stepYm = null, fromYm = null,
} = {}) {
  const p = buildProjection(base, { ...scenario, years: 10, ownerPayTarget: 0, loan: null, ownerPayCurrent, payrollTaxPct })
  if (!p) return null
  const gross = 1 + Math.max(0, num(payrollTaxPct)) / 100
  const byYm = {}
  p.rows.forEach(r => {
    const draws = stepYm && r.ym >= stepYm ? num(scenario.drawsAfter ?? scenario.drawsNow) : num(scenario.drawsNow)
    byYm[r.ym] = round2(r.beforeOwner - num(ownerPayCurrent) * gross - draws)
  })
  const start = fromYm && byYm[fromYm] != null ? fromYm : p.rows[0].ym
  const win = Array.from({ length: 12 }, (_, k) => byYm[nextYm(start, k)]).filter(v => v != null)
  return { byYm, avg: round2(win.reduce((s, v) => s + v, 0) / win.length), fromYm: start }
}
