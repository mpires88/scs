// Balance sheet built from the transaction ledger. Pure — unit-tested in
// __tests__/balanceSheet.test.js.
//
// The construction: every transaction is a cash movement (adjustment pairs
// net to zero) carrying a category. Partitioning the running totals gives a
// sheet that balances *by construction*:
//
//   cash (per bank account)      = Σ of the account's rows
//   asset-category balance       = −Σ of the category's rows  (cash out builds it)
//   liability/equity balance     = +Σ of the category's rows
//   retained earnings            = Σ of all P&L-section rows (cumulative net income)
//   uncategorized activity       = Σ of uncategorized rows (shown so the sheet
//                                  still balances until they're categorized)
//
// so  Total Assets = Total Liabilities + Total Equity  is an identity, not a
// hope. Balances are point-in-time at each month end of the selected year.

import { BS_SECTIONS, isBSSection, ASSET_SECTIONS } from './sections'
import { ADJUSTMENTS_ACCOUNT, stripAcctNum } from './insights'

const ymOf = t => (t.transaction_date || '').slice(0, 7)
const round2 = n => Math.round(n * 100) / 100

// ─── Ledger-account registry helpers ─────────────────────────────────────────
// The registry (client_settings key 'ledger_accounts') maps feed labels to one
// balance-sheet line per physical account:
//   { key, label, type: 'bank'|'card', matches: [feedLabel…],
//     boundCategories: [categoryName…], opening: { date, balance } | null,
//     reconciliations: [{ date, balance }…] }

export function matchLedgerAccount(registry, feedLabel) {
  const label = (feedLabel || '').trim()
  return registry.find(e => (e.matches || []).some(m => (m || '').trim() === label)) ?? null
}

export function boundCategoryOwner(registry, category) {
  return registry.find(e => (e.boundCategories || []).includes(category)) ?? null
}

