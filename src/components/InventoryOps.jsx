// Dashboard cards for the COGS workflow (gross margin method) and the weekly
// Open to Buy guardrail. Presentation only — the math lives in lib/insights.js
// and the inserts/settings writes live in Dashboard handlers. See COGS_PLAN.md.

import { useState } from 'react'
import { T as D, fmt } from '../lib/theme'

const cardStyle = { background:D.card, border:`1px solid ${D.border}`, borderRadius:7, padding:'14px 16px', display:'flex', flexDirection:'column' }
const cardLabel = { fontSize:9.5, fontWeight:700, color:D.gold, textTransform:'uppercase', letterSpacing:'.07em', marginBottom:6 }
const cardBig   = { fontSize:22, fontWeight:600, color:D.navy, lineHeight:1.2 }
const cardSub   = { fontSize:10, color:'rgba(74,74,74,0.6)', marginTop:4, lineHeight:1.5 }
const btn       = { padding:'5px 12px', background:D.navy, color:'#fff', border:'none', borderRadius:5, fontSize:11, cursor:'pointer' }
const btnGhost  = { padding:'4px 10px', background:'none', border:`1px solid ${D.border}`, borderRadius:5, fontSize:10.5, color:D.charcoal, cursor:'pointer' }
const inputSt   = { padding:'4px 8px', border:`1px solid ${D.border}`, borderRadius:5, fontSize:11, outline:'none', minWidth:0 }
const amberNote = { display:'inline-block', fontSize:9.5, fontWeight:700, color:'#92400E', background:'#FEF3C7', borderRadius:3, padding:'1px 7px' }
const linkBtn   = { background:'none', border:'none', color:D.steel, fontSize:10, cursor:'pointer', padding:0, textDecoration:'underline' }

const parseMoney = v => {
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
  return isNaN(n) ? null : n
}

// ─── Ratio editor (shared by CogsCard) ────────────────────────────────────────

function RatioEditor({ method, onSave, onDone }) {
  const [sealed,  setSealed]  = useState(method?.sealedCostRatio ?? '')
  const [rest,    setRest]    = useState(method?.restPct ?? '')
  const [blended, setBlended] = useState(method?.blendedPct ?? '')
  const clean = v => { const n = parseFloat(v); return isNaN(n) ? null : Math.max(0, Math.min(100, n)) }
  const save = () => {
    onSave({
      ...method,
      sealedCostRatio: clean(sealed), restPct: clean(rest), blendedPct: clean(blended),
      updatedAt: new Date().toISOString().slice(0, 10),
    })
    onDone?.()
  }
  const row = { display:'flex', alignItems:'center', gap:6, fontSize:10.5, color:D.charcoal, justifyContent:'space-between' }
  const pct = { ...inputSt, width:52, textAlign:'right' }
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:6 }}>
      <div style={row}><span>Sealed cost ratio (cost ÷ price)</span><span><input style={pct} value={sealed} placeholder="%" onChange={e => setSealed(e.target.value)} />%</span></div>
      <div style={row}><span>Rest of revenue</span><span><input style={pct} value={rest} placeholder="%" onChange={e => setRest(e.target.value)} />%</span></div>
      <div style={row}><span>Blended (months without Square breakdown)</span><span><input style={pct} value={blended} placeholder="%" onChange={e => setBlended(e.target.value)} />%</span></div>
      <div><button style={btn} onClick={save}>Save ratios</button></div>
    </div>
  )
}

// ─── Month-end entries card (COGS + sales-tax accrual) ────────────────────────

function EntryLine({ ok, children }) {
  return (
    <div style={{ display:'flex', alignItems:'flex-start', gap:7, fontSize:11, marginTop:6, color: ok ? D.charcoal : '#B45309', fontWeight: ok ? 400 : 600 }}>
      <span style={{
        flexShrink:0, width:14, height:14, borderRadius:'50%', display:'inline-flex', alignItems:'center', justifyContent:'center',
        background: ok ? '#D1E8D4' : '#FEF3C7', color: ok ? '#1A5C28' : '#92400E', fontSize:9, fontWeight:700, marginTop:1,
      }}>{ok ? '✓' : '!'}</span>
      <span style={{ lineHeight:1.5 }}>{children}</span>
    </div>
  )
}

