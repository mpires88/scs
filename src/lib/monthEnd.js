// Month-end journal rows, as pure builders.
//
// Extracted from Dashboard.jsx so the dashboard card and the Month-End Close
// page produce identical entries instead of each assembling their own. Every
// entry is a zero-net PAIR (see COGS_PLAN.md §1): one leg on the P&L, one on
// the balance sheet, so cash is never implied to have moved. Callers stamp
// `account: ADJUSTMENTS_ACCOUNT` and `client_id` at insert time.

import { lastDayOfMonth } from './insights'

// COGS estimate for a month: expense the cost of what sold, relieve inventory.
export function cogsRows(month, amount) {
  const date = lastDayOfMonth(month)
  return [
    { transaction_date: date, description: `COGS ESTIMATE — ${month}`,   amount: -amount, category: 'Product Costs' },
    { transaction_date: date, description: `INVENTORY RELIEF — ${month}`, amount:  amount, category: 'Inventory' },
  ]
}

// Sales tax collected in a month: it was never revenue, it's owed to the state.
export function taxRows(month, amount) {
  const date = lastDayOfMonth(month)
  return [
    { transaction_date: date, description: `SALES TAX ACCRUAL — ${month}`,   amount: -amount, category: 'Sales Tax Collected' },
    { transaction_date: date, description: `SALES TAX LIABILITY — ${month}`, amount:  amount, category: 'Sales Tax Payable' },
  ]
}

// Everything still pending for a month. Already-booked legs are skipped, so
// calling this twice for the same month yields an empty array the second time.
export function buildMonthEndRows({ month, cogsProposal, taxProposal, cogsBooked = false }) {
  const rows = []
  if (cogsProposal && !cogsBooked) rows.push(...cogsRows(month, cogsProposal.amount))
  if (taxProposal && !taxProposal.booked) rows.push(...taxRows(month, taxProposal.amount))
  return rows
}

// Quarterly count true-up: move the gap between the book balance and what was
// actually counted. Returns [] when the difference rounds away to nothing.
export function trueUpRows({ date, quarterLabel, adjustment }) {
  if (Math.abs(adjustment) < 0.01) return []
  return [
    { transaction_date: date, description: `COGS TRUE-UP — ${quarterLabel}`,              amount: -adjustment, category: 'Product Costs' },
    { transaction_date: date, description: `INVENTORY RELIEF (TRUE-UP) — ${quarterLabel}`, amount:  adjustment, category: 'Inventory' },
  ]
}

export const quarterLabel = d => `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`
