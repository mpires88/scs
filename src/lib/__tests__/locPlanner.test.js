import { describe, it, expect } from 'vitest'
import { simulateNote, buildSeasonDefaults } from '../locPlanner'

// The worked example from the plan: $12k note, 6-week season, ~$3.3k/wk extra
// sales at 13% margin, base reups ~$8.6k/wk, 8.5% APR + 2% origination.
const BASE = {
  draw: 12000, weeks: 6, extraSalesPerWeek: 3333, grossMarginPct: 13,
  sellThroughPct: 100, aprPct: 8.5, originationPct: 2, baseWeeklyCogs: 8600,
}

describe('simulateNote', () => {
  it('prices the note from how long it is actually outstanding', () => {
    const r = simulateNote(BASE)
    // Wind-down: 12000 / 8600 → 2 weeks; note out 8 weeks = 56 days.
    expect(r.windDownWeeks).toBe(2)
    expect(r.weeksOut).toBe(8)
    expect(r.interest).toBeCloseTo(12000 * 0.085 * 56 / 365, 2)
    expect(r.origination).toBeCloseTo(240, 2)
    expect(r.totalCost).toBeCloseTo(r.interest + r.origination, 2)
  })

  it('nets incremental gross profit against the financing cost', () => {
    const r = simulateNote(BASE)
    expect(r.incRevenue).toBeCloseTo(3333 * 6, 2)
    expect(r.incGrossProfit).toBeCloseTo(3333 * 6 * 0.13, 2)
    expect(r.netBenefit).toBeCloseTo(r.incGrossProfit - r.totalCost, 2)
    expect(r.coverage).toBeGreaterThan(5) // the plan's ~6-7× coverage
  })

  it('reports how little of the plan must sell to cover the note', () => {
    const r = simulateNote(BASE)
    expect(r.breakevenSales).toBeCloseTo(r.totalCost / 0.13, 2)
    expect(r.breakevenSellThroughPct).toBeLessThan(20)
  })

  it('stretches the note and shrinks the profit when sell-through drops', () => {
    const full = simulateNote(BASE)
    const half = simulateNote({ ...BASE, sellThroughPct: 50 })
    expect(half.incGrossProfit).toBeCloseTo(full.incGrossProfit / 2, 2)
    expect(half.windDownWeeks).toBeGreaterThan(full.windDownWeeks)
    expect(half.interest).toBeGreaterThan(full.interest)
  })

  it('walks the cash curve from the origination fee to the net benefit', () => {
    const r = simulateNote(BASE)
    expect(r.series[0]).toMatchObject({ week: 0, netBenefit: -r.origination, stock: 12000 })
    const last = r.series[r.series.length - 1]
    expect(last.week).toBe(r.weeksOut)
    expect(last.outstanding).toBe(0)
    expect(last.netBenefit).toBeCloseTo(r.netBenefit, 2)
  })

  it('guards the degenerate inputs', () => {
    expect(simulateNote({ ...BASE, draw: 0 })).toBeNull()
    expect(simulateNote({ ...BASE, grossMarginPct: 0 }).breakevenSales).toBeNull()
    expect(simulateNote({ ...BASE, baseWeeklyCogs: 0 }).windDownWeeks).toBe(1)
  })
})

describe('buildSeasonDefaults', () => {
  // Two seasons of history plus trailing months for the growth comparison.
  const row = (period, revenue, gmPct) => ({
    period, year: +period.slice(0, 4), month: +period.slice(5),
    revenue, cogs: revenue * (1 - gmPct / 100),
    grossProfit: revenue * gmPct / 100, grossMarginPct: gmPct,
  })
  const PL = [
    row('2024-09', 16000, 13), row('2024-10', 16000, 13),
    row('2024-11', 24000, 13), row('2024-12', 32000, 13),
    row('2025-05', 20000, 13), row('2025-06', 20000, 13), row('2025-07', 20000, 13),
    row('2025-09', 28000, 13), row('2025-10', 28000, 13),
    row('2025-11', 28000, 13), row('2025-12', 42000, 13),
    row('2026-05', 30000, 14), row('2026-06', 30000, 14), row('2026-07', 30000, 14),
  ]
  const NOW = new Date(2026, 7, 5) // Aug 2026

  it('measures each season against its own Sep–Oct baseline', () => {
    const d = buildSeasonDefaults({ monthlyPL: PL, now: NOW })
    expect(d.seasons.map(s => s.year)).toEqual([2024, 2025])
    expect(d.seasons[0].uplift).toBeCloseTo((24000 - 16000) + (32000 - 16000), 2)
    expect(d.seasons[1].uplift).toBeCloseTo((28000 - 28000) + (42000 - 28000), 2)
  })

  it('scales last season by this year’s trailing growth', () => {
    const d = buildSeasonDefaults({ monthlyPL: PL, now: NOW })
    expect(d.growth).toBeCloseTo(90000 / 60000, 6)
    // 14000 uplift × 1.5 growth / 6 weeks = 3500/wk.
    expect(d.suggestedExtraPerWeek).toBe(3500)
    expect(d.gmPct).toBeCloseTo(14, 6)
    expect(d.baseWeeklyCogs).toBeCloseTo(30000 * 0.86 * 3 / 3 / 4.33, 2)
  })

  it('suggests a draw of about a week and a half of extra product', () => {
    const d = buildSeasonDefaults({ monthlyPL: PL, now: NOW })
    expect(d.suggestedDraw).toBe(Math.max(1000, Math.round(3500 * 0.86 * 1.5 / 500) * 500))
  })

  it('skips seasons with no baseline or no holiday data', () => {
    const d = buildSeasonDefaults({ monthlyPL: PL.filter(r => r.period !== '2024-11' && r.period !== '2024-12'), now: NOW })
    expect(d.seasons.map(s => s.year)).toEqual([2025])
  })
})
