import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react'
import { supabase, isMissingSchemaError } from '../lib/supabase'
import { normKey, buildCatIndex, suggestCat, clusterGroups } from '../lib/merchantClustering'
import { groupStatus, buildDescCatMap } from '../lib/categorize'
import { ALL_SECTIONS, fetchAccounts } from '../lib/chartOfAccounts'
import { matchLedgerAccount } from '../lib/balanceSheet'
import { getSetting, setSetting } from '../lib/settings'
import { useUnsavedChanges } from '../lib/unsavedChanges'
import CategoryInput from './CategoryInput'
import ImportModal from './ImportModal'
import MultiSelect from './MultiSelect'
import { fetchVendors, addVendor, findVendorByName, setVendorOnTransactions } from '../lib/vendors'
import { T, fmt2, fmtYm, MON } from '../lib/theme'

const PAGE_SIZE = 50        // groups per page (grouped view)
const FLAT_PAGE_SIZE = 100  // transactions per page (ungrouped view)
const REVIEW_STATE_KEY = 'txn_review_state'
const AUTOSAVE_MS = 800     // quiet time after the last category edit before it's written

// Sorting. Text columns read best ascending on first click, dates/numbers
// descending (newest and largest first), so the initial direction depends on
// the column rather than always being ascending.
const TEXT_COLS = new Set(['description', 'category', 'account', 'vendor'])
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const nextSort = (prev, col) => prev.col === col
  ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
  : { col, dir: TEXT_COLS.has(col) ? 'asc' : 'desc' }

// Effective category of a transaction under a pending-assignments map.
// All review state anchors to transaction IDs; group keys are display-only.
const effCat = (assignments, t) => (t.id in assignments ? assignments[t.id] : (t.category || ''))

// Stable identity of a set of pending writes, so a failed autosave isn't
// retried until the set actually changes.
const pendingKey = idToCat => JSON.stringify(Object.keys(idToCat).sort().map(id => [id, idToCat[id]]))

// Stable serialization of the persisted review state, used both to store it
// and to detect real changes (so the debounced write doesn't fire on no-ops).
const reviewJson = (separated, rejected) =>
  JSON.stringify({ separated: [...separated].sort(), rejected: [...rejected].sort() })

// Newest transaction date in a group — the grouped view's "Last" column.
const lastOf = g => g.txns.reduce((m, t) => ((t.transaction_date || '') > m ? t.transaction_date : m), '')

