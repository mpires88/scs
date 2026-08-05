import { useEffect } from 'react'
import { T } from '../lib/theme'

// ─── Slide-out explainer ──────────────────────────────────────────────────────
// Plain-English guide to how a retail shop's money moves, written for the shop
// owner rather than the bookkeeper. The point it exists to make: buying
// inventory is not an expense, so a low bank balance next to a full shelf is
// the normal shape of a growing card shop — not a warning sign.

export default function BooksGuide({ open, onClose, noCogs = false }) {
  useEffect(() => {
    if (!open) return
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div style={g.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <aside style={g.panel} role="dialog" aria-modal="true" aria-labelledby="books-guide-title">
        <header style={g.head}>
          <div>
            <h3 id="books-guide-title" style={g.title}>How your books work</h3>
            <p style={g.subtitle}>Where the money goes, and why cash isn&apos;t the scoreboard</p>
          </div>
          <button style={g.close} onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div style={g.body}>
          <BooksGuideContent noCogs={noCogs} />
        </div>
      </aside>
    </div>
  )
}

// The guide's material, independent of how it's presented — the drawer above
// and the /help page both render this.
export function BooksGuideContent({ noCogs = false }) {
  return (
    <>
          {/* ── The cycle ── */}
          <Section title="The loop every dollar travels">
            <CycleDiagram />
            <p style={g.p}>
              Cash buys cards. Cards sit on the shelf until someone wants one. At the moment
              of the sale — and <em>only</em> then — the cost of that specific card becomes an
              expense called <strong>Cost of Goods Sold</strong>, the sale becomes{' '}
              <strong>Revenue</strong>, and the difference is your <strong>Gross Profit</strong>.
            </p>
          </Section>

          {/* ── The core misunderstanding ── */}
          <Section title="Buying inventory is not an expense">
            <p style={g.p}>
              Spend $5,000 on a case of cards and you have not lost $5,000. You traded one
              thing you own (cash) for another thing you own (inventory). Your business is
              worth exactly what it was worth five minutes earlier.
            </p>
            <p style={g.p}>
              Nothing about that purchase touches your Profit &amp; Loss. It moves money from
              one pocket to another on the Balance Sheet. This is why a heavy buying month can
              leave the bank account looking frightening while the business is completely fine.
            </p>
          </Section>

          {/* ── The reassurance, stated plainly ── */}
          <Section title="Low cash + full shelves = a growing shop" accent={T.success}>
            <div style={g.pull}>
              <div style={g.pullRow}>
                <span style={g.pullLabel}>What it feels like</span>
                <span style={g.pullBad}>&ldquo;I&apos;m running out of money.&rdquo;</span>
              </div>
              <div style={g.pullRow}>
                <span style={g.pullLabel}>What it usually is</span>
                <span style={g.pullGood}>&ldquo;My money is sitting on the shelf.&rdquo;</span>
              </div>
            </div>
            <p style={g.p}>
              Your money lives in two places: the bank and the shelf. Moving it from one to the
              other doesn&apos;t make you richer or poorer — it just changes the form it takes.
              A shop that just bought heavily is <em>supposed</em> to be cash-light and
              inventory-heavy. That&apos;s what buying season looks like on a balance sheet.
            </p>
            <p style={g.p}>
              The number worth watching isn&apos;t the bank balance on any given day. It&apos;s
              whether inventory is <strong>turning</strong> — selling through at a healthy
              margin, in reasonable time.
            </p>
            <div style={g.warnBox}>
              <strong style={{ color: '#92400E' }}>When it&apos;s worth worrying</strong>
              <ul style={g.ul}>
                <li>Inventory keeps climbing but sales don&apos;t follow — the cards aren&apos;t moving.</li>
                <li>Cash is too low to cover rent, payroll, or the tax set-aside this month.</li>
                <li>You&apos;re buying on a credit card and the balance carries month to month.</li>
              </ul>
              <p style={{ ...g.p, margin: '6px 0 0' }}>
                Those are real problems. A low balance the week after a big buy is not.
              </p>
            </div>
          </Section>

          {/* ── Inventory vs COGS ── */}
          <Section title="Inventory vs. COGS, side by side">
            <div style={g.tableWrap}>
              <table style={g.table}>
                <thead>
                  <tr>
                    <th style={{ ...g.th, width: '26%' }}></th>
                    <th style={{ ...g.th, color: T.navy }}>Inventory</th>
                    <th style={{ ...g.th, color: T.amber }}>COGS</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['What it is',    'Cards you own but haven’t sold yet', 'The cost of the cards you did sell'],
                    ['Where it lives', 'Balance Sheet — Current Assets',     'Profit & Loss — Cost of Goods Sold'],
                    ['Recorded when',  'The day you buy the cards',               'The day the card sells'],
                    ['Effect on profit', 'None at all',                           'Reduces gross profit'],
                    ['Category here',  'Inventory',                               'COGS - Product, COGS - Shipping'],
                  ].map(([k, a, b]) => (
                    <tr key={k}>
                      <td style={g.tdKey}>{k}</td>
                      <td style={g.td}>{a}</td>
                      <td style={g.td}>{b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ ...g.p, marginTop: 10 }}>
              Same dollars, two different moments. The cost of a card waits patiently in
              Inventory — sometimes for months — and only becomes an expense on the day a
              customer carries it out the door.
            </p>
          </Section>

          {noCogs && (
            <Section title="Right now, this shop isn't recording COGS" accent={T.amber}>
              <p style={g.p}>
                Inventory purchases are being logged, but no Cost of Goods Sold entries exist
                for some months with sales. That means the shelf never gets &ldquo;drawn
                down&rdquo; when cards sell, so the dashboard shows gross profit, margin, net
                P&amp;L, breakeven, and runway as <strong>better than they really are</strong>.
              </p>
              <p style={g.p}>
                Every figure carrying an amber <em>no COGS recorded</em> badge is affected. The
                badges clear month by month as COGS entries get booked.
              </p>
            </Section>
          )}

          {/* ── Number sources ── */}
          {/* ── The three statements ── */}
          <Section title="The three statements, and when to read each">
            <dl style={g.dl}>
              {[
                ['Profit & Loss', `Did the shop make money over a stretch of time? Sales (with the state's
                  sales-tax cut already out), minus what the product cost you, minus the cost of keeping
                  the doors open. On this shop's margins roughly 83¢ of each sales dollar goes back into
                  product, so a big month isn't automatically a good month — watch Gross Profit for
                  whether the markup held.`],
                ['Balance Sheet', `A snapshot of a single day: what the shop owns (money in the bank,
                  product on the shelf), what it owes (sales tax collected but not yet sent, the credit
                  card), and your stake — everything left after the owing. When the P&L says you made
                  money but the bank looks thin, this shows where the profit went: usually onto the
                  shelf. Owns minus owes equals your stake, to the penny.`],
                ['Cash Flow', `Only money that actually moved through the bank — product buys, bills,
                  card payments, your draws. No estimates; if cash didn't move, it isn't here. Profit
                  and cash are different things, so when you're wondering where it all went, or whether
                  the shop can afford a big collection buy, read this one.`],
              ].map(([k, v]) => (
                <div key={k} style={g.dlRow}>
                  <dt style={g.dt}>{k}</dt>
                  <dd style={g.dd}>{v}</dd>
                </div>
              ))}
            </dl>
            <p style={{ ...g.p, marginTop: 12, opacity: .75 }}>
              Read them together: the P&amp;L says whether you earned it, the Balance Sheet says
              where it&apos;s sitting, and the Cash Flow says how it moved.
            </p>
          </Section>

          <Section title="Where each number comes from">
            <dl style={g.dl}>
              {[
                ['Revenue',        'Every transaction you filed under a Revenue category, less sales tax collected. Comes from your imported bank activity.'],
                ['COGS',           'Transactions filed under a Cost of Goods Sold category — what the cards you sold cost you.'],
                ['Gross Profit',   'Revenue minus COGS. What the sale earned before any of the costs of keeping the doors open.'],
                ['Gross Margin',   'Gross Profit as a percentage of Revenue. Roughly: of every sales dollar, how much survives the cost of the card.'],
                ['Operating Expenses', 'Rent, payroll, utilities, fees, supplies — the cost of being open, whether or not you sell a thing.'],
                ['Net P&L',        'Gross Profit minus Operating Expenses, plus or minus anything non-operating. The bottom line.'],
                ['Cash Runway',    'The bank balance you typed in, divided by your average monthly spend. It ages — update it when you check.'],
                ['Breakeven',      'Fixed monthly costs divided by gross margin. The monthly sales needed to cover the shop.'],
              ].map(([k, v]) => (
                <div key={k} style={g.dlRow}>
                  <dt style={g.dt}>{k}</dt>
                  <dd style={g.dd}>{v}</dd>
                </div>
              ))}
            </dl>
            <p style={{ ...g.p, marginTop: 12, opacity: .75 }}>
              Balance-sheet categories — Inventory, credit card payments, owner&apos;s draw —
              are deliberately kept out of every profit figure above. They move money around;
              they don&apos;t earn or lose it.
            </p>
          </Section>
    </>
  )
}

// ─── Illustration ─────────────────────────────────────────────────────────────
// Two bands: what the shop owns (balance sheet) above, how the month went
// (P&L) below. A single sale event is what crosses between them.

function CycleDiagram() {
  const box = (x, y, w, h, stroke) => (
    <>
      <rect x={x} y={y} width={w} height={h} rx="7" fill="#fff" stroke={T.border} strokeWidth="1" />
      <rect x={x} y={y} width={w} height="3" rx="1.5" fill={stroke} />
    </>
  )

  return (
    <svg viewBox="0 0 520 404" width="100%" role="img"
      aria-labelledby="cyc-t cyc-d" style={{ display: 'block', marginBottom: 14 }}>
      <title id="cyc-t">The retail cash cycle</title>
      <desc id="cyc-d">
        On the balance sheet, cash buys inventory — no expense is recorded. When a card
        sells, that single event records revenue and moves the card&apos;s cost into cost of
        goods sold on the profit and loss statement. Revenue minus cost of goods sold is
        gross profit, and the customer&apos;s payment returns to cash.
      </desc>

      <defs>
        {[['as', T.steel], ['ag', T.gold], ['an', T.navy], ['ae', T.success]].map(([id, c]) => (
          <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
          </marker>
        ))}
      </defs>

      {/* ── Balance sheet band ── */}
      <rect x="34" y="10" width="478" height="136" rx="9"
        fill={T.page} stroke={T.border} strokeWidth="1" strokeDasharray="4 3" />
      <text x="50" y="31" fill={T.gold} fontSize="9" fontWeight="700" letterSpacing="1.1">
        BALANCE SHEET · WHAT THE SHOP OWNS
      </text>

      {box(62, 54, 152, 76, T.steel)}
      <text x="138" y="84" textAnchor="middle" fill={T.navy} fontSize="14" fontWeight="700">CASH</text>
      <text x="138" y="105" textAnchor="middle" fill={T.charcoal} fontSize="10.5">in the bank</text>

      {box(332, 54, 152, 76, T.navy)}
      <text x="408" y="84" textAnchor="middle" fill={T.navy} fontSize="14" fontWeight="700">INVENTORY</text>
      <text x="408" y="105" textAnchor="middle" fill={T.charcoal} fontSize="10.5">cards on the shelf</text>

      <line x1="222" y1="92" x2="322" y2="92" stroke={T.steel} strokeWidth="1.6" markerEnd="url(#as)" />
      <text x="272" y="82" textAnchor="middle" fill={T.navy} fontSize="10.5" fontWeight="600">buy cards</text>
      <text x="272" y="112" textAnchor="middle" fill={T.amber} fontSize="9.5" fontWeight="600">not an expense</text>

      {/* ── The sale: the only thing that crosses ── */}
      <path d="M 408 130 C 408 154, 382 178, 350 178"
        fill="none" stroke={T.gold} strokeWidth="1.6" markerEnd="url(#ag)" />

      <rect x="210" y="160" width="134" height="36" rx="18" fill="#FBF6E7" stroke={T.gold} strokeWidth="1.2" />
      <text x="277" y="183" textAnchor="middle" fill="#7A6829" fontSize="11.5" fontWeight="700">A CARD SELLS</text>

      <path d="M 244 196 C 214 218, 160 222, 124 244"
        fill="none" stroke={T.success} strokeWidth="1.6" markerEnd="url(#ae)" />
      <path d="M 292 196 C 294 216, 282 226, 279 244"
        fill="none" stroke={T.gold} strokeWidth="1.6" markerEnd="url(#ag)" />

      {/* ── P&L band ── */}
      <rect x="34" y="210" width="478" height="182" rx="9"
        fill={T.page} stroke={T.border} strokeWidth="1" strokeDasharray="4 3" />
      <text x="50" y="231" fill={T.gold} fontSize="9" fontWeight="700" letterSpacing="1.1">
        PROFIT &amp; LOSS · HOW THE MONTH WENT
      </text>

      {box(52, 252, 134, 76, T.success)}
      <text x="119" y="282" textAnchor="middle" fill={T.navy} fontSize="13" fontWeight="700">REVENUE</text>
      <text x="119" y="303" textAnchor="middle" fill={T.charcoal} fontSize="10">what they paid</text>

      <text x="198" y="297" textAnchor="middle" fill={T.charcoal} fontSize="18" fontWeight="600">−</text>

      {box(210, 252, 134, 76, T.amber)}
      <text x="277" y="282" textAnchor="middle" fill={T.navy} fontSize="13" fontWeight="700">COGS</text>
      <text x="277" y="303" textAnchor="middle" fill={T.charcoal} fontSize="10">what the card cost</text>

      <text x="356" y="297" textAnchor="middle" fill={T.charcoal} fontSize="18" fontWeight="600">=</text>

      {box(368, 252, 134, 76, T.navy)}
      <text x="435" y="282" textAnchor="middle" fill={T.navy} fontSize="13" fontWeight="700">GROSS PROFIT</text>
      <text x="435" y="303" textAnchor="middle" fill={T.charcoal} fontSize="10">what you actually made</text>

      <text x="119" y="348" textAnchor="middle" fill={T.charcoal} fontSize="9.5" opacity="0.75">
        rent &amp; payroll come out after this
      </text>

      {/* ── Money returns to cash ── */}
      <path d="M 52 288 C 14 294, 9 240, 9 180 C 9 150, 58 138, 94 134"
        fill="none" stroke={T.success} strokeWidth="1.6" strokeDasharray="4 3" markerEnd="url(#ae)" />
      <text transform="rotate(-90 27 210)" x="27" y="210" textAnchor="middle"
        fill={T.success} fontSize="9.5" fontWeight="600">the customer pays you</text>
    </svg>
  )
}

// ─── Layout bits ──────────────────────────────────────────────────────────────

function Section({ title, accent = T.gold, children }) {
  return (
    <section style={{ ...g.section, borderLeft: `3px solid ${accent}` }}>
      <h4 style={g.sectionTitle}>{title}</h4>
      {children}
    </section>
  )
}

const g = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(27,58,92,.34)', zIndex: 900,
    display: 'flex', justifyContent: 'flex-end',
  },
  panel: {
    width: 'min(520px, 100%)', height: '100%', background: T.card,
    borderLeft: `1px solid ${T.border}`, boxShadow: '-14px 0 40px rgba(0,0,0,.14)',
    display: 'flex', flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  head: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
    padding: '15px 20px', background: '#fff', borderBottom: `1px solid ${T.border}`, flexShrink: 0,
  },
  title:    { fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 2px' },
  subtitle: { fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 },
  close: {
    background: 'none', border: 'none', fontSize: 15, color: '#9ca3af',
    cursor: 'pointer', padding: '2px 6px', borderRadius: 4, flexShrink: 0, lineHeight: 1,
  },
  body: { padding: '18px 20px 40px', overflowY: 'auto', flex: 1 },

  // Left border is set per-section for the accent colour, so the other three
  // are longhands rather than a `border` shorthand it would have to override.
  section: {
    background: '#fff', borderRadius: 7, padding: '14px 16px', marginBottom: 14,
    borderTop: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`,
  },
  sectionTitle: {
    fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase',
    letterSpacing: '.07em', margin: '0 0 10px',
  },
  p: { fontSize: 12, lineHeight: 1.72, color: T.charcoal, margin: '0 0 9px' },

  pull: { background: T.page, border: `1px solid ${T.border}`, borderRadius: 6, padding: '10px 12px', marginBottom: 11 },
  pullRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8, marginBottom: 5 },
  pullLabel: { fontSize: 9, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', minWidth: 118 },
  pullBad:  { fontSize: 12.5, color: T.danger,  fontWeight: 500 },
  pullGood: { fontSize: 12.5, color: T.success, fontWeight: 600 },

  warnBox: { background: '#FEF9EC', border: '1px solid #F5E3B8', borderRadius: 6, padding: '10px 13px', marginTop: 4, fontSize: 12 },
  ul: { fontSize: 12, lineHeight: 1.7, color: T.charcoal, margin: '6px 0 0', paddingLeft: 18 },

  tableWrap: { overflowX: 'auto', border: `1px solid ${T.border}`, borderRadius: 6 },
  table: { width: '100%', borderCollapse: 'collapse', minWidth: 380 },
  th: {
    textAlign: 'left', padding: '7px 10px', background: T.page, fontSize: 9.5, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '.06em', borderBottom: `1px solid ${T.border}`,
  },
  tdKey: { padding: '7px 10px', fontSize: 10.5, fontWeight: 600, color: T.gold, borderTop: `1px solid ${T.border}`, verticalAlign: 'top' },
  td:    { padding: '7px 10px', fontSize: 11.5, color: T.charcoal, borderTop: `1px solid ${T.border}`, lineHeight: 1.55, verticalAlign: 'top' },

  dl: { margin: 0 },
  dlRow: { display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0', borderTop: `1px solid ${T.border}` },
  dt: { flex: '0 0 118px', fontSize: 11, fontWeight: 700, color: T.navy, margin: 0 },
  dd: { flex: 1, fontSize: 11.5, lineHeight: 1.6, color: T.charcoal, margin: 0 },
}
