// Normalize a description for grouping — strips noise, numbers, lowercases.
export function normKey(desc) {
  return (desc || '')
    .toLowerCase()
    .replace(/#\w+/g,    '')
    .replace(/\*\w+/g,   '')
    .replace(/\b\d+\b/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g,     ' ')
    .trim()
}

// Word-overlap (Jaccard) similarity, ignoring very short words.
export function wordSim(a, b) {
  const words = s => new Set(s.split(/\s+/).filter(w => w.length > 2))
  const wa = words(a), wb = words(b)
  if (!wa.size || !wb.size) return 0
  let inter = 0
  wa.forEach(w => { if (wb.has(w)) inter++ })
  return inter / Math.max(wa.size, wb.size)
}

// Build an inverted index: word → [{ key, cat }] for fast candidate lookup.
export function buildCatIndex(descCatMap) {
  const idx = {}
  for (const [key, cat] of Object.entries(descCatMap)) {
    key.split(/\s+/).filter(w => w.length > 2).forEach(w => {
      if (!idx[w]) idx[w] = []
      idx[w].push({ key, cat })
    })
  }
  return idx
}

// Return the best-matching category for `key` from the index, or '' if none.
export function suggestCat(key, idx, threshold = 0.4) {
  const candidates = new Map()
  key.split(/\s+/).filter(w => w.length > 2).forEach(w => {
    ;(idx[w] || []).forEach(({ key: k, cat }) => candidates.set(k, cat))
  })
  let bestScore = 0, bestCat = ''
  candidates.forEach((cat, k) => {
    const score = wordSim(key, k)
    if (score > bestScore) { bestScore = score; bestCat = cat }
  })
  return bestScore >= threshold ? bestCat : ''
}

// Cluster similar description groups using union-find with lead-word bucketing.
// Input groups must have shape: { key, displayDesc, txns[], total, suggestedCat }
export function clusterGroups(groups, threshold = 0.45) {
  if (!groups.length) return { clusters: [], keyToCluster: {} }

  const parent = groups.map((_, i) => i)
  const rank   = new Array(groups.length).fill(0)
  function find(i) { return parent[i] === i ? i : (parent[i] = find(parent[i])) }
  function union(i, j) {
    const [pi, pj] = [find(i), find(j)]
    if (pi === pj) return
    if (rank[pi] < rank[pj])       parent[pi] = pj
    else if (rank[pi] > rank[pj])  parent[pj] = pi
    else                         { parent[pj] = pi; rank[pi]++ }
  }

  const buckets = {}
  groups.forEach((g, i) => {
    const lead = g.key.split(/\s+/).find(w => w.length > 3) ?? g.key.split(/\s+/)[0] ?? ''
    if (!lead) return
    ;(buckets[lead] ??= []).push(i)
  })

  for (const idxs of Object.values(buckets)) {
    for (let a = 0; a < idxs.length; a++)
      for (let b = a + 1; b < idxs.length; b++)
        if (wordSim(groups[idxs[a]].key, groups[idxs[b]].key) >= threshold)
          union(idxs[a], idxs[b])
  }

  const clusterMap = {}
  groups.forEach((g, i) => {
    const root = find(i)
    if (!clusterMap[root]) clusterMap[root] = []
    clusterMap[root].push(i)
  })

  const keyToCluster = {}
  const clusters = Object.values(clusterMap).map(memberIdxs => {
    const repIdx = memberIdxs.reduce((best, i) =>
      groups[i].txns.length > groups[best].txns.length ? i : best, memberIdxs[0]
    )
    const rep     = groups[repIdx]
    const allTxns = memberIdxs.flatMap(i => groups[i].txns)
    const total   = memberIdxs.reduce((s, i) => s + groups[i].total, 0)
    const sugCat  = rep.suggestedCat || memberIdxs.map(i => groups[i].suggestedCat).find(Boolean) || ''
    const variants = memberIdxs.length > 1
      ? memberIdxs.filter(i => i !== repIdx).map(i => groups[i].displayDesc)
      : []
    memberIdxs.forEach(i => { keyToCluster[groups[i].key] = rep.key })
    return { key: rep.key, displayDesc: rep.displayDesc, txns: allTxns, total, suggestedCat: sugCat, variants }
  })

  return {
    clusters: clusters.sort((a, b) => a.key.localeCompare(b.key)),
    keyToCluster,
  }
}
