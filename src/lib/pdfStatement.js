// Credit-card statement PDF parsing.
//
// Split deliberately in two halves: `extractPdfLines` (bottom of this file) is
// the browser-only pdf.js work, everything above it is pure functions over
// already-reconstructed text lines so the parsing rules stay testable in Node.
//
// Written against Capital One Spark statements, whose transaction tables lay
// out as `Trans Date | Post Date | Description | Amount`. Any issuer using that
// same four-column shape parses without changes.

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const utc = s => Date.parse(`${s}T00:00:00Z`)
const DAY = 86400000

// Statement amounts: "$13.00", "- $500.00", "($13.00)". Returns a signed number
// in the *statement's* convention (positive = increases the balance owed).
function parseAmount(raw) {
  const s = String(raw).trim()
  const neg = s.startsWith('-') || (s.startsWith('(') && s.endsWith(')'))
  const digits = s.replace(/[^\d.]/g, '')
  if (!/^\d+(\.\d+)?$/.test(digits)) return null
  const n = parseFloat(digits)
  return neg ? -n : n
}

// ─── Line reconstruction ──────────────────────────────────────────────────────

// pdf.js emits one item per text run; a table row's cells share a y. Group by y,
// order by x, and join — inserting a space only where the runs don't already
// supply one, since the statement's column padding is itself a (wide) space run.
export function itemsToLines(items, { yTolerance = 2 } = {}) {
  const rows = []
  items.forEach(it => {
    if (!it || typeof it.str !== 'string' || it.str === '') return
    const row = rows.find(r => Math.abs(r.y - it.y) <= yTolerance)
    if (row) row.items.push(it)
    else rows.push({ y: it.y, items: [it] })
  })
  return rows
    .sort((a, b) => b.y - a.y) // pdf y grows upward, so top of page is last
    .map(r => r.items
      .sort((a, b) => a.x - b.x)
      .reduce((acc, it) => (acc && !/\s$/.test(acc) && !/^\s/.test(it.str) ? `${acc} ` : acc) + it.str, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
}

// ─── Statement parsing ────────────────────────────────────────────────────────

// "May 12, 2026 - Jun 10, 2026" in the page header.
export function parseCycle(lines) {
  const re = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\s*[-–—]\s*([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/
  for (const line of lines) {
    const m = line.match(re)
    if (!m) continue
    const m1 = MONTHS[m[1].toLowerCase()], m2 = MONTHS[m[4].toLowerCase()]
    if (!m1 || !m2) continue
    return { start: iso(m[3], m1, m[2]), end: iso(m[6], m2, m[5]) }
  }
  return null
}

// Transaction rows carry no year ("Jun 1"). Pick whichever of the cycle's years
// puts the date closest to the cycle, so a Dec→Jan cycle resolves both sides.
export function resolveYear(month, day, cycle) {
  if (!cycle) return null
  const years = [...new Set([+cycle.start.slice(0, 4), +cycle.end.slice(0, 4)])]
  const lo = utc(cycle.start), hi = utc(cycle.end)
  let best = null, bestDist = Infinity
  years.forEach(y => {
    const t = Date.UTC(y, month - 1, day)
    const dist = t < lo ? lo - t : t > hi ? t - hi : 0
    if (dist < bestDist) { bestDist = dist; best = { year: y, dist: dist / DAY } }
  })
  return best
}

const TXN_RE   = /^([A-Za-z]{3})\.?\s+(\d{1,2})\s+([A-Za-z]{3})\.?\s+(\d{1,2})\s+(.+?)\s+(-?\s*\(?\$[\d,]+\.\d{2}\)?)$/
const TOTAL_RE = /^Total (Transactions|Fees|Interest) for This Period\s+\(?-?\$?([\d,]+\.\d{2})\)?$/i

// `lines` is the whole document, in reading order. Returns normalized rows in
// the app's convention (expenses negative) plus metadata for the review step.
export function parseCardStatement(lines) {
  const cycle = parseCycle(lines)
  const warnings = []
  const rows = [], interest = []
  const totals = {}
  let section = null

  lines.forEach(line => {
    if (/:\s*Payments, Credits and Adjustments$/i.test(line)) { section = 'payments'; return }
    if (/:\s*Transactions$/i.test(line))                      { section = 'transactions'; return }
    if (/^Fees$/i.test(line))                                 { section = 'fees'; return }
    if (/^Interest Charged$/i.test(line))                     { section = 'interest'; return }
    if (/^Totals Year-to-Date$/i.test(line))                  { section = 'ytd'; return }

    const total = line.match(TOTAL_RE)
    if (total) { totals[total[1].toLowerCase()] = parseAmount(total[2]); return }

    if (section === 'interest') {
      const m = line.match(/^(Interest Charge on .+?)\s+\(?-?\$([\d,]+\.\d{2})\)?$/i)
      if (m) {
        const amt = parseAmount(m[2])
        if (amt) interest.push({ label: m[1].trim(), amount: amt })
      }
      return
    }

    const m = line.match(TXN_RE)
    if (!m) return
    const mon = MONTHS[m[1].toLowerCase()]
    if (!mon) return
    const day = +m[2]
    const amount = parseAmount(m[6])
    if (amount === null) return

    const resolved = resolveYear(mon, day, cycle)
    if (!resolved) { warnings.push(`No statement period found — cannot date "${m[5]}"`); return }
    if (resolved.dist > 45) warnings.push(`"${m[5]}" (${m[1]} ${day}) falls well outside the statement period`)

    rows.push({
      transaction_date: iso(resolved.year, mon, day),
      description: m[5].trim(),
      amount: -amount, // statement is positive-is-a-charge; the app wants expenses negative
      section: section || 'transactions',
    })
  })

  // The statement prints its own totals — reconcile so a silently dropped row
  // surfaces at review time instead of as a quiet shortfall in the ledger.
  const charged = rows.filter(r => r.section !== 'payments').reduce((s, r) => s - r.amount, 0)
  const stated = (totals.transactions ?? 0) + (totals.fees ?? 0)
  if (totals.transactions != null && Math.abs(charged - stated) > 0.005) {
    warnings.push(`Parsed charges total $${charged.toFixed(2)} but the statement says $${stated.toFixed(2)}`)
  }

  return {
    rows,
    interest: interest.map(i => ({
      transaction_date: cycle?.end ?? null,
      description: i.label.toUpperCase(),
      amount: -i.amount,
    })),
    cycle,
    totals,
    card: parseCardIdentity(lines),
    warnings,
  }
}

// "Spark Classic credit card | Business Mastercard ending in 3877" → a stable
// account label, so card rows are distinguishable from bank rows in the ledger.
export function parseCardIdentity(lines) {
  const text = lines.join('\n')
  const last4 = text.match(/ending in (\d{4})/i)?.[1] ?? null
  const issuer = ['Capital One', 'Chase', 'American Express', 'Citi', 'Bank of America', 'Discover', 'Wells Fargo']
    .find(name => new RegExp(`\\b${name}\\b`, 'i').test(text)) ?? null
  const product = lines.find(l => /credit card\s*\|/i.test(l))?.split('|')[0].trim() ?? null
  return {
    issuer, last4, product,
    label: last4 ? `${issuer ?? 'Card'} ...${last4}` : (issuer ?? null),
  }
}

// ─── Browser extraction ───────────────────────────────────────────────────────

// pdf.js is ~1MB and only ever needed once a PDF is actually dropped, so it is
// imported lazily rather than bundled into the main chunk.
const loadPdfjs = async () => {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString()
  return pdfjs
}

// `load` is injectable so this can be exercised against pdf.js's Node-compatible
// "legacy" build outside a browser — the browser build needs DOM globals, which
// is how an API mistake here once shipped unnoticed.
export async function extractPdfLines(arrayBuffer, load = loadPdfjs) {
  const pdfjs = await load()
  // getDocument returns a *loading task*; the document proxy it resolves to has
  // no destroy() of its own, so teardown belongs to the task.
  const task = pdfjs.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false })
  try {
    const doc = await task.promise
    const lines = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const { items } = await page.getTextContent()
      lines.push(...itemsToLines(items.map(it => ({
        str: it.str, x: it.transform[4], y: it.transform[5],
      }))))
      page.cleanup()
    }
    return lines
  } finally {
    await task.destroy()
  }
}
