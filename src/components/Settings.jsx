import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'
import { fetchAccounts } from '../lib/chartOfAccounts'
import { getSetting, setSetting } from '../lib/settings'
import { T, fmt2 } from '../lib/theme'
import InfoTip from './InfoTip'

// One place to see and change everything the app remembers. These are the same
// six keys the in-context editors write (dashboard runway card, margin table,
// P&L budget inputs, the two InventoryOps cards) — this is an extra way in, not
// a replacement, so nothing here needs migrating.

const clampPct = v => {
  const n = parseFloat(v)
  return isNaN(n) ? null : Math.max(0, Math.min(100, n))
}

export default function Settings({ clientId }) {
  const [cash,      setCash]      = useState(null)
  const [method,    setMethod]    = useState({})
  const [cogsPct,   setCogsPct]   = useState({})
  const [budget,    setBudget]    = useState({})
  const [counts,    setCounts]    = useState([])
  const [budgets,   setBudgets]   = useState({})
  const [sqCats,    setSqCats]    = useState([])
  const [accounts,  setAccounts]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [saved,     setSaved]     = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const [cashV, methodV, pctV, budgetV, countsV, budgetsV, sqRes, coaRes] = await Promise.all([
        getSetting(clientId, 'cash_balance', null).catch(() => null),
        getSetting(clientId, 'cogs_method', {}).catch(() => ({})),
        getSetting(clientId, 'cogs_pct', {}).catch(() => ({})),
        getSetting(clientId, 'purchase_budget', {}).catch(() => ({})),
        getSetting(clientId, 'inventory_counts', []).catch(() => []),
        getSetting(clientId, 'budgets', {}).catch(() => ({})),
        supabase.from('square_reports').select('categories').eq('client_id', clientId),
        fetchAccounts(clientId).catch(() => ({ accounts: [] })),
      ])
      if (cancelled) return
      setCash(cashV); setMethod(methodV || {}); setCogsPct(pctV || {})
      setBudget(budgetV || {}); setCounts(Array.isArray(countsV) ? countsV : [])
      setBudgets(budgetsV || {}); setAccounts(coaRes.accounts ?? [])
      setSqCats([...new Set((sqRes.data ?? []).flatMap(r =>
        (Array.isArray(r.categories) ? r.categories : []).map(c => c.name)))].sort())
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [clientId])

  const persist = useCallback(async (key, value, label) => {
    try {
      await setSetting(clientId, key, value)
      setSaved(`✓ ${label} saved`)
      setTimeout(() => setSaved(s => (s === `✓ ${label} saved` ? '' : s)), 2500)
    } catch (e) { alert('Could not save: ' + e.message) }
  }, [clientId])

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:300, background:T.page }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={{ width:28, height:28, border:`2px solid ${T.border}`, borderTopColor:T.navy, borderRadius:'50%', animation:'spin .7s linear infinite' }} />
    </div>
  )

  const budgetCount = Object.keys(budgets).filter(k => budgets[k] != null).length

  return (
    <div style={{ background:T.page, minHeight:'100%', fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme:'light' }}>
      <header style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'14px 28px', background:T.card, borderBottom:`1px solid ${T.border}` }}>
        <div>
          <h2 style={{ fontSize:14, fontWeight:600, color:T.navy, margin:'0 0 2px' }}>Settings</h2>
          <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:0 }}>
            Everything the app remembers, in one place
          </p>
        </div>
        {saved && <span style={{ fontSize:11, color:T.success, fontWeight:500 }}>{saved}</span>}
      </header>

      <div style={{ padding:'20px 28px 48px', maxWidth:760 }}>
        <p style={{ fontSize:11, color:'rgba(74,74,74,0.6)', margin:'0 0 16px', lineHeight:1.6 }}>
          These are the same values the Dashboard and P&amp;L cards edit in place. Changing one
          here takes effect on those pages the next time they load.
        </p>

        {/* ── Cash ── */}
        <Card
          title="Cash on hand"
          info="The bank balance the runway and Open-to-Buy guardrails work from. The app can't read it, so it stays as you left it — a stale figure quietly makes both numbers wrong."
        >
          <Row label="Balance">
            <MoneyInput
              value={cash?.amount ?? ''}
              onCommit={v => {
                const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
                if (isNaN(n)) return
                const next = { amount: n, asOf: cash?.asOf ?? new Date().toISOString().slice(0, 10) }
                setCash(next); persist('cash_balance', next, 'Cash balance')
              }}
            />
          </Row>
          <Row label="As of">
            <input
              type="date" style={{ ...input, width:140 }}
              value={cash?.asOf ?? ''}
              onChange={e => {
                const next = { amount: cash?.amount ?? 0, asOf: e.target.value }
                setCash(next); persist('cash_balance', next, 'Cash date')
              }}
            />
          </Row>
        </Card>

        {/* ── COGS method ── */}
        <Card
          title="COGS method"
          info="Cost of Goods Sold is estimated as a percentage of what sold. The hybrid split is used when a month's Square report breaks out Sealed Products; otherwise the blended rate applies."
        >
          {[
            ['sealedCostRatio', 'Sealed cost ratio (cost ÷ price)'],
            ['restPct',         'Rest of revenue'],
            ['blendedPct',      'Blended — months with no Square breakdown'],
          ].map(([key, label]) => (
            <Row key={key} label={label}>
              <PctInput
                value={method?.[key] ?? ''}
                onCommit={v => {
                  const next = { ...method, [key]: clampPct(v), updatedAt: new Date().toISOString().slice(0, 10) }
                  setMethod(next); persist('cogs_method', next, 'COGS method')
                }}
              />
            </Row>
          ))}
          {method?.updatedAt && <Note>Last changed {method.updatedAt}.</Note>}
        </Card>

        {/* ── COGS % per product line ── */}
        <Card
          title="Estimated COGS % by product line"
          info="Used by Margin by Product Line when a category has no logged inventory buys to cost it against. Leave blank to show that line as unknown rather than guessed."
        >
          {sqCats.length === 0 ? (
            <Note>No Square product categories yet — upload a Square report first.</Note>
          ) : sqCats.map(cat => (
            <Row key={cat} label={cat}>
              <PctInput
                value={cogsPct?.[cat] ?? ''}
                onCommit={v => {
                  const n = clampPct(v)
                  const next = { ...cogsPct }
                  if (n == null) delete next[cat]; else next[cat] = n
                  setCogsPct(next); persist('cogs_pct', next, `${cat} COGS %`)
                }}
              />
            </Row>
          ))}
        </Card>

        {/* ── Purchasing guardrail ── */}
        <Card
          title="Purchasing guardrail"
          info="Feeds the Open-to-Buy card. The cash floor is what you refuse to dip below; the deposit haircut discounts expected incoming deposits so the guardrail stays conservative."
        >
          <Row label="Cash floor — never spend below">
            <MoneyInput
              value={budget?.cashFloor ?? ''}
              onCommit={v => {
                const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
                const next = { ...budget, cashFloor: isNaN(n) ? 0 : Math.max(0, n) }
                setBudget(next); persist('purchase_budget', next, 'Cash floor')
              }}
            />
          </Row>
          <Row label="Deposit haircut (default 80%)">
            <PctInput
              value={budget?.depositHaircut != null ? Math.round(budget.depositHaircut * 100) : ''}
              onCommit={v => {
                const n = clampPct(v)
                const next = { ...budget }
                if (n == null) delete next.depositHaircut; else next.depositHaircut = n / 100
                setBudget(next); persist('purchase_budget', next, 'Deposit haircut')
              }}
            />
          </Row>
        </Card>

        {/* ── Inventory counts (read-only) ── */}
        <Card
          title="Inventory counts"
          info="Each quarterly count books a true-up pair adjusting COGS to what you actually counted. Because recording one writes real journal entries, it stays on the Dashboard's Inventory card rather than here."
        >
          {counts.length === 0 ? (
            <Note>No counts recorded yet.</Note>
          ) : (
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11.5 }}>
              <thead>
                <tr>
                  {['Date', 'Counted', 'Book before', 'Adjustment'].map((h, i) => (
                    <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding:'6px 8px', background:T.page, fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.06em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...counts].reverse().map((c, i) => (
                  <tr key={i} style={{ borderTop:`1px solid ${T.border}` }}>
                    <td style={{ padding:'6px 8px', color:T.charcoal }}>{c.date}</td>
                    <td style={{ ...num }}>{fmt2(c.counted)}</td>
                    <td style={{ ...num }}>{fmt2(c.bookBefore)}</td>
                    <td style={{ ...num, color: Math.abs(c.adjustment) < 0.01 ? T.charcoal : c.adjustment > 0 ? T.danger : T.success }}>
                      {fmt2(c.adjustment)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ marginTop:10 }}>
            <Link href="/" style={{ ...linkBtn }}>Record a count on the Dashboard →</Link>
          </div>
        </Card>

        {/* ── Budgets (pointer) ── */}
        <Card
          title="Monthly budgets"
          info="Per-account monthly targets, compared against this year's actual monthly average. They're edited on the P&L where each account sits next to its real numbers."
        >
          <Note>
            {budgetCount > 0
              ? `${budgetCount} account${budgetCount !== 1 ? 's' : ''} of ${accounts.length} have a monthly budget set.`
              : 'No budgets set yet.'}
          </Note>
          <div style={{ marginTop:10 }}>
            <Link href="/pl" style={{ ...linkBtn }}>Edit on the P&amp;L — tick “Budget vs. actual” →</Link>
          </div>
        </Card>
      </div>
    </div>
  )
}

// ─── Bits ─────────────────────────────────────────────────────────────────────

function Card({ title, info, children }) {
  return (
    <section style={{ background:T.card, borderRadius:7, padding:'14px 16px', marginBottom:12,
      borderTop:`1px solid ${T.border}`, borderRight:`1px solid ${T.border}`,
      borderBottom:`1px solid ${T.border}`, borderLeft:`3px solid ${T.gold}` }}>
      <h3 style={{ display:'flex', alignItems:'center', gap:5, fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.07em', margin:'0 0 10px' }}>
        <span>{title}</span>
        {info && <InfoTip title={title}>{info}</InfoTip>}
      </h3>
      {children}
    </section>
  )
}

function Row({ label, children }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:7, minHeight:26 }}>
      <label style={{ flex:1, fontSize:11.5, color:T.charcoal }}>{label}</label>
      <div style={{ flexShrink:0 }}>{children}</div>
    </div>
  )
}

