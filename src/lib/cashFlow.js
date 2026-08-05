// Cash Flow Statement.
//
// Cash itself is defined by the bank feed: a row is cash only when its account
// maps to a registry entry of type 'bank'. Everything else is excluded —
// card-feed rows (charging a card moves no cash; the payment does, and that has
// its own bank row) and Adjustments rows (COGS estimates, the sales-tax
// accrual, the Square fee gross-up are journal entries by construction).
//
// Presentation follows the small-business convention the owner asked for:
//   • Operating — INDIRECT: start at net income and undo the places where
//     profit and cash part company (sales tax, stock, card-funded spending)
//   • Investing / Financing — DIRECT: the actual cash lines, since there are
//     few of them and naming them is clearer than a reconciliation
//   • the credit card sits in FINANCING, treated as a borrowing facility
//
// Whatever the presentation, the Operating total is pinned to real cash: it is
// computed directly from the bank rows, and the indirect lines must sum to it.
// `reconciles` re-derives the whole statement independently so a classification
// or add-back error can't hide.

import { matchLedgerAccount } from './balanceSheet'
import { ADJUSTMENTS_ACCOUNT, stripAcctNum } from './insights'
import { isPLSection } from './sections'

const round2 = n => Math.round(n * 100) / 100

export const CF_GROUPS = ['Operating', 'Investing', 'Financing']

// Activity for a category, by its chart section. Inventory is Operating —
// stock is working capital for a shop, not a capital asset. Current Liabilities
// are Operating too (remitting sales tax), EXCEPT the credit card, which the
// registry identifies and which is routed to Financing below.
export const GROUP_BY_SECTION = {
  'Revenue':                 'Operating',
  'Deductions to Income':    'Operating',
  'Cost of Goods Sold':      'Operating',
  'Operating Expenses':      'Operating',
  'Non-Operating Income':    'Operating',
  'Non-Operating Expenses':  'Operating',
  'Current Assets':          'Operating',
  'Current Liabilities':     'Operating',
  'Non-Current Assets':      'Investing',
  'Non-Current Liabilities': 'Financing',
  'Equity':                  'Financing',
}

const UNCLASSIFIED = 'Uncategorized'
const ROLE_TAX_COLLECTED = 'Sales Tax Collected'
const ROLE_TAX_PAYABLE   = 'Sales Tax Payable'
const ROLE_INVENTORY     = 'Inventory'

export function isCashRow(t, registry) {
  const acct = (t.account || '').trim()
  if (!acct || acct === ADJUSTMENTS_ACCOUNT) return false
  return matchLedgerAccount(registry, acct)?.type === 'bank'
}

const isCardRow = (t, registry) =>
  matchLedgerAccount(registry, (t.account || '').trim())?.type === 'card'

export function cashFlowYears(txns, registry = []) {
  return [...new Set(
    txns.filter(t => isCashRow(t, registry))
        .map(t => +(t.transaction_date || '').slice(0, 4))
        .filter(Boolean)
  )].sort()
}

