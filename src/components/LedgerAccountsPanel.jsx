// Admin panel for the ledger-account registry (client_settings key
// 'ledger_accounts'): the physical bank/card accounts that appear as
// balance-sheet lines. Maps import feed labels to one account each and holds
// opening balances. See BANK_CARD_ACCOUNTS_PLAN.md.

import { useState, useEffect, useCallback } from 'react'
import { getSetting, setSetting } from '../lib/settings'
import { T } from '../lib/theme'

const slug = label => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export default function LedgerAccountsPanel({ clientId }) {
  const [registry, setRegistry] = useState(null) // null = loading
  const [saving,   setSaving]   = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newType,  setNewType]  = useState('bank')
  const [drafts,   setDrafts]   = useState({})   // key → { match?, opening?, openingDate?, label? }

  useEffect(() => {
    let cancelled = false
    getSetting(clientId, 'ledger_accounts', []).catch(() => [])
      .then(v => { if (!cancelled) setRegistry(Array.isArray(v) ? v : []) })
    return () => { cancelled = true }
  }, [clientId])

  const save = useCallback(async next => {
    setRegistry(next)
    setSaving(true)
    try { await setSetting(clientId, 'ledger_accounts', next) }
    catch (e) { alert('Could not save accounts: ' + e.message) }
    setSaving(false)
  }, [clientId])

  const update = (key, fn) => save(registry.map(e => e.key === key ? fn(e) : e))
  const draft = (key, field) => drafts[key]?.[field] ?? ''
  const setDraft = (key, field, val) => setDrafts(p => ({ ...p, [key]: { ...p[key], [field]: val } }))
  const clearDraft = (key, field) => setDrafts(p => {
    const c = { ...p, [key]: { ...p[key] } }
    delete c[key][field]
    return c
  })

  const addAccount = () => {
    const label = newLabel.trim()
    if (!label) return
    const key = slug(label) + '-' + Math.random().toString(36).slice(2, 6)
    save([...(registry ?? []), {
      key, label, type: newType, matches: [], boundCategories: [], opening: null, reconciliations: [],
    }])
    setNewLabel('')
  }

  const addMatch = key => {
    const m = draft(key, 'match').trim()
    if (!m) return
    update(key, e => ({ ...e, matches: [...new Set([...(e.matches ?? []), m])] }))
    clearDraft(key, 'match')
  }

  const saveOpening = key => {
    const raw = draft(key, 'opening')
    if (raw === '') return
    const n = parseFloat(String(raw).replace(/[$,\s]/g, ''))
    const date = draft(key, 'openingDate') || new Date().toISOString().slice(0, 10)
    update(key, e => ({ ...e, opening: isNaN(n) || n === 0 ? null : { date, balance: n } }))
    clearDraft(key, 'opening')
  }

  if (registry === null) return null

  return (
    <div style={p.card}>
      <div style={p.head}>
        <span style={p.label}>
          Bank &amp; Card Accounts
          <span style={p.hint}>balance-sheet lines for real accounts — map every import feed label to one</span>
        </span>
        {saving && <span style={{ fontSize: 11, color: T.charcoal }}>Saving…</span>}
      </div>

      {registry.length === 0 && (
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 14px 10px' }}>
          No accounts yet — add your checking account and credit card below.
        </p>
      )}

      {registry.map(e => (
        <div key={e.key} style={p.row}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              style={{ ...p.input, width: 200, fontWeight: 600 }}
              value={draft(e.key, 'label') || e.label}
              onChange={ev => setDraft(e.key, 'label', ev.target.value)}
              onBlur={() => {
                const v = draft(e.key, 'label').trim()
                if (v && v !== e.label) update(e.key, x => ({ ...x, label: v }))
                clearDraft(e.key, 'label')
              }}
            />
            <span style={{ ...p.badge, background: e.type === 'card' ? '#FDE8E8' : '#EBF1F7', color: e.type === 'card' ? '#991B1B' : T.navy }}>
              {e.type === 'card' ? 'credit card · liability' : 'bank · asset'}
            </span>
            {e.opening?.balance != null && (
              <span style={{ fontSize: 10.5, color: T.charcoal }}>
                opening {e.type === 'card' ? 'owed ' : ''}${Math.abs(e.opening.balance).toLocaleString()} as of {e.opening.date}
              </span>
            )}
            <button
              style={p.del} title="Remove this account from the registry (transactions are untouched)"
              onClick={() => save(registry.filter(x => x.key !== e.key))}
            >remove</button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
            <span style={p.tiny}>Feed labels:</span>
            {(e.matches ?? []).map(m => (
              <span key={m} style={p.chip}>
                {m}
                <button
                  title="Unmap this label"
                  onClick={() => update(e.key, x => ({ ...x, matches: x.matches.filter(v => v !== m) }))}
                  style={p.chipX}
                >×</button>
              </span>
            ))}
            <input
              style={{ ...p.input, width: 220, fontSize: 10.5 }}
              placeholder="paste a feed label to map it…"
              value={draft(e.key, 'match')}
              onChange={ev => setDraft(e.key, 'match', ev.target.value)}
              onKeyDown={ev => ev.key === 'Enter' && addMatch(e.key)}
            />
            <button style={p.btnSm} onClick={() => addMatch(e.key)} disabled={!draft(e.key, 'match').trim()}>Map</button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <span style={p.tiny}>Opening balance{e.type === 'card' ? ' (amount owed)' : ''}:</span>
            <input
              style={{ ...p.input, width: 100, fontSize: 10.5, textAlign: 'right' }}
              placeholder={e.opening?.balance != null ? String(e.opening.balance) : '$0'}
              value={draft(e.key, 'opening')}
              onChange={ev => setDraft(e.key, 'opening', ev.target.value)}
              onKeyDown={ev => ev.key === 'Enter' && saveOpening(e.key)}
            />
            <input
              style={{ ...p.input, width: 110, fontSize: 10.5 }}
              type="date"
              value={draft(e.key, 'openingDate') || e.opening?.date || ''}
              onChange={ev => setDraft(e.key, 'openingDate', ev.target.value)}
            />
            <button style={p.btnSm} onClick={() => saveOpening(e.key)} disabled={draft(e.key, 'opening') === ''}>Set</button>
            <span style={{ ...p.tiny, color: '#b6b2a8' }}>as of the day before the account&apos;s first imported transaction</span>
          </div>

          {e.boundCategories?.length > 0 && (
            <div style={{ ...p.tiny, marginTop: 6 }}>
              Bound transfer categor{e.boundCategories.length !== 1 ? 'ies' : 'y'}: {e.boundCategories.join(', ')} — payments categorized there reduce this balance.
            </div>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          style={{ ...p.input, flex: 1, minWidth: 180 }}
          placeholder="New account name… (e.g. Business Savings)"
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addAccount()}
        />
        <select style={p.input} value={newType} onChange={e => setNewType(e.target.value)}>
          <option value="bank">Bank account (asset)</option>
          <option value="card">Credit card (liability)</option>
        </select>
        <button style={p.btn} onClick={addAccount} disabled={!newLabel.trim() || saving}>Add Account</button>
      </div>
    </div>
  )
}

const p = {
  card:  { background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, marginBottom: 12, overflow: 'hidden' },
  head:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', background: T.page, borderBottom: `1px solid ${T.border}` },
  label: { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.07em' },
  hint:  { marginLeft: 10, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#9ca3af' },
  row:   { padding: '10px 14px', borderBottom: '1px solid #F0EEE9' },
  input: { padding: '5px 9px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 12, color: T.navy, background: '#fff', outline: 'none' },
  badge: { fontSize: 9.5, fontWeight: 700, borderRadius: 3, padding: '2px 8px', whiteSpace: 'nowrap' },
  chip:  { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: T.charcoal, background: '#f1f5f9', borderRadius: 4, padding: '2px 8px' },
  chipX: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#9ca3af', padding: 0, lineHeight: 1 },
  tiny:  { fontSize: 10, color: '#9ca3af' },
  btn:   { padding: '5px 14px', background: T.navy, color: '#fff', border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' },
  btnSm: { padding: '3px 10px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 10, fontWeight: 500, cursor: 'pointer' },
  del:   { marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: '#9ca3af', textDecoration: 'underline', padding: 0 },
}
