import { describe, it, expect } from 'vitest'
import { groupRowsByParent } from '../plGrouping'

const OPEX = 'Operating Expenses'
const row = (name, months) => ({
  name,
  byMonth: months,
  total: Object.values(months).reduce((s, v) => s + v, 0),
})

const ACCOUNTS = [
  { name: 'Occupancy',         pl_section: OPEX, parent: null },
  { name: 'Rent',              pl_section: OPEX, parent: 'Occupancy' },
  { name: 'Security',          pl_section: OPEX, parent: 'Occupancy' },
  { name: 'Utilities & Phone', pl_section: OPEX, parent: null },
  { name: 'Advertising',       pl_section: OPEX, parent: null },
]

describe('groupRowsByParent', () => {
  it('nests active children under the parent with a subtotal', () => {
    const rows = [
      row('Rent', { 1: -1250, 2: -1250 }),
      row('Security', { 1: -33 }),
      row('Advertising', { 1: -200 }),
    ]
    const entries = groupRowsByParent(rows, ACCOUNTS, OPEX)
    expect(entries).toHaveLength(2)

    const g = entries[0]
    expect(g.kind).toBe('group')
    expect(g.name).toBe('Occupancy')
    expect(g.own).toBeNull()
    expect(g.children.map(c => c.name)).toEqual(['Rent', 'Security'])
    expect(g.totals).toEqual({ 1: -1283, 2: -1250 })
    expect(g.total).toBe(-2533)

    expect(entries[1]).toMatchObject({ kind: 'row', name: 'Advertising' })
  })

  it("includes the parent's own activity in the subtotal", () => {
    const rows = [
      row('Occupancy', { 1: -100 }),
      row('Rent', { 1: -1250 }),
    ]
    const [g] = groupRowsByParent(rows, ACCOUNTS, OPEX)
    expect(g.kind).toBe('group')
    expect(g.own.name).toBe('Occupancy')
    expect(g.totals).toEqual({ 1: -1350 })
    expect(g.total).toBe(-1350)
  })

  it('emits the group at the first member position and consumes later members', () => {
    const rows = [
      row('Advertising', { 1: -200 }),
      row('Rent', { 1: -1250 }),
      row('Utilities & Phone', { 1: -60 }),
      row('Occupancy', { 1: -100 }),
    ]
    const entries = groupRowsByParent(rows, ACCOUNTS, OPEX)
    expect(entries.map(e => `${e.kind}:${e.name}`)).toEqual([
      'row:Advertising', 'group:Occupancy', 'row:Utilities & Phone',
    ])
  })

  it('keeps a parent with no active children as a plain row', () => {
    const rows = [row('Occupancy', { 1: -100 }), row('Advertising', { 1: -200 })]
    const entries = groupRowsByParent(rows, ACCOUNTS, OPEX)
    expect(entries.every(e => e.kind === 'row')).toBe(true)
  })

  it('treats orphans as plain rows: parent missing, cross-section, or itself a child', () => {
    const accounts = [
      { name: 'Rent', pl_section: OPEX, parent: 'Gone' },                    // parent not in chart
      { name: 'Insurance', pl_section: OPEX, parent: 'Inventory' },
      { name: 'Inventory', pl_section: 'Current Assets', parent: null },     // parent in another section
      { name: 'Sub', pl_section: OPEX, parent: 'Rent' },                     // parent is itself a child
    ]
    const rows = [row('Rent', { 1: -1 }), row('Insurance', { 1: -2 }), row('Sub', { 1: -3 })]
    const entries = groupRowsByParent(rows, accounts, OPEX)
    expect(entries.every(e => e.kind === 'row')).toBe(true)
    expect(entries).toHaveLength(3)
  })

  it('leaves free-text categories not in the chart as plain rows', () => {
    const rows = [row('Mystery Vendor', { 1: -5 })]
    const entries = groupRowsByParent(rows, ACCOUNTS, OPEX)
    expect(entries).toEqual([{ kind: 'row', ...rows[0] }])
  })
})