// `columns` overrides which columns to show, so the combined page can line all
// three statements up on the same months. A column with no cash reads zero;
// nothing is dropped, because the page passes a superset of what this derives.
export function buildCashFlow({ txns, accounts = [], registry = [], year, period = 'monthly', columns = null }) {
  const yearly = period === 'yearly'
  const allDates = period === 'all'   // every month of every year, side by side
  if (!yearly && !allDates && !year) return null

  const cash = txns.filter(t => isCashRow(t, registry))
  if (!cash.length) return null

  const sectionOf = new Map(accounts.map(a => [stripAcctNum(a.name), a.pl_section]))
  const colOf = t => yearly
    ? +(t.transaction_date || '').slice(0, 4)
    : allDates
      ? (t.transaction_date || '').slice(0, 7)
      : +(t.transaction_date || '').slice(5, 7)
  const inScope = t => (yearly || allDates || (t.transaction_date || '').startsWith(String(year))) && colOf(t)

  const scopedCash = cash.filter(inScope)
  if (!scopedCash.length) return null
  let months = [...new Set(scopedCash.map(colOf))]
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
  // All-dates columns run continuously — a quiet month is a zero column, not
  // a silently missing one, so the opening/closing chain stays honest.
  if (allDates && months.length) {
    const filled = []
    let [y, m] = String(months[0]).split('-').map(Number)
    const last = months[months.length - 1]
    for (let ym = months[0]; ym <= last;) {
      filled.push(ym)
      m += 1
      if (m > 12) { m = 1; y += 1 }
      ym = `${y}-${String(m).padStart(2, '0')}`
    }
    months = filled
  }
  if (columns?.length) months = [...columns]

  const role = t => stripAcctNum((t.category || '').trim()) || UNCLASSIFIED
  // Categories the registry binds to a card — payments to it are financing.
  const cardCats = new Set(
    registry.filter(e => e.type === 'card')
      .flatMap(e => e.boundCategories || [])
      .map(stripAcctNum))

  const groupOf = t => {
    const r = role(t)
    if (cardCats.has(r)) return 'Financing'
    return GROUP_BY_SECTION[sectionOf.get(r)] ?? 'Operating'
  }

  const blank = () => Object.fromEntries(months.map(m => [m, 0]))
  const accumulate = (rows, value) => {
    const by = blank()
    rows.forEach(t => { by[colOf(t)] += value(t) })
    months.forEach(m => { by[m] = round2(by[m]) })
    return by
  }
  const sumOf = by => round2(months.reduce((s, m) => s + by[m], 0))
  const line = (name, by, note) => ({ name, byMonth: by, total: sumOf(by), note })
  const amt = t => Number(t.amount) || 0

  // ── Investing and Financing: the actual cash lines, by category ────────────
  const directSection = group => {
    const rows = scopedCash.filter(t => groupOf(t) === group)
    const byCat = new Map()
    rows.forEach(t => {
      const n = (t.category || '').trim() || UNCLASSIFIED
      if (!byCat.has(n)) byCat.set(n, [])
      byCat.get(n).push(t)
    })
    return [...byCat.entries()]
      .map(([name, ts]) => line(name, accumulate(ts, amt)))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  }

  // ── Operating: net income, reconciled to cash ─────────────────────────────
  const scopedAll = txns.filter(inScope)          // every row, not just cash
  const isPL = t => isPLSection(sectionOf.get(role(t)))

  // Net income is the P&L bottom line: accrual, all accounts, cash or not.
  const netIncome = accumulate(scopedAll.filter(isPL), amt)

  // Sales tax was collected as cash inside the deposits but accrued OUT of
  // revenue as a liability, so add it back.
  const taxCollected = accumulate(
    scopedAll.filter(t => role(t) === ROLE_TAX_COLLECTED), t => -amt(t))

  // Remittances to the state are cash out but never touched the P&L.
  const taxPaid = accumulate(
    scopedCash.filter(t => role(t) === ROLE_TAX_PAYABLE), amt)

  // Stock bought is cash out but not an expense; COGS is an expense but no cash
  // moves. Summing every Inventory row nets the two into one working-capital
  // line: negative when the shelf grew.
  const inventory = accumulate(
    scopedAll.filter(t => role(t) === ROLE_INVENTORY), amt)

  // Anything bought on the card — a cost OR stock — is counted by the lines
  // above as though cash paid for it. None did; the card funded it, and the
  // cash shows up later as the card payment under financing. So back out
  // whatever a card row contributed to the lines above, whichever line it was.
  const namedContribution = t =>
    (isPL(t) ? amt(t) : 0)
    + (role(t) === ROLE_TAX_COLLECTED ? -amt(t) : 0)
    + (role(t) === ROLE_INVENTORY ? amt(t) : 0)
  const cardFunded = accumulate(
    scopedAll.filter(t => isCardRow(t, registry)), t => -namedContribution(t))

  const operatingCash = accumulate(scopedCash.filter(t => groupOf(t) === 'Operating'), amt)

  const named = [
    line('Net income', netIncome,
      'The bottom line from the Profit & Loss for the same period. Cash flow starts here and then '
      + 'undoes every place where profit and cash disagree.'),
    line('Sales tax collected', taxCollected,
      'Customers hand you sales tax along with the sale, so the cash arrives in your deposits — but it '
      + 'is never your income, so the P&L takes it straight back out. Added back here because the money '
      + 'really did land in the bank.'),
    line('Sales tax paid', taxPaid,
      'Cash you sent the state. It never appears on the P&L (it was never your income), but it '
      + 'definitely left the bank, so it comes out here.'),
    line('Change in inventory', inventory,
      'Buying stock costs cash but is not an expense — it sits on the shelf as an asset. Cost of Goods '
      + 'Sold is the reverse: an expense with no cash attached. This one line nets the two. Negative '
      + 'means the shelf grew, which is usually where a profitable month’s cash went.'),
    line('Add back: bought on the card', cardFunded,
      'Costs and stock put on the credit card. They count against profit (or land on the shelf) but no '
      + 'cash left the bank — the card paid. The cash shows up later under Financing, when you pay the '
      + 'card. Without this the same spending would be counted twice.'),
  ]
  // Anything the named lines don't explain. Should be nothing; shown rather
  // than swallowed so a gap is visible instead of silently distorting a line.
  const residual = blank()
  months.forEach(m => {
    residual[m] = round2(operatingCash[m] - named.reduce((s, l) => s + l.byMonth[m], 0))
  })
  const operatingRows = [...named]
  if (months.some(m => Math.abs(residual[m]) >= 0.005)) {
    operatingRows.push(line('Other timing differences', residual,
      'A balancing figure: cash that moved through the bank in a way none of the lines above explain. '
      + 'It is shown rather than hidden so nothing is quietly absorbed into another line. It is usually '
      + 'a category the chart of accounts has not been given a section for. Ideally this line is absent.'))
  }

  const sections = [
    { section: 'Operating', rows: operatingRows, totals: operatingCash, total: sumOf(operatingCash) },
    ...['Investing', 'Financing'].map(group => {
      const rows = directSection(group)
      const totals = blank()
      months.forEach(m => { totals[m] = round2(rows.reduce((s, r) => s + r.byMonth[m], 0)) })
      return { section: group, rows, totals, total: sumOf(totals) }
    }),
  ]

  const netChange = { byMonth: blank(), total: 0 }
  months.forEach(m => {
    netChange.byMonth[m] = round2(sections.reduce((s, sec) => s + sec.totals[m], 0))
  })
  netChange.total = sumOf(netChange.byMonth)

  // Cash entering each column, from every bank row before it — run off the FULL
  // history so the closing figure is a real bank balance, not a period subtotal.
  const firstCol = months[0]
  const before = cash.reduce((s, t) => {
    const d = t.transaction_date || ''
    const started = yearly
      ? +d.slice(0, 4) < firstCol
      : allDates
        ? d.slice(0, 7) < firstCol
        : d < `${year}-${String(firstCol).padStart(2, '0')}-01`
    return started ? s + amt(t) : s
  }, 0)

  const opening = {}, closing = {}
  let running = round2(before)
  months.forEach(m => {
    opening[m] = round2(running)
    running = round2(running + netChange.byMonth[m])
    closing[m] = running
  })

  // Independent re-derivation: the period's cash rows summed flat, untouched by
  // any classification or add-back above.
  const direct = round2(scopedCash.reduce((s, t) => s + amt(t), 0))

  return {
    months, yearly, allDates, sections, netChange, opening, closing,
    reconciles: Math.abs(direct - netChange.total) < 0.005,
    unexplained: sumOf(residual),
    unclassified: scopedCash.some(t => !(t.category || '').trim()),
    cashAccounts: registry.filter(e => e.type === 'bank').map(e => e.label),
  }
}
