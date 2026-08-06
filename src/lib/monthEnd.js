// Month-end journal rows, as pure builders.
//
// Extracted from Dashboard.jsx so the dashboard card and the Month-End Close
// page produce identical entries instead of each assembling their own. Every
// entry is a zero-net PAIR (see COGS_PLAN.md §1): one leg on the P&L, one on
// the balance sheet, so cash is never implied to have moved. Callers stamp
// `account: ADJUSTMENTS_ACCOUNT` and `client_id` at insert time.

import { lastDayOfMonth, resolveRoleName } from './insights'

// Category names are ROLES resolved against the live chart at build time —
// "Product Costs" books as "3000 Product Costs" once the chart renames it.
// With no accounts list the role name is used as-is.

// COGS estimate for a month: expense the cost of what sold, relieve inventory.
export function cogsRows(month, amount, accounts = []) {
  const date = lastDayOfMonth(month)
  return [
    { transaction_date: date, description: `COGS ESTIMATE — ${month}`,   amount: -amount, category: resolveRoleName(accounts, 'Product Costs') },
    { transaction_date: date, description: `INVENTORY RELIEF — ${month}`, amount:  amount, category: resolveRoleName(accounts, 'Inventory') },
  ]
}

// Sales tax collected in a month: it was never revenue, it's owed to the state.
export function taxRows(month, amount, accounts = []) {
  const date = lastDayOfMonth(month)
  return [
    { transaction_date: date, description: `SALES TAX ACCRUAL — ${month}`,   amount: -amount, category: resolveRoleName(accounts, 'Sales Tax Collected') },
    { transaction_date: date, description: `SALES TAX LIABILITY — ${month}`, amount:  amount, category: resolveRoleName(accounts, 'Sales Tax Payable') },
  ]
}

// Square keeps its processing fee before depositing, so the bank only ever sees
// the net. Left alone, revenue is understated by the fee and the fee itself
// appears on no expense line. This grosses both up: profit is unchanged, but
// revenue becomes what customers actually paid and the fee becomes visible.
export function squareFeeRows(month, amount, accounts = []) {
  const date = lastDayOfMonth(month)
  return [
    { transaction_date: date, description: `SQUARE FEES — ${month}`,          amount: -amount, category: resolveRoleName(accounts, 'Processing Fees') },
    { transaction_date: date, description: `SQUARE FEE GROSS-UP — ${month}`,  amount:  amount, category: resolveRoleName(accounts, 'Square Deposits') },
  ]
}

// Discounts & comps never reach the bank: Square nets them out before anything
// is deposited. Booking them shows what was given away — revenue grosses up to
// the pre-discount price and the giveaway becomes a visible deduction line.
export function discountRows(month, amount, accounts = []) {
  const date = lastDayOfMonth(month)
  return [
    { transaction_date: date, description: `SQUARE DISCOUNTS — ${month}`,         amount: -amount, category: resolveRoleName(accounts, 'Discounts') },
    { transaction_date: date, description: `SQUARE DISCOUNT GROSS-UP — ${month}`, amount:  amount, category: resolveRoleName(accounts, 'Square Deposits') },
  ]
}

// The descriptions each entry type writes for a month. Booking a correction has
// to clear the old pair first, and deriving the delete from the same place as
// the insert is what stops the two drifting apart.
export const ENTRY_DESCRIPTIONS = {
  cogs: month => [`COGS ESTIMATE — ${month}`, `INVENTORY RELIEF — ${month}`],
  tax:  month => [`SALES TAX ACCRUAL — ${month}`, `SALES TAX LIABILITY — ${month}`],
  fee:  month => [`SQUARE FEES — ${month}`, `SQUARE FEE GROSS-UP — ${month}`],
}

// Descriptions to remove before re-booking: only entries whose figures no
// longer match the report they came from. An entry that still agrees is left
// alone, so re-booking never churns rows that are already right.
export function staleDescriptions({ month, taxProposal, feeProposal }) {
  const out = []
  if (taxProposal?.stale) out.push(...ENTRY_DESCRIPTIONS.tax(month))
  if (feeProposal?.stale) out.push(...ENTRY_DESCRIPTIONS.fee(month))
  return out
}

// Everything still pending for a month. Already-booked legs are skipped, so
// calling this twice for the same month yields an empty array the second time.
export function buildMonthEndRows({ month, cogsProposal, taxProposal, feeProposal, cogsBooked = false, accounts = [] }) {
  const rows = []
  if (cogsProposal && !cogsBooked) rows.push(...cogsRows(month, cogsProposal.amount, accounts))
  if (taxProposal && !taxProposal.booked) rows.push(...taxRows(month, taxProposal.amount, accounts))
  if (feeProposal?.amount > 0 && !feeProposal.booked) rows.push(...squareFeeRows(month, feeProposal.amount, accounts))
  return rows
}

// Quarterly count true-up: move the gap between the book balance and what was
// actually counted. Returns [] when the difference rounds away to nothing.
export function trueUpRows({ date, quarterLabel, adjustment, accounts = [] }) {
  if (Math.abs(adjustment) < 0.01) return []
  return [
    { transaction_date: date, description: `COGS TRUE-UP — ${quarterLabel}`,              amount: -adjustment, category: resolveRoleName(accounts, 'Product Costs') },
    { transaction_date: date, description: `INVENTORY RELIEF (TRUE-UP) — ${quarterLabel}`, amount:  adjustment, category: resolveRoleName(accounts, 'Inventory') },
  ]
}

export const quarterLabel = d => `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`
