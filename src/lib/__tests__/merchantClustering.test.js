import { describe, it, expect } from 'vitest'
import { normKey, wordSim, buildCatIndex, suggestCat, clusterGroups } from '../merchantClustering'

describe('normKey', () => {
  it('lowercases, strips reference noise and numbers, collapses whitespace', () => {
    expect(normKey('AMAZON MKTPL*RT4Y21 #8821')).toBe('amazon mktpl')
    expect(normKey('CHECK 1042')).toBe('check')
    expect(normKey('  Stop &  Shop   #0552 ')).toBe('stop shop')
    expect(normKey('')).toBe('')
    expect(normKey(null)).toBe('')
  })
})

describe('wordSim', () => {
  it('is 1 for identical keys and 0 for disjoint keys', () => {
    expect(wordSim('costco gas station', 'costco gas station')).toBe(1)
    expect(wordSim('costco gas', 'amazon prime')).toBe(0)
  })

  it('ignores words of length ≤ 2', () => {
    expect(wordSim('ab cd costco', 'costco')).toBe(1)
  })

  it('is 0 when either side has no usable words', () => {
    expect(wordSim('ab', 'costco')).toBe(0)
  })
})

describe('suggestCat', () => {
  const idx = buildCatIndex({
    'costco gas station': 'Fuel',
    'amazon mktpl': 'Supplies',
  })

  it('returns the best match above the threshold', () => {
    expect(suggestCat('costco gas station', idx)).toBe('Fuel')
    expect(suggestCat('costco gas', idx)).toBe('Fuel') // 2/3 overlap ≥ 0.4
  })

  it('returns empty below the threshold or with no candidates', () => {
    expect(suggestCat('costco wholesale delivery north', idx)).toBe('') // 1/4 < 0.4
    expect(suggestCat('starbucks', idx)).toBe('')
  })
})

describe('clusterGroups', () => {
  const g = (key, n) => ({
    key, displayDesc: key.toUpperCase(),
    txns: Array.from({ length: n }, (_, i) => ({ id: `${key}-${i}` })),
    total: n, suggestedCat: '',
  })

  it('merges similar groups; the largest member becomes the representative', () => {
    const { clusters, keyToCluster } = clusterGroups([g('costco gas', 5), g('costco gas station', 2), g('amazon mktpl', 3)])
    expect(clusters).toHaveLength(2)
    const costco = clusters.find(c => c.key === 'costco gas')
    expect(costco.txns).toHaveLength(7)
    expect(costco.variants).toEqual(['COSTCO GAS STATION'])
    expect(keyToCluster['costco gas station']).toBe('costco gas')
  })

  it('keeps dissimilar groups separate', () => {
    const { clusters } = clusterGroups([g('costco gas', 1), g('costco wholesale delivery north', 1)])
    expect(clusters).toHaveLength(2)
  })

  it('handles empty input', () => {
    expect(clusterGroups([])).toEqual({ clusters: [], keyToCluster: {} })
  })
})
