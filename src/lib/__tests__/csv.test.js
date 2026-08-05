import { describe, it, expect } from 'vitest'
import { parseCSVText, parseBankCSV, parseDate, fingerprint, autoDetectCols } from '../csv'

describe('autoDetectCols — Capital One card export', () => {
  // Real header row from a Capital One transaction_download CSV.
  const headers = ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit']

  it('maps the card export: transaction date and split debit/credit, but never Card No. as account', () => {
    const { cols, splitAmounts } = autoDetectCols(headers)
    expect(cols.transaction_date).toBe('Transaction Date') // not Posted Date
    expect(cols.account).toBe('') // "3877" is not an account label — bank name fallback applies
    expect(splitAmounts).toBe(true)
    expect(cols.debit).toBe('Debit')
    expect(cols.credit).toBe('Credit')
    // Capital One's own merchant categories DO auto-map — the user should
    // clear this mapping on import so "Gas/Automotive" etc. don't reach the DB.
    expect(cols.category).toBe('Category')
  })

  it('still prefers real account columns when a bank export has them', () => {
    const { cols } = autoDetectCols(['Date', 'Description', 'Amount', 'Account Name', 'Card No.'])
    expect(cols.account).toBe('Account Name')
  })
})

describe('parseDate', () => {
  it('parses all six supported formats', () => {
    expect(parseDate('01/31/2024', 'MM/DD/YYYY')).toBe('2024-01-31')
    expect(parseDate('1/5/2024',   'M/D/YYYY')).toBe('2024-01-05')
    expect(parseDate('31/01/2024', 'DD/MM/YYYY')).toBe('2024-01-31')
    expect(parseDate('2024-01-31', 'YYYY-MM-DD')).toBe('2024-01-31')
    expect(parseDate('01-31-2024', 'MM-DD-YYYY')).toBe('2024-01-31')
    expect(parseDate('2024/01/31', 'YYYY/MM/DD')).toBe('2024-01-31')
  })

  it('rejects impossible calendar dates', () => {
    expect(parseDate('02/31/2024', 'MM/DD/YYYY')).toBeNull()
    expect(parseDate('02/29/2023', 'MM/DD/YYYY')).toBeNull() // not a leap year
    expect(parseDate('02/29/2024', 'MM/DD/YYYY')).toBe('2024-02-29')
  })

  it('rejects malformed input', () => {
    expect(parseDate('', 'MM/DD/YYYY')).toBeNull()
    expect(parseDate('01/31', 'MM/DD/YYYY')).toBeNull()
    expect(parseDate('01/31/24', 'MM/DD/YYYY')).toBeNull() // 2-digit year
    expect(parseDate('13/01/2024', 'MM/DD/YYYY')).toBeNull()
    expect(parseDate('abc', 'MM/DD/YYYY')).toBeNull()
  })
})

describe('fingerprint', () => {
  it('prefers reference_id and trims it', () => {
    expect(fingerprint({ reference_id: ' 123 ' })).toBe('ref:123')
    expect(fingerprint({ reference_id: 123 })).toBe('ref:123')
  })

  it('normalizes float artifacts from split debit/credit arithmetic', () => {
    // The D7 case: credit − debit yields 13.809999…, the DB stores 13.81.
    const fromCsv = { transaction_date: '2024-01-05', amount: 27.31 - 13.5, description: 'STORE' }
    const fromDb  = { transaction_date: '2024-01-05', amount: 13.81,        description: 'STORE' }
    expect((27.31 - 13.5) === 13.81).toBe(false) // the artifact is real
    expect(fingerprint(fromCsv)).toBe(fingerprint(fromDb))
  })

  it('treats -0 (a debitsPositive flip of 0) as 0', () => {
    expect(fingerprint({ transaction_date: '2024-01-05', amount: -0, description: 'X' }))
      .toBe(fingerprint({ transaction_date: '2024-01-05', amount: 0, description: 'X' }))
  })

  it('collapses whitespace and case in descriptions', () => {
    expect(fingerprint({ transaction_date: '2024-01-05', amount: 5, description: '  COSTCO   GAS  ' }))
      .toBe(fingerprint({ transaction_date: '2024-01-05', amount: 5, description: 'costco gas' }))
  })

  it('still distinguishes genuinely different rows', () => {
    const a = { transaction_date: '2024-01-05', amount: 5, description: 'costco' }
    expect(fingerprint({ ...a, amount: 5.01 })).not.toBe(fingerprint(a))
    expect(fingerprint({ ...a, transaction_date: '2024-01-06' })).not.toBe(fingerprint(a))
    expect(fingerprint({ ...a, description: 'costco gas' })).not.toBe(fingerprint(a))
  })
})

describe('parseCSVText', () => {
  it('parses quoted fields with embedded commas and escaped quotes', () => {
    const { headers, rows } = parseCSVText('a,b\n"x, y","say ""hi"""\n')
    expect(headers).toEqual(['a', 'b'])
    expect(rows).toEqual([{ a: 'x, y', b: 'say "hi"' }])
  })

  it('handles CRLF line endings and skips blank rows', () => {
    const { rows } = parseCSVText('a,b\r\n1,2\r\n,\r\n3,4\r\n')
    expect(rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }])
  })

  it('returns empty shape for empty input', () => {
    expect(parseCSVText('')).toEqual({ headers: [], rows: [] })
  })
})

describe('parseBankCSV', () => {
  it('strips a metadata preamble above the real header row', () => {
    const text = [
      'Account Summary,',
      'Freedom Checking,1234',
      'Last update,01/31/2024', // "update" must not count as a header row
      'Date,Description,Amount',
      '01/05/2024,COFFEE,-4.50',
    ].join('\n')
    const { headers, rows } = parseBankCSV(text)
    expect(headers).toEqual(['Date', 'Description', 'Amount'])
    expect(rows).toEqual([{ Date: '01/05/2024', Description: 'COFFEE', Amount: '-4.50' }])
  })

  it('drops Totals and date-range summary rows and counts them', () => {
    const text = [
      'Date,Description,Amount',
      '01/05/2024,COFFEE,-4.50',
      'Totals,,-4.50',
      '01/01/2024 - 01/31/2024,,-4.50',
      '01/06/2024,A - B STORE,-2.00', // " - " inside a real description stays
    ].join('\n')
    const { rows, skipped } = parseBankCSV(text)
    expect(skipped).toBe(2)
    expect(rows.map(r => r.Description)).toEqual(['COFFEE', 'A - B STORE'])
  })

  it('strips a leading BOM', () => {
    const { headers } = parseBankCSV('﻿Date,Description\n01/05/2024,X')
    expect(headers).toEqual(['Date', 'Description'])
  })

  it('returns empty shape when nothing parses', () => {
    expect(parseBankCSV('')).toEqual({ headers: [], rows: [], skipped: 0 })
  })
})