// 'YYYY-MM-DD' → 'Aug 28, 2026'. Sorting still uses the ISO string.
const fmtDate = iso => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${MON[+m] || ''} ${+d}, ${y}`
}

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

// `headerLeft` lets the combined Transactions hub put its title and tab
// switcher where the standalone title sits; the live stats line stays.
// `initialFilters` comes from the URL when a report figure links here, so the
// page opens already showing the transactions behind that number.
export default function Transactions({ clientId = null, headerLeft = null, initialFilters = null }) {
  const [txns,        setTxns]        = useState([])
  const [loading,     setLoading]     = useState(true)
  const [loadError,   setLoadError]   = useState(null)
  const [accounts,    setAccounts]    = useState([])
  const [assignments, setAssignments] = useState({})    // txnId → category ('' = clear)
  const [rejected,    setRejected]    = useState(new Set()) // txn IDs whose suggestion was dismissed
  const [separated,   setSeparated]   = useState(new Set()) // txn IDs given their own group
  const [fuzzy,       setFuzzy]       = useState(true)
  const [search,      setSearch]      = useState(initialFilters?.q || '')
  // Exact category names from a deep link. Unlike `search` this is not fuzzy —
  // it has to reproduce the figure that was clicked, not merely resemble it.
  const [catFilter,   setCatFilter]   = useState(initialFilters?.cats ?? [])
  const [filter,      setFilter]      = useState('all')
  const [view,        setView]        = useState(initialFilters?.view || 'flat')  // 'grouped' | 'flat'
  const [dateFrom,    setDateFrom]    = useState(initialFilters?.from || '')
  const [dateTo,      setDateTo]      = useState(initialFilters?.to || '')
  const [acctFilter,  setAcctFilter]  = useState([])      // [] = all accounts
  const [registry,    setRegistry]    = useState([])      // client_settings 'ledger_accounts'
  const [vendors,     setVendors]     = useState([])      // vendors table; [] until migration §7 has run
  const [vendorsReady, setVendorsReady] = useState(true)  // false while bank_transactions has no vendor_id column
  const [vendorFilter, setVendorFilter] = useState(initialFilters?.vendor || '') // a vendor id, or 'none'
  const [bulkVendor,  setBulkVendor]  = useState('')
  const [sortGrouped, setSortGrouped] = useState({ col: 'description', dir: 'asc'  })
  const [sortFlat,    setSortFlat]    = useState({ col: 'date',        dir: 'desc' })
  const [expanded,    setExpanded]    = useState({})
  const [selected,    setSelected]    = useState(new Set())
  const [bulkCat,     setBulkCat]     = useState('')
  const [page,        setPage]        = useState(0)
  const [saving,      setSaving]      = useState(false)   // any write, deletes included — gates the destructive buttons
  const [writing,     setWriting]     = useState(false)   // a category write specifically — drives the "Saving…" status
  const [savedMsg,    setSavedMsg]    = useState('')
  const [saveError,   setSaveError]   = useState('')
  const [flushTick,   setFlushTick]   = useState(0)       // bumped when a write lands, so autosave re-checks what's left
  const [showImport,  setShowImport]  = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const { setDirty } = useUnsavedChanges()
  const hydratedRef  = useRef(false) // gates the persist effect until load() has applied stored state
  const lastSavedRef = useRef('')
  const inFlightRef  = useRef(false) // a category write is on the wire
  const failedRef    = useRef('')    // pending set whose autosave failed — waits for a new edit or Retry
  const searchRef    = useRef(null)

  // "/" focuses the search box from anywhere on the page that isn't already a
  // text field — the hint in the box promises it.
  useEffect(() => {
    const h = e => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      if (!searchRef.current || searchRef.current.offsetParent === null) return // hidden tab
      e.preventDefault()
      searchRef.current.focus()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const allCats = useMemo(() => accounts.map(a => a.name), [accounts])

  // Transfer categories: the ones the ledger registry binds to a BANK account
  // (Chart of Accounts → Bank & Card Accounts). Money categorized here moved
  // between your own accounts — it never touches the P&L, and the balance
  // sheet carries it to the receiving account. A card's payment category is a
  // payment, not a transfer, so it stays under its own section.
  const transferCats = useMemo(
    () => registry.filter(e => e.type === 'bank')
      .flatMap(e => e.boundCategories || [])
      .filter(c => allCats.includes(c)),
    [registry, allCats]
  )
  const transferSet = useMemo(() => new Set(transferCats), [transferCats])
  const transferLabelOf = useCallback(
    c => registry.find(e => (e.boundCategories || []).includes(c))?.label ?? c,
    [registry]
  )

  // COA-grouped category list for pickers, transfers first so "mark as a
  // transfer" is one pick away.
  const groupedCats = useMemo(() => {
    if (!accounts.length) return null
    const bySection = {}
    accounts.forEach(a => {
      if (transferSet.has(a.name)) return
      const sec = a.pl_section ?? 'Other'
      if (!bySection[sec]) bySection[sec] = []
      bySection[sec].push(a.name)
    })
    const ordered = ALL_SECTIONS.filter(s => bySection[s]?.length).map(s => ({ section: s, accounts: bySection[s] }))
    if (bySection['Other']?.length) ordered.push({ section: 'Other', accounts: bySection['Other'] })
    if (transferCats.length) ordered.unshift({ section: 'Transfers', accounts: transferCats })
    return ordered.length ? ordered : null
  }, [accounts, transferCats, transferSet])

  const vendorNames = useMemo(() => vendors.map(v => v.name), [vendors])

  // ── Load ───────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null)
    try {
      // The .order('id') tiebreaker makes .range() pagination stable — without a
      // total order, Postgres may repeat or skip rows across pages.
      const COLS = 'id, transaction_date, description, amount, category, account, reference_id'
      const mkBase = cols => opts => supabase
        .from('bank_transactions')
        .select(cols, opts)
        .eq('client_id', clientId)
        .order('transaction_date')
        .order('id')
      let base = mkBase(`${COLS}, vendor_id`)

      // count:'exact' rides along on the first page so the remaining pages are
      // known up front and can be fetched in parallel, not one after another.
      const [firstTry, coaRes, reviewState, ledgerVal, vendorRows] = await Promise.all([
        base({ count: 'exact' }).range(0, 999),
        fetchAccounts(clientId),
        getSetting(clientId, REVIEW_STATE_KEY, null).catch(() => null),
        getSetting(clientId, 'ledger_accounts', []).catch(() => []),
        fetchVendors(clientId).catch(() => []), // no vendors table yet just means no vendors
      ])
      // Until migration §7 adds vendor_id, load without it and hide the column
      // rather than failing the whole page.
      let firstRes = firstTry
      let withVendors = true
      if (firstRes.error && isMissingSchemaError(firstRes.error)) {
        withVendors = false
        base = mkBase(COLS)
        firstRes = await base({ count: 'exact' }).range(0, 999)
      }
      if (firstRes.error) throw firstRes.error
      setVendorsReady(withVendors)
      setVendors(withVendors ? vendorRows : [])

      const first = firstRes.data ?? []
      const total = firstRes.count ?? first.length
      setAccounts(coaRes.accounts)
      setRegistry(Array.isArray(ledgerVal) ? ledgerVal : [])
      const loadedSep = new Set(reviewState?.separated ?? [])
      const loadedRej = new Set(reviewState?.rejected ?? [])
      setSeparated(loadedSep)
      setRejected(loadedRej)
      lastSavedRef.current = reviewJson(loadedSep, loadedRej)
      setTxns(first)     // show data immediately
      setLoading(false)  // spinner off — UI is usable now

      // Quietly fetch the rest — all pages at once
      let all = first
      if (total > first.length) {
        setLoadingMore(true)
        const ranges = []
        for (let offset = first.length; offset < total; offset += 1000) ranges.push(offset)
        const pages = await Promise.all(ranges.map(o => base().range(o, o + 999)))
        // A failed page must surface, not silently truncate — loadingMore is
        // the gate that keeps Import from deduping against a partial list.
        const failed = pages.find(r => r.error)
        if (failed) throw new Error(`Could not load all transactions: ${failed.error.message}`)
        // De-duped by id: a row inserted or deleted while pages are in flight
        // can shift range boundaries and repeat a row across two pages.
        const byId = new Map(first.map(t => [t.id, t]))
        pages.forEach(r => (r.data ?? []).forEach(t => { if (!byId.has(t.id)) byId.set(t.id, t) }))
        all = [...byId.values()]
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

  const vendorById   = useMemo(() => new Map(vendors.map(v => [v.id, v])), [vendors])
  const vendorNameOf = useCallback(t => vendorById.get(t.vendor_id)?.name || '', [vendorById])

  const catOf = useCallback(t => effCat(assignments, t), [assignments])

  // A transaction's account as the Chart of Accounts names it. Feed labels come
  // off the bank/card export and can spell one account several ways; the ledger
  // registry folds those spellings onto a single name, so this page agrees with
  // the balance sheet instead of showing an account twice.
  const acctNameOf = useCallback(
    t => matchLedgerAccount(registry, t.account)?.label || t.account || 'Unmapped',
    [registry]
  )

  // Accounts actually present in the data, by display name.
  const acctOptions = useMemo(
    () => [...new Set(txns.map(acctNameOf))].sort((a, b) => a.localeCompare(b)),
    [txns, acctNameOf]
  )

  // Date range and account narrow the working set before grouping, so group
  // totals and counts describe the current selection rather than all history.
  // ISO date strings compare lexicographically, which is also chronological.
  const dateActive = !!(dateFrom || dateTo)
  const acctActive = acctFilter.length > 0
  const catActive  = catFilter.length > 0
  // Matches the SAVED category, not the effective one: a deep link reproduces a
  // figure built from saved data, and filtering on pending edits would make
  // rows vanish from under you as you recategorize them.
  const catSet  = useMemo(() => new Set(catFilter),  [catFilter])
  const acctSet = useMemo(() => new Set(acctFilter), [acctFilter])
  const dateFiltered = useMemo(() => {
    if (!dateFrom && !dateTo && !acctSet.size && !catSet.size && !vendorFilter) return txns
    return txns.filter(t => {
      const d = t.transaction_date || ''
      if (dateFrom && d < dateFrom) return false
      if (dateTo   && d > dateTo)   return false
      if (acctSet.size && !acctSet.has(acctNameOf(t))) return false
      if (catSet.size && !catSet.has((t.category || '').trim())) return false
      if (vendorFilter && (vendorFilter === 'none' ? !!t.vendor_id : t.vendor_id !== vendorFilter)) return false
      return true
    })
  }, [txns, dateFrom, dateTo, acctSet, acctNameOf, catSet, vendorFilter])

  const groups = useMemo(() => {
    // Suggestion index is built from the full history, not the date window —
    // narrowing the view shouldn't weaken the category suggestions.
    const descCatMap = buildDescCatMap(txns)
    const catIndex = buildCatIndex(descCatMap)

    // Separate pinned transactions
    const mainTxns = dateFiltered.filter(t => !separated.has(t.id))
    const sepTxns  = dateFiltered.filter(t =>  separated.has(t.id))

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
  }, [txns, dateFiltered, fuzzy, separated])

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

  // Single-transaction edit, used by the ungrouped view. Review state is already
  // keyed by transaction id, so this needs no group bookkeeping.
  const assignTxn = (id, cat) => {
    setAssignments(p => ({ ...p, [id]: cat }))
    setSavedMsg('')
  }

  const acceptTxnSuggestion = (id, cat) => { assignTxn(id, cat) }
  const rejectTxnSuggestion = id => setRejected(prev => new Set([...prev, id]))

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

  // Selection is keyed by group key in grouped view and by transaction id in
  // flat view, so it must not survive anything that regroups or switches view;
  // it deliberately does survive page changes.
  useEffect(() => { setPage(0); setSelected(new Set()) }, [search, filter, fuzzy, view, dateFrom, dateTo, acctFilter, catFilter, vendorFilter])
  useEffect(() => { setPage(0) }, [sortGrouped, sortFlat])

  const visibleGroups = useMemo(() => {
    const q = search.toLowerCase()
    return groups.filter(g => {
      // Category matches on the effective category (pending edits included), and
      // a group matches if ANY of its rows does — a mixed group would otherwise
      // vanish when searching for one of the categories inside it.
      if (q && !g.key.includes(q) && !g.displayDesc.toLowerCase().includes(q)
        && !g.txns.some(t => catOf(t).toLowerCase().includes(q) || vendorNameOf(t).toLowerCase().includes(q))) return false
      const st = statusByKey.get(g.key)
      if (filter === 'uncategorized' && st.uncategorized === 0) return false
      if (filter === 'categorized'   && st.uncategorized > 0)   return false
      if (filter === 'mixed'         && st.kind !== 'mixed')    return false
      if (filter === 'suggestions'   && !hasSugg(g))            return false
      return true
    })
  }, [groups, search, filter, statusByKey, hasSugg, catOf, vendorNameOf])

  const sortedGroups = useMemo(() => {
    const { col, dir } = sortGrouped
    const mul = dir === 'asc' ? 1 : -1
    const val = g => {
      switch (col) {
        case 'count': return g.txns.length
        case 'total': return g.total
        case 'last':  return lastOf(g)
        default:      return g.key
      }
    }
    return [...visibleGroups].sort((a, b) => mul * cmp(val(a), val(b)) || a.key.localeCompare(b.key))
  }, [visibleGroups, sortGrouped])

  // Group-derived facts a single transaction needs in flat view, where the
  // status tabs still filter on suggestion/mixed state that only grouping knows.
  const txnMeta = useMemo(() => {
    const m = new Map()
    groups.forEach(g => {
      const st = statusByKey.get(g.key)
      const sugg = hasSugg(g) ? g.suggestedCat : ''
      g.txns.forEach(t => m.set(t.id, { mixed: st?.kind === 'mixed', sugg }))
    })
    return m
  }, [groups, statusByKey, hasSugg])

  const visibleTxns = useMemo(() => {
    const q = search.toLowerCase()
    return dateFiltered.filter(t => {
      const cat = catOf(t)
      if (q && !(t.description || '').toLowerCase().includes(q)
        && !cat.toLowerCase().includes(q)
        && !vendorNameOf(t).toLowerCase().includes(q)) return false
      const c = cat
      const meta = txnMeta.get(t.id)
      if (filter === 'uncategorized' && c)  return false
      if (filter === 'categorized'   && !c) return false
      if (filter === 'mixed'         && !meta?.mixed) return false
      if (filter === 'suggestions'   && !(meta?.sugg && !c && !rejected.has(t.id))) return false
      return true
    })
  }, [dateFiltered, search, filter, catOf, txnMeta, rejected, vendorNameOf])

  const sortedTxns = useMemo(() => {
    const { col, dir } = sortFlat
    const mul = dir === 'asc' ? 1 : -1
    const val = t => {
      switch (col) {
        case 'description': return (t.description || '').toLowerCase()
        case 'category':    return catOf(t).toLowerCase()
        case 'account':     return (t.account || '').toLowerCase()
        case 'vendor':      return vendorNameOf(t).toLowerCase()
        case 'amount':      return Number(t.amount) || 0
        default:            return t.transaction_date || ''
      }
    }
    return [...visibleTxns].sort((a, b) => mul * cmp(val(a), val(b)) || cmp(a.id, b.id))
  }, [visibleTxns, sortFlat, catOf, vendorNameOf])

  const onSortGrouped = col => setSortGrouped(p => nextSort(p, col))
  const onSortFlat    = col => setSortFlat(p => nextSort(p, col))

  const isFlat     = view === 'flat'
  const pageSize   = isFlat ? FLAT_PAGE_SIZE : PAGE_SIZE
  const rowCount   = isFlat ? sortedTxns.length : sortedGroups.length
  const pageCount  = Math.ceil(rowCount / pageSize)
  const pageGroups = sortedGroups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const pageTxns   = sortedTxns.slice(page * FLAT_PAGE_SIZE, (page + 1) * FLAT_PAGE_SIZE)

  // ── Stats (transaction-based, not group-based) ─────────────────────────────

  const uncatTxnCount = useMemo(() => dateFiltered.filter(t => !catOf(t)).length, [dateFiltered, catOf])
  const suggCount     = useMemo(() => groups.filter(g => hasSugg(g)).length, [groups, hasSugg])
  const mixedCount    = useMemo(
    () => groups.filter(g => statusByKey.get(g.key)?.kind === 'mixed').length,
    [groups, statusByKey]
  )
  // Uncategorized transactions a suggestion would fill — the gold slice of the
  // progress bar, so the bar shows how much of the gap is one click away.
  const suggTxnCount  = useMemo(
    () => dateFiltered.filter(t => !catOf(t) && !rejected.has(t.id) && txnMeta.get(t.id)?.sugg).length,
    [dateFiltered, catOf, rejected, txnMeta]
  )
  // Real changes only — re-picking the saved value is a no-op. Split by whether
  // the category is on the chart: known ones autosave; free text that isn't
  // waits for an explicit Save, so a typo can't reach the books unconfirmed.
  const pending = useMemo(() => {
    const auto = {}, held = {}
    for (const [id, cat] of Object.entries(assignments)) {
      const t = txnById.get(id)
      if (!t || (cat || '') === (t.category || '')) continue
      if (!cat || allCats.includes(cat)) auto[id] = cat || null
      else held[id] = cat
    }
    return { auto, held, autoCount: Object.keys(auto).length, heldCount: Object.keys(held).length }
  }, [assignments, txnById, allCats])
  const pendingTxnCount = pending.autoCount + pending.heldCount

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

  // Rows are keyed by the Chart of Accounts name, so several feed spellings of
  // one account collapse into a single row instead of implying a gap in each.
  const coverage = useMemo(() => {
    if (!txns.length) return null
    const map = {}
    txns.forEach(t => {
      const acct = acctNameOf(t)
      const ym   = (t.transaction_date || '').slice(0, 7)
      if (!ym) return
      if (!map[acct]) map[acct] = {}
      map[acct][ym] = (map[acct][ym] || 0) + 1
    })
    const months = [...new Set(txns.map(t => (t.transaction_date || '').slice(0, 7)).filter(Boolean))].sort()
    return { accounts: Object.keys(map).sort(), months, map }
  }, [txns, acctNameOf])

  // ── Delete ─────────────────────────────────────────────────────────────────

  const deleteSelected = async () => {
    const ids = selectedTxns().map(t => t.id)
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
      setSavedMsg(`Deleted ${ids.length} transaction${ids.length !== 1 ? 's' : ''}`)
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
      setSavedMsg('All transactions deleted')
    } catch (e) { alert('Delete failed: ' + e.message) }
    finally { setSaving(false) }
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  // Writes one batch of category changes and folds the result into local
  // state. Only the assignments still equal to what was written are cleared:
  // an edit made while the write was on the wire stays pending for the next.
  const persist = useCallback(async idToCat => {
    const ids = Object.keys(idToCat)
    if (!ids.length) return
    inFlightRef.current = true
    setSaving(true); setWriting(true); setSavedMsg(''); setSaveError('')
    try {
      const byCat = {}
      for (const [id, cat] of Object.entries(idToCat)) {
        const k = cat ?? '__null__'
        if (!byCat[k]) byCat[k] = []
        byCat[k].push(id)
      }
      let total = 0
      for (const [catKey, catIds] of Object.entries(byCat)) {
        const catValue = catKey === '__null__' ? null : catKey
        for (let i = 0; i < catIds.length; i += 500) {
          const batch = catIds.slice(i, i + 500)
          const { error } = await supabase.from('bank_transactions')
            .update({ category: catValue }).eq('client_id', clientId).in('id', batch)
          if (error) throw error
          total += batch.length
        }
      }
      setTxns(prev => prev.map(t => t.id in idToCat ? { ...t, category: idToCat[t.id] ?? '' } : t))
      setAssignments(prev => {
        const next = { ...prev }
        let changed = false
        for (const id of ids) {
          if (id in next && (next[id] || '') === (idToCat[id] || '')) { delete next[id]; changed = true }
        }
        return changed ? next : prev
      })
      failedRef.current = ''
      setSavedMsg(`Saved ${total} transaction${total !== 1 ? 's' : ''}`)
    } catch (e) {
      failedRef.current = pendingKey(idToCat)
      setSaveError(e.message)
    } finally {
      inFlightRef.current = false
      setSaving(false); setWriting(false)
      setFlushTick(n => n + 1)
    }
  }, [clientId])

  // Autosave: chart-of-accounts categories are written shortly after the last
  // edit. One write at a time — a timer that fires mid-write stands down, and
  // the tick bump when that write lands brings it back for whatever remains.
  // After a failure nothing retries on its own; a new edit (or Retry) does.
  useEffect(() => {
    if (!pending.autoCount) return
    if (pendingKey(pending.auto) === failedRef.current) return
    const h = setTimeout(() => { if (!inFlightRef.current) persist(pending.auto) }, AUTOSAVE_MS)
    return () => clearTimeout(h)
  }, [pending, flushTick, persist])

  const retrySave = () => { failedRef.current = ''; setSaveError(''); setFlushTick(n => n + 1) }

  // Explicit save for what autosave holds back: free text that isn't on the
  // chart of accounts. Allowed (the chart is user-managed), but a typo
  // shouldn't slip into the books silently.
  const doSave = async () => {
    if (!pending.heldCount || inFlightRef.current) return
    const unknown = [...new Set(Object.values(pending.held))]
    if (!confirm(
      `${unknown.length === 1 ? 'This category is' : 'These categories are'} not in your chart of accounts:\n\n${unknown.join('\n')}\n\nSave anyway?`
    )) return
    await persist({ ...pending.auto, ...pending.held })
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

  // Selection keys differ per view (group key vs transaction id); every bulk
  // action resolves them to transactions through here so both views share one
  // code path.
  const pageKeys   = isFlat ? pageTxns.map(t => t.id) : pageGroups.map(g => g.key)
  const allPageSel = pageKeys.length > 0 && pageKeys.every(k => selected.has(k))
  const toggleSelAll = () => {
    if (allPageSel) setSelected(p => { const n = new Set(p); pageKeys.forEach(k => n.delete(k)); return n })
    else            setSelected(p => { const n = new Set(p); pageKeys.forEach(k => n.add(k));    return n })
  }

  const selectedTxns = useCallback(() => (
    isFlat
      ? [...selected].map(id => txnById.get(id)).filter(Boolean)
      : [...selected].flatMap(k => groups.find(g => g.key === k)?.txns ?? [])
  ), [isFlat, selected, txnById, groups])

  const applyBulkCat = cat => {
    if (!selected.size || !cat) return
    setAssignments(p => {
      const next = { ...p }
      selectedTxns().forEach(t => { next[t.id] = cat })
      return next
    })
    setSelected(new Set()); setBulkCat(''); setSavedMsg('')
  }
  const applyBulk = () => applyBulkCat(bulkCat.trim())

  // ── Vendors ────────────────────────────────────────────────────────────────

  // `name` is whatever the picker committed: an existing vendor, a brand-new
  // one (created here on the spot), or '' to clear. Written immediately — a
  // vendor is a label on the row, not a figure on the books, so nothing
  // needs the category autosave's hold-back rules.
  const assignVendor = async (ids, name) => {
    const clean = (name || '').trim()
    try {
      let vendor = null
      if (clean) {
        vendor = findVendorByName(vendors, clean)
        if (!vendor) {
          vendor = await addVendor(clientId, clean)
          setVendors(prev => prev.some(v => v.id === vendor.id)
            ? prev
            : [...prev, vendor].sort((a, b) => a.name.localeCompare(b.name)))
        }
      }
      const vid = vendor?.id ?? null
      await setVendorOnTransactions(clientId, ids, vid)
      const idSet = new Set(ids)
      setTxns(prev => prev.map(t => idSet.has(t.id) ? { ...t, vendor_id: vid } : t))
      setSavedMsg(vendor
        ? `Vendor set to ${vendor.name} on ${ids.length} transaction${ids.length !== 1 ? 's' : ''}`
        : `Vendor cleared on ${ids.length} transaction${ids.length !== 1 ? 's' : ''}`)
    } catch (e) { alert('Could not save vendor: ' + e.message) }
  }

  const applyBulkVendor = () => {
    const ts = selectedTxns()
    if (!ts.length || !bulkVendor.trim()) return
    assignVendor(ts.map(t => t.id), bulkVendor)
    setSelected(new Set()); setBulkVendor('')
  }

  const clearBulkCats = () => {
    const ts = selectedTxns()
    if (!ts.length) return
    const scope = isFlat
      ? `${ts.length} transaction${ts.length !== 1 ? 's' : ''}`
      : `${ts.length} transaction${ts.length !== 1 ? 's' : ''} across ${selected.size} group${selected.size !== 1 ? 's' : ''}`
    if (!confirm(`Clear the category on ${scope}?`)) return
    setAssignments(p => {
      const next = { ...p }
      ts.forEach(t => { next[t.id] = '' })
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

  const total       = dateFiltered.length
  const catTxnCount = total - uncatTxnCount
  const pctDone     = total ? (catTxnCount / total) * 100 : 0
  const pctSugg     = total ? (suggTxnCount / total) * 100 : 0
  const pctOpen     = Math.max(0, 100 - pctDone - pctSugg)
  const vendorFilterLabel = !vendorFilter ? ''
    : vendorFilter === 'none' ? 'no vendor'
    : (vendorById.get(vendorFilter)?.name || 'one vendor')
  const anyFilter   = dateActive || acctActive || catActive || !!vendorFilter
  const scope = [
    acctActive && (acctFilter.length === 1 ? acctFilter[0] : `${acctFilter.length} accounts`),
    catActive  && `${catFilter.length} categor${catFilter.length !== 1 ? 'ies' : 'y'}`,
    vendorFilter && vendorFilterLabel,
    dateActive && `${dateFrom ? fmtDate(dateFrom) : 'start'} – ${dateTo ? fmtDate(dateTo) : 'now'}`,
  ].filter(Boolean).join(' · ')
  const rowFirst = rowCount === 0 ? 0 : page * pageSize + 1
  const rowLast  = Math.min(rowCount, (page + 1) * pageSize)
  const noun     = isFlat ? 'transaction' : 'group'

  // The counts are the filter: each tile is the status tab it replaced.
  const tiles = [
    { key: 'all',           label: 'All',           n: total,         color: INK,                                 title: 'Every transaction in the current range' },
    { key: 'uncategorized', label: 'Uncategorized', n: uncatTxnCount, color: uncatTxnCount > 0 ? T.amber  : INK, title: 'Transactions with no category yet' },
    { key: 'suggestions',   label: 'Suggestions',   n: suggCount,     color: suggCount     > 0 ? T.gold   : INK, title: 'Merchant groups with a suggested category' },
    { key: 'mixed',         label: 'Mixed groups',  n: mixedCount,    color: mixedCount    > 0 ? T.danger : INK, title: 'Merchant groups whose transactions carry different categories' },
    { key: 'categorized',   label: 'Categorized',   n: catTxnCount,   color: INK,                                 title: 'Transactions that already have a category' },
  ]

  return (
    <div style={s.wrap} className="scs-txn">
      <style>{CSS}</style>

      {/* Page header */}
      <header style={s.pageHeader}>
        <div>{headerLeft ?? <h2 style={s.h2}>Transactions</h2>}</div>
        <div style={s.headerRight}>
          {writing && <span style={s.savingMsg}>Saving…</span>}
          {!writing && saveError && (
            <span style={s.errorMsg}>
              Save failed: {saveError}{' '}
              <button style={s.retryBtn} onClick={retrySave}>Retry</button>
            </span>
          )}
          {!writing && !saveError && savedMsg && <span style={s.savedMsg}><span style={s.okDot} />{savedMsg}</span>}
          {suggCount > 0 && (
            <button style={s.btnOutline} onClick={acceptAll} title="Fills uncategorized transactions only — never overwrites an existing category">
              Accept all suggestions ({suggCount})
            </button>
          )}
          <button
            style={{ ...s.btnSecondary, ...(loadingMore ? s.btnDisabled : {}) }}
            disabled={loadingMore}
            title={loadingMore ? 'Waiting for all transactions to load — duplicate detection needs the full list' : undefined}
            onClick={() => setShowImport(true)}
          >↑ Import CSV / PDF</button>
          {pending.heldCount > 0 && (
            <button
              style={{ ...s.btnPrimary, ...(saving ? s.btnDisabled : {}) }}
              disabled={saving}
              onClick={doSave}
              title="Categories that aren't in your chart of accounts wait for an explicit save"
            >
              {`Save (${pending.heldCount})`}
            </button>
          )}
          <OverflowMenu items={[
            { label: `Delete all ${txns.length.toLocaleString()} transactions…`, danger: true, disabled: saving || txns.length === 0, onClick: deleteAll },
          ]} />
        </div>
      </header>
      {(catActive || vendorFilter) && (
        <div style={s.linkBanner}>
          <span>
            Showing{' '}
            {catActive && <strong>{catFilter.join(', ')}</strong>}
            {catActive && vendorFilter && ' · '}
            {vendorFilter && (vendorFilter === 'none'
              ? <>transactions with <strong>no vendor</strong></>
              : <>vendor <strong>{vendorFilterLabel}</strong></>)}
            {dateActive && <> from <strong>{dateFrom || 'the start'}</strong> to <strong>{dateTo || 'now'}</strong></>}
            {' '}— linked from {vendorFilter ? 'the Vendors page' : 'a report'}.
          </span>
          <button onClick={() => { setCatFilter([]); setVendorFilter(''); setDateFrom(''); setDateTo('') }} style={s.linkClear}>Clear filter</button>
        </div>
      )}

      <div style={s.content}>
        {/* Stat tiles + progress */}
        <div style={s.stats}>
          {tiles.map(t => {
            const on = filter === t.key
            return (
              <button
                key={t.key} type="button" title={t.title} aria-pressed={on}
                style={{ ...s.stat, ...(on ? s.statOn : {}) }}
                onClick={() => setFilter(t.key)}
              >
                <span style={s.statLabel}>{t.label}</span>
                <span style={{ ...s.statNum, color: t.color }}>{t.n.toLocaleString()}</span>
              </button>
            )
          })}
          <div style={s.progress}>
            <span style={s.progressText}>
              <b style={{ color: INK }}>{total ? `${pctDone.toFixed(1)}% categorized` : 'No transactions in range'}</b>
              {scope && <> · {scope}</>}
              {anyFilter && <> · of {txns.length.toLocaleString()}</>}
              {loadingMore && <> · <span style={{ opacity: .6 }}>loading more…</span></>}
            </span>
            <div style={s.bar} role="progressbar" aria-valuenow={Math.round(pctDone)} aria-valuemin={0} aria-valuemax={100} aria-label="Share of transactions categorized">
              <i style={{ ...s.barSeg, width: `${pctDone}%`, background: T.success }} title="Categorized" />
              <i style={{ ...s.barSeg, width: `${pctSugg}%`, background: T.gold }} title="Uncategorized, suggestion available" />
              <i style={{ ...s.barSeg, width: `${pctOpen}%`, background: T.amber }} title="Uncategorized" />
            </div>
          </div>
        </div>

        {/* Toolbar */}
        <div style={s.toolbar}>
          <label style={s.search}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={searchRef}
              style={s.searchInput}
              placeholder="Search descriptions and categories"
              aria-label="Search descriptions and categories"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); e.currentTarget.blur() } }}
            />
            {search
              ? <button type="button" title="Clear search (Esc)" aria-label="Clear search" onClick={() => setSearch('')} style={s.searchClear}>×</button>
              : <kbd style={s.kbd} title="Press / to search">/</kbd>}
          </label>
          {acctOptions.length > 1 && (
            <div style={s.filterGroup}>
              <span style={s.filterLabel}>Account</span>
              <MultiSelect
                options={acctOptions}
                value={acctFilter}
                onChange={setAcctFilter}
                noun="accounts"
                style={{ maxWidth: 220, height: 28 }}
                title="Names come from the bank and credit-card accounts on Chart of Accounts"
              />
            </div>
          )}
          <div style={s.filterGroup}>
            <span style={s.filterLabel}>Dates</span>
            <input
              type="date" style={{ ...s.input, width: 132 }}
              value={dateFrom} max={dateTo || undefined}
              onChange={e => setDateFrom(e.target.value)}
              aria-label="From date"
            />
            <span style={s.dateSep}>–</span>
            <input
              type="date" style={{ ...s.input, width: 132 }}
              value={dateTo} min={dateFrom || undefined}
              onChange={e => setDateTo(e.target.value)}
              aria-label="To date"
            />
            {dateActive && (
              <button style={s.clearDates} onClick={() => { setDateFrom(''); setDateTo('') }} title="Clear date filter">✕</button>
            )}
          </div>
          <div style={{ flex: 1 }} />
          {!isFlat && (
            <label style={s.fuzzyLabel}>
              <input type="checkbox" checked={fuzzy} onChange={e => setFuzzy(e.target.checked)} />
              Group similar merchants
            </label>
          )}
          <div style={s.seg} role="group" aria-label="View">
            {[['flat', 'All transactions'], ['grouped', 'Grouped']].map(([val, label], i) => (
              <button
                key={val} type="button"
                style={{ ...s.segBtn, ...(i > 0 ? s.segDivider : {}), ...(view === val ? s.segOn : {}) }}
                onClick={() => setView(val)}
                aria-pressed={view === val}
                title={val === 'grouped'
                  ? 'One row per merchant, with transactions rolled up'
                  : 'One row per transaction, individually editable'}
              >{label}</button>
            ))}
          </div>
        </div>

        {/* Upload coverage — one line until opened */}
        {coverage && <CoveragePanel coverage={coverage} />}

        {/* Table */}
        {rowCount === 0 ? (
          <p style={s.empty}>No {noun}s match your filters.</p>
        ) : (
          <>
            <div style={s.tableWrap}>
              {isFlat ? (
              <table className="scs-tbl" style={s.table}>
                <colgroup>
                  <col style={{ width: 34 }} /><col style={{ width: 112 }} /><col />
                  <col style={{ width: 300 }} />{vendorsReady && <col style={{ width: 180 }} />}
                  <col style={{ width: 120 }} /><col style={{ width: 150 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ ...s.th, ...s.thCk }}>
                      <input type="checkbox" checked={allPageSel} onChange={toggleSelAll} aria-label="Select every row on this page" />
                    </th>
                    <SortTh col="date"        label="Date"        sort={sortFlat} onSort={onSortFlat} />
                    <SortTh col="description" label="Description" sort={sortFlat} onSort={onSortFlat} />
                    <th style={s.th}>Category</th>
                    {vendorsReady && <SortTh col="vendor" label="Vendor" sort={sortFlat} onSort={onSortFlat} />}
                    <SortTh col="amount"      label="Amount"      sort={sortFlat} onSort={onSortFlat} align="right" />
                    <SortTh col="account"     label="Account"     sort={sortFlat} onSort={onSortFlat} />
                  </tr>
                </thead>
                <tbody>
                  {pageTxns.map(t => {
                    const cat     = catOf(t)
                    const isDirty = t.id in assignments && (assignments[t.id] || '') !== (t.category || '')
                    const meta    = txnMeta.get(t.id)
                    const sugg    = meta?.sugg && !cat && !rejected.has(t.id) ? meta.sugg : ''
                    const isSel   = selected.has(t.id)
                    const amt     = Number(t.amount) || 0

                    return (
                      <tr key={t.id} className={isSel ? 'sel' : undefined}>
                        <td style={{ ...s.td, ...s.tdCk, ...(isDirty ? s.dirtyEdge : {}) }}>
                          <input
                            type="checkbox"
                            checked={isSel}
                            aria-label="Select transaction"
                            onChange={() => setSelected(p => {
                              const n = new Set(p); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n
                            })}
                          />
                        </td>
                        <td style={{ ...s.td, ...s.tdDate }}>{fmtDate(t.transaction_date)}</td>
                        <td style={{ ...s.td, ...s.tdDesc }} title={t.description}>
                          {separated.has(t.id) && <span style={s.sepTag}>separated</span>}
                          {t.description}
                        </td>
                        <td style={{ ...s.td, ...s.tdCat }}>
                          <CategoryChip
                            value={cat}
                            dirty={isDirty}
                            unknown={!!cat && !allCats.includes(cat)}
                            suggestion={sugg}
                            onAccept={() => acceptTxnSuggestion(t.id, sugg)}
                            onReject={() => rejectTxnSuggestion(t.id)}
                            transfer={transferSet.has(cat)}
                            onChange={val => assignTxn(t.id, val)}
                            categories={allCats}
                            groups={groupedCats}
                          />
                        </td>
                        {vendorsReady && (
                          <td style={{ ...s.td, ...s.tdCat }}>
                            <CategoryChip
                              value={vendorNameOf(t)}
                              emptyLabel="Set vendor…"
                              placeholder="— no vendor —"
                              title="Pick a vendor, or type a new name and press Enter to add one"
                              onChange={val => assignVendor([t.id], val)}
                              categories={vendorNames}
                            />
                          </td>
                        )}
                        <td style={{ ...s.td, ...s.tdAmt, ...(amt > 0 ? s.credit : {}) }}>{amt > 0 ? '+' : ''}{fmt2(amt)}</td>
                        <td style={{ ...s.td, ...s.tdAcct }} title={t.account || undefined}>{t.account || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              ) : (
              <table className="scs-tbl" style={s.table}>
                <colgroup>
                  <col style={{ width: 34 }} /><col style={{ width: 26 }} /><col />
                  <col style={{ width: 300 }} />{vendorsReady && <col style={{ width: 180 }} />}
                  <col style={{ width: 60 }} /><col style={{ width: 120 }} /><col style={{ width: 116 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ ...s.th, ...s.thCk }}>
                      <input type="checkbox" checked={allPageSel} onChange={toggleSelAll} aria-label="Select every group on this page" />
                    </th>
                    <th style={s.th} aria-label="Expand" />
                    <SortTh col="description" label="Merchant" sort={sortGrouped} onSort={onSortGrouped} />
                    <th style={s.th}>Category</th>
                    {vendorsReady && <th style={s.th}>Vendor</th>}
                    <SortTh col="count"       label="Txns"     sort={sortGrouped} onSort={onSortGrouped} align="right" />
                    <SortTh col="total"       label="Total"    sort={sortGrouped} onSort={onSortGrouped} align="right" />
                    <SortTh col="last"        label="Last"     sort={sortGrouped} onSort={onSortGrouped} title="Sort by most recent transaction" />
                  </tr>
                </thead>
                <tbody>
                  {pageGroups.map(g => {
                    const st      = statusByKey.get(g.key)
                    const mixed   = st.kind === 'mixed'
                    const cat     = mixed ? '' : ([...st.distinct][0] || '')
                    const isDirty = g.txns.some(t => t.id in assignments && (assignments[t.id] || '') !== (t.category || ''))
                    const sugg    = hasSugg(g) ? g.suggestedCat : ''
                    const isExp   = !!expanded[g.key]
                    const isSel   = selected.has(g.key)
                    const n       = g.txns.length
                    const vIds    = new Set(g.txns.map(t => t.vendor_id || ''))
                    const vMixed  = vIds.size > 1
                    const vName   = vMixed ? '' : (vendorById.get([...vIds][0])?.name || '')

                    return (
                      <Fragment key={g.key}>
                        <tr className={isSel ? 'sel' : undefined}>
                          <td style={{ ...s.td, ...s.tdCk, ...(isDirty ? s.dirtyEdge : {}) }}>
                            <input
                              type="checkbox"
                              checked={isSel}
                              aria-label="Select group"
                              onChange={() => setSelected(p => {
                                const nx = new Set(p); nx.has(g.key) ? nx.delete(g.key) : nx.add(g.key); return nx
                              })}
                            />
                          </td>
                          <td style={{ ...s.td, ...s.tdExp }}>
                            <button
                              type="button" style={s.expandBtn}
                              onClick={() => setExpanded(p => ({ ...p, [g.key]: !p[g.key] }))}
                              aria-expanded={isExp}
                              title={isExp ? 'Hide transactions' : `Show ${n} transaction${n !== 1 ? 's' : ''}`}
                            >{isExp ? '▾' : '▸'}</button>
                          </td>
                          <td style={{ ...s.td, ...s.tdDesc }}>
                            <div style={s.descRow}>
                              {g.isSeparated && <span style={s.sepTag}>separated</span>}
                              <span style={s.descText} title={g.displayDesc}>{g.displayDesc}</span>
                              {g.variants?.length > 0 && (
                                <span style={s.badge} title={g.variants.join('\n')}>+{g.variants.length} similar</span>
                              )}
                              {st.kind === 'partial' && (
                                <span style={s.warnBadge} title="Expand the row to see which transactions differ">
                                  {st.uncategorized} of {n} uncategorized
                                </span>
                              )}
                              {mixed && (
                                <span style={s.warnBadge} title={mixedTitle(g, catOf)}>
                                  {st.distinct.size} categories{st.uncategorized > 0 ? ` · ${st.uncategorized} uncategorized` : ''}
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ ...s.td, ...s.tdCat }}>
                            <CategoryChip
                              value={cat}
                              dirty={isDirty}
                              unknown={!!cat && !allCats.includes(cat)}
                              suggestion={sugg}
                              mixed={mixed}
                              mixedLabel={`Mixed — set to overwrite all ${n}`}
                              title={n > 1 ? `Applies to all ${n} transactions in this group` : undefined}
                              onAccept={() => acceptSuggestion(g)}
                              onReject={() => rejectSuggestion(g)}
                              transfer={transferSet.has(cat)}
                              onChange={val => assignGroup(g, val)}
                              categories={allCats}
                              groups={groupedCats}
                            />
                          </td>
                          {vendorsReady && (
                            <td style={{ ...s.td, ...s.tdCat }}>
                              <CategoryChip
                                value={vName}
                                mixed={vMixed}
                                mixedLabel={`Mixed — set to overwrite all ${n}`}
                                emptyLabel={n > 1 ? `Set vendor for ${n}…` : 'Set vendor…'}
                                placeholder="— no vendor —"
                                title={n > 1 ? `Applies to all ${n} transactions in this group. Type a new name and press Enter to add a vendor.` : 'Pick a vendor, or type a new name and press Enter to add one'}
                                onChange={val => assignVendor(g.txns.map(t => t.id), val)}
                                categories={vendorNames}
                              />
                            </td>
                          )}
                          <td style={{ ...s.td, ...s.tdNum }}>{n}</td>
                          <td style={{ ...s.td, ...s.tdAmt, ...(g.total > 0 ? s.credit : {}) }}>{g.total > 0 ? '+' : ''}{fmt2(g.total)}</td>
                          <td style={{ ...s.td, ...s.tdLast }}>{fmtDate(lastOf(g))}</td>
                        </tr>

                        {/* Expanded transaction list — same columns, indented and tinted */}
                        {isExp && (
                          <>
                            {g.variants?.length > 0 && (
                              <tr className="sub">
                                <td colSpan={vendorsReady ? 8 : 7} style={s.subHead} title={[g.displayDesc, ...g.variants].join('\n')}>
                                  <b>Grouped descriptions:</b> {[g.displayDesc, ...g.variants].join(' · ')}
                                </td>
                              </tr>
                            )}
                            {g.txns.slice(0, 25).map(t => {
                              const tc     = catOf(t)
                              const tDirty = t.id in assignments && (assignments[t.id] || '') !== (t.category || '')
                              const ta     = Number(t.amount) || 0
                              return (
                                <tr key={t.id} className="sub">
                                  <td style={s.subTd} />
                                  <td style={s.subTd} />
                                  <td style={{ ...s.subTd, ...s.subDesc }} title={t.description}>
                                    <span style={s.subDate}>{fmtDate(t.transaction_date)}</span>
                                    {t.description}
                                    <span style={s.subAcct}> · {t.account || 'no account'}</span>
                                  </td>
                                  <td style={{ ...s.subTd, color: tc ? T.charcoal : '#B45309', fontStyle: tc ? 'normal' : 'italic' }}>
                                    {tDirty && <span style={{ ...s.dirtyDot, marginRight: 6 }} title="Unsaved change" />}
                                    {tc || 'uncategorized'}
                                  </td>
                                  {vendorsReady && <td style={{ ...s.subTd, color: '#6B6560' }}>{vendorNameOf(t)}</td>}
                                  <td style={s.subTd} />
                                  <td style={{ ...s.subTd, ...s.tdAmt, ...(ta > 0 ? s.credit : {}) }}>{ta > 0 ? '+' : ''}{fmt2(ta)}</td>
                                  <td style={s.subTd}>
                                    {g.isSeparated ? (
                                      <button style={s.rejoinBtn} onClick={() => rejoinTxn(t.id)}>↩ Rejoin group</button>
                                    ) : n > 1 ? (
                                      <button style={s.separateBtn} onClick={() => separateTxn(t.id)} title="Move this transaction to its own group">Remove</button>
                                    ) : null}
                                  </td>
                                </tr>
                              )
                            })}
                            {n > 25 && (
                              <tr className="sub">
                                <td colSpan={vendorsReady ? 8 : 7} style={{ ...s.subTd, ...s.subDesc, color: '#8A857D' }}>…and {n - 25} more</td>
                              </tr>
                            )}
                          </>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
              )}
            </div>

            {/* Bulk bar — floats over the table instead of pushing it down */}
            {selected.size > 0 && (
              <div style={s.bulkBar} role="region" aria-label="Bulk actions">
                <b style={{ fontVariantNumeric: 'tabular-nums' }}>{selected.size} {noun}{selected.size !== 1 ? 's' : ''} selected</b>
                <span style={s.bulkDivider} />
                <input
                  style={s.bulkInput}
                  list="bulk-cats"
                  value={bulkCat}
                  onChange={e => setBulkCat(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') applyBulk() }}
                  placeholder="Category…"
                  aria-label="Category to apply to the selection"
                />
                <datalist id="bulk-cats">{allCats.map(c => <option key={c} value={c} />)}</datalist>
                <button
                  style={{ ...s.bulkBtnPrimary, ...(!bulkCat.trim() ? s.btnDisabled : {}) }}
                  disabled={!bulkCat.trim()}
                  onClick={applyBulk}
                >Apply</button>
                <button style={s.bulkBtn} onClick={clearBulkCats}>Clear categories</button>
                {transferCats.map(c => (
                  <button key={c} style={s.bulkBtn} onClick={() => applyBulkCat(c)} title={`Categorize the selection as a transfer to ${transferLabelOf(c)} — kept off the P&L`}>
                    ⇄ Transfer to {transferLabelOf(c)}
                  </button>
                ))}
                {vendorsReady && (
                  <>
                    <span style={s.bulkDivider} />
                    <input
                      style={{ ...s.bulkInput, width: 170 }}
                      list="bulk-vendors"
                      value={bulkVendor}
                      onChange={e => setBulkVendor(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') applyBulkVendor() }}
                      placeholder="Vendor…"
                      aria-label="Vendor to set on the selection"
                    />
                    <datalist id="bulk-vendors">{vendorNames.map(n => <option key={n} value={n} />)}</datalist>
                    <button style={{ ...s.bulkBtn, ...(!bulkVendor.trim() ? s.btnDisabled : {}) }} disabled={!bulkVendor.trim()} onClick={applyBulkVendor} title="A name that isn't on the vendor list yet is added to it">Set vendor</button>
                  </>
                )}
                <button style={{ ...s.bulkBtnDanger, ...(saving ? s.btnDisabled : {}) }} disabled={saving} onClick={deleteSelected}>Delete</button>
                <button style={s.bulkBtnLink} onClick={() => setSelected(new Set())}>Deselect</button>
              </div>
            )}

            <div style={s.footer}>
              <span>
                Showing <b>{rowFirst.toLocaleString()}–{rowLast.toLocaleString()}</b> of <b>{rowCount.toLocaleString()}</b> {noun}{rowCount !== 1 ? 's' : ''}
              </span>
              {pageCount > 1 && (
                <div style={s.pager}>
                  <button style={{ ...s.pageBtn, ...(page === 0 ? s.btnDisabled : {}) }} disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
                  <span>Page {page + 1} of {pageCount}</span>
                  <button style={{ ...s.pageBtn, ...(page >= pageCount - 1 ? s.btnDisabled : {}) }} disabled={page >= pageCount - 1} onClick={() => setPage(p => p + 1)}>Next ›</button>
                </div>
              )}
            </div>
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

// ─── Sortable column header ───────────────────────────────────────────────────

function SortTh({ col, label, sort, onSort, align, title }) {
  const active = sort.col === col
  return (
    <th
      style={{ ...s.th, ...(align === 'right' ? { textAlign: 'right' } : {}), cursor: 'pointer', userSelect: 'none' }}
      onClick={() => onSort(col)}
      title={title || `Sort by ${label.toLowerCase()}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      <span style={{ marginLeft: 4, fontSize: 8, opacity: active ? 0.9 : 0.3 }}>
        {active ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </th>
  )
}

