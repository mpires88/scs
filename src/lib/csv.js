// CSV parsing + bank-import helpers shared by the import flow.

export function parseCSVText(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++ }
      else if (c === '"') inQuotes = false
      else field += c
    } else {
      if      (c === '"')                { inQuotes = true }
      else if (c === ',')               { row.push(field.trim()); field = '' }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') i++
        row.push(field.trim())
        if (row.some(f => f !== '')) rows.push(row)
        row = []; field = ''
      } else field += c
    }
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(f => f !== '')) rows.push(row) }
  if (!rows.length) return { headers: [], rows: [] }
  const headers = rows[0]
  return { headers, rows: rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))) }
}

export const DATE_FORMATS = [
  { label: 'MM/DD/YYYY  e.g. 01/31/2024', value: 'MM/DD/YYYY' },
  { label: 'M/D/YYYY    e.g. 1/5/2024',   value: 'M/D/YYYY'   },
  { label: 'DD/MM/YYYY  e.g. 31/01/2024', value: 'DD/MM/YYYY' },
  { label: 'YYYY-MM-DD  e.g. 2024-01-31', value: 'YYYY-MM-DD' },
  { label: 'MM-DD-YYYY  e.g. 01-31-2024', value: 'MM-DD-YYYY' },
  { label: 'YYYY/MM/DD  e.g. 2024/01/31', value: 'YYYY/MM/DD' },
]

export function parseDate(raw, fmt) {
  const s = (raw || '').trim()
  if (!s) return null
  const sep = fmt.includes('-') ? '-' : '/'
  const parts = s.split(sep)
  if (parts.length !== 3) return null
  let y, m, d
  if (fmt.startsWith('YYYY'))    [y, m, d] = parts
  else if (fmt.startsWith('DD')) [d, m, y] = parts
  else                           [m, d, y] = parts
  m = String(+m).padStart(2, '0')
  d = String(+d).padStart(2, '0')
  if (String(y).length !== 4 || isNaN(+y) || isNaN(+m) || isNaN(+d)) return null
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null
  // Reject impossible dates (e.g. Feb 31) — they'd fail the whole insert batch at the DB
  const dt = new Date(`${y}-${m}-${d}T00:00:00Z`)
  if (dt.getUTCMonth() + 1 !== +m || dt.getUTCDate() !== +d) return null
  return `${y}-${m}-${d}`
}

// Cleans a raw bank CSV export and parses it. Handles: BOM, metadata preambles
// (e.g. Freedom Checking) — find the last header row containing both "date" and
// "description" as whole words ("update" must not match) and strip everything
// above it — and summary rows whose first field is "Totals" or a date range
// like "01/01/2024 - 01/31/2024" (must start with a digit — descriptions
// containing " - " are real data and stay).
export function parseBankCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  const allLines = text.split(/\r?\n/)
  let txnSectionStart = 0
  for (let i = 0; i < allLines.length; i++) {
    const lower = allLines[i].toLowerCase()
    if (/\bdate\b/.test(lower) && /\bdescription\b/.test(lower)) txnSectionStart = i
  }
  if (txnSectionStart > 0) text = allLines.slice(txnSectionStart).join('\n')

  const raw = parseCSVText(text)
  if (!raw.headers.length) return { headers: [], rows: [], skipped: 0 }
  const rows = raw.rows.filter(r => {
    const firstVal = (Object.values(r)[0] || '').trim()
    return firstVal.toLowerCase() !== 'totals' && !/^\d[\d/.-]*\s+-\s+\d/.test(firstVal)
  })
  return { headers: raw.headers, rows, skipped: raw.rows.length - rows.length }
}

export function fingerprint(row) {
  if (row.reference_id) return `ref:${String(row.reference_id).trim()}`
  const amt = Number(row.amount)
  // toFixed(2) matches the DB's rounding: split debit/credit imports compute
  // credit − debit, whose float artifacts (13.809999…) must fingerprint equal
  // to the 13.81 the DB stores. The zero guard avoids (-0).toFixed → "-0.00".
  const amtKey = Number.isFinite(amt) ? (amt === 0 ? 0 : amt).toFixed(2) : 'NaN'
  const desc = (row.description || '').toLowerCase().replace(/\s+/g, ' ').trim()
  return `${row.transaction_date}|${amtKey}|${desc}`
}

export const STANDARD_FIELDS = [
  { key: 'transaction_date', label: 'Date',         required: true  },
  { key: 'description',      label: 'Description',  required: true  },
  { key: 'amount',           label: 'Amount',       required: false },
  { key: 'account',          label: 'Account',      required: false },
  { key: 'reference_id',     label: 'Reference ID', required: false },
  { key: 'category',         label: 'Category',     required: false },
]

// catSource: where each row's category comes from.
//   'file'    — the mapped Category column (a bookkeeping export you trust)
//   'suggest' — ignore the file and match the description against how you have
//               categorized that merchant before. Card exports carry the
//               ISSUER's taxonomy ("Gas/Automotive", "Merchandise"), which means
//               nothing in this chart of accounts.
export const DEFAULT_CFG = () => ({
  bankName: '', dateFormat: 'MM/DD/YYYY', splitAmounts: false, debitsPositive: false,
  catSource: 'file',
  cols: { transaction_date: '', description: '', amount: '', credit: '', debit: '', account: '', reference_id: '', category: '' },
})

const LS_KEY_BANKS = 'csv_uploader_bank_mappings'
export const loadAllMappings = () => { try { return JSON.parse(localStorage.getItem(LS_KEY_BANKS) || '{}') } catch { return {} } }
export const saveBankMapping = (bank, cfg) => {
  const all = loadAllMappings(); all[bank] = cfg
  localStorage.setItem(LS_KEY_BANKS, JSON.stringify(all))
}

export function autoDetectCols(headers) {
  const find = (candidates) => {
    const h = headers.map(x => x.toLowerCase().trim())
    for (const c of candidates) {
      const idx = h.findIndex(x => x === c || x.includes(c))
      if (idx >= 0) return headers[idx]
    }
    return ''
  }
  const credit = find(['cr amount', 'credit amount', 'credit', 'deposits'])
  const debit  = find(['db amount', 'debit amount', 'debit', 'withdrawals'])
  const splitAmounts = !!(credit || debit)
  return {
    splitAmounts,
    cols: {
      transaction_date: find(['date', 'posted date', 'posting date', 'transaction date', 'trans date']),
      description:      find(['description', 'memo', 'payee', 'narrative', 'details', 'name', 'transaction description']),
      amount:           splitAmounts ? '' : find(['amount', 'transaction amount', 'net amount']),
      // 'Card No.' is deliberately NOT an account candidate: a card-number
      // fragment ("3877") is a terrible account label. Card exports have no
      // real account column — the import falls back to the bank name instead.
      account:          find(['account name', 'account number', 'account']),
      reference_id:     find(['ref num', 'reference', 'ref', 'check number', 'transaction id', 'confirmation']),
      category:         find(['category']),
      credit, debit,
    },
  }
}
