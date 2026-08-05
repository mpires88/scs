// KPI band for the Financial Statements page — pure computation, one row per
// indicator, keyed to the same columns the three statements share.
//
// Definitions follow the statements themselves (see insights.buildMonthlyPL):
// net revenue is Revenue plus Deductions to Income (deductions are negative),
// gross profit nets COGS, operating margin nets operating expenses. Anything
// the ledger can't answer for a column is null and renders as a dash.

import { stripAcctNum } from './insights'
import { buildCashFlow } from './cashFlow'

const pad2 = n => String(n).padStart(2, '0')

export const KPI_DEFS = [
  { key: 'gm',       label: 'Gross margin',            fmt: 'pct',
    note: 'Net revenue minus cost of goods, as a share of net revenue. COGS is the monthly estimate until the quarterly count trues it up.' },
  { key: 'om',       label: 'Operating margin',        fmt: 'pct',
    note: 'What is left of net revenue after COGS and operating expenses.' },
  { key: 'be',       label: 'Breakeven coverage',      fmt: 'pct',
    note: 'Net revenue as a share of the revenue needed to cover fixed costs at this margin. Above 100%, the period paid for itself. Fixed costs come from the cost-type tags on the Chart of Accounts.' },
  { key: 'yoy',      label: 'Revenue vs last year',    fmt: 'pctSigned',
    note: 'Net revenue against the same period a year earlier. Dashes mean there is no comparable period yet.' },
  { key: 'ocf',      label: 'Operating cash flow',     fmt: 'money',
    note: 'Net cash from operating activities, exactly as the Cash Flow statement below reports it.' },
  { key: 'disc',     label: 'Discounts & comps given', fmt: 'money',
    note: 'The retail value given away through Square discounts and comps, booked from the monthly Square report.' },
  { key: 'discRate', label: 'Discount rate',           fmt: 'pct',
    note: 'Discounts & comps as a share of gross revenue.' },
]

export function buildKpis({ txns, accounts, registry = [], columns, period = 'monthly', year }) {
  if (!columns?.length) return null
  const yearly   = period === 'yearly'
  const allDates = period === 'all'

  const sectionOf  = new Map(accounts.map(a => [a.name, a.pl_section]))
  const fixedNames = new Set(accounts.filter(a => a.cost_type === 'fixed').map(a => a.name))
  const usingTags  = fixedNames.size > 0

  const colOf = t => yearly
    ? +(t.transaction_date || '').slice(0, 4)
    : allDates
      ? (t.transaction_date || '').slice(0, 7)
      : +(t.transaction_date || '').slice(5, 7)
  const inScope = t => yearly || allDates || (t.transaction_date || '').startsWith(String(year))

  // One pass: P&L section sums per column, the specific lines KPIs need, and
  // net revenue per calendar month across ALL years (for the YoY comparison
  // even when the prior year is not among the columns).
  const agg = {}
  const blank = () => ({ rev: 0, ded: 0, cogs: 0, opex: 0, fixed: 0, disc: 0 })
  const ymNetRev = {}

  txns.forEach(t => {
    if (!(t.category || '').trim()) return
    const amt = Number(t.amount) || 0
    const sec = sectionOf.get(t.category) ?? 'Operating Expenses'
    const ym = (t.transaction_date || '').slice(0, 7)
    if (ym && (sec === 'Revenue' || sec === 'Deductions to Income'))
      ymNetRev[ym] = (ymNetRev[ym] ?? 0) + amt
    if (!inScope(t)) return
    const c = colOf(t)
    if (!c) return
    const a = (agg[c] ??= blank())
    if      (sec === 'Revenue')              a.rev  += amt
    else if (sec === 'Deductions to Income') a.ded  += amt
    else if (sec === 'Cost of Goods Sold')   a.cogs += amt
    else if (sec === 'Operating Expenses')   a.opex += amt
    // Mirrors insights.computeBreakeven: tagged accounts when tags exist,
    // otherwise every operating expense is treated as fixed.
    if (usingTags ? fixedNames.has(t.category) : sec === 'Operating Expenses') a.fixed += amt
    if (stripAcctNum(t.category) === 'Discounts') a.disc += amt
  })

  const yearNetRev = {}
  Object.entries(ymNetRev).forEach(([ym, v]) => {
    const y = +ym.slice(0, 4)
    yearNetRev[y] = (yearNetRev[y] ?? 0) + v
  })
  const prevNetRev = c => yearly
    ? yearNetRev[c - 1]
    : allDates
      ? ymNetRev[`${+String(c).slice(0, 4) - 1}${String(c).slice(4)}`]
      : ymNetRev[`${year - 1}-${pad2(c)}`]

  // Operating cash flow comes from the same builder as the statement, on the
  // same columns, so the two can never disagree.
  const cf = buildCashFlow({ txns, accounts, registry, year, period, columns })
  const opCf = cf?.sections.find(s => s.section === 'Operating') ?? null

  const derive = (a, { ocf, prevRev }) => {
    const netRev      = a.rev + a.ded
    const grossProfit = netRev + a.cogs
    const opIncome    = grossProfit + a.opex
    const gmRatio     = netRev > 0 ? grossProfit / netRev : null
    const fixedCost   = -a.fixed
    const breakevenRev = gmRatio > 0 && fixedCost > 0 ? fixedCost / gmRatio : null
    return {
      gm:       netRev > 0 ? grossProfit / netRev * 100 : null,
      om:       netRev > 0 ? opIncome / netRev * 100 : null,
      be:       breakevenRev ? netRev / breakevenRev * 100 : null,
      yoy:      prevRev > 0 ? (netRev - prevRev) / prevRev * 100 : null,
      ocf,
      disc:     -a.disc || 0,
      discRate: a.rev > 0 ? -a.disc / a.rev * 100 : null,
    }
  }

  const byCol = {}
  columns.forEach(c => {
    byCol[c] = derive(agg[c] ?? blank(), {
      ocf:     opCf ? (opCf.totals[c] ?? null) : null,
      prevRev: prevNetRev(c),
    })
  })

  // The Period column re-derives over the whole selection rather than averaging
  // cells, so ratios stay revenue-weighted. YoY compares the selected columns'
  // total against the same calendar span one year earlier (monthly mode only —
  // the other modes already span every year there is).
  const whole = blank()
  columns.forEach(c => {
    const a = agg[c]
    if (!a) return
    Object.keys(whole).forEach(k => { whole[k] += a[k] })
  })
  const prevWhole = !yearly && !allDates
    ? columns.reduce((s, c) => s + (ymNetRev[`${year - 1}-${pad2(c)}`] ?? NaN), 0)
    : NaN
  const totals = derive(whole, {
    ocf:     opCf ? columns.reduce((s, c) => s + (opCf.totals[c] ?? 0), 0) : null,
    prevRev: Number.isNaN(prevWhole) ? null : prevWhole,
  })

  return {
    columns, yearly, allDates,
    rows: KPI_DEFS.map(def => ({
      ...def,
      byCol: Object.fromEntries(columns.map(c => [c, byCol[c][def.key]])),
      total: totals[def.key],
    })),
  }
}
