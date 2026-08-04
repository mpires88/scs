import { useState } from 'react'
import { T, fmt } from '../lib/theme'

// ─── Follow one case of cards ─────────────────────────────────────────────────
// Walks a single purchase from the supplier's table, onto the shelf, into a
// customer's hands — recalculating four figures at each step. The argument is
// carried by "Business is worth": it holds still through the buy, the wait and
// the restock, and moves exactly once, on the sale.
//
// The teaching figures are deliberately round. Real ones would be harder to
// follow in your head, which defeats the point; the shop's actual position is
// stated once at the end, from live data.

const STEPS = [
  {
    tag: 'Start', bank: 10000, shelf: 0, profit: 0,
    shelfNote: 'Empty', custNote: "Hasn't walked in yet", custHas: false,
    title: 'A normal Tuesday morning',
    body: 'Ten thousand in the bank, nothing on the shelf, no sales yet this month. Watch the four numbers below and nothing else.',
    verdict: 'Baseline', tone: 'calm',
  },
  {
    tag: 'Buy', bank: 8000, shelf: 2000, profit: 0,
    shelfNote: '1 case, unopened', custNote: "Still hasn't walked in", custHas: false,
    flow: { ch: 1, goods: '1 case', cash: '$2,000' },
    title: 'You buy a case from the supplier for $2,000',
    body: 'Cash goes across the table to them; the case comes back to you and goes straight on the shelf. The bank drops by two thousand — and that is the entire event. You did not lose $2,000, you are holding it in cardboard instead of currency.',
    verdict: 'Profit moved $0', tone: 'warn',
  },
  {
    tag: 'Wait', bank: 8000, shelf: 2000, profit: 0,
    shelfNote: '1 case, waiting', custNote: 'Browsing, not buying', custHas: false,
    title: 'Six weeks go by',
    body: 'Nothing changes. Not one of the four numbers. Time sitting on the shelf is not a loss, however much it feels like one when the rent is due.',
    verdict: 'Still $0', tone: 'calm',
  },
  {
    tag: 'Sell', bank: 9600, shelf: 1000, profit: 600,
    shelfNote: 'Half a case left', custNote: 'Paid $1,600, walked out happy', custHas: true,
    flow: { ch: 2, goods: 'half the case', cash: '$1,600' },
    title: 'A customer buys half the case for $1,600',
    body: 'Three things move at once. Their money comes in, cards leave the shelf at what they cost you — $1,000 — and the $600 gap between those two is the first real profit of the month. This is the only step so far where the business actually got richer.',
    verdict: 'First profit: $600', tone: 'good',
  },
  {
    tag: 'Restock', bank: 3600, shelf: 7000, profit: 600,
    shelfNote: 'Half a case + 3 new', custNote: 'Will be back', custHas: true,
    flow: { ch: 1, goods: '3 cases', cash: '$6,000' },
    title: 'Buying season — three more cases, $6,000',
    body: 'This is the screen that frightens you. The bank is down 64% from where you started the month. And yet you are $600 up, holding $7,000 of stock, and the business is worth more than it was on Tuesday. Nothing has gone wrong. This is simply what a card shop looks like in August.',
    verdict: 'Profit still $600 — the bank is not the scoreboard', tone: 'warn',
  },
]

const signed = n => (n ? `${n > 0 ? '+' : '−'}${fmt(Math.abs(n)).replace('$', '$')}` : 'no change')

