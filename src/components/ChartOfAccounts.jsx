import { useState, useEffect, useCallback } from 'react'
import {
  PL_SECTIONS, BS_SECTIONS,
  isPLSection, isBSSection,
  fetchAccounts, addAccount as coaAdd, setSection, setParent, setCostType,
  renameAccount, deleteAccount, countTransactionsUsing, seedDefaults,
} from '../lib/chartOfAccounts'
import { T } from '../lib/theme'
import LedgerAccountsPanel from './LedgerAccountsPanel'

// ─── Helper: order accounts so children appear right after their parent ───────
function buildDisplayList(sectionAccounts) {
  const alpha = (a, b) => a.name.localeCompare(b.name)
  const topLevel = sectionAccounts.filter(a => !a.parent).sort(alpha)
  const byParent = {}
  sectionAccounts.filter(a => a.parent).forEach(a => {
    if (!byParent[a.parent]) byParent[a.parent] = []
    byParent[a.parent].push(a)
  })
  Object.values(byParent).forEach(children => children.sort(alpha))
  const result = []
  for (const p of topLevel) {
    result.push(p)
    ;(byParent[p.name] ?? []).forEach(child => result.push(child))
  }
  // Orphaned sub-accounts (parent deleted or moved to another section)
  const placed = new Set(result.map(a => a.name))
  sectionAccounts.filter(a => a.parent && !placed.has(a.name)).sort(alpha).forEach(a => result.push(a))
  return result
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChartOfAccounts({ clientId }) {
  const [accounts,    setAccounts]    = useState([])
  const [legacy,      setLegacy]      = useState(false)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const [saving,      setSaving]      = useState(false)
  const [tab,         setTab]         = useState('pl')     // 'pl' | 'bs'

  // inline-edit state
  const [editKey,     setEditKey]     = useState(null)
  const [editName,    setEditName]    = useState('')
  const [editParent,  setEditParent]  = useState('')

  // delete-confirm state
  const [deleting,    setDeleting]    = useState(null)     // { name, txCount }
  const [reassignTo,  setReassignTo]  = useState('')

  // add-row state
  const [addingTo,    setAddingTo]    = useState(null)     // section key or '__global__'
  const [newName,     setNewName]     = useState('')
  const [newSection,  setNewSection]  = useState('Operating Expenses')
  const [newParent,   setNewParent]   = useState('')

  // No synchronous setState here: initial state is already loading=true, and
  // post-mutation reloads refresh the table silently.
  const load = useCallback(async () => {
    try {
      const { accounts: rows, legacy: isLegacy } = await fetchAccounts(clientId)
      setAccounts(rows)
      setLegacy(isLegacy)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }, [clientId])

  // All state updates inside load() happen after awaits (async callbacks), never synchronously.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  const run = async (fn, failMsg) => {
    setSaving(true)
    try { await fn() } catch (e) { alert(`${failMsg}: ${e.message}`) }
    setSaving(false)
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  const onSeedDefaults = () => run(async () => {
    await seedDefaults(clientId)
    await load()
  }, 'Seed failed')

  const onAddAccount = (section) => {
    const name = newName.trim()
    if (!name) return
    const maxOrder = accounts.reduce((m, a) => Math.max(m, a.sort_order ?? 0), 0)
    run(async () => {
      await coaAdd(clientId, { name, section, parent: newParent || null, sortOrder: maxOrder + 10 })
      setNewName(''); setNewParent(''); setAddingTo(null)
      await load()
    }, 'Could not add account')
  }

  const onSaveEdit = (oldName) => {
    const name = editName.trim()
    if (!name) { setEditKey(null); return }
    run(async () => {
      if (name !== oldName) await renameAccount(clientId, oldName, name)
      await setParent(clientId, name, editParent || null)
      setEditKey(null)
      await load()
    }, 'Rename failed')
  }

  const onChangeSection = (name, section) => {
    run(async () => {
      await setSection(clientId, name, section)
      // Clear parent if the parent lives in a different section
      const acc = accounts.find(a => a.name === name)
      if (acc?.parent) {
        const parentAcc = accounts.find(a => a.name === acc.parent)
        if (!parentAcc || parentAcc.pl_section !== section) await setParent(clientId, name, null)
      }
      setAccounts(prev => prev.map(a =>
        a.name === name ? { ...a, pl_section: section, parent: null } : a
      ))
    }, 'Could not change section')
  }

  const onChangeParent = (name, parentName) => {
    run(async () => {
      await setParent(clientId, name, parentName || null)
      setAccounts(prev => prev.map(a =>
        a.name === name ? { ...a, parent: parentName ?? null } : a
      ))
    }, 'Could not change parent')
  }

  const onChangeCostType = (name, costType) => {
    run(async () => {
      await setCostType(clientId, name, costType)
      setAccounts(prev => prev.map(a =>
        a.name === name ? { ...a, cost_type: costType || null } : a
      ))
    }, 'Could not tag cost type')
  }

  const startDelete = async (name) => {
    let txCount = null // null = count unavailable, don't claim "no transactions use it"
    try { txCount = await countTransactionsUsing(clientId, name) } catch { /* keep null */ }
    setReassignTo('')
    setDeleting({ name, txCount })
  }

  const confirmDelete = () => {
    const { name } = deleting
    run(async () => {
      await deleteAccount(clientId, name, reassignTo || null)
      setDeleting(null)
      await load()
    }, 'Delete failed')
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={s.spinner} />
      <p style={{ fontSize: 12, color: T.charcoal, marginTop: 14 }}>Loading chart of accounts…</p>
    </div>
  )

  const activeSections = tab === 'pl' ? PL_SECTIONS : BS_SECTIONS
  const grouped = activeSections.reduce((acc, sec) => {
    acc[sec] = accounts.filter(a => a.pl_section === sec)
    return acc
  }, {})

  const plCount = accounts.filter(a => isPLSection(a.pl_section)).length
  const bsCount = accounts.filter(a => isBSSection(a.pl_section)).length

  return (
    <div style={{ background: T.page, minHeight: '100%' }}>
      {/* Page header */}
      <header style={s.pageHeader}>
        <div>
          <h1 style={s.pageTitle}>Chart of Accounts</h1>
          <p style={s.pageSub}>Define accounts, assign them to P&amp;L or Balance Sheet sections, and tag expenses fixed or variable.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {saving && <span style={{ fontSize: 11, color: T.charcoal }}>Saving…</span>}
          {accounts.length === 0 && (
            <button style={s.btnPrimary} onClick={onSeedDefaults} disabled={saving}>
              Seed Default Accounts
            </button>
          )}
        </div>
      </header>

      <div style={{ padding: '20px 28px', maxWidth: 920 }}>
        {error && <div style={s.errorBox}>{error}</div>}

        {legacy && (
          <div style={s.warnBox}>
            <strong>Heads up:</strong> account classifications are stored in this browser only.
            Run <code>supabase/migration.sql</code> in your Supabase SQL editor so they live in the
            database and stay correct on every device. Fixed/variable tagging also needs the migration.
          </div>
        )}

        {accounts.length === 0 && !loading && (
          <div style={s.infoBox}>
            No accounts yet. Click <strong>Seed Default Accounts</strong> to pre-populate the standard chart of accounts for a small retail business.
          </div>
        )}

        {/* Statement type tabs */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: `1px solid ${T.border}` }}>
          {[
            { key: 'pl', label: 'Income Statement (P&L)', count: plCount },
            { key: 'bs', label: 'Balance Sheet',           count: bsCount },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setAddingTo(null); setNewName(''); setNewParent('') }}
              style={{
                padding: '8px 18px', border: 'none', cursor: 'pointer',
                background: 'transparent', fontSize: 12, fontWeight: tab === t.key ? 600 : 400,
                color: tab === t.key ? T.navy : T.charcoal,
                borderBottom: tab === t.key ? `2px solid ${T.navy}` : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {t.label}
              <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 500, color: tab === t.key ? T.gold : '#9ca3af', background: '#f1f5f9', borderRadius: 10, padding: '1px 6px' }}>
                {t.count}
              </span>
            </button>
          ))}
        </div>

        {/* Sections */}
        {activeSections.map(section => {
          const sectionAccounts = grouped[section] ?? []
          const displayList     = buildDisplayList(sectionAccounts)
          // Only top-level accounts in this section can be parents
          const parentOptions   = sectionAccounts.filter(a => !a.parent)
          const showCostType    = !legacy && section === 'Operating Expenses'

          return (
            <div key={section} style={s.sectionCard}>
              <div style={s.sectionHead}>
                <span style={s.sectionLabel}>
                  {section}
                  {showCostType && <span style={{ marginLeft: 10, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#9ca3af' }}>tag each expense fixed or variable — it feeds the breakeven number</span>}
                </span>
                <button
                  style={s.addBtn}
                  onClick={() => { setAddingTo(addingTo === section ? null : section); setNewName(''); setNewParent('') }}
                >
                  + Add account
                </button>
              </div>

              {addingTo === section && (
                <div style={s.addForm}>
                  <input
                    autoFocus
                    style={s.input}
                    placeholder="Account name…"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') onAddAccount(section)
                      if (e.key === 'Escape') setAddingTo(null)
                    }}
                  />
                  <select
                    style={s.sectionSelect}
                    value={newParent}
                    onChange={e => setNewParent(e.target.value)}
                    title="Optional: nest this under a parent account"
                  >
                    <option value="">— Top Level —</option>
                    {parentOptions.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                  <button style={s.btnPrimary} onClick={() => onAddAccount(section)} disabled={!newName.trim() || saving}>Add</button>
                  <button style={s.btnSecondary} onClick={() => setAddingTo(null)}>Cancel</button>
                </div>
              )}

              {displayList.length === 0 && (
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 14px 10px' }}>No accounts in this section.</p>
              )}

              <table style={s.table}>
                <tbody>
                  {displayList.map(acc => {
                    const isChild     = !!acc.parent
                    const editOptions = sectionAccounts.filter(a => !a.parent && a.name !== acc.name)
                    const isEditing   = editKey === acc.name
                    const isDeleting  = deleting?.name === acc.name

                    return (
                      <tr key={acc.name} style={s.row}
                        onMouseEnter={e => e.currentTarget.style.background = T.page}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        {/* Name */}
                        <td style={{ ...s.td, width: '99%' }}>
                          {isEditing ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                              <input
                                autoFocus
                                style={{ ...s.input, margin: 0, fontSize: 12 }}
                                value={editName}
                                onChange={e => setEditName(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter')  onSaveEdit(acc.name)
                                  if (e.key === 'Escape') setEditKey(null)
                                }}
                              />
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 10, color: '#9ca3af', flexShrink: 0 }}>Sub-account of:</span>
                                <select
                                  style={{ ...s.sectionSelect, fontSize: 10, padding: '3px 7px' }}
                                  value={editParent}
                                  onChange={e => setEditParent(e.target.value)}
                                >
                                  <option value="">— Top Level —</option>
                                  {editOptions.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                                </select>
                                <button style={{ ...s.btnPrimary,    padding: '3px 10px', fontSize: 10 }} onClick={() => onSaveEdit(acc.name)} disabled={saving}>Save</button>
                                <button style={{ ...s.btnSecondary,  padding: '3px 8px',  fontSize: 10 }} onClick={() => setEditKey(null)}>Cancel</button>
                              </div>
                              <p style={{ fontSize: 10, color: '#9ca3af', margin: 0 }}>
                                Renaming updates every transaction that uses this category.
                              </p>
                            </div>
                          ) : isDeleting ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: T.danger }}>
                                Remove &quot;{acc.name}&quot;?
                                {deleting.txCount == null
                                  ? ' Could not check how many transactions use it.'
                                  : deleting.txCount > 0
                                    ? ` ${deleting.txCount} transaction${deleting.txCount !== 1 ? 's' : ''} use${deleting.txCount === 1 ? 's' : ''} it.`
                                    : ' No transactions use it.'}
                              </span>
                              {deleting.txCount !== 0 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: 10.5, color: T.charcoal }}>Reassign them to:</span>
                                  <select
                                    style={{ ...s.sectionSelect, fontSize: 10, padding: '3px 7px' }}
                                    value={reassignTo}
                                    onChange={e => setReassignTo(e.target.value)}
                                  >
                                    <option value="">— Leave uncategorized —</option>
                                    {accounts.filter(a => a.name !== acc.name).map(a =>
                                      <option key={a.name} value={a.name}>{a.name}</option>
                                    )}
                                  </select>
                                </div>
                              )}
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button style={{ ...s.btnDanger, padding: '3px 10px', fontSize: 10 }} onClick={confirmDelete} disabled={saving}>
                                  {deleting.txCount !== 0 && !reassignTo ? 'Delete & leave uncategorized' : 'Delete'}
                                </button>
                                <button style={{ ...s.btnSecondary, padding: '3px 8px', fontSize: 10 }} onClick={() => setDeleting(null)}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', paddingLeft: isChild ? 20 : 0 }}>
                              {isChild && <span style={{ color: '#c0bbb4', marginRight: 6, fontSize: 11 }}>└</span>}
                              <span style={{ fontSize: 12, color: T.charcoal }}>{acc.name}</span>
                              {isChild && (
                                <span style={{ marginLeft: 8, fontSize: 10, color: '#9ca3af', background: '#f1f5f9', borderRadius: 4, padding: '1px 7px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  {acc.parent}
                                  <button
                                    title="Remove parent"
                                    onClick={() => onChangeParent(acc.name, null)}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#9ca3af', padding: 0, lineHeight: 1 }}
                                  >×</button>
                                </span>
                              )}
                            </div>
                          )}
                        </td>

                        {/* Fixed / variable (Operating Expenses only) */}
                        {showCostType ? (
                          <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'flex', gap: 2 }}>
                              {['fixed', 'variable'].map(ct => (
                                <button
                                  key={ct}
                                  onClick={() => onChangeCostType(acc.name, acc.cost_type === ct ? null : ct)}
                                  title={ct === 'fixed' ? 'Same every month (rent, insurance, payroll)' : 'Scales with sales (fees, supplies)'}
                                  style={{
                                    padding: '2px 9px', fontSize: 9.5, fontWeight: 600, cursor: 'pointer',
                                    borderRadius: 3, border: `1px solid ${acc.cost_type === ct ? T.navy : T.border}`,
                                    background: acc.cost_type === ct ? T.navy : '#fff',
                                    color: acc.cost_type === ct ? '#fff' : '#9ca3af',
                                    textTransform: 'capitalize',
                                  }}
                                >{ct}</button>
                              ))}
                            </div>
                          </td>
                        ) : <td style={s.td}></td>}

                        {/* Section selector */}
                        <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                          <select
                            style={s.sectionSelect}
                            value={acc.pl_section}
                            onChange={e => onChangeSection(acc.name, e.target.value)}
                          >
                            <optgroup label="Income Statement">
                              {PL_SECTIONS.map(sec => <option key={sec} value={sec}>{sec}</option>)}
                            </optgroup>
                            <optgroup label="Balance Sheet">
                              {BS_SECTIONS.map(sec => <option key={sec} value={sec}>{sec}</option>)}
                            </optgroup>
                          </select>
                        </td>

                        {/* Actions */}
                        <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                          <button
                            style={s.iconBtn}
                            title="Edit"
                            onClick={() => { setDeleting(null); setEditKey(acc.name); setEditName(acc.name); setEditParent(acc.parent ?? '') }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                          </button>
                          <button
                            style={{ ...s.iconBtn, color: T.danger }}
                            title="Delete"
                            onClick={() => { setEditKey(null); startDelete(acc.name) }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                              <polyline points="3 6 5 6 21 6"/>
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                              <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                            </svg>
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        })}

        {/* Physical bank/card accounts (balance-sheet lines) */}
        <LedgerAccountsPanel clientId={clientId} />

        {/* Global add form */}
        <div style={{ ...s.sectionCard, marginTop: 8 }}>
          <div style={s.sectionHead}>
            <span style={s.sectionLabel}>Add Account</span>
          </div>
          <div style={s.addForm}>
            <input
              style={s.input}
              placeholder="Account name…"
              value={addingTo === '__global__' ? newName : ''}
              onChange={e => { setAddingTo('__global__'); setNewName(e.target.value) }}
              onKeyDown={e => {
                if (e.key === 'Enter' && addingTo === '__global__') onAddAccount(newSection)
                if (e.key === 'Escape') { setAddingTo(null); setNewName('') }
              }}
            />
            <select
              style={s.sectionSelect}
              value={newSection}
              onChange={e => { setNewSection(e.target.value); setNewParent('') }}
            >
              <optgroup label="Income Statement">
                {PL_SECTIONS.map(sec => <option key={sec} value={sec}>{sec}</option>)}
              </optgroup>
              <optgroup label="Balance Sheet">
                {BS_SECTIONS.map(sec => <option key={sec} value={sec}>{sec}</option>)}
              </optgroup>
            </select>
            <select
              style={s.sectionSelect}
              value={newParent}
              onChange={e => setNewParent(e.target.value)}
              title="Optional: nest this under a parent account"
            >
              <option value="">— Top Level —</option>
              {accounts.filter(a => a.pl_section === newSection && !a.parent).map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
            <button
              style={s.btnPrimary}
              disabled={!(addingTo === '__global__' && newName.trim()) || saving}
              onClick={() => onAddAccount(newSection)}
            >
              Add Account
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  pageHeader:    { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 28px', background: T.card, borderBottom: `1px solid ${T.border}` },
  pageTitle:     { fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 2px' },
  pageSub:       { fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 },
  spinner:       { width: 28, height: 28, border: `2px solid ${T.border}`, borderTopColor: T.navy, borderRadius: '50%', animation: 'spin .7s linear infinite' },
  errorBox:      { background: '#FDE8E8', border: '1px solid #F5C2C2', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#991B1B', marginBottom: 16 },
  warnBox:       { background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#92400E', marginBottom: 16, lineHeight: 1.6 },
  infoBox:       { background: '#EBF1F7', border: '1px solid #B8CDE0', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: T.navy, marginBottom: 16 },
  sectionCard:   { background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, marginBottom: 12, overflow: 'hidden' },
  sectionHead:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', background: T.page, borderBottom: `1px solid ${T.border}` },
  sectionLabel:  { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.07em' },
  addBtn:        { fontSize: 11, fontWeight: 500, color: T.navy, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0', whiteSpace: 'nowrap' },
  addForm:       { display: 'flex', gap: 8, padding: '10px 14px', alignItems: 'center', borderBottom: '1px solid #F0EEE9', flexWrap: 'wrap' },
  input:         { flex: 1, padding: '5px 9px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 12, color: T.navy, background: '#fff', outline: 'none' },
  sectionSelect: { padding: '5px 9px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, color: T.charcoal, background: '#fff', outline: 'none' },
  table:         { width: '100%', borderCollapse: 'collapse' },
  row:           { borderBottom: '1px solid #F0EEE9', transition: 'background .1s' },
  td:            { padding: '7px 14px', verticalAlign: 'middle' },
  iconBtn:       { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: '3px 5px', borderRadius: 4, lineHeight: 0 },
  btnPrimary:    { padding: '5px 14px', background: T.navy, color: '#fff', border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  btnSecondary:  { padding: '5px 12px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  btnDanger:     { padding: '5px 12px', background: '#FDE8E8', color: T.danger, border: '1px solid #F5C2C2', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
}