export function CogsCard({ cl, proposal, method, taxProposal, busy, onBook, onSaveMethod }) {
  const [editing, setEditing] = useState(false)
  if (!cl) return null
  const hasRatios = !!(method && (method.blendedPct || (method.sealedCostRatio && method.restPct)))

  const cogsPending = !!proposal && !cl.cogsBooked
  const taxPending  = !!taxProposal && !taxProposal.booked
  const pendingCount = (cogsPending ? 1 : 0) + (taxPending ? 1 : 0)
  const allDone = cl.cogsBooked && (!taxProposal || taxProposal.booked)
  const border = allDone ? D.success : D.amber

  return (
    <div style={{ ...cardStyle, borderTop:`3px solid ${border}` }}>
      <div style={cardLabel}>Month-End Entries · {cl.label}</div>

      {/* COGS line */}
      {cl.cogsBooked ? (
        <EntryLine ok>COGS booked</EntryLine>
      ) : proposal ? (
        <EntryLine ok={false}>
          COGS {fmt(proposal.amount)}{' '}
          <span style={{ fontWeight:400, color:'rgba(74,74,74,0.6)' }}>
            ({proposal.formula === 'hybrid'
              ? <>sealed {fmt(proposal.parts.sealed)} × {proposal.parts.sealedPct}% + other × {proposal.parts.restPct}%</>
              : <>{proposal.parts.blendedPct}% blended{!cl.squareUploaded && ' — upload the Square report for the hybrid formula'}</>})
          </span>
        </EntryLine>
      ) : (
        <EntryLine ok={false}>{hasRatios ? `COGS — no revenue recorded for ${cl.label} yet` : 'COGS — set the ratios below'}</EntryLine>
      )}

      {/* Sales tax accrual line */}
      {taxProposal ? (
        taxProposal.booked
          ? <EntryLine ok>Sales tax accrued to liability</EntryLine>
          : <EntryLine ok={false}>Sales tax {fmt(taxProposal.amount)} → Sales Tax Payable</EntryLine>
      ) : (
        <EntryLine ok>No sales tax to accrue{cl.squareUploaded ? '' : ' (Square report not uploaded)'}</EntryLine>
      )}

      {pendingCount > 0 && (
        <div style={{ marginTop:10 }}>
          <button style={{ ...btn, opacity: busy ? .6 : 1 }} disabled={busy} onClick={onBook}>
            {busy ? 'Booking…' : `Book ${pendingCount === 1 ? 'entry' : `${pendingCount} entries`}`}
          </button>
        </div>
      )}
      <div style={cardSub}>
        Zero-net pairs dated {cl.month} month-end · one per month ·{' '}
        <button style={linkBtn} onClick={() => setEditing(e => !e)}>{editing ? 'hide ratios' : 'ratios'}</button>
      </div>
      {(editing || !hasRatios) && (
        <RatioEditor method={method} onSave={onSaveMethod} onDone={() => setEditing(false)} />
      )}
    </div>
  )
}

// ─── Inventory card (book balance + quarterly true-up) ────────────────────────