export default function FollowTheCase({ stats = null }) {
  const [idx, setIdx] = useState(0)
  const cur  = STEPS[idx]
  const prev = STEPS[Math.max(0, idx - 1)]
  const worth = cur.bank + cur.shelf
  const prevWorth = prev.bank + prev.shelf

  const figures = [
    { label: 'In the bank',       value: cur.bank,   delta: idx ? cur.bank - prev.bank : 0 },
    { label: 'On the shelf',      value: cur.shelf,  delta: idx ? cur.shelf - prev.shelf : 0 },
    { label: 'Profit so far',     value: cur.profit, delta: idx ? cur.profit - prev.profit : 0 },
    { label: 'Business is worth', value: worth,      delta: idx ? worth - prevWorth : 0, sunk: true },
  ]

  return (
    <section style={s.wrap}>
      <style>{CSS}</style>

      <h3 style={s.kicker}>Follow one case of cards</h3>
      <p style={s.lede}>
        From the supplier&apos;s table, onto your shelf, into a customer&apos;s hands. Step
        through it and watch the four numbers underneath. <strong>Three of them move
        constantly. One of them barely moves at all</strong> — and that one is the business.
      </p>

      {/* ── Stage ── */}
      <div style={s.stageWrap}>
        <div style={s.stage}>
          <Zone label="Supplier" note="Card show · distributor" glyph={<SupplierGlyph />} />

          <Channel active={cur.flow?.ch === 1} flow={cur.flow} stepKey={idx} />

          <div style={{ ...s.zone, background: T.page, borderLeft: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}` }}>
            <Shelf value={cur.shelf} stepKey={idx} />
            <div style={s.shelfRule} />
            <div style={s.zLabel}>Your shelf</div>
            <div style={s.zNote}>{cur.shelfNote}</div>
            <div style={{ ...s.zTotal, color: T.gold }}>{fmt(cur.shelf)}</div>
          </div>

          <Channel active={cur.flow?.ch === 2} flow={cur.flow} stepKey={idx} />

          <Zone label="Customer" note={cur.custNote} glyph={<CustomerGlyph holding={cur.custHas} />} />
        </div>
      </div>

      {/* ── Ledger strip ── */}
      <dl style={s.strip}>
        {figures.map(f => (
          <div key={f.label} style={{ ...s.cell, ...(f.sunk ? { background: T.page } : {}) }}>
            <dt style={s.cellLabel}>{f.label}</dt>
            <dd style={s.cellValue}>{fmt(f.value)}</dd>
            <span style={{
              ...s.delta,
              color: f.delta > 0 ? T.success : f.delta < 0 ? T.danger : 'rgba(74,74,74,0.5)',
            }}>{signed(f.delta)}</span>
          </div>
        ))}
      </dl>

      {/* ── Stepper ── */}
      <div style={s.rail} role="tablist" aria-label="Steps">
        {STEPS.map((st, i) => (
          <button
            key={st.tag} type="button" role="tab" aria-current={i === idx}
            onClick={() => setIdx(i)}
            style={{ ...s.railBtn, ...(i === idx ? s.railBtnOn : {}) }}
          >{st.tag}</button>
        ))}
      </div>

      <div style={s.scene} aria-live="polite">
        <h4 style={s.sceneTitle}>{cur.title}</h4>
        <p style={s.sceneBody}>{cur.body}</p>
        <span style={{ ...s.verdict, ...VERDICT[cur.tone] }}>{cur.verdict}</span>
      </div>

      <div style={s.nav}>
        <button type="button" style={{ ...s.btn, ...s.btnGhost, ...(idx === 0 ? s.btnOff : {}) }}
          disabled={idx === 0} onClick={() => setIdx(i => Math.max(0, i - 1))}>← Back</button>
        <button type="button" style={{ ...s.btn, ...(idx === STEPS.length - 1 ? s.btnOff : {}) }}
          disabled={idx === STEPS.length - 1} onClick={() => setIdx(i => Math.min(STEPS.length - 1, i + 1))}>
          {idx === STEPS.length - 1 ? "That's the whole cycle" : 'Next step →'}
        </button>
      </div>

      {/* ── What you just watched ── */}
      <div style={s.pts}>
        {[
          ['Buying isn’t spending', 'Paying the supplier moved money from the bank to the shelf. The business was worth exactly the same before and after. No profit, no loss, nothing on the P&L.', true],
          ['Only the customer creates profit', 'The one moment the business got richer was the sale — and only by the gap between what the customer paid and what those cards cost you.', true],
          ['So the bank lies', 'A low balance right after buying season means you bought well, not that you’re failing. The number to watch is whether the shelf keeps turning into sales.', false],
        ].map(([h, b, key]) => (
          <div key={h} style={{ ...s.pt, borderTopColor: key ? T.gold : T.border }}>
            <h4 style={s.ptTitle}>{h}</h4>
            <p style={s.ptBody}>{b}</p>
          </div>
        ))}
      </div>

      {stats && stats.inventory > 0 && (
        <p style={s.real}>
          <strong>Your shop, {stats.year} so far.</strong>{' '}
          <b style={s.num}>{fmt(stats.inventory)}</b> went from the bank onto the shelf across{' '}
          <b style={s.num}>{stats.buys}</b> purchases, against <b style={s.num}>{fmt(stats.revenue)}</b>{' '}
          of sales. That first number is the one that makes the bank balance look alarming — and it
          is the one that isn&apos;t a cost at all until a customer carries the cards out of the door.
        </p>
      )}
    </section>
  )
}

// ─── Stage pieces ─────────────────────────────────────────────────────────────

function Zone({ label, note, glyph }) {
  return (
    <div style={s.zone}>
      <div style={s.glyph}>{glyph}</div>
      <div style={s.zLabel}>{label}</div>
      <div style={s.zNote}>{note}</div>
    </div>
  )
}

// Goods travel right, money travels left. The cash chip is delayed a beat so
// the pair reads as one exchange rather than two things blinking at once.
// Remounting on `stepKey` is what replays the CSS animation.
function Channel({ active, flow, stepKey }) {
  return (
    <div style={s.channel}>
      <div style={s.lane}>
        <span style={s.laneRule} />
        {active && <span key={`g${stepKey}`} className="ftc-goods" style={{ ...s.chip, ...s.chipGoods }}>{flow.goods}</span>}
        <span style={{ ...s.arrow, right: 0 }}>→</span>
      </div>
      <div style={s.lane}>
        <span style={s.laneRule} />
        {active && <span key={`c${stepKey}`} className="ftc-cash" style={{ ...s.chip, ...s.chipCash }}>{flow.cash}</span>}
        <span style={{ ...s.arrow, left: 0 }}>←</span>
      </div>
    </div>
  )
}

// One glyph per $500, so a full shelf reads as stock rather than a bar chart.
function Shelf({ value, stepKey }) {
  const units = Math.round(value / 500)
  if (!units) return <div style={s.shelfStack}><span style={s.emptyShelf}>— empty —</span></div>
  return (
    <div style={s.shelfStack}>
      {Array.from({ length: Math.min(units, 14) }, (_, i) => (
        <i key={`${stepKey}-${i}`} className="ftc-box"
          style={{ ...s.box, height: 30 + (i % 3) * 7, animationDelay: `${i * 26}ms` }} />
      ))}
    </div>
  )
}

function SupplierGlyph() {
  return (
    <svg width="74" height="62" viewBox="0 0 74 62" fill="none" aria-hidden="true" style={{ color: T.charcoal }}>
      <path d="M8 22h58v4H8z" fill="currentColor" opacity=".28" />
      <path d="M12 26v30M62 26v30" stroke="currentColor" strokeWidth="2" opacity=".4" />
      <path d="M6 22 14 8h46l8 14" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" opacity=".55" fill="none" />
      <rect x="20" y="30" width="15" height="18" rx="1.5" fill={T.gold} stroke="currentColor" strokeOpacity=".35" />
      <rect x="39" y="34" width="15" height="14" rx="1.5" fill={T.gold} stroke="currentColor" strokeOpacity=".35" opacity=".75" />
    </svg>
  )
}

function CustomerGlyph({ holding }) {
  return (
    <svg width="60" height="62" viewBox="0 0 60 62" fill="none" aria-hidden="true" style={{ color: T.charcoal }}>
      <circle cx="30" cy="15" r="9" stroke="currentColor" strokeWidth="2" opacity=".55" fill="none" />
      <path d="M13 56c0-11 7.6-19 17-19s17 8 17 19" stroke="currentColor" strokeWidth="2" opacity=".55" fill="none" strokeLinecap="round" />
      <g opacity={holding ? 1 : 0} style={{ transition: 'opacity .3s ease' }}>
        <rect x="38" y="34" width="16" height="21" rx="2" fill={T.gold} stroke="currentColor" strokeOpacity=".4" />
        <path d="M41 40h10M41 44h7" stroke={T.card} strokeWidth="1.6" strokeLinecap="round" opacity=".85" />
      </g>
    </svg>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const CSS = `
@keyframes ftcSlideR { from { transform: translate(-190%, -50%) scale(.85); opacity: 0 } }
@keyframes ftcSlideL { from { transform: translate(90%, -50%) scale(.85); opacity: 0 } }
@keyframes ftcPop    { from { transform: translateY(9px) scaleY(.6); opacity: 0 } }
.ftc-goods { animation: ftcSlideR .62s cubic-bezier(.3,.7,.3,1) }
.ftc-cash  { animation: ftcSlideL .62s cubic-bezier(.3,.7,.3,1) .21s both }
.ftc-box   { animation: ftcPop .34s cubic-bezier(.2,.8,.3,1.2) both }
@media (prefers-reduced-motion: reduce) {
  .ftc-goods, .ftc-cash, .ftc-box { animation-duration: .001ms !important; animation-delay: 0ms !important }
}
`

const VERDICT = {
  calm: { background: T.page,   color: T.charcoal, borderColor: T.border },
  warn: { background: '#FEF3C7', color: '#92400E', borderColor: '#FCD34D' },
  good: { background: '#E6F0E9', color: '#12603A', borderColor: '#B8D4BE' },
}

const s = {
  wrap:      { background: T.card, borderRadius: 7, padding: '18px 20px 22px', marginBottom: 14,
               borderTop: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}`,
               borderBottom: `1px solid ${T.border}`, borderLeft: `3px solid ${T.gold}` },
  kicker:    { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase',
               letterSpacing: '.07em', margin: '0 0 10px' },
  lede:      { fontSize: 12, lineHeight: 1.72, color: T.charcoal, margin: '0 0 16px', maxWidth: '62ch' },

  stageWrap: { border: `1px solid ${T.border}`, borderRadius: 5, background: '#fff', overflowX: 'auto' },
  stage:     { display: 'grid', minWidth: 640, gridTemplateColumns: '1fr 96px 1.15fr 96px 1fr', alignItems: 'stretch' },
  zone:      { padding: '22px 14px 16px', textAlign: 'center', display: 'flex',
               flexDirection: 'column', alignItems: 'center', gap: 1 },
  glyph:     { height: 62, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  zLabel:    { fontSize: 10, fontWeight: 700, color: T.navy, textTransform: 'uppercase',
               letterSpacing: '.13em', marginTop: 10 },
  zNote:     { fontSize: 11, color: 'rgba(74,74,74,0.6)', lineHeight: 1.45, marginTop: 2 },
  zTotal:    { fontSize: 15, fontWeight: 700, marginTop: 6, fontVariantNumeric: 'tabular-nums' },

  shelfStack:{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 3, height: 62 },
  box:       { width: 14, borderRadius: 1, background: T.gold, border: '1px solid #7d6b2f', display: 'block' },
  shelfRule: { width: 72, height: 2, background: 'rgba(74,74,74,0.35)', margin: '4px auto 0', borderRadius: 1 },
  emptyShelf:{ fontSize: 10.5, color: '#B4B0A8', alignSelf: 'center' },

  channel:   { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, padding: '22px 0 16px' },
  lane:      { position: 'relative', height: 24 },
  laneRule:  { position: 'absolute', left: 6, right: 6, top: '50%', height: 1, background: T.border },
  chip:      { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
               fontSize: 9.5, letterSpacing: '.02em', whiteSpace: 'nowrap', padding: '3px 7px',
               borderRadius: 2, borderWidth: 1, borderStyle: 'solid', fontWeight: 600 },
  chipGoods: { background: '#FDE8E8', color: T.danger, borderColor: '#F5C2C2' },
  chipCash:  { background: '#E6F0E9', color: '#12603A', borderColor: '#B8D4BE' },
  arrow:     { position: 'absolute', top: '50%', transform: 'translateY(-50%)', fontSize: 11,
               color: '#B4B0A8' },

  strip:     { display: 'grid', gap: 1, background: T.border, margin: '16px 0 0',
               gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
               border: `1px solid ${T.border}`, borderRadius: 4, overflow: 'hidden' },
  cell:      { background: '#fff', padding: '12px 14px' },
  cellLabel: { fontSize: 9, fontWeight: 700, letterSpacing: '.13em', textTransform: 'uppercase',
               color: T.gold, display: 'block' },
  cellValue: { margin: '6px 0 0', fontSize: 21, fontWeight: 700, color: T.navy,
               fontVariantNumeric: 'tabular-nums', letterSpacing: '-.02em' },
  delta:     { display: 'block', marginTop: 2, fontSize: 10.5, fontVariantNumeric: 'tabular-nums',
               minHeight: '1.3em' },

  rail:      { display: 'flex', marginTop: 16, border: `1px solid ${T.border}`, borderRadius: 4,
               overflow: 'hidden' },
  railBtn:   { flex: '1 1 0', appearance: 'none', border: 'none', borderRight: `1px solid ${T.border}`,
               cursor: 'pointer', background: '#fff', color: T.charcoal, fontSize: 10,
               letterSpacing: '.07em', textTransform: 'uppercase', padding: '9px 4px', fontWeight: 600 },
  railBtnOn: { background: T.navy, color: '#fff' },

  scene:     { marginTop: 18, minHeight: 118 },
  sceneTitle:{ fontSize: 15, fontWeight: 600, color: T.navy, margin: '0 0 8px' },
  sceneBody: { fontSize: 12, lineHeight: 1.72, color: T.charcoal, margin: 0, maxWidth: '62ch', opacity: .92 },
  verdict:   { display: 'inline-block', marginTop: 12, padding: '4px 11px', borderRadius: 3,
               fontSize: 11, fontWeight: 600, borderWidth: 1, borderStyle: 'solid' },

  nav:       { display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' },
  btn:       { appearance: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 500,
               padding: '7px 15px', borderRadius: 5, border: `1px solid ${T.navy}`,
               background: T.navy, color: '#fff' },
  btnGhost:  { background: 'transparent', color: T.charcoal, borderColor: T.border },
  btnOff:    { opacity: .35, cursor: 'not-allowed' },

  pts:       { display: 'grid', gap: 16, marginTop: 26,
               gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' },
  pt:        { borderTop: '2px solid', paddingTop: 11 },
  ptTitle:   { fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase',
               color: T.gold, margin: '0 0 6px' },
  ptBody:    { fontSize: 11.5, lineHeight: 1.62, color: T.charcoal, margin: 0 },

  real:      { marginTop: 22, padding: '13px 15px', borderRadius: 5, background: T.page,
               border: `1px solid ${T.border}`, fontSize: 12, lineHeight: 1.68,
               color: T.charcoal, maxWidth: '68ch' },
  num:       { fontVariantNumeric: 'tabular-nums', color: T.navy },
}