// ─── Category chip ────────────────────────────────────────────────────────────

// The category cell at rest: one chip, one row height. It states the category,
// the lack of one, the suggestion, or that the group is mixed — every state
// that used to stack inside the cell. Clicking it swaps in the real picker,
// which hands control back through `onDone`, so typing, Enter, Escape and the
// blur rules all stay exactly as CategoryInput defines them.
function CategoryChip({
  value, dirty = false, unknown = false, suggestion = '', mixed = false, mixedLabel = 'Mixed',
  transfer = false, emptyLabel = 'Set category…', placeholder,
  title, onAccept, onReject, onChange, categories, groups = null,
}) {
  const [editing, setEditing] = useState(false)
  const btnRef     = useRef(null)
  const wasEditing = useRef(false)

  // When the picker closes, put focus back on the chip — but only if the
  // picker's removal dropped focus on <body>. A Tab that moved on to the next
  // control keeps its destination.
  useEffect(() => {
    if (editing) { wasEditing.current = true; return }
    if (!wasEditing.current) return
    wasEditing.current = false
    if (document.activeElement === document.body) btnRef.current?.focus()
  }, [editing])

  if (editing) return (
    <CategoryInput
      value={value}
      onChange={onChange}
      categories={categories}
      groups={groups}
      placeholder={mixed ? '— mixed —' : placeholder}
      autoFocus
      onDone={() => setEditing(false)}
    />
  )

  if (suggestion) return (
    <span style={s.chipSugg} title={title}>
      <button type="button" ref={btnRef} className="scs-chip" style={s.chipSuggMain} onClick={() => setEditing(true)} title="Choose a different category">
        <span style={s.chipSuggKey}>Suggested</span>
        <span style={s.chipText}>{suggestion}</span>
      </button>
      <button type="button" style={s.acceptBtn} onClick={onAccept} title="Accept — fills uncategorized transactions only">✓</button>
      <button type="button" style={s.rejectBtn} onClick={onReject} title="Dismiss suggestion">✕</button>
    </span>
  )

  const variant = mixed ? s.chipMixed : !value ? s.chipEmpty : unknown ? s.chipUnknown : transfer ? s.chipTransfer : {}
  const ring    = dirty && !mixed ? s.chipDirty : {}
  const label   = mixed ? mixedLabel : (value || emptyLabel)
  const hint    = unknown ? 'Not in your chart of accounts — waits for Save'
    : dirty ? 'Unsaved change — writes in a moment'
    : transfer && value ? 'Transfer between your own accounts — kept off the P&L'
    : title
  return (
    <button type="button" ref={btnRef} className="scs-chip" style={{ ...s.chip, ...variant, ...ring }} onClick={() => setEditing(true)} title={hint}>
      {dirty && !mixed && <span style={s.dirtyDot} />}
      {transfer && value && !mixed && <span style={s.transferMark} aria-label="Transfer">⇄</span>}
      {unknown && <span style={s.unkMark}>!</span>}
      <span style={s.chipText}>{label}</span>
      <span style={s.chipCaret}>▼</span>
    </button>
  )
}