export function InventoryCard({ balance, counts, busy, onTrueUp, impliedPct, method, onSaveMethod }) {
  const [val, setVal] = useState('')
  const counted = parseMoney(val)
  const adj = counted != null ? Math.round((balance - counted) * 100) / 100 : null
  const last = counts?.length ? counts[counts.length - 1] : null

  const now = new Date()
  const qEnd = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 0)
  const nextDue = qEnd.toLocaleDateString('default', { month: 'short', day: 'numeric' })

  const blended = method?.blendedPct != null ? Number(method.blendedPct) : null
  const drifted = impliedPct != null && blended != null && Math.abs(impliedPct - blended) > 2

  return (
    <div style={{ ...cardStyle, borderTop:`3px solid ${D.steel}` }}>
      <div style={cardLabel}>Inventory on Hand</div>
      <div style={cardBig}>{fmt(balance)}</div>
      <div style={cardSub}>
        Book value{last ? <> · last counted {last.date} ({fmt(last.counted)})</> : <> · never counted</>}
        {' · '}next count due {nextDue}
      </div>
      <div style={{ display:'flex', gap:6, marginTop:10 }}>
        <input
          style={{ ...inputSt, flex:1 }} value={val} placeholder="Counted value at cost…"
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && counted != null && !busy && onTrueUp(counted)}
        />
        <button
          style={{ ...btnGhost, opacity: counted == null || busy ? .5 : 1 }}
          disabled={counted == null || busy}
          onClick={() => onTrueUp(counted)}
        >True up</button>
      </div>
      {adj != null && (
        <div style={cardSub}>
          {Math.abs(adj) < 0.01
            ? 'Book balance matches the count — records the count only.'
            : adj > 0
              ? `Books ${fmt(adj)} additional COGS this quarter (shrinkage / underestimate).`
              : `Reduces COGS by ${fmt(-adj)} this quarter (estimate ran high).`}
        </div>
      )}
      {impliedPct != null && (
        <div style={{ ...cardSub, marginTop:8 }}>
          This quarter's booked COGS ≈ {impliedPct.toFixed(1)}% of revenue{blended != null && <> (blended set to {blended}%)</>}.
          {drifted && (
            <>
              {' '}
              <button style={linkBtn} onClick={() => onSaveMethod({ ...method, blendedPct: Math.round(impliedPct * 10) / 10 })}>
                apply as blended %
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Open to Buy card ─────────────────────────────────────────────────────────

export function OpenToBuyCard({ otb, budget, onSaveBudget }) {
  const [editFloor, setEditFloor] = useState(false)
  const [floorVal, setFloorVal] = useState('')

  if (!otb) return (
    <div style={{ ...cardStyle, borderTop:`3px solid ${D.border}` }}>
      <div style={cardLabel}>Open to Buy</div>
      <div style={{ fontSize:10.5, color:D.charcoal, lineHeight:1.6 }}>
        Enter your bank balance on the Cash Runway card to size this week's inventory buying.
      </div>
    </div>
  )

  const stateColor = { healthy: D.success, tight: D.amber, hold: D.danger }[otb.state]
  const saveFloor = () => {
    const n = parseMoney(floorVal)
    if (n != null) { onSaveBudget({ ...budget, cashFloor: Math.max(0, n) }); setEditFloor(false) }
  }
  const b = otb.breakdown

  return (
    <div style={{ ...cardStyle, borderTop:`3px solid ${stateColor}` }}>
      <div style={cardLabel}>Open to Buy · This Week</div>
      <div style={{ ...cardBig, color: otb.state === 'hold' ? D.danger : D.navy }}>
        {otb.state === 'hold' ? '$0 — cover expenses first' : `${fmt(otb.availableNow)} now`}
      </div>
      <div style={cardSub}>
        {otb.state === 'hold'
          ? <>The {fmt(otb.reserve)} reserve exceeds cash on hand — let deposits land before buying.</>
          : <>up to {fmt(otb.availableUpper)} as deposits land (~{fmt(otb.weeklyDeposits)}/wk expected)</>}
      </div>
      <div style={{ ...cardSub, marginTop:7 }}>
        Reserved {fmt(otb.reserve)}: OpEx {fmt(b.avgOpex)} · card {fmt(b.ccMonthly)} · tax set-aside {fmt(b.taxOwed)} ·{' '}
        floor {editFloor ? (
          <span style={{ display:'inline-flex', gap:4 }}>
            <input style={{ ...inputSt, width:70, fontSize:10 }} value={floorVal} placeholder={String(b.floor)}
              onChange={e => setFloorVal(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveFloor()} autoFocus />
            <button style={{ ...btnGhost, fontSize:9.5, padding:'2px 7px' }} onClick={saveFloor}>set</button>
          </span>
        ) : (
          <button style={linkBtn} onClick={() => { setFloorVal(String(b.floor || '')); setEditFloor(true) }}>{fmt(b.floor)}</button>
        )}
      </div>
      {otb.weeklyBuys > 0 && (
        <div style={cardSub}>Typical buying pace: {fmt(otb.weeklyBuys)}/wk</div>
      )}
      {otb.stale && (
        <div style={{ marginTop:8 }}>
          <span style={amberNote}>
            ⚠ cash balance {otb.staleDays != null ? `${otb.staleDays} days old` : 'undated'} — update it on the Cash Runway card
          </span>
        </div>
      )}
    </div>
  )
}
