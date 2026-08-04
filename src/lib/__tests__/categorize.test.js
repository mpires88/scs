import { describe, it, expect } from 'vitest'
import { dominantCat, groupStatus, buildDescCatMap, resolveImportCategory } from '../categorize'

const savedCat = t => t.category || ''

describe('dominantCat', () => {
  it('returns the most common category, ignoring uncategorized rows', () => {
    expect(dominantCat([
      { category: 'Fuel' }, { category: 'Fuel' }, { category: 'Meals' }, { category: null },
    ])).toBe('Fuel')
  })

  it('breaks ties deterministically by name', () => {
    expect(dominantCat([{ category: 'Meals' }, { category: 'Fuel' }])).toBe('Fuel')
    expect(dominantCat([{ category: 'Fuel' }, { category: 'Meals' }])).toBe('Fuel')
  })

  it('returns empty when nothing is categorized', () => {
    expect(dominantCat([{ category: null }, { category: '' }])).toBe('')
    expect(dominantCat([])).toBe('')
  })
})

describe('groupStatus', () => {
  it('none: every transaction uncategorized', () => {
    const st = groupStatus([{ category: '' }, { category: null }], savedCat)
    expect(st.kind).toBe('none')
    expect(st.uncategorized).toBe(2)
  })

  it('partial: some categorized, one distinct category', () => {
    const st = groupStatus([{ category: 'Fuel' }, { category: '' }], savedCat)
    expect(st.kind).toBe('partial')
    expect(st.uncategorized).toBe(1)
  })

  it('mixed outranks partial and reports both facts', () => {
    const st = groupStatus([{ category: 'Fuel' }, { category: 'Meals' }, { category: '' }], savedCat)
    expect(st.kind).toBe('mixed')
    expect(st.uncategorized).toBe(1)
    expect([...st.distinct].sort()).toEqual(['Fuel', 'Meals'])
  })

  it('complete: all categorized, one distinct category', () => {
    expect(groupStatus([{ category: 'Fuel' }, { category: 'Fuel' }], savedCat).kind).toBe('complete')
  })

  it('respects the accessor (pending assignments included)', () => {
    const assignments = { b: 'Fuel' }
    const catOf = t => (t.id in assignments ? assignments[t.id] : (t.category || ''))
    const st = groupStatus([{ id: 'a', category: 'Fuel' }, { id: 'b', category: '' }], catOf)
    expect(st.kind).toBe('complete')
  })
})

describe('resolveImportCategory', () => {
  it("keeps a row's own imported category over the group's", () => {
    // The regression that put rent in Inventory: a mostly-inventory cluster
    // dominated the handful of rent rows sitting inside it.
    expect(resolveImportCategory({ category: 'Rent' }, 'Inventory', false)).toBe('Rent')
  })

  it("falls back to the group's category for rows the source left blank", () => {
    expect(resolveImportCategory({ category: '' }, 'Inventory', false)).toBe('Inventory')
    expect(resolveImportCategory({}, 'Inventory', false)).toBe('Inventory')
    expect(resolveImportCategory({ category: null }, 'Inventory', false)).toBe('Inventory')
  })

  it('lets a deliberate group edit override every row in the group', () => {
    expect(resolveImportCategory({ category: 'Rent' }, 'Occupancy', true)).toBe('Occupancy')
    expect(resolveImportCategory({ category: '' }, 'Occupancy', true)).toBe('Occupancy')
  })

  it('allows a touched group to clear categories, and trims', () => {
    expect(resolveImportCategory({ category: 'Rent' }, '', true)).toBe('')
    expect(resolveImportCategory({ category: '  Rent  ' }, '', false)).toBe('Rent')
    expect(resolveImportCategory({ category: '' }, '  Inventory  ', false)).toBe('Inventory')
  })

  it('returns empty when neither side has a category', () => {
    expect(resolveImportCategory({ category: '' }, '', false)).toBe('')
  })
})

describe('buildDescCatMap', () => {
  it('picks the most common category per key, not the first seen', () => {
    const txns = [
      { description: 'COSTCO GAS', category: 'Meals' }, // one old miscategorization, seen first
      { description: 'COSTCO GAS #1', category: 'Fuel' },
      { description: 'COSTCO GAS #2', category: 'Fuel' },
    ]
    expect(buildDescCatMap(txns)).toEqual({ 'costco gas': 'Fuel' })
  })

  it('is order-independent, with a deterministic name tie-break', () => {
    const a = [{ description: 'X SHOP', category: 'Meals' }, { description: 'X SHOP', category: 'Fuel' }]
    expect(buildDescCatMap(a)).toEqual({ 'x shop': 'Fuel' })
    expect(buildDescCatMap([...a].reverse())).toEqual({ 'x shop': 'Fuel' })
  })

  it('ignores uncategorized rows and unkeyable descriptions', () => {
    expect(buildDescCatMap([
      { description: 'COSTCO', category: '' },
      { description: '12345', category: 'Fuel' }, // normKey('12345') === ''
    ])).toEqual({})
  })
})