// ─── Overflow menu ────────────────────────────────────────────────────────────

// Destructive, rarely used actions live behind "···" rather than beside Import.
function OverflowMenu({ items }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = e => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const onKey  = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button" style={s.btnIcon} title="More actions"
        aria-haspopup="menu" aria-expanded={open} aria-label="More actions"
        onClick={() => setOpen(o => !o)}
      >···</button>
      {open && (
        <div role="menu" style={s.menu}>
          {items.map(it => (
            <button
              key={it.label} type="button" role="menuitem"
              disabled={it.disabled}
              style={{ ...s.menuItem, ...(it.danger ? s.menuDanger : {}), ...(it.disabled ? s.btnDisabled : {}) }}
              onClick={() => { setOpen(false); it.onClick() }}
            >{it.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Coverage Panel ───────────────────────────────────────────────────────────

// One line at rest — the range, the account count, and any gaps — with the
// month-by-month matrix behind a disclosure. A gap is a month with no rows
// between an account's first and last month; months outside that span are
// simply before the account existed or after its last upload.
function CoveragePanel({ coverage }) {
  const { accounts, months, map } = coverage
  const gaps = []
  accounts.forEach(acct => {
    const have = months.filter(ym => map[acct]?.[ym])
    if (have.length < 2) return
    const lo = have[0], hi = have[have.length - 1]
    months.forEach(ym => { if (ym > lo && ym < hi && !map[acct]?.[ym]) gaps.push({ acct, ym }) })
  })
  const gapSet = new Set(gaps.map(g => `${g.acct}|${g.ym}`))
  const range  = months.length ? `${fmtYm(months[0])} – ${fmtYm(months[months.length - 1])}` : ''
  const gapLabel = gaps.slice(0, 2).map(g => `${g.acct}, ${fmtYm(g.ym)}`).join('; ') + (gaps.length > 2 ? '; …' : '')

  return (
    <details style={s.cov}>
      <summary style={s.covSummary}>
        <span style={s.covTitle}>Upload coverage</span>
        <span>{accounts.length} account{accounts.length !== 1 ? 's' : ''}</span>
        <span style={s.covSep}>·</span>
        <span>{range}</span>
        <span style={s.covSep}>·</span>
        {gaps.length > 0
          ? <span style={s.gapPill} title={gaps.map(g => `${g.acct} — ${fmtYm(g.ym)}`).join('\n')}>{gaps.length} gap{gaps.length !== 1 ? 's' : ''} · {gapLabel}</span>
          : <span style={s.okPill}>no gaps</span>}
      </summary>
      <div style={{ padding: '4px 12px 12px', overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ padding: '4px 10px 4px 0', textAlign: 'left', color: T.charcoal, fontWeight: 600, whiteSpace: 'nowrap', minWidth: 150 }}>Account</th>
              {months.map(ym => (
                <th key={ym} style={{ padding: '4px 6px', textAlign: 'center', color: T.charcoal, fontWeight: 500, whiteSpace: 'nowrap' }}>{fmtYm(ym)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accounts.map(acct => (
              <tr key={acct}>
                <td style={{ padding: '3px 10px 3px 0', color: T.charcoal, whiteSpace: 'nowrap', fontWeight: 500 }}>{acct}</td>
                {months.map(ym => {
                  const count = map[acct]?.[ym] ?? 0
                  const gap   = gapSet.has(`${acct}|${ym}`)
                  const cell  = count > 0 ? { background: '#D1E8D4', color: '#1A5C28' }
                    : gap ? { background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D' }
                    : { background: T.page, color: '#C0BDB7' }
                  return (
                    <td key={ym} style={{ padding: '3px 6px', textAlign: 'center' }}>
                      <span style={{ ...s.covCell, ...cell }} title={gap ? 'No rows for this month — was a statement skipped?' : undefined}>{count > 0 ? count : '—'}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const INK = '#1F2933'

// Hover, selection and disclosure states can't be inline styles.
const CSS = `
@keyframes spin { to { transform: rotate(360deg); } }
.scs-txn .scs-tbl tbody tr:hover > td { background: #F8F7F3; }
.scs-txn .scs-tbl tbody tr.sel > td { background: #EEF3F8; }
.scs-txn .scs-tbl tbody tr.sel:hover > td { background: #E6EDF5; }
.scs-txn .scs-tbl tbody tr.sub > td { background: #F3F6F9; }
.scs-txn .scs-tbl tbody tr.sub:hover > td { background: #EDF2F7; }
.scs-txn details > summary { list-style: none; }
.scs-txn details > summary::-webkit-details-marker { display: none; }
.scs-txn details > summary::before { content: '▸'; font-size: 9px; color: #8A857D; width: 10px; display: inline-block; }
.scs-txn details[open] > summary::before { content: '▾'; }
.scs-txn .scs-chip:hover { box-shadow: 0 0 0 2px #E6EDF5; }
.scs-txn button:focus-visible, .scs-txn input:focus-visible, .scs-txn summary:focus-visible { outline: 2px solid ${T.steel}; outline-offset: 1px; }
`

const s = {
  wrap:        { width: '100%', background: T.page, minHeight: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' },
  pageHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', padding: '12px 28px', background: T.card, borderBottom: `1px solid ${T.border}` },
  headerRight: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  h2:          { fontSize: 14, fontWeight: 600, color: T.navy, margin: 0 },
  savedMsg:    { fontSize: 11, color: T.success, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 },
  okDot:       { width: 7, height: 7, borderRadius: '50%', background: T.success, display: 'inline-block' },
  savingMsg:   { fontSize: 11, color: T.charcoal, opacity: .7 },
  errorMsg:    { fontSize: 11, color: T.danger, fontWeight: 500 },
  retryBtn:    { padding: '2px 8px', background: '#fff', color: T.danger, border: '1px solid #F5C2C2', borderRadius: 4, fontSize: 10.5, cursor: 'pointer' },
  center:      { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300, background: T.page, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  spinner:     { width: 28, height: 28, border: `2px solid ${T.border}`, borderTopColor: T.navy, borderRadius: '50%', animation: 'spin .7s linear infinite' },
  errorBox:    { background: '#FDE8E8', border: '1px solid #F5C2C2', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#991B1B', marginBottom: 14 },
  linkBanner:  { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 28px', background: '#EBF1F7', borderBottom: `1px solid ${T.border}`, fontSize: 11.5, color: T.navy },
  linkClear:   { padding: '2px 10px', fontSize: 11, borderRadius: 5, cursor: 'pointer', border: `1px solid ${T.border}`, background: '#fff', color: T.charcoal },
  content:     { padding: '16px 28px 24px' },

  // stat tiles + progress
  stats:       { display: 'flex', alignItems: 'stretch', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
  // Longhand border properties, not the shorthand: the variants below override
  // borderColor/borderStyle, and React warns when a longhand is dropped on
  // re-render while a shorthand for the same property is still set.
  stat:        { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 110, padding: '8px 12px', borderWidth: 1, borderStyle: 'solid', borderColor: T.border, background: '#fff', borderRadius: 6, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' },
  statOn:      { borderColor: T.navy, boxShadow: `inset 0 0 0 1px ${T.navy}`, background: '#EBF1F7' },
  statLabel:   { fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: T.gold, whiteSpace: 'nowrap' },
  statNum:     { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 },
  progress:    { marginLeft: 'auto', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, minWidth: 240, maxWidth: 420, fontSize: 10.5, color: T.charcoal },
  progressText:{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  bar:         { height: 6, borderRadius: 3, background: '#E6E3DC', overflow: 'hidden', display: 'flex' },
  barSeg:      { display: 'block', height: '100%' },

  // toolbar
  toolbar:     { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' },
  search:      { display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${T.border}`, borderRadius: 5, background: '#fff', padding: '0 8px', width: 280, height: 28, color: T.charcoal },
  searchInput: { border: 0, outline: 'none', flex: 1, minWidth: 0, fontSize: 11, fontFamily: 'inherit', background: 'transparent', color: INK },
  searchClear: { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 15, lineHeight: 1, padding: '0 2px' },
  kbd:         { fontSize: 9.5, fontFamily: 'inherit', border: `1px solid ${T.border}`, borderRadius: 3, padding: '0 4px', color: '#8A857D', background: T.page, lineHeight: '14px' },
  filterGroup: { display: 'flex', alignItems: 'center', gap: 5 },
  filterLabel: { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em' },
  input:       { padding: '5px 9px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, color: T.charcoal, background: '#fff', outline: 'none', height: 28 },
  dateSep:     { color: T.charcoal, opacity: .5 },
  clearDates:  { padding: '3px 7px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 4, fontSize: 10, cursor: 'pointer', lineHeight: 1.3 },
  fuzzyLabel:  { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.charcoal, cursor: 'pointer', userSelect: 'none' },
  seg:         { display: 'inline-flex', border: `1px solid ${T.border}`, borderRadius: 6, overflow: 'hidden', background: '#fff' },
  segBtn:      { padding: '0 12px', height: 26, border: 0, background: 'transparent', fontSize: 11, color: T.charcoal, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  segDivider:  { borderLeft: `1px solid ${T.border}` },
  segOn:       { background: T.navy, color: '#fff', fontWeight: 500 },

  // coverage
  cov:         { border: `1px solid ${T.border}`, borderRadius: 6, background: T.card, fontSize: 11, marginBottom: 12 },
  covSummary:  { padding: '7px 12px', cursor: 'pointer', color: T.charcoal, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  covTitle:    { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em' },
  covSep:      { color: T.border },
  gapPill:     { display: 'inline-flex', alignItems: 'center', height: 16, padding: '0 6px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: '#FEF3C7', color: '#92400E' },
  okPill:      { display: 'inline-flex', alignItems: 'center', height: 16, padding: '0 6px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: '#E6F0E9', color: '#1A5C28' },
  covCell:     { display: 'inline-block', borderRadius: 3, padding: '1px 7px', fontWeight: 500, minWidth: 32, textAlign: 'center', fontVariantNumeric: 'tabular-nums' },

  // table
  tableWrap:   { border: `1px solid ${T.border}`, borderRadius: 6, background: '#fff', overflowX: 'auto' },
  table:       { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 1040 },
  th:          { background: T.page, padding: '7px 10px', textAlign: 'left', fontWeight: 700, borderBottom: `2px solid ${T.border}`, fontSize: 9.5, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' },
  thCk:        { textAlign: 'center', padding: 0 },
  td:          { padding: '0 10px', height: 38, borderBottom: '1px solid #EEECE6', verticalAlign: 'middle', fontSize: 12, color: T.charcoal, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  tdCk:        { textAlign: 'center', padding: 0 },
  tdExp:       { padding: '0 0 0 6px' },
  tdDate:      { fontVariantNumeric: 'tabular-nums' },
  tdDesc:      { color: INK, fontSize: 12.5 },
  descRow:     { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  descText:    { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  tdCat:       { overflow: 'visible' },
  tdNum:       { textAlign: 'right', color: '#8A857D', fontVariantNumeric: 'tabular-nums' },
  tdAmt:       { textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: INK },
  credit:      { color: T.success },
  tdAcct:      { color: '#6B6560', fontSize: 11 },
  tdLast:      { color: '#6B6560', fontVariantNumeric: 'tabular-nums' },
  dirtyEdge:   { boxShadow: `inset 3px 0 0 ${T.navy}` },
  dirtyDot:    { flexShrink: 0, width: 6, height: 6, borderRadius: '50%', background: T.navy, display: 'inline-block' },
  sepTag:      { flexShrink: 0, fontSize: 9.5, color: '#8A857D', background: T.page, border: `1px solid ${T.border}`, borderRadius: 3, padding: '1px 5px', marginRight: 7, verticalAlign: 'middle' },
  badge:       { flexShrink: 0, fontSize: 10, fontWeight: 500, color: '#4A7BA7', background: '#E8EFF5', borderRadius: 3, padding: '1px 6px', whiteSpace: 'nowrap', cursor: 'default' },
  warnBadge:   { flexShrink: 0, fontSize: 10, fontWeight: 500, color: '#92400E', background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 3, padding: '1px 6px', whiteSpace: 'nowrap', cursor: 'default' },
  expandBtn:   { background: 'none', border: 'none', cursor: 'pointer', color: '#8A857D', fontSize: 11, padding: '2px 4px', lineHeight: 1 },
  subTd:       { padding: '0 10px', height: 30, borderBottom: '1px solid #E3E9EF', fontSize: 11.5, color: T.charcoal, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'middle' },
  subDesc:     { paddingLeft: 44 },
  subDate:     { color: '#6B6560', fontVariantNumeric: 'tabular-nums', marginRight: 8 },
  subAcct:     { color: '#8A857D' },
  subHead:     { padding: '0 10px 0 44px', height: 24, borderBottom: '1px solid #E3E9EF', fontSize: 10.5, color: T.steel, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  separateBtn: { padding: '2px 8px', background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D', borderRadius: 3, fontSize: 10, fontWeight: 500, cursor: 'pointer' },
  rejoinBtn:   { padding: '2px 8px', background: '#EBF1F7', color: T.navy, border: '1px solid #B8CDE0', borderRadius: 3, fontSize: 10, fontWeight: 500, cursor: 'pointer' },

  // category chips
  chip:        { display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, maxWidth: '100%', padding: '0 9px', borderRadius: 5, borderWidth: 1, borderStyle: 'solid', borderColor: T.border, background: '#fff', fontSize: 11.5, color: INK, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', whiteSpace: 'nowrap', verticalAlign: 'middle' },
  chipText:    { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
  chipCaret:   { fontSize: 8, opacity: .4, flexShrink: 0 },
  chipEmpty:   { borderStyle: 'dashed', borderColor: '#F0D9A6', background: '#FFFBF1', color: '#B45309' },
  chipDirty:   { borderColor: T.navy, boxShadow: '0 0 0 2px #C9DAEA' },
  chipUnknown: { borderColor: '#E4B95A', background: '#FFF6DC', color: '#7A5A0E' },
  chipMixed:   { borderStyle: 'dashed', color: '#6B6560' },
  chipTransfer:{ borderColor: '#B8CDE0', background: '#EBF1F7', color: T.navy },
  transferMark:{ fontSize: 12, lineHeight: 1, color: T.steel, flexShrink: 0 },
  unkMark:     { fontWeight: 800, fontSize: 10, color: T.amber, flexShrink: 0 },
  chipSugg:    { display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, maxWidth: '100%', padding: '0 4px 0 0', borderRadius: 5, border: `1px dashed ${T.gold}`, background: '#F6F1E3', whiteSpace: 'nowrap', verticalAlign: 'middle' },
  chipSuggMain:{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, height: 22, padding: '0 6px 0 9px', border: 0, borderRadius: 4, background: 'transparent', color: '#5C4D17', fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  chipSuggKey: { fontSize: 9, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: T.gold, flexShrink: 0 },
  acceptBtn:   { flexShrink: 0, width: 20, height: 18, padding: 0, background: '#E6F0E9', color: '#047857', border: '1px solid #B8D4BE', borderRadius: 3, fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: 1 },
  rejectBtn:   { flexShrink: 0, width: 20, height: 18, padding: 0, background: '#FDE8E8', color: T.danger, border: '1px solid #F5C2C2', borderRadius: 3, fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: 1 },

  // bulk bar
  bulkBar:     { position: 'sticky', bottom: 12, zIndex: 20, marginTop: 12, display: 'flex', width: 'fit-content', maxWidth: '100%', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: T.navy, color: '#fff', borderRadius: 8, padding: '8px 8px 8px 14px', boxShadow: '0 10px 26px rgba(27,58,92,.35)', fontSize: 11.5 },
  bulkDivider: { width: 1, height: 18, background: 'rgba(255,255,255,.2)', margin: '0 4px' },
  bulkInput:   { padding: '4px 9px', border: '1px solid rgba(255,255,255,.3)', borderRadius: 5, fontSize: 11, color: INK, background: '#fff', outline: 'none', width: 220 },
  bulkBtn:     { padding: '4px 10px', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer', border: '1px solid rgba(255,255,255,.28)', background: 'rgba(255,255,255,.08)', color: '#fff' },
  bulkBtnPrimary: { padding: '4px 12px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid #fff', background: '#fff', color: T.navy },
  bulkBtnDanger:  { padding: '4px 10px', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer', border: '1px solid rgba(255,180,180,.45)', background: 'transparent', color: '#FFB4B4' },
  bulkBtnLink:    { padding: '4px 8px', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer', border: '1px solid transparent', background: 'transparent', color: 'rgba(255,255,255,.75)', textDecoration: 'underline', textUnderlineOffset: 2 },

  // footer
  footer:      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '12px 2px 0', fontSize: 11, color: '#6B6560' },
  pager:       { display: 'inline-flex', alignItems: 'center', gap: 10 },
  pageBtn:     { padding: '4px 10px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 4, fontSize: 11, cursor: 'pointer' },
  empty:       { color: '#9ca3af', textAlign: 'center', padding: '48px 0', fontSize: 14 },

  // overflow menu
  btnIcon:     { padding: '6px 9px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, fontWeight: 700, letterSpacing: 1, cursor: 'pointer', lineHeight: 1.3 },
  menu:        { position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 500, minWidth: 220, background: '#fff', border: `1px solid ${T.border}`, borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.14)', padding: 4 },
  menuItem:    { display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 0, borderRadius: 4, fontSize: 11.5, color: T.charcoal, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  menuDanger:  { color: T.danger },

  // buttons
  btnPrimary:  { padding: '6px 16px', background: T.navy, color: '#fff', border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  btnSecondary:{ padding: '6px 14px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  btnOutline:  { padding: '6px 14px', background: 'transparent', color: T.gold, border: `1px solid ${T.gold}`, borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
}