export function buildBalanceSheet({ txns, accounts, year, registry = [] }) {
  if (!year) return null
  const sectionOf = new Map(accounts.map(a => [a.name, a.pl_section]))
  const matchCache = new Map() // feed label → registry entry | null
  const matchOf = label => {
    if (!matchCache.has(label)) matchCache.set(label, matchLedgerAccount(registry, label))
    return matchCache.get(label)
  }
  // Bound categories match with leading account numbers stripped, so a rename
  // like "Credit Card Payment" → "4400 Credit Card Payment" keeps the binding.
  const boundOwner = new Map() // stripped category name → registry entry
  registry.forEach(e => (e.boundCategories || []).forEach(c => boundOwner.set(stripAcctNum(c), e)))

  // Per-entity, per-month sums. Entities: registry accounts, unmapped cash
  // accounts, BS categories, cumulative P&L (retained earnings), uncategorized.
  //
  // Every row contributes once on the ACCOUNT side and once on the CATEGORY
  // side — the two complete decompositions whose equality is why the sheet
  // balances. Registry entries collect both sides into one bucket:
  //   account side: bank rows +amt (cash), card rows −amt (charges build debt)
  //   category side: rows in a bound category +amt (a payment from checking,
  //     amount −400, reduces the card's owed balance by 400)
  // A transfer visible on BOTH feeds (checking payment + card credit) nets to
  // zero inside the card bucket: −(+400) from the account side cancels +400
  // from the category side — the card-feed echo drops out by construction.
  const sums = new Map() // key → Map(ym → sum)
  const add = (key, ym, amt) => {
    if (!sums.has(key)) sums.set(key, new Map())
    const m = sums.get(key)
    m.set(ym, (m.get(ym) ?? 0) + amt)
  }

  const cashAccounts = new Set() // unmapped feed labels
  let hasRows = false
  txns.forEach(t => {
    const ym = ymOf(t)
    if (!ym) return
    hasRows = true
    const amt = Number(t.amount) || 0

    // Account side
    const acct = (t.account || '').trim() || '(no account)'
    if (acct !== ADJUSTMENTS_ACCOUNT) {
      const entry = matchOf(acct)
      if (entry) add(`reg:${entry.key}`, ym, entry.type === 'card' ? -amt : amt)
      else { cashAccounts.add(acct); add(`acct:${acct}`, ym, amt) }
    }

    // Category side
    const cat = (t.category || '').trim()
    if (!cat) { add('__uncat__', ym, amt); return }
    const owner = boundOwner.get(stripAcctNum(cat))
    if (owner) { add(`reg:${owner.key}`, ym, amt); return }
    const section = sectionOf.get(cat) ?? 'Operating Expenses'
    if (isBSSection(section)) add(`cat:${cat}`, ym, amt)
    else add('__pl__', ym, amt) // isPLSection or fallback — cumulative net income
  })
  if (!hasRows) return null

  const allYms = [...new Set([...sums.values()].flatMap(m => [...m.keys()]))].sort()
  const firstYm = allYms[0], lastYm = allYms[allYms.length - 1]

  // Month-end columns for the selected year, clipped to the data range.
  const months = []
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, '0')}`
    if (ym >= firstYm.slice(0, 7) && ym <= lastYm) months.push(m)
  }
  if (!months.length) return null

  // Cumulative balance of one entity as of each shown month end.
  const balanceByMonth = (key, sign = 1) => {
    const perYm = sums.get(key) ?? new Map()
    const byMonth = {}
    months.forEach(m => {
      const target = `${year}-${String(m).padStart(2, '0')}`
      let s = 0
      perYm.forEach((v, ym) => { if (ym <= target) s += v })
      byMonth[m] = round2(s * sign)
    })
    return byMonth
  }
  const lastM = months[months.length - 1]
  const mkRow = (name, key, sign, flags = {}) => {
    const byMonth = balanceByMonth(key, sign)
    return { name, byMonth, total: byMonth[lastM], ...flags }
  }
  const active = row => months.some(m => row.byMonth[m] !== 0)

  // Registry accounts: one line each, opening balance folded in. Banks sit in
  // Current Assets even when negative (an overdraft is negative cash, not a
  // mystery liability); cards sit in Current Liabilities even when the ledger
  // says overpaid — the parenthesized negative is the honest signal.
  const regAssetRows = [], regLiabRows = []
  let obeConstant = 0
  registry.forEach(e => {
    const opening = Number(e.opening?.balance) || 0
    const byMonth = balanceByMonth(`reg:${e.key}`, 1)
    months.forEach(m => { byMonth[m] = round2(byMonth[m] + opening) })
    const row = {
      name: e.type === 'bank' ? `Cash — ${e.label}` : e.label,
      byMonth, total: byMonth[lastM], derived: true, registry: true,
    }
    if (!active(row)) return
    if (e.type === 'card') regLiabRows.push(row); else regAssetRows.push(row)
    obeConstant += e.type === 'card' ? -opening : opening
  })

  // Feed labels no registry entry claims: rendered as before (positive → cash,
  // negative → owed) but flagged so the report can nudge "map this account".
  const cashRows = [], owedRows = []
  ;[...cashAccounts].sort().forEach(a => {
    const asAsset = mkRow(`Cash — ${a}`, `acct:${a}`, 1, { derived: true, unmapped: registry.length > 0 })
    if (!active(asAsset)) return
    if ((asAsset.total ?? 0) >= 0) cashRows.push(asAsset)
    else owedRows.push(mkRow(`Owed on ${a}`, `acct:${a}`, -1, { derived: true, unmapped: registry.length > 0 }))
  })
  const unmappedLabels = registry.length > 0 ? [...cashAccounts].sort() : []

  // Opening balances are builder inputs, not transactions — their offset lives
  // on an explicit equity line so the sheet still balances.
  const obe = round2(obeConstant) !== 0
    ? {
        name: 'Opening Balance Equity', derived: true,
        byMonth: Object.fromEntries(months.map(m => [m, round2(obeConstant)])),
        total: round2(obeConstant),
      }
    : null

  const retained = mkRow('Retained Earnings', '__pl__', 1, { derived: true })
  const uncat = mkRow('Uncategorized activity', '__uncat__', 1, { derived: true, warn: true })
  const hasUncat = active(uncat)

  const acctOrder = new Map(accounts.map((a, i) => [a.name, i]))
  const sections = BS_SECTIONS.map(section => {
    const sign = ASSET_SECTIONS.has(section) ? -1 : 1
    const catRows = accounts
      .filter(a => a.pl_section === section)
      .sort((a, b) => (acctOrder.get(a.name) ?? 1e9) - (acctOrder.get(b.name) ?? 1e9))
      .map(a => mkRow(a.name, `cat:${a.name}`, sign))
      .filter(active)
    const rows = [
      ...(section === 'Current Assets' ? [...regAssetRows, ...cashRows] : []),
      ...(section === 'Current Liabilities' ? [...regLiabRows, ...owedRows] : []),
      ...catRows,
      ...(section === 'Equity' ? [retained, ...(obe ? [obe] : []), ...(hasUncat ? [uncat] : [])] : []),
    ]
    const totals = {}
    months.forEach(m => { totals[m] = round2(rows.reduce((s, r) => s + (r.byMonth[m] ?? 0), 0)) })
    return { section, rows, totals, total: totals[lastM] }
  })

  const combine = names => {
    const byMonth = {}
    months.forEach(m => {
      byMonth[m] = round2(names.reduce((s, n) => s + (sections.find(x => x.section === n)?.totals[m] ?? 0), 0))
    })
    return { byMonth, total: byMonth[lastM] }
  }
  const computed = {
    assets:      combine(['Current Assets', 'Non-Current Assets']),
    liabilities: combine(['Current Liabilities', 'Non-Current Liabilities']),
    equity:      combine(['Equity']),
    liabEquity:  combine(['Current Liabilities', 'Non-Current Liabilities', 'Equity']),
  }

  return { year, months, sections, computed, hasUncat, unmappedLabels }
}

// Years present in the ledger, for the report's year tabs.
export function balanceSheetYears(txns) {
  return [...new Set(txns.map(t => +ymOf(t).slice(0, 4)).filter(Boolean))].sort()
}
