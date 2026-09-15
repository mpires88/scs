import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { supabase, fetchAll, isMissingSchemaError } from '../lib/supabase'
import { fetchVendors, addVendor, renameVendor, setVendorNotes, deleteVendor } from '../lib/vendors'
import { fetchAccounts } from '../lib/chartOfAccounts'
import { isBSSection } from '../lib/sections'
import { ADJUSTMENTS_ACCOUNT, stripAcctNum } from '../lib/insights'
import { vendorSpend, vendorYears } from '../lib/vendorSpend'
import { buildTxnLink } from '../lib/txnLink'
import { T, fmt2, MON } from '../lib/theme'

const INK = '#1F2933'
const ALL = 'all'

const fmtDate = iso => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${MON[+m] || ''} ${+d}, ${y}`
}

// Who SCS buys from, and how much. The list is managed here (add, rename,
// notes, remove); the assigning happens on the Transactions page, where each
// row and each merchant group has a Vendor chip.
export default function Vendors({ clientId }) {
  const [vendors,      setVendors]      = useState([])
  const [txns,         setTxns]         = useState([])
  const [sectionOf,    setSectionOf]    = useState(() => new Map())
  const [loading,      setLoading]      = useState(true)
  const [tableMissing, setTableMissing] = useState(false)
  const [loadError,    setLoadError]    = useState(null)
  const [year,         setYear]         = useState(undefined) // undefined = latest year, 'all' = all time
  const [newName,      setNewName]      = useState('')
  const [saving,       setSaving]       = useState(false)
  const [msg,          setMsg]          = useState('')
  const [editId,       setEditId]       = useState(null)
  const [editName,     setEditName]     = useState('')
  const [noteDrafts,   setNoteDrafts]   = useState({})

  // Loads once per client. State lands in promise callbacks (never in the
  // effect body itself), and a client switch mid-flight is ignored. Mutations
  // below update local state rather than reloading.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetchVendors(clientId),
      fetchAll(() => supabase.from('bank_transactions')
        .select('id, transaction_date, amount, category, vendor_id, account')
        .eq('client_id', clientId).order('transaction_date').order('id')),
      fetchAccounts(clientId).catch(() => ({ accounts: [] })),
    ]).then(([vs, rows, coa]) => {
      if (cancelled) return
      setVendors(vs)
      setTxns(rows)
      setSectionOf(new Map((coa.accounts ?? []).map(a => [a.name, a.pl_section])))
      setTableMissing(false); setLoadError(null)
      setLoading(false)
    }).catch(e => {
      if (cancelled) return
      if (isMissingSchemaError(e)) { setTableMissing(true); setLoadError(null) }
      else { setTableMissing(false); setLoadError(e.message || String(e)) }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [clientId])

  const years = useMemo(() => vendorYears(txns), [txns])
  const shown = year === undefined ? (years[0] ?? ALL) : year
  const range = shown === ALL ? {} : { from: `${shown}-01-01`, to: `${shown}-12-31` }

  // Unassigned rows that are really purchases: money out, not a journal entry,
  // and not a balance-sheet movement (a transfer, a card payment, an owner
  // draw) — with Inventory as the exception, since stock is bought from someone.
  const isSpendRow = useCallback(t => {
    if ((Number(t.amount) || 0) >= 0) return false
    if ((t.account || '').trim() === ADJUSTMENTS_ACCOUNT) return false
    const cat = (t.category || '').trim()
    if (!cat) return true
    const sec = sectionOf.get(cat)
    if (sec && isBSSection(sec) && stripAcctNum(cat) !== 'Inventory') return false
    return true
  }, [sectionOf])

  const report = useMemo(
    () => vendorSpend(txns, vendors, { year: shown === ALL ? null : shown, isSpendRow }),
    [txns, vendors, shown, isSpendRow]
  )
  const activeCount = report.rows.filter(r => r.count > 0).length
  const txnCountOf = useMemo(() => {
    const m = new Map()
    txns.forEach(t => { if (t.vendor_id) m.set(t.vendor_id, (m.get(t.vendor_id) || 0) + 1) })
    return m
  }, [txns])

  // ── Mutations ──────────────────────────────────────────────────────────────

  const add = async e => {
    e?.preventDefault()
    const name = newName.trim()
    if (!name) return
    setSaving(true); setMsg('')
    try {
      const v = await addVendor(clientId, name)
      setVendors(prev => prev.some(x => x.id === v.id) ? prev : [...prev, v].sort((a, b) => a.name.localeCompare(b.name)))
      setNewName('')
      setMsg(`Added ${v.name}`)
    } catch (err) { alert('Could not add vendor: ' + err.message) }
    setSaving(false)
  }

  const startRename = v => { setEditId(v.id); setEditName(v.name) }
  const commitRename = async () => {
    const id = editId, name = editName.trim()
    setEditId(null)
    const cur = vendors.find(v => v.id === id)
    if (!cur || !name || name === cur.name) return
    try {
      await renameVendor(clientId, id, name)
      setVendors(prev => prev.map(v => v.id === id ? { ...v, name } : v).sort((a, b) => a.name.localeCompare(b.name)))
      setMsg(`Renamed to ${name}`)
    } catch (err) { alert('Could not rename: ' + err.message) }
  }

  const commitNotes = async id => {
    const draft = noteDrafts[id]
    if (draft === undefined) return
    setNoteDrafts(p => { const n = { ...p }; delete n[id]; return n })
    const cur = vendors.find(v => v.id === id)
    if (!cur || (draft.trim() || null) === (cur.notes || null)) return
    try {
      await setVendorNotes(clientId, id, draft)
      setVendors(prev => prev.map(v => v.id === id ? { ...v, notes: draft.trim() || null } : v))
    } catch (err) { alert('Could not save notes: ' + err.message) }
  }

  const remove = async v => {
    const n = txnCountOf.get(v.id) || 0
    const what = n ? `\n\n${n} transaction${n !== 1 ? 's' : ''} will lose this vendor (the transactions themselves stay).` : ''
    if (!confirm(`Remove ${v.name} from the vendor list?${what}`)) return
    try {
      await deleteVendor(clientId, v.id)
      setVendors(prev => prev.filter(x => x.id !== v.id))
      setTxns(prev => prev.map(t => t.vendor_id === v.id ? { ...t, vendor_id: null } : t))
      setMsg(`Removed ${v.name}`)
    } catch (err) { alert('Could not remove: ' + err.message) }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={v.center}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={v.spinner} />
    </div>
  )

  if (tableMissing) return (
    <div style={v.wrap}>
      <header style={v.pageHeader}><div><h2 style={v.h2}>Vendors</h2></div></header>
      <div style={v.content}>
        <div style={v.notice}>
          The vendors table doesn&apos;t exist yet. Run <code>supabase/migration.sql</code> (section 7) in the Supabase SQL editor, then reload.
        </div>
      </div>
    </div>
  )

  if (loadError) return (
    <div style={v.wrap}>
      <header style={v.pageHeader}><div><h2 style={v.h2}>Vendors</h2></div></header>
      <div style={v.content}><div style={v.errorBox}>Failed to load: {loadError}</div></div>
    </div>
  )

  const periodLabel = shown === ALL ? 'all time' : String(shown)
  const unassignedLink = buildTxnLink({ vendor: 'none', ...range })

  return (
    <div style={v.wrap} className="scs-vendors">
      <style>{CSS}</style>
      <header style={v.pageHeader}>
        <div>
          <h2 style={v.h2}>Vendors</h2>
          <p style={v.sub}>
            {vendors.length} vendor{vendors.length !== 1 ? 's' : ''}
            {' · '}{activeCount} with activity {periodLabel === 'all time' ? 'overall' : `in ${periodLabel}`}
          </p>
        </div>
        <div style={v.headerRight}>
          {msg && <span style={v.savedMsg}><span style={v.okDot} />{msg}</span>}
          <div style={v.seg} role="group" aria-label="Period">
            {[ALL, ...years].map((y, i) => (
              <button
                key={y} type="button" aria-pressed={shown === y}
                style={{ ...v.segBtn, ...(i > 0 ? v.segDivider : {}), ...(shown === y ? v.segOn : {}) }}
                onClick={() => setYear(y)}
              >{y === ALL ? 'All time' : y}</button>
            ))}
          </div>
        </div>
      </header>

      <div style={v.content}>
        {/* Summary */}
        <div style={v.stats}>
          <div style={v.stat}>
            <span style={v.statLabel}>Spend with vendors</span>
            <span style={v.statNum}>{fmt2(report.total)}</span>
            <span style={v.statHint}>{periodLabel}</span>
          </div>
          <div style={v.stat}>
            <span style={v.statLabel}>Vendors with activity</span>
            <span style={v.statNum}>{activeCount}</span>
            <span style={v.statHint}>of {vendors.length} on the list</span>
          </div>
          <Link href={unassignedLink} style={{ ...v.stat, ...v.statLink, textDecoration: 'none' }} title="Open these transactions and set a vendor on each">
            <span style={v.statLabel}>Spend without a vendor</span>
            <span style={{ ...v.statNum, color: report.unassigned.count ? T.amber : INK }}>{fmt2(report.unassigned.spend)}</span>
            <span style={v.statHint}>{report.unassigned.count.toLocaleString()} transaction{report.unassigned.count !== 1 ? 's' : ''} · assign them →</span>
          </Link>
        </div>

        {/* Add */}
        <form onSubmit={add} style={v.addRow}>
          <input
            id="vendor-new-name"
            style={v.input}
            placeholder="New vendor name… (e.g. Costco, Uline, Panini)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            aria-label="New vendor name"
          />
          <button type="submit" style={{ ...v.btnPrimary, ...(!newName.trim() || saving ? v.btnDisabled : {}) }} disabled={!newName.trim() || saving}>Add vendor</button>
          <span style={v.addHint}>You can also type a new vendor straight into a row on the Transactions page.</span>
        </form>

        {/* Table */}
        {report.rows.length === 0 ? (
          <p style={v.empty}>No vendors yet. Add one above, or set a vendor on any transaction.</p>
        ) : (
          <div style={v.tableWrap}>
            <table style={v.table} className="scs-vtbl">
              <colgroup>
                <col /><col style={{ width: 90 }} /><col style={{ width: 120 }} /><col style={{ width: 70 }} />
                <col style={{ width: 110 }} /><col style={{ width: 110 }} /><col style={{ width: 200 }} /><col style={{ width: 220 }} /><col style={{ width: 120 }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={v.th}>Vendor</th>
                  <th style={{ ...v.th, textAlign: 'right' }}>Txns</th>
                  <th style={{ ...v.th, textAlign: 'right' }}>Spend</th>
                  <th style={{ ...v.th, textAlign: 'right' }}>Share</th>
                  <th style={v.th}>First</th>
                  <th style={v.th}>Last</th>
                  <th style={v.th}>Top category</th>
                  <th style={v.th}>Notes</th>
                  <th style={v.th} />
                </tr>
              </thead>
              <tbody>
                {report.rows.map(r => {
                  const share = report.total > 0 ? (r.spend / report.total) * 100 : 0
                  const idle = r.count === 0
                  const draft = noteDrafts[r.id]
                  return (
                    <tr key={r.id} style={idle ? { opacity: .6 } : undefined}>
                      <td style={{ ...v.td, ...v.tdName }}>
                        {editId === r.id ? (
                          <input
                            autoFocus
                            style={{ ...v.input, width: '100%', height: 26, fontSize: 12 }}
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditId(null) }}
                            aria-label="Vendor name"
                          />
                        ) : (
                          <Link href={buildTxnLink({ vendor: r.id, ...range })} style={v.nameLink} title="Show this vendor's transactions">
                            {r.name}
                          </Link>
                        )}
                      </td>
                      <td style={{ ...v.td, ...v.num }}>{r.count.toLocaleString()}</td>
                      <td style={{ ...v.td, ...v.num, fontWeight: 600, color: INK }}>{fmt2(r.spend)}</td>
                      <td style={{ ...v.td, ...v.num }}>
                        <span style={v.shareWrap}>
                          <span style={v.shareBar}><i style={{ width: `${Math.min(100, share)}%` }} /></span>
                          {share ? `${share.toFixed(0)}%` : '—'}
                        </span>
                      </td>
                      <td style={{ ...v.td, ...v.muted }}>{fmtDate(r.first)}</td>
                      <td style={{ ...v.td, ...v.muted }}>{fmtDate(r.last)}</td>
                      <td style={{ ...v.td, ...v.muted }} title={r.topCategory || undefined}>{r.topCategory || '—'}</td>
                      <td style={v.td}>
                        <input
                          style={v.noteInput}
                          placeholder="notes…"
                          value={draft ?? (r.notes || '')}
                          onChange={e => setNoteDrafts(p => ({ ...p, [r.id]: e.target.value }))}
                          onBlur={() => commitNotes(r.id)}
                          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                          aria-label={`Notes for ${r.name}`}
                        />
                      </td>
                      <td style={{ ...v.td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <button type="button" style={v.lnk} onClick={() => startRename(vendors.find(x => x.id === r.id))}>Rename</button>
                        <button type="button" style={{ ...v.lnk, color: T.danger, marginLeft: 10 }} onClick={() => remove(vendors.find(x => x.id === r.id))}>Remove</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...v.td, ...v.tf }}>Total</td>
                  <td style={{ ...v.td, ...v.tf, ...v.num }}>{report.rows.reduce((s, r) => s + r.count, 0).toLocaleString()}</td>
                  <td style={{ ...v.td, ...v.tf, ...v.num }}>{fmt2(report.total)}</td>
                  <td colSpan={6} style={{ ...v.td, ...v.tf }} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

const CSS = `
.scs-vendors .scs-vtbl tbody tr:hover > td { background: #F8F7F3; }
.scs-vendors button:focus-visible, .scs-vendors input:focus-visible, .scs-vendors a:focus-visible { outline: 2px solid ${T.steel}; outline-offset: 1px; }
.scs-vendors a.stat-link:hover { border-color: ${T.navy}; }
`

const v = {
  wrap:        { width: '100%', background: T.page, minHeight: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' },
  center:      { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300, background: T.page },
  spinner:     { width: 28, height: 28, border: `2px solid ${T.border}`, borderTopColor: T.navy, borderRadius: '50%', animation: 'spin .7s linear infinite' },
  pageHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', padding: '12px 28px', background: T.card, borderBottom: `1px solid ${T.border}` },
  headerRight: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  h2:          { fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 2px' },
  sub:         { fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 },
  savedMsg:    { fontSize: 11, color: T.success, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 },
  okDot:       { width: 7, height: 7, borderRadius: '50%', background: T.success, display: 'inline-block' },
  content:     { padding: '16px 28px 24px' },
  notice:      { background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: '#92400E' },
  errorBox:    { background: '#FDE8E8', border: '1px solid #F5C2C2', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#991B1B' },
  seg:         { display: 'inline-flex', border: `1px solid ${T.border}`, borderRadius: 6, overflow: 'hidden', background: '#fff' },
  segBtn:      { padding: '0 12px', height: 26, border: 0, background: 'transparent', fontSize: 11, color: T.charcoal, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  segDivider:  { borderLeft: `1px solid ${T.border}` },
  segOn:       { background: T.navy, color: '#fff', fontWeight: 500 },
  stats:       { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 },
  stat:        { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 190, padding: '8px 12px', border: `1px solid ${T.border}`, background: '#fff', borderRadius: 6 },
  statLink:    { cursor: 'pointer' },
  statLabel:   { fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: T.gold, whiteSpace: 'nowrap' },
  statNum:     { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2, color: INK },
  statHint:    { fontSize: 10.5, color: '#6B6560' },
  addRow:      { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 },
  addHint:     { fontSize: 10.5, color: '#8A857D' },
  input:       { padding: '5px 9px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11.5, color: INK, background: '#fff', outline: 'none', height: 28, width: 300, maxWidth: '100%', fontFamily: 'inherit' },
  btnPrimary:  { padding: '6px 16px', background: T.navy, color: '#fff', border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  empty:       { color: '#9ca3af', textAlign: 'center', padding: '48px 0', fontSize: 14 },
  tableWrap:   { border: `1px solid ${T.border}`, borderRadius: 6, background: '#fff', overflowX: 'auto' },
  table:       { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 1000 },
  th:          { background: T.page, padding: '7px 10px', textAlign: 'left', fontWeight: 700, borderBottom: `2px solid ${T.border}`, fontSize: 9.5, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' },
  td:          { padding: '0 10px', height: 38, borderBottom: '1px solid #EEECE6', verticalAlign: 'middle', fontSize: 12, color: T.charcoal, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  tdName:      { color: INK, fontSize: 12.5, fontWeight: 500 },
  nameLink:    { color: T.navy, textDecoration: 'none' },
  num:         { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  muted:       { color: '#6B6560', fontSize: 11.5 },
  shareWrap:   { display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', width: '100%' },
  shareBar:    { display: 'inline-block', width: 28, height: 5, borderRadius: 3, background: '#E6E3DC', overflow: 'hidden' },
  noteInput:   { width: '100%', border: '1px solid transparent', borderRadius: 4, padding: '3px 6px', fontSize: 11.5, color: T.charcoal, background: 'transparent', outline: 'none', fontFamily: 'inherit' },
  lnk:         { background: 'none', border: 0, padding: 0, color: T.navy, fontSize: 11, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2, fontFamily: 'inherit' },
  tf:          { background: T.page, fontWeight: 600, color: INK, borderBottom: 0, borderTop: `2px solid ${T.border}` },
}
