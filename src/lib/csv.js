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
  return `${y}-${m}-${d}`
}

export function fingerprint(row) {
  if (row.reference_id) return `ref:${row.reference_id}`
  return `${row.transaction_date}|${row.amount}|${(row.description || '').toLowerCase().trim()}`
}

export const STANDARD_FIELDS = [
  { key: 'transaction_date', label: 'Date',         required: true  },
  { key: 'description',      label: 'Description',  required: true  },
  { key: 'amount',           label: 'Amount',       required: false },
  { key: 'account',          label: 'Account',      required: false },
  { key: 'reference_id',     label: 'Reference ID', required: false },
  { key: 'category',         label: 'Category',     required: false },
]

export const DEFAULT_CFG = () => ({
  bankName: '', dateFormat: 'MM/DD/YYYY', splitAmounts: false, debitsPositive: false,
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
      account:          find(['account name', 'account number', 'account']),
      reference_id:     find(['ref num', 'reference', 'ref', 'check number', 'transaction id', 'confirmation']),
      category:         find(['category']),
      credit, debit,
    },
  }
}
