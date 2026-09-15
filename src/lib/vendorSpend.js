// Spend by vendor for the Vendors page. Pure — unit-tested in
// __tests__/vendorSpend.test.js.
//
// "Spend" is money out, shown positive: the vendor's negative rows summed and
// flipped. A refund assigned to the same vendor is a positive row and nets
// against it, so a returned item doesn't inflate what was spent there.
//
// `isSpendRow` decides which UNASSIGNED rows count as spend still waiting for
// a vendor. The default is any money-out row; the page narrows it to rows that
// are actually purchases (not transfers, card payments or owner draws).

const round2 = n => Math.round(n * 100) / 100

export function vendorSpend(txns, vendors, { year = null, isSpendRow = t => (Number(t.amount) || 0) < 0 } = {}) {
  const prefix = year ? `${year}-` : ''
  const byId = new Map(vendors.map(v => [v.id, {
    id: v.id, name: v.name, notes: v.notes ?? '', count: 0, spend: 0, last: '', first: '', cats: new Map(),
  }]))
  let unassignedCount = 0, unassignedSpend = 0

  txns.forEach(t => {
    const d = t.transaction_date || ''
    if (prefix && !d.startsWith(prefix)) return
    const amt = Number(t.amount) || 0
    const row = t.vendor_id ? byId.get(t.vendor_id) : null
    if (!row) {
      if (isSpendRow(t)) { unassignedCount += 1; unassignedSpend += -amt }
      return
    }
    row.count += 1
    row.spend += -amt
    if (!row.last  || d > row.last)  row.last  = d
    if (!row.first || d < row.first) row.first = d
    const c = (t.category || '').trim()
    if (c) row.cats.set(c, (row.cats.get(c) || 0) + 1)
  })

  const rows = [...byId.values()].map(r => ({
    id: r.id, name: r.name, notes: r.notes, count: r.count,
    spend: round2(r.spend), last: r.last, first: r.first,
    // Most-used category, ties broken by name so the answer is stable.
    topCategory: [...r.cats.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '',
  })).sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name))

  return {
    rows,
    total: round2(rows.reduce((s, r) => s + r.spend, 0)),
    unassigned: { count: unassignedCount, spend: round2(unassignedSpend) },
  }
}

// Years present in the ledger, newest first, for the page's year tabs.
export function vendorYears(txns) {
  return [...new Set(txns.map(t => +(t.transaction_date || '').slice(0, 4)).filter(Boolean))].sort((a, b) => b - a)
}
