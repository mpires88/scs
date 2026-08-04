import { describe, it, expect } from 'vitest'
import {
  itemsToLines, parseCycle, resolveYear, parseCardStatement, parseCardIdentity, extractPdfLines,
} from '../pdfStatement'

// Shorthand for a pdf.js text item as `itemsToLines` consumes it.
const it_ = (str, x, y) => ({ str, x, y })

describe('itemsToLines', () => {
  it('joins a table row by x and orders rows top-down', () => {
    const lines = itemsToLines([
      it_('$13.00', 560, 583),
      it_('May 22', 45, 583), it_(' ', 71, 583), it_('May 22', 105, 583), it_(' ', 131, 583),
      it_('FACEBK *ZEH3HMHH22MENLO PARKCA', 163, 583),
      it_('Trans Date', 45, 600), it_('Amount', 560, 600),
    ])
    expect(lines).toEqual([
      'Trans Date Amount',
      'May 22 May 22 FACEBK *ZEH3HMHH22MENLO PARKCA $13.00',
    ])
  })

  it('inserts a separator when the column padding runs are absent', () => {
    expect(itemsToLines([it_('May 22', 45, 100), it_('CHARGE', 163, 100)]))
      .toEqual(['May 22 CHARGE'])
  })

  it('tolerates sub-point y drift within one row but splits real rows', () => {
    expect(itemsToLines([it_('a', 10, 100), it_('b', 20, 101.4), it_('c', 10, 90)]))
      .toEqual(['a b', 'c'])
  })
})

describe('parseCycle', () => {
  it('reads the billing period out of the page header', () => {
    expect(parseCycle(['May 12, 2026 - Jun 10, 2026 | 30 days in Billing Cycle']))
      .toEqual({ start: '2026-05-12', end: '2026-06-10' })
  })

  it('returns null when no period is present', () => {
    expect(parseCycle(['Account Summary', 'Previous Balance $4,669.88'])).toBeNull()
  })
})

describe('resolveYear', () => {
  const sameYear = { start: '2026-05-12', end: '2026-06-10' }
  const crossing = { start: '2025-12-12', end: '2026-01-10' }

  it('picks the year that lands inside the cycle', () => {
    expect(resolveYear(5, 22, sameYear).year).toBe(2026)
    expect(resolveYear(6, 1, sameYear).year).toBe(2026)
  })

  it('resolves both sides of a December-to-January cycle', () => {
    expect(resolveYear(12, 20, crossing).year).toBe(2025)
    expect(resolveYear(1, 5, crossing).year).toBe(2026)
  })

  it('reports distance for dates outside the cycle so callers can warn', () => {
    expect(resolveYear(5, 8, sameYear)).toEqual({ year: 2026, dist: 4 })
    expect(resolveYear(5, 22, sameYear).dist).toBe(0)
  })

  it('returns null without a cycle', () => {
    expect(resolveYear(5, 22, null)).toBeNull()
  })
})

// A faithful reduction of the Capital One Spark layout: two cardholder
// sections, a fee table, and the separately-listed interest charge.
const STATEMENT = [
  'Spark Classic credit card | Business Mastercard ending in 3877',
  'May 12, 2026 - Jun 10, 2026 | 30 days in Billing Cycle',
  'Pay or manage your account at capitalone.com',
  'Minimum Payment 25 Years $15,128',
  'Transactions',
  'TIMOTHY FARMER #3877: Payments, Credits and Adjustments',
  'Trans Date Post Date Description Amount',
  'May 22 May 23 CAPITAL ONE MOBILE PYMT - $500.00',
  'TIMOTHY FARMER #3877: Transactions',
  'Trans Date Post Date Description Amount',
  'May 22 May 22 FACEBK *ZEH3HMHH22MENLO PARKCA $13.00',
  'Jun 9 Jun 9 AMAZON MKTPL*OS34C5XR3SEATTLEWA $115.77',
  'TIMOTHY FARMER #3877: Total Transactions $128.77',
  'Total Transactions for This Period $128.77',
  'Fees',
  'Trans Date Post Date Description Amount',
  'Total Fees for This Period $0.00',
  'Interest Charged',
  'Interest Charge on Purchases $105.80',
  'Interest Charge on Cash Advances $0.00',
  'Total Interest for This Period $105.80',
  'Totals Year-to-Date',
  'Total Interest charged $586.68',
]

