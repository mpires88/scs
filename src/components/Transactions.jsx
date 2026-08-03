import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { normKey, buildCatIndex, suggestCat, clusterGroups } from '../lib/merchantClustering'
import { groupStatus, buildDescCatMap } from '../lib/categorize'
import { ALL_SECTIONS, fetchAccounts } from '../lib/chartOfAccounts'
import { getSetting, setSetting } from '../lib/settings'
import { useUnsavedChanges } from '../lib/unsavedChanges'
import CategoryInput from './CategoryInput'
import ImportModal from './ImportModal'
import { T } from '../lib/theme'

const PAGE_SIZE = 50
const REVIEW_STATE_KEY = 'txn_review_state'

// Effective category of a transaction under a pending-assignments map.
// All review state anchors to transaction IDs; group keys are display-only.
const effCat = (assignments, t) => (t.id in assignments ? assignments[t.id] : (t.category || ''))

// Stable serialization of the persisted review state, used both to store it
// and to detect real changes (so the debounced write doesn't fire on no-ops).
const reviewJson = (separated, rejected) =>
  JSON.stringify({ separated: [...separated].sort(), rejected: [...rejected].sort() })

const keepIds = (set, idSet) => {
  const next = new Set([...set].filter(id => idSet.has(id)))
  return next.size === set.size ? set : next
}

const dropIds = (set, idSet) => {
  const next = new Set([...set].filter(id => !idSet.has(id)))
  return next.size === set.size ? set : next
}

