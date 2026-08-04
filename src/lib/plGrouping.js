// Groups one P&L section's active-account rows so sub-accounts sit under
// their parent with a subtotal (e.g. Rent nested under Occupancy). Pure —
// unit-tested in __tests__/plGrouping.test.js; kept out of chartOfAccounts.js
// so tests don't have to import the supabase client.
//
// rows:     [{ name, byMonth, total }] for ONE section, in display order
// accounts: the full chart of accounts (name, pl_section, parent)
// section:  the section these rows belong to
//
// Returns ordered entries:
//   { kind: 'row', name, byMonth, total }                      plain account
//   { kind: 'group', name, own, children, totals, total }      parent + subs
// where `own` is the parent's direct-activity row (null when the parent has
// no transactions of its own) and totals/total cover own + children.
//
// A parent with no ACTIVE children stays a plain row — a subtotal of itself
// is noise. Orphans stay plain too: parent missing from the chart, in a
// different section, or itself a sub-account (nesting is one level deep).
// The group is emitted at the first member's position so the section keeps
// its chart-of-accounts order.
export function groupRowsByParent(rows, accounts, section) {
  const acct = new Map(accounts.map(a => [a.name, a]))
  const validParent = name => {
    const p = acct.get(name)?.parent
    if (!p) return null
    const pa = acct.get(p)
    return pa && pa.pl_section === section && !pa.parent ? p : null
  }

  const childrenOf = new Map()
  rows.forEach(r => {
    const p = validParent(r.name)
    if (p) {
      if (!childrenOf.has(p)) childrenOf.set(p, [])
      childrenOf.get(p).push(r)
    }
  })

  const entries = []
  const consumed = new Set()
  rows.forEach(r => {
    if (consumed.has(r.name)) return
    const parentName = childrenOf.has(r.name) ? r.name : validParent(r.name)
    const children = parentName ? (childrenOf.get(parentName) ?? []) : []
    if (!children.length) { entries.push({ kind: 'row', ...r }); return }

    const own = rows.find(x => x.name === parentName) ?? null
    const members = [...children, ...(own ? [own] : [])]
    members.forEach(m => consumed.add(m.name))

    const totals = {}
    members.forEach(m => {
      Object.keys(m.byMonth).forEach(k => { totals[k] = (totals[k] ?? 0) + m.byMonth[k] })
    })
    entries.push({
      kind: 'group', name: parentName, own, children,
      totals, total: members.reduce((s, m) => s + m.total, 0),
    })
  })
  return entries
}
