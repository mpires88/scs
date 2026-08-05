// Shared design tokens — the single source of truth for the app's palette.

export const T = {
  navy: '#1B3A5C', gold: '#A08A3C', charcoal: '#4A4A4A',
  page: '#F5F4F0', card: '#FAFAF8', border: '#D9D6CF',
  steel: '#4A7BA7', success: '#059669', danger: '#DC2626', amber: '#D97706',
}

export const PIE_COLORS = [
  '#1B3A5C', '#A08A3C', '#4A7BA7', '#059669', '#D97706',
  '#DC2626', '#3D7D7A', '#6B6560', '#2d6a9f', '#c49a28',
]

export const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Statement table geometry. The P&L, Balance Sheet and Cash Flow stack on one
// page, so their columns have to be the same width or the eye can't read down
// a month across the three. Kept here rather than in each component precisely
// so they can't drift apart.
//
// The label column is fixed and truncates (with a title tooltip) — letting it
// size to content would make the widest account name on any one statement throw
// the other two out of line.
export const STMT = {
  label:   240,   // account / line name
  num:      56,   // one month
  numWide:  64,   // one year, in the yearly view
  total:    74,
}

export const fmt = n => {
  if (n == null || isNaN(n)) return '—'
  return (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString()
}

export const fmtK = n => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n)
  return (n < 0 ? '-' : '') + (abs >= 1000 ? '$' + (abs / 1000).toFixed(0) + 'K' : '$' + Math.round(abs))
}

export const fmtPct = n => (n == null || isNaN(n)) ? '—' : n.toFixed(1) + '%'

export const fmt2 = n =>
  (n == null || isNaN(n)) ? '—' : (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const fmtPeriod = p => {
  if (!p) return ''
  const [y, m] = p.split('-')
  return new Date(+y, +m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' })
}

// Compact column label for a 'YYYY-MM' key: "Mar '24".
export const fmtYm = ym => {
  const [y, m] = String(ym).split('-')
  return `${MON[+m]} '${String(y).slice(2)}`
}
