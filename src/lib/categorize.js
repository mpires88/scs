// Shared categorization helpers used by the transaction review screen and the
// CSV import flow. Pure functions — unit-tested in __tests__/categorize.test.js.

import { normKey } from './merchantClustering'

// Most common saved category among txns, '' if none. Ties break by name so the
// result never depends on iteration order.
export function dominantCat(txns) {
  const counts = {}
  txns.forEach(t => { const c = t.category || ''; if (c) counts[c] = (counts[c] || 0) + 1 })
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ''
}

// Category an imported row should be saved with.
//
// A row's OWN imported category wins unless the user deliberately set the
// group's category. Import groups are merchant clusters, so one group routinely
// holds rows the source filed differently; blanket-applying the group's
// category silently rewrites the minority. That is not hypothetical — it put
// 235 historical rows in the wrong account, including rent booked as inventory,
// which drops off the P&L entirely because inventory is a balance-sheet asset.
//
// `groupCat` still fills rows the source left uncategorized, and still wins
// outright once `groupTouched` is set, since editing a group means "file all of
// these here".
export function resolveImportCategory(row, groupCat, groupTouched) {
  const own = (row.category || '').trim()
  const group = (groupCat || '').trim()
  if (groupTouched) return group
  return own || group
}

// Status of a group under an effective-category accessor (pending edits
// included). `mixed` outranks `partial`: conflicting categories are the more
// urgent signal, and a group can be both — `uncategorized` reports the count
// either way.
export function groupStatus(txns, catOf) {
  const cats = txns.map(catOf)
  const uncategorized = cats.filter(c => !c).length
  const distinct = new Set(cats.filter(Boolean))
  if (uncategorized === cats.length) return { kind: 'none',     uncategorized, distinct }
  if (distinct.size > 1)             return { kind: 'mixed',    uncategorized, distinct }
  if (uncategorized > 0)             return { kind: 'partial',  uncategorized, distinct }
  return                                    { kind: 'complete', uncategorized, distinct }
}

// normalized description key → most common category among categorized txns.
// Tally-based (not first-wins) so one old miscategorization can't become a
// merchant's permanent suggestion; same tie-break as dominantCat.
export function buildDescCatMap(txns) {
  const tallies = {}
  txns.forEach(t => {
    if (!t.category) return
    const k = normKey(t.description)
    if (!k) return
    ;(tallies[k] ??= {})[t.category] = (tallies[k][t.category] || 0) + 1
  })
  const map = {}
  for (const [k, counts] of Object.entries(tallies)) {
    map[k] = Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
  }
  return map
}
