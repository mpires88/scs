// Deep links from a report figure to the transactions behind it.
//
// One place so the report writing the link and the page reading it can't drift
// on parameter names. Params:
//   cats  exact category names, comma-separated — what makes a figure's link
//         reproduce that figure rather than a fuzzy text match
//   q     free-text search, for links that have no clean category set
//   from  inclusive start date (YYYY-MM-DD)
//   to    inclusive end date
//   view  'flat' so the individual rows show, not merchant groups

// A figure spanning many accounts (a section subtotal) would otherwise produce
// an unusable URL. Past this the link falls back to the date range alone, which
// is still useful and honest — it just shows more than the one line.
const MAX_CATS_LEN = 1400

export const lastDayOfMonth = (year, month) =>
  `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`

// Report columns come in three shapes: a month number (monthly view), a year
// number (yearly view), and a 'YYYY-MM' string (all-dates view). `null` means
// the Total column — the whole statement period.
export function columnRange(column, { year, yearly = false, columns = [] } = {}) {
  const ymRange = ym => {
    const [y, m] = String(ym).split('-').map(Number)
    return { from: `${ym}-01`, to: lastDayOfMonth(y, m) }
  }
  const yearRange = y => ({ from: `${y}-01-01`, to: `${y}-12-31` })

  if (column == null) {
    // Total column: span everything the statement is showing.
    if (!columns.length) return year ? yearRange(year) : {}
    const first = columnRange(columns[0], { year, yearly })
    const last  = columnRange(columns[columns.length - 1], { year, yearly })
    return { from: first.from, to: last.to }
  }
  if (typeof column === 'string' && column.includes('-')) return ymRange(column)
  if (yearly) return yearRange(column)
  return year ? ymRange(`${year}-${String(column).padStart(2, '0')}`) : {}
}

export function buildTxnLink({ cats = [], q = '', from = '', to = '' } = {}) {
  const p = new URLSearchParams()
  const list = cats.filter(Boolean).join(',')
  if (list && list.length <= MAX_CATS_LEN) p.set('cats', list)
  else if (q) p.set('q', q)
  if (from) p.set('from', from)
  if (to)   p.set('to', to)
  p.set('view', 'flat')
  return `/transactions?${p.toString()}`
}

// Parse the other side. Kept here so the shape stays in one file.
export function readTxnParams(searchParams) {
  const get = k => searchParams?.get?.(k) ?? ''
  const cats = get('cats')
  return {
    cats: cats ? cats.split(',').map(s => s.trim()).filter(Boolean) : [],
    q:    get('q'),
    from: get('from'),
    to:   get('to'),
    view: get('view') === 'flat' ? 'flat' : null,
  }
}