describe('parseCardStatement', () => {
  const r = parseCardStatement(STATEMENT)

  it('flips the statement sign so charges are expenses and payments are credits', () => {
    expect(r.rows).toEqual([
      { transaction_date: '2026-05-22', description: 'CAPITAL ONE MOBILE PYMT', amount: 500, section: 'payments' },
      { transaction_date: '2026-05-22', description: 'FACEBK *ZEH3HMHH22MENLO PARKCA', amount: -13, section: 'transactions' },
      { transaction_date: '2026-06-09', description: 'AMAZON MKTPL*OS34C5XR3SEATTLEWA', amount: -115.77, section: 'transactions' },
    ])
  })

  it('returns the interest charge separately, dated to the cycle close', () => {
    expect(r.interest).toEqual([
      { transaction_date: '2026-06-10', description: 'INTEREST CHARGE ON PURCHASES', amount: -105.8 },
    ])
  })

  it('ignores zero interest lines and the year-to-date totals', () => {
    expect(r.interest).toHaveLength(1)
    expect(r.totals).toEqual({ transactions: 128.77, fees: 0, interest: 105.8 })
  })

  it('reconciles against the statement totals without warning', () => {
    expect(r.warnings).toEqual([])
  })

  it('warns when a row is missed and the charges no longer add up', () => {
    const missing = STATEMENT.filter(l => !l.includes('AMAZON'))
    expect(parseCardStatement(missing).warnings)
      .toEqual([expect.stringContaining('$13.00 but the statement says $128.77')])
  })

  it('does not mistake summary or marketing lines for transactions', () => {
    expect(r.rows.map(x => x.description)).not.toContain('Total Transactions')
    expect(parseCardStatement(['Minimum Payment 25 Years $15,128']).rows).toEqual([])
  })

  it('picks up fee rows, which share the transaction table shape', () => {
    const withFee = STATEMENT.flatMap(l =>
      l === 'Total Fees for This Period $0.00'
        ? ['Jun 5 Jun 5 LATE FEE $39.00', 'Total Fees for This Period $39.00']
        : [l])
    const fees = parseCardStatement(withFee)
    expect(fees.rows).toContainEqual(
      { transaction_date: '2026-06-05', description: 'LATE FEE', amount: -39, section: 'fees' }
    )
    expect(fees.warnings).toEqual([]) // fees count toward the reconciled charge total
  })

  it('parses parenthesised credits', () => {
    const { rows } = parseCardStatement([
      'May 12, 2026 - Jun 10, 2026',
      'Jun 2 Jun 2 REFUND STORE ($25.00)',
    ])
    expect(rows[0].amount).toBe(25)
  })

  it('keeps a description containing its own dollar figure intact', () => {
    const { rows } = parseCardStatement([
      'May 12, 2026 - Jun 10, 2026',
      'Jun 2 Jun 2 STORE $5.00 OFF PROMO $12.34',
    ])
    expect(rows[0]).toMatchObject({ description: 'STORE $5.00 OFF PROMO', amount: -12.34 })
  })

  it('flags rows it cannot date instead of silently guessing', () => {
    const { rows, warnings } = parseCardStatement(['Jun 2 Jun 2 STORE $12.34'])
    expect(rows).toEqual([])
    expect(warnings).toEqual([expect.stringContaining('No statement period')])
  })
})

// Guards the pdf.js contract itself. `destroy()` lives on the loading task, not
// on the document proxy it resolves to — calling it on the document shipped a
// "doc.destroy is not a function" failure that no parsing test could catch.
describe('extractPdfLines', () => {
  const item = (str, x, y) => ({ str, transform: [1, 0, 0, 1, x, y] })

  const stub = (pages, { failOnPage = null } = {}) => {
    const calls = { taskDestroyed: 0, pagesCleaned: 0 }
    const doc = {
      numPages: pages.length,
      getPage: async n => {
        if (n === failOnPage) throw new Error('bad page')
        return {
          getTextContent: async () => ({ items: pages[n - 1] }),
          cleanup: () => { calls.pagesCleaned++ },
        }
      },
    }
    // Deliberately NO destroy() on the document — matching the real proxy.
    const pdfjs = {
      getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => { calls.taskDestroyed++ } }),
    }
    return { load: async () => pdfjs, calls }
  }

  it('reconstructs lines across every page in order', async () => {
    const { load } = stub([
      [item('May 22', 45, 583), item('CHARGE', 163, 583), item('$13.00', 560, 583)],
      [item('page two', 45, 700)],
    ])
    expect(await extractPdfLines(new ArrayBuffer(8), load))
      .toEqual(['May 22 CHARGE $13.00', 'page two'])
  })

  it('tears down through the loading task and cleans each page', async () => {
    const { load, calls } = stub([[item('a', 1, 1)], [item('b', 1, 1)]])
    await extractPdfLines(new ArrayBuffer(8), load)
    expect(calls.taskDestroyed).toBe(1)
    expect(calls.pagesCleaned).toBe(2)
  })

  it('still tears down when a page throws', async () => {
    const { load, calls } = stub([[item('a', 1, 1)], [item('b', 1, 1)]], { failOnPage: 2 })
    await expect(extractPdfLines(new ArrayBuffer(8), load)).rejects.toThrow('bad page')
    expect(calls.taskDestroyed).toBe(1)
  })
})

describe('parseCardIdentity', () => {
  it('builds an account label from the issuer and last four', () => {
    expect(parseCardIdentity(STATEMENT)).toEqual({
      issuer: 'Capital One',
      last4: '3877',
      product: 'Spark Classic credit card',
      label: 'Capital One ...3877',
    })
  })

  it('degrades gracefully on an unrecognised issuer', () => {
    expect(parseCardIdentity(['Business card ending in 1234']))
      .toMatchObject({ issuer: null, last4: '1234', label: 'Card ...1234' })
  })
})
