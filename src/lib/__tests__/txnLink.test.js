import { describe, it, expect } from 'vitest'
import { buildTxnLink, readTxnParams, columnRange, lastDayOfMonth } from '../txnLink'

const parse = url => new URLSearchParams(url.split('?')[1])

describe('lastDayOfMonth', () => {
  it('handles 31s, 30s and leap February', () => {
    expect(lastDayOfMonth(2026, 1)).toBe('2026-01-31')
    expect(lastDayOfMonth(2026, 6)).toBe('2026-06-30')
    expect(lastDayOfMonth(2024, 2)).toBe('2024-02-29')
    expect(lastDayOfMonth(2026, 2)).toBe('2026-02-28')
  })
})

describe('columnRange', () => {
  it('turns a month column into that calendar month', () => {
    expect(columnRange(6, { year: 2026 })).toEqual({ from: '2026-06-01', to: '2026-06-30' })
  })

  it('turns a yearly column into the whole year', () => {
    expect(columnRange(2025, { yearly: true })).toEqual({ from: '2025-01-01', to: '2025-12-31' })
  })

  it('reads a YYYY-MM column from the all-dates view', () => {
    expect(columnRange('2025-02', {})).toEqual({ from: '2025-02-01', to: '2025-02-28' })
  })

  it('spans the shown columns for the Total column', () => {
    expect(columnRange(null, { year: 2026, columns: [3, 4, 5] }))
      .toEqual({ from: '2026-03-01', to: '2026-05-31' })
    expect(columnRange(null, { yearly: true, columns: [2024, 2026] }))
      .toEqual({ from: '2024-01-01', to: '2026-12-31' })
  })
})

describe('buildTxnLink', () => {
  it('carries exact categories, the range, and the flat view', () => {
    const p = parse(buildTxnLink({ cats: ['4100 Occupancy'], from: '2026-06-01', to: '2026-06-30' }))
    expect(p.get('cats')).toBe('4100 Occupancy')
    expect(p.get('from')).toBe('2026-06-01')
    expect(p.get('to')).toBe('2026-06-30')
    expect(p.get('view')).toBe('flat')   // individual rows, not merchant groups
  })

  it('joins several categories so a subtotal reproduces itself', () => {
    expect(parse(buildTxnLink({ cats: ['Rent', 'Utilities & Phone'] })).get('cats'))
      .toBe('Rent,Utilities & Phone')
  })

  it('falls back to the date range when the category list is unusably long', () => {
    const many = Array.from({ length: 200 }, (_, i) => `Account number ${i} with a long name`)
    const p = parse(buildTxnLink({ cats: many, from: '2026-01-01', to: '2026-12-31' }))
    expect(p.get('cats')).toBeNull()      // rather than a broken URL
    expect(p.get('from')).toBe('2026-01-01')
  })

  it('round-trips through readTxnParams', () => {
    const url = buildTxnLink({ cats: ['Rent', 'Misc'], from: '2026-01-01', to: '2026-01-31' })
    expect(readTxnParams(parse(url))).toEqual({
      cats: ['Rent', 'Misc'], q: '', from: '2026-01-01', to: '2026-01-31', view: 'flat',
    })
  })

  it('reads empty params without inventing filters', () => {
    expect(readTxnParams(new URLSearchParams()))
      .toEqual({ cats: [], q: '', from: '', to: '', view: null })
  })
})