const Note = ({ children }) => (
  <p style={{ fontSize:11, color:'rgba(74,74,74,0.6)', margin:'4px 0 0', lineHeight:1.6 }}>{children}</p>
)

// Commits on blur/Enter rather than per keystroke — every commit is a network write.
function CommitInput({ value, onCommit, suffix, width = 92, align = 'right', placeholder }) {
  const [draft, setDraft] = useState(null)
  const shown = draft ?? (value === '' || value == null ? '' : String(value))
  const commit = () => { if (draft !== null) { onCommit(draft); setDraft(null) } }
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:3 }}>
      <input
        style={{ ...input, width, textAlign: align }}
        value={shown} placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setDraft(null) }}
      />
      {suffix && <span style={{ fontSize:11, color:'rgba(74,74,74,0.55)' }}>{suffix}</span>}
    </span>
  )
}

const PctInput   = props => <CommitInput {...props} suffix="%" width={58} placeholder="—" />
const MoneyInput = props => <CommitInput {...props} width={110} placeholder="$0" />

const input   = { padding:'4px 8px', border:`1px solid ${T.border}`, borderRadius:5, fontSize:11.5, color:T.charcoal, background:'#fff', outline:'none' }
const num     = { padding:'6px 8px', textAlign:'right', fontVariantNumeric:'tabular-nums', color:T.charcoal, whiteSpace:'nowrap' }
const linkBtn = { display:'inline-block', padding:'5px 12px', background:'#fff', color:T.charcoal, border:`1px solid ${T.border}`, borderRadius:5, fontSize:10.5, fontWeight:500, textDecoration:'none' }