function mixedTitle(g, catOf) {
  const counts = {}
  g.txns.forEach(t => { const c = catOf(t) || '(uncategorized)'; counts[c] = (counts[c] || 0) + 1 })
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}: ${n}`).join('\n')
}

// ─── Transactions Page ────────────────────────────────────────────────────────

export default function Transactions({ clientId = null }) {
  const [txns,        setTxns]        = useState([])
  const [loading,     setLoading]     = useState(true)
  const [loadError,   setLoadError]   = useState(null)
  const [accounts,    setAccounts]    = useState([])
  const [assignments, setAssignments] = useState({})    // txnId → category ('' = clear)
  const [rejected,    setRejected]    = useState(new Set()) // txn IDs whose suggestion was dismissed
  const [separated,   setSeparated]   = useState(new Set()) // txn IDs given their own group
  const [fuzzy,       setFuzzy]       = useState(true)
  const [search,      setSearch]      = useState('')
  const [filter,      setFilter]      = useState('all')
  const [expanded,    setExpanded]    = useState({})
  const [selected,    setSelected]    = useState(new Set())
  const [bulkCat,     setBulkCat]     = useState('')
  const [page,        setPage]        = useState(0)
  const [saving,      setSaving]      = useState(false)
  const [savedMsg,    setSavedMsg]    = useState('')
  const [showImport,  setShowImport]  = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const { setDirty } = useUnsavedChanges()
  const hydratedRef  = useRef(false) // gates the persist effect until load() has applied stored state
  const lastSavedRef = useRef('')

  const allCats = useMemo(() => accounts.map(a => a.name), [accounts])

  // COA-grouped category list for pickers
  const groupedCats = useMemo(() => {
    if (!accounts.length) return null
    const bySection = {}
    accounts.forEach(a => {
      const sec = a.pl_section ?? 'Other'
      if (!bySection[sec]) bySection[sec] = []
      bySection[sec].push(a.name)
    })
    const ordered = ALL_SECTIONS.filter(s => bySection[s]?.length).map(s => ({ section: s, accounts: bySection[s] }))
    if (bySection['Other']?.length) ordered.push({ section: 'Other', accounts: bySection['Other'] })
    return ordered.length ? ordered : null
  }, [accounts])

  // ── Load ───────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null)
    try {
      // The .order('id') tiebreaker makes .range() pagination stable — without a
      // total order, Postgres may repeat or skip rows across pages.
      const base = () => supabase
        .from('bank_transactions')
        .select('id, transaction_date, description, amount, category, account, reference_id')
        .eq('client_id', clientId)
        .order('transaction_date')
        .order('id')

      const [firstRes, coaRes, reviewState] = await Promise.all([
        base().range(0, 999),
        fetchAccounts(clientId),
        getSetting(clientId, REVIEW_STATE_KEY, null).catch(() => null),
      ])
      if (firstRes.error) throw firstRes.error

      const first = firstRes.data ?? []
      setAccounts(coaRes.accounts)
      const loadedSep = new Set(reviewState?.separated ?? [])
      const loadedRej = new Set(reviewState?.rejected ?? [])
      setSeparated(loadedSep)
      setRejected(loadedRej)
      lastSavedRef.current = reviewJson(loadedSep, loadedRej)
      setTxns(first)     // show data immediately
      setLoading(false)  // spinner off — UI is usable now

      // If we got a full page, quietly fetch the rest
      let all = first
      if (first.length === 1000) {
        setLoadingMore(true)
        let offset = 1000
        while (true) {
          const res = await base().range(offset, offset + 999)
          // A failed page must surface, not silently truncate — loadingMore is
          // the gate that keeps Import from deduping against a partial list.
          if (res.error) throw new Error(`Could not load all transactions (stopped at ${all.length}): ${res.error.message}`)
          if (!res.data?.length) break
          all = [...all, ...res.data]
          if (res.data.length < 1000) break
          offset += 1000
        }
        // Single commit — one regroup/recluster instead of one per page.
        // Merged by id so a save completed while paging keeps its categories
        // (pages fetched before the save hold pre-save values).
        setTxns(prev => {
          const local = new Map(prev.map(t => [t.id, t]))
          return all.map(t => {
            const l = local.get(t.id)
            return l && (l.category || '') !== (t.category || '') ? { ...t, category: l.category } : t
          })
        })
        setLoadingMore(false)
      }

      // Prune persisted review state — only against the fully loaded list,
      // never the first page, or valid IDs would be discarded.
      const idSet = new Set(all.map(t => t.id))
      setSeparated(prev => keepIds(prev, idSet))
      setRejected(prev => keepIds(prev, idSet))
      hydratedRef.current = true
    } catch (e) {
      setLoadError(e.message)
      setLoading(false)
      setLoadingMore(false)
    }
  }, [clientId])

  useEffect(() => { load() }, [load])

  // Persist separated/rejected (debounced, change-detected). Best-effort: a
  // failed write leaves the in-session state intact and retries on next change.
  useEffect(() => {
    if (!hydratedRef.current) return
    const json = reviewJson(separated, rejected)
    if (json === lastSavedRef.current) return
    const h = setTimeout(() => {
      lastSavedRef.current = json
      setSetting(clientId, REVIEW_STATE_KEY, JSON.parse(json)).catch(() => {})
    }, 800)
    return () => clearTimeout(h)
  }, [separated, rejected, clientId])

  // ── Grouping ───────────────────────────────────────────────────────────────

  const txnById = useMemo(() => new Map(txns.map(t => [t.id, t])), [txns])

  const catOf = useCallback(t => effCat(assignments, t), [assignments])

  const groups = useMemo(() => {
    // Suggestion index: most common category per normalized description
    const descCatMap = buildDescCatMap(txns)
    const catIndex = buildCatIndex(descCatMap)

    // Separate pinned transactions
    const mainTxns = txns.filter(t => !separated.has(t.id))
    const sepTxns  = txns.filter(t =>  separated.has(t.id))

    // Build raw groups
    const groupMap = {}
    mainTxns.forEach(t => {
      const key = normKey(t.description)
      if (!groupMap[key]) {
        groupMap[key] = { key, displayDesc: t.description || '', txns: [], total: 0, suggestedCat: '' }
      }
      groupMap[key].txns.push(t)
      groupMap[key].total += Number(t.amount) || 0
    })

    // Attach suggestions to any group with uncategorized transactions — a
    // partially categorized group gets its gaps suggested too (usually from
    // its own categorized rows, which score highest in the index).
    Object.values(groupMap).forEach(g => {
      if (g.txns.some(t => !t.category)) g.suggestedCat = suggestCat(g.key, catIndex)
    })

    const rawGroups = Object.values(groupMap).sort((a, b) => a.key.localeCompare(b.key))

    // Cluster if fuzzy mode is on
    const mainGroups = fuzzy ? clusterGroups(rawGroups).clusters : rawGroups

    // Separated transactions each get a singleton group
    const sepGroups = sepTxns.map(t => ({
      key:          `sep:${t.id}`,
      displayDesc:  t.description || '',
      txns:         [t],
      total:        Number(t.amount) || 0,
      suggestedCat: '',
      isSeparated:  true,
    }))

    return [...mainGroups, ...sepGroups]
  }, [txns, fuzzy, separated])

  const statusByKey = useMemo(() => {
    const m = new Map()
    groups.forEach(g => m.set(g.key, groupStatus(g.txns, catOf)))
    return m
  }, [groups, catOf])

  // ── Helpers ────────────────────────────────────────────────────────────────

  const hasSugg = useCallback(
    g => !!g.suggestedCat && g.txns.some(t => !catOf(t) && !rejected.has(t.id)),
    [catOf, rejected]
  )

  // Explicit edit on a group row: overwrites every transaction in the group.
  // The partial/mixed badges make the blast radius visible before committing.
  const assignGroup = (g, cat) => {
    setAssignments(p => {
      const next = { ...p }
      g.txns.forEach(t => { next[t.id] = cat })
      return next
    })
    setSavedMsg('')
  }

  // Accepting a suggestion fills only uncategorized transactions — an
  // automated action never overwrites work a human already did.
  const acceptSuggestion = g => {
    setAssignments(p => {
      const next = { ...p }
      g.txns.forEach(t => { if (!effCat(p, t)) next[t.id] = g.suggestedCat })
      return next
    })
    setSavedMsg('')
  }

  const rejectSuggestion = g => {
    setRejected(prev => {
      const next = new Set(prev)
      g.txns.forEach(t => { if (!catOf(t)) next.add(t.id) })
      return next
    })
  }

  // Separating/rejoining regenerates group keys, so drop the selection with it
  const separateTxn = id => { setSeparated(prev => new Set([...prev, id])); setSelected(new Set()) }
  const rejoinTxn   = id => { setSeparated(prev => { const n = new Set(prev); n.delete(id); return n }); setSelected(new Set()) }

  // ── Filter + pagination ────────────────────────────────────────────────────

  // Selection is keyed by group key, so it must not survive anything that
  // regroups; it deliberately does survive page changes.
  useEffect(() => { setPage(0); setSelected(new Set()) }, [search, filter, fuzzy])

  const visibleGroups = useMemo(() => {
    const q = search.toLowerCase()
    return groups.filter(g => {
      if (q && !g.key.includes(q) && !g.displayDesc.toLowerCase().includes(q)) return false
      const st = statusByKey.get(g.key)
      if (filter === 'uncategorized' && st.uncategorized === 0) return false
      if (filter === 'categorized'   && st.uncategorized > 0)   return false
      if (filter === 'mixed'         && st.kind !== 'mixed')    return false
      if (filter === 'suggestions'   && !hasSugg(g))            return false
      return true
    })
  }, [groups, search, filter, statusByKey, hasSugg])

  const pageCount  = Math.ceil(visibleGroups.length / PAGE_SIZE)
  const pageGroups = visibleGroups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // ── Stats (transaction-based, not group-based) ─────────────────────────────

  const uncatTxnCount = useMemo(() => txns.filter(t => !catOf(t)).length, [txns, catOf])
  const suggCount     = useMemo(() => groups.filter(g => hasSugg(g)).length, [groups, hasSugg])
  const mixedCount    = useMemo(
    () => groups.filter(g => statusByKey.get(g.key)?.kind === 'mixed').length,
    [groups, statusByKey]
  )
  const pendingTxnCount = useMemo(() => {
    let n = 0
    for (const [id, cat] of Object.entries(assignments)) {
      const t = txnById.get(id)
      if (t && (cat || '') !== (t.category || '')) n++
    }
    return n
  }, [assignments, txnById])

  // ── Unsaved-changes guards ─────────────────────────────────────────────────

  const hasPending = pendingTxnCount > 0

  useEffect(() => {
    setDirty(hasPending)
    return () => setDirty(false)
  }, [hasPending, setDirty])

  useEffect(() => {
    if (!hasPending) return
    const h = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [hasPending])

  // ── Upload coverage ────────────────────────────────────────────────────────

  const coverage = useMemo(() => {
    if (!txns.length) return null
    const map = {}
    txns.forEach(t => {
      const acct = t.account || 'Unknown'
      const ym   = (t.transaction_date || '').slice(0, 7)
      if (!ym) return
      if (!map[acct]) map[acct] = {}
      map[acct][ym] = (map[acct][ym] || 0) + 1
    })
    const months = [...new Set(txns.map(t => (t.transaction_date || '').slice(0, 7)).filter(Boolean))].sort()
    return { accounts: Object.keys(map).sort(), months, map }
  }, [txns])

  // ── Delete ─────────────────────────────────────────────────────────────────

  const deleteSelected = async () => {
    const ids = [...selected].flatMap(key => (groups.find(g => g.key === key)?.txns ?? []).map(t => t.id))
    if (!ids.length) return
    if (!confirm(`Permanently delete ${ids.length} transaction${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return
    setSaving(true)
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const { error } = await supabase.from('bank_transactions')
          .delete().eq('client_id', clientId).in('id', ids.slice(i, i + 500))
        if (error) throw error
      }
      const idSet = new Set(ids)
      setTxns(prev => prev.filter(t => !idSet.has(t.id)))
      setAssignments(prev => {
        const next = { ...prev }
        let changed = false
        idSet.forEach(id => { if (id in next) { delete next[id]; changed = true } })
        return changed ? next : prev
      })
      setRejected(prev => dropIds(prev, idSet))
      setSeparated(prev => dropIds(prev, idSet))
      setSelected(new Set())
      setSavedMsg(`✓ Deleted ${ids.length} transaction${ids.length !== 1 ? 's' : ''}`)
    } catch (e) { alert('Delete failed: ' + e.message) }
    finally { setSaving(false) }
  }

  const deleteAll = async () => {
    if (!confirm(`Permanently delete ALL ${txns.length} transactions? This cannot be undone.`)) return
    const typed = window.prompt(`Type DELETE to confirm:`)
    if (typed !== 'DELETE') return
    setSaving(true)
    try {
      const { error } = await supabase.from('bank_transactions').delete().eq('client_id', clientId)
      if (error) throw error
      setTxns([]); setAssignments({}); setSelected(new Set())
      setRejected(new Set()); setSeparated(new Set())
      setSavedMsg('✓ All transactions deleted')
    } catch (e) { alert('Delete failed: ' + e.message) }
    finally { setSaving(false) }
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  const doSave = async () => {
    // Only writes that change something; re-picking the saved value is a no-op.
    const idToCat = {}
    for (const [id, cat] of Object.entries(assignments)) {
      const t = txnById.get(id)
      if (!t) continue
      if ((cat || '') === (t.category || '')) continue
      idToCat[id] = cat || null
    }
    if (!Object.keys(idToCat).length) return

    // Free text is allowed (the chart of accounts is user-managed) but typos
    // shouldn't slip into the books silently.
    const unknown = [...new Set(Object.values(idToCat).filter(c => c && !allCats.includes(c)))]
    if (unknown.length && !confirm(
      `${unknown.length === 1 ? 'This category is' : 'These categories are'} not in your chart of accounts:\n\n${unknown.join('\n')}\n\nSave anyway?`
    )) return

    setSaving(true); setSavedMsg('')
    try {
      const byCat = {}
      for (const [id, cat] of Object.entries(idToCat)) {
        const k = cat ?? '__null__'
        if (!byCat[k]) byCat[k] = []
        byCat[k].push(id)
      }
      let total = 0
      for (const [catKey, ids] of Object.entries(byCat)) {
        const catValue = catKey === '__null__' ? null : catKey
        for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500)
          const { error } = await supabase.from('bank_transactions')
            .update({ category: catValue }).eq('client_id', clientId).in('id', batch)
          if (error) throw error
          total += batch.length
        }
      }
      setTxns(prev => prev.map(t => t.id in idToCat ? { ...t, category: idToCat[t.id] ?? '' } : t))
      setAssignments({})
      setSavedMsg(`✓ ${total} transaction${total !== 1 ? 's' : ''} saved`)
    } catch (e) {
      alert('Save failed: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const acceptAll = () => {
    setAssignments(p => {
      const next = { ...p }
      groups.forEach(g => {
        if (!hasSugg(g)) return
        g.txns.forEach(t => { if (!effCat(p, t)) next[t.id] = g.suggestedCat })
      })
      return next
    })
    setSavedMsg('')
  }

  // ── Bulk select ────────────────────────────────────────────────────────────

  const allPageSel = pageGroups.length > 0 && pageGroups.every(g => selected.has(g.key))
  const toggleSelAll = () => {
    if (allPageSel) setSelected(p => { const n = new Set(p); pageGroups.forEach(g => n.delete(g.key)); return n })
    else            setSelected(p => { const n = new Set(p); pageGroups.forEach(g => n.add(g.key));    return n })
  }

  const selectedGroups = () => [...selected].map(k => groups.find(g => g.key === k)).filter(Boolean)

  const applyBulk = () => {
    const cat = bulkCat.trim()
    if (!selected.size || !cat) return
    setAssignments(p => {
      const next = { ...p }
      selectedGroups().forEach(g => g.txns.forEach(t => { next[t.id] = cat }))
      return next
    })
    setSelected(new Set()); setBulkCat(''); setSavedMsg('')
  }

  const clearBulkCats = () => {
    const gs = selectedGroups()
    const txCount = gs.reduce((s, g) => s + g.txns.length, 0)
    if (!txCount) return
    if (!confirm(`Clear the category on ${txCount} transaction${txCount !== 1 ? 's' : ''} across ${gs.length} group${gs.length !== 1 ? 's' : ''}?`)) return
    setAssignments(p => {
      const next = { ...p }
      gs.forEach(g => g.txns.forEach(t => { next[t.id] = '' }))
      return next
    })
    setSelected(new Set()); setSavedMsg('')
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={s.center}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={s.spinner} />
      <p style={{ color: '#6b7280', marginTop: 16 }}>Loading transactions…</p>
    </div>
  )

  if (loadError) return (
    <div style={s.wrap}><div style={{ padding: 28 }}><div style={s.errorBox}>Failed to load: {loadError}</div></div></div>
  )

  return (
    <div style={s.wrap}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Page header */}
      <header style={s.pageHeader}>
        <div>
          <h2 style={s.h2}>Transactions</h2>
          <p style={s.sub}>
            {groups.length} merchant groups · {txns.length} transactions
            {loadingMore && <> · <span style={{ color: T.charcoal, opacity: .6 }}>loading more…</span></>}
            {uncatTxnCount > 0 && <> · <span style={{ color: T.amber, fontWeight: 500 }}>{uncatTxnCount} transaction{uncatTxnCount !== 1 ? 's' : ''} uncategorized</span></>}
            {suggCount  > 0 && <> · <span style={{ color: T.gold, fontWeight: 500 }}>{suggCount} suggestions</span></>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {savedMsg && <span style={s.savedMsg}>{savedMsg}</span>}
          {suggCount > 0 && (
            <button style={s.btnOutline} onClick={acceptAll} title="Fills uncategorized transactions only — never overwrites an existing category">Accept all ({suggCount})</button>
          )}
          {txns.length > 0 && (
            <button style={s.btnDanger} disabled={saving} onClick={deleteAll}>Delete All</button>
          )}
          <button
            style={{ ...s.btnSecondary, ...(loadingMore ? s.btnDisabled : {}) }}
            disabled={loadingMore}
            title={loadingMore ? 'Waiting for all transactions to load — duplicate detection needs the full list' : undefined}
            onClick={() => setShowImport(true)}
          >↑ Import CSV</button>
          <button
            style={{ ...s.btnPrimary, ...(pendingTxnCount === 0 || saving ? s.btnDisabled : {}) }}
            disabled={pendingTxnCount === 0 || saving}
            onClick={doSave}
          >
            {saving ? 'Saving…' : pendingTxnCount > 0 ? `Save (${pendingTxnCount})` : 'Save'}
          </button>
        </div>
      </header>

      <div style={s.content}>
      {/* Upload coverage */}
      {coverage && <CoveragePanel coverage={coverage} />}

      {/* Toolbar */}
      <div style={s.toolbar}>
        <input
          style={{ ...s.input, width: 240 }}
          placeholder="Search descriptions…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div style={s.tabs}>
          {[
            ['all',           'All'],
            ['suggestions',   `Suggestions${suggCount > 0 ? ` (${suggCount})` : ''}`],
            ['uncategorized', 'Uncategorized'],
            ['mixed',         `Mixed${mixedCount > 0 ? ` (${mixedCount})` : ''}`],
            ['categorized',   'Categorized'],
          ].map(([val, label]) => (
            <button key={val}
              style={{ ...s.tab, ...(filter === val ? s.tabActive : {}) }}
              onClick={() => setFilter(val)}
            >{label}</button>
          ))}
        </div>
        <label style={s.fuzzyLabel}>
          <input type="checkbox" checked={fuzzy} onChange={e => setFuzzy(e.target.checked)} />
          Group similar merchants
        </label>
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div style={s.bulkBar}>
          <span style={{ fontSize: 13, color: '#1e40af' }}><strong>{selected.size}</strong> selected</span>
          <input
            style={{ ...s.input, width: 220 }}
            list="bulk-cats"
            value={bulkCat}
            onChange={e => setBulkCat(e.target.value)}
            placeholder="Category…"
          />
          <datalist id="bulk-cats">{allCats.map(c => <option key={c} value={c} />)}</datalist>
          <button
            style={{ ...s.btnPrimary, ...(!bulkCat.trim() ? s.btnDisabled : {}) }}
            disabled={!bulkCat.trim()}
            onClick={applyBulk}
          >Apply</button>
          <button style={s.btnSecondary} onClick={clearBulkCats}>Clear categories</button>
          <button style={s.btnSecondary} onClick={() => setSelected(new Set())}>Clear selection</button>
          <button style={s.btnDanger} disabled={saving} onClick={deleteSelected}>Delete selected</button>
        </div>
      )}

      {/* Group table */}
      {visibleGroups.length === 0 ? (
        <p style={{ color: '#9ca3af', textAlign: 'center', padding: '48px 0', fontSize: 14 }}>
          No groups match your filter.
        </p>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={{ ...s.th, width: 36 }}>
                    <input type="checkbox" checked={allPageSel} onChange={toggleSelAll} />
                  </th>
                  <th style={s.th}>Merchant / Description</th>
                  <th style={{ ...s.th, minWidth: 280 }}>Account Category</th>
                  <th style={{ ...s.th, width: 60, textAlign: 'right' }}>Txns</th>
                  <th style={{ ...s.th, width: 110, textAlign: 'right' }}>Total</th>
                  <th style={{ ...s.th, width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {pageGroups.map((g, i) => {
                  const st      = statusByKey.get(g.key)
                  const cat     = st.kind === 'mixed' ? '' : ([...st.distinct][0] || '')
                  const isDirty = g.txns.some(t => t.id in assignments && (assignments[t.id] || '') !== (t.category || ''))
                  const sugg    = hasSugg(g)
                  const isExp   = !!expanded[g.key]
                  const unknownCat = cat && !allCats.includes(cat)

                  return (
                    <Fragment key={g.key}>
                      <tr style={{
                        background: isDirty ? '#eff6ff' : sugg ? '#fdf4ff' : (i % 2 === 0 ? '#fff' : '#f9fafb'),
                      }}>
                        <td style={s.td}>
                          <input
                            type="checkbox"
                            checked={selected.has(g.key)}
                            onChange={() => setSelected(p => {
                              const n = new Set(p); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n
                            })}
                          />
                        </td>

                        <td style={{ ...s.td, maxWidth: 0, width: '99%' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, overflow: 'hidden' }}>
                            {isDirty && <span style={s.dirtyDot} title="Unsaved change" />}
                            {g.isSeparated && <span style={s.sepTag}>separated</span>}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, color: '#111827' }}>
                              {g.displayDesc}
                            </span>
                            {g.variants?.length > 0 && (
                              <span style={s.badge} title={g.variants.join('\n')}>
                                +{g.variants.length} similar
                              </span>
                            )}
                            {st.kind === 'partial' && (
                              <span style={s.warnBadge} title="Expand the row to see which transactions differ">
                                {st.uncategorized} of {g.txns.length} uncategorized
                              </span>
                            )}
                            {st.kind === 'mixed' && (
                              <span style={s.warnBadge} title={mixedTitle(g, catOf)}>
                                {st.distinct.size} categories{st.uncategorized > 0 ? ` · ${st.uncategorized} uncategorized` : ''}
                              </span>
                            )}
                          </div>
                        </td>

                        <td style={s.td}>
                          {sugg && (
                            <div style={s.suggRow}>
                              <span style={s.suggDot} />
                              <span style={s.suggLabel}>Suggested: {g.suggestedCat}</span>
                              <button style={s.acceptBtn} onClick={() => acceptSuggestion(g)} title="Accept — fills uncategorized transactions only">✓</button>
                              <button style={s.rejectBtn} onClick={() => rejectSuggestion(g)} title="Dismiss">✕</button>
                            </div>
                          )}
                          <CategoryInput
                            value={cat}
                            onChange={val => assignGroup(g, val)}
                            categories={allCats}
                            groups={groupedCats}
                            placeholder={st.kind === 'mixed' ? '— mixed categories —' : undefined}
                            style={unknownCat
                              ? { border: '1px solid #d97706', boxShadow: '0 0 0 2px #FDE68A' }
                              : isDirty ? { border: '1px solid #3b82f6', boxShadow: '0 0 0 2px #bfdbfe' } : {}}
                          />
                          {g.txns.length > 1 && (
                            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                              Applies to all {g.txns.length} transactions
                            </div>
                          )}
                        </td>

                        <td style={{ ...s.td, textAlign: 'right', color: '#9ca3af', fontSize: 13 }}>
                          {g.txns.length}
                        </td>
                        <td style={{ ...s.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: g.total < 0 ? '#dc2626' : '#16a34a' }}>
                          {g.total.toFixed(2)}
                        </td>
                        <td style={s.td}>
                          <button style={s.expandBtn} onClick={() => setExpanded(p => ({ ...p, [g.key]: !p[g.key] }))}>
                            {isExp ? '▲' : '▼'}
                          </button>
                        </td>
                      </tr>

                      {/* Expanded transaction list */}
                      {isExp && (
                        <tr>
                          <td colSpan={6} style={{ padding: 0, background: '#EBF1F7', borderBottom: `2px solid #B8CDE0` }}>
                            <div style={{ padding: '10px 12px 12px 48px' }}>
                              {g.variants?.length > 0 && (
                                <p style={{ fontSize: 10.5, color: T.charcoal, margin: '0 0 8px' }}>
                                  <strong>Grouped descriptions:</strong> {[g.displayDesc, ...g.variants].join(', ')}
                                </p>
                              )}
                              <table style={s.table}>
                                <thead>
                                  <tr>
                                    {['Date', 'Description', 'Amount', 'Category', 'Account', ''].map(h => (
                                      <th key={h} style={{ ...s.th, background: '#D8E4EF', padding: '5px 8px' }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {g.txns.slice(0, 25).map(t => (
                                    <tr key={t.id} style={{ background: '#fff' }}>
                                      <td style={{ ...s.td, padding: '4px 8px', whiteSpace: 'nowrap' }}>{t.transaction_date}</td>
                                      <td style={{ ...s.td, padding: '4px 8px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</td>
                                      <td style={{ ...s.td, padding: '4px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: Number(t.amount) < 0 ? '#dc2626' : '#16a34a' }}>
                                        {Number(t.amount).toFixed(2)}
                                      </td>
                                      <td style={{ ...s.td, padding: '4px 8px', color: catOf(t) ? T.charcoal : '#d97706', fontStyle: catOf(t) ? 'normal' : 'italic' }}>
                                        {catOf(t) || 'uncategorized'}
                                        {t.id in assignments && (assignments[t.id] || '') !== (t.category || '') && <span style={{ ...s.dirtyDot, marginLeft: 5 }} title="Unsaved change" />}
                                      </td>
                                      <td style={{ ...s.td, padding: '4px 8px' }}>{t.account || '—'}</td>
                                      <td style={{ ...s.td, padding: '4px 8px', whiteSpace: 'nowrap' }}>
                                        {g.isSeparated ? (
                                          <button style={s.rejoinBtn} onClick={() => rejoinTxn(t.id)}>↩ Rejoin group</button>
                                        ) : g.txns.length > 1 ? (
                                          <button style={s.separateBtn} onClick={() => separateTxn(t.id)} title="Move this transaction to its own group">Remove from group</button>
                                        ) : null}
                                      </td>
                                    </tr>
                                  ))}
                                  {g.txns.length > 25 && (
                                    <tr>
                                      <td colSpan={6} style={{ padding: '4px 8px', color: '#9ca3af' }}>
                                        …and {g.txns.length - 25} more
                                      </td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <div style={s.pager}>
              <button style={s.btnSecondary} disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
              <span style={{ fontSize: 13, color: '#6b7280' }}>Page {page + 1} of {pageCount} · {visibleGroups.length} groups</span>
              <button style={s.btnSecondary} disabled={page >= pageCount - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
            </div>
          )}
        </>
      )}

      </div>{/* end content */}

      {/* Import modal */}
      {showImport && (
        <ImportModal
          clientId={clientId}
          allCats={allCats}
          groupedCats={groupedCats}
          existingTxns={txns}
          onDone={() => { setShowImport(false); load() }}
          onClose={() => setShowImport(false)}
        />
      )}
    </div>
  )
}

// ─── Coverage Panel ───────────────────────────────────────────────────────────

function CoveragePanel({ coverage }) {
  const { accounts, months, map } = coverage
  const fmtMonth = ym => {
    const [y, mo] = ym.split('-')
    return new Date(+y, +mo - 1, 1).toLocaleString('default', { month: 'short', year: '2-digit' })
  }
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: '12px 16px', marginBottom: 16, overflowX: 'auto' }}>
      <h3 style={{ fontSize: 10.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', margin: '0 0 10px' }}>
        Upload Coverage
      </h3>
      <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ padding: '4px 10px 4px 0', textAlign: 'left', color: T.charcoal, fontWeight: 600, whiteSpace: 'nowrap', minWidth: 130 }}>Account</th>
            {months.map(ym => (
              <th key={ym} style={{ padding: '4px 6px', textAlign: 'center', color: T.charcoal, fontWeight: 500, whiteSpace: 'nowrap' }}>
                {fmtMonth(ym)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {accounts.map(acct => (
            <tr key={acct}>
              <td style={{ padding: '3px 10px 3px 0', color: T.charcoal, whiteSpace: 'nowrap', fontWeight: 500 }}>{acct}</td>
              {months.map(ym => {
                const count = map[acct]?.[ym] ?? 0
                return (
                  <td key={ym} style={{ padding: '3px 6px', textAlign: 'center' }}>
                    {count > 0
                      ? <span style={{ display: 'inline-block', background: '#D1E8D4', color: '#1A5C28', borderRadius: 3, padding: '1px 7px', fontWeight: 500 }}>{count}</span>
                      : <span style={{ display: 'inline-block', background: T.page, color: '#C0BDB7', borderRadius: 3, padding: '1px 7px' }}>—</span>
                    }
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  wrap:        { width: '100%', background: T.page, minHeight: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' },
  pageHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 28px', background: T.card, borderBottom: `1px solid ${T.border}` },
  h2:          { fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 2px' },
  sub:         { fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 },
  savedMsg:    { fontSize: 11, color: T.success, fontWeight: 500 },
  center:      { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300, background: T.page, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  spinner:     { width: 28, height: 28, border: `2px solid ${T.border}`, borderTopColor: T.navy, borderRadius: '50%', animation: 'spin .7s linear infinite' },
  errorBox:    { background: '#FDE8E8', border: '1px solid #F5C2C2', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#991B1B', marginBottom: 14 },
  content:     { padding: '20px 28px' },
  toolbar:     { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' },
  input:       { padding: '5px 9px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, color: T.charcoal, background: '#fff', outline: 'none' },
  tabs:        { display: 'flex', gap: 2 },
  tab:         { padding: '5px 12px', border: `1px solid ${T.border}`, borderRadius: 5, background: '#fff', fontSize: 11, color: T.charcoal, cursor: 'pointer', fontWeight: 400 },
  tabActive:   { background: T.navy, color: '#fff', border: `1px solid ${T.navy}`, fontWeight: 500 },
  fuzzyLabel:  { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.charcoal, cursor: 'pointer', userSelect: 'none' },
  bulkBar:     { display: 'flex', gap: 8, alignItems: 'center', background: '#EBF1F7', border: '1px solid #B8CDE0', borderRadius: 6, padding: '8px 12px', marginBottom: 12, flexWrap: 'wrap' },
  table:       { width: '100%', borderCollapse: 'collapse' },
  th:          { background: T.page, padding: '7px 10px', textAlign: 'left', fontWeight: 700, borderBottom: `2px solid ${T.border}`, fontSize: 9.5, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' },
  td:          { padding: '7px 10px', borderBottom: `1px solid ${T.border}`, verticalAlign: 'middle', fontSize: 12, color: T.charcoal },
  dirtyDot:    { flexShrink: 0, width: 6, height: 6, borderRadius: '50%', background: T.navy, display: 'inline-block' },
  sepTag:      { flexShrink: 0, fontSize: 9.5, color: '#9ca3af', background: T.page, border: `1px solid ${T.border}`, borderRadius: 3, padding: '1px 5px' },
  badge:       { flexShrink: 0, fontSize: 10, fontWeight: 500, color: '#4A7BA7', background: '#E8EFF5', borderRadius: 3, padding: '1px 6px', whiteSpace: 'nowrap', cursor: 'default' },
  warnBadge:   { flexShrink: 0, fontSize: 10, fontWeight: 500, color: '#92400E', background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 3, padding: '1px 6px', whiteSpace: 'nowrap', cursor: 'default' },
  suggRow:     { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 },
  suggDot:     { flexShrink: 0, width: 6, height: 6, borderRadius: '50%', background: T.gold, display: 'inline-block' },
  suggLabel:   { fontSize: 11, color: T.gold, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  acceptBtn:   { flexShrink: 0, padding: '1px 7px', background: '#E6F0E9', color: '#047857', border: '1px solid #B8D4BE', borderRadius: 3, fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  rejectBtn:   { flexShrink: 0, padding: '1px 5px', background: '#FDE8E8', color: T.danger, border: '1px solid #F5C2C2', borderRadius: 3, fontSize: 11, cursor: 'pointer' },
  expandBtn:   { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 10, padding: '2px 5px', lineHeight: 1 },
  separateBtn: { padding: '2px 8px', background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D', borderRadius: 3, fontSize: 10, fontWeight: 500, cursor: 'pointer' },
  rejoinBtn:   { padding: '2px 8px', background: '#EBF1F7', color: T.navy, border: `1px solid #B8CDE0`, borderRadius: 3, fontSize: 10, fontWeight: 500, cursor: 'pointer' },
  pager:       { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 14, marginTop: 20 },
  btnPrimary:  { padding: '6px 16px', background: T.navy, color: '#fff', border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  btnSecondary:{ padding: '6px 14px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  btnOutline:  { padding: '6px 14px', background: 'transparent', color: T.gold, border: `1px solid ${T.gold}`, borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  btnDanger:   { padding: '6px 14px', background: '#FDE8E8', color: T.danger, border: '1px solid #F5C2C2', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
}
