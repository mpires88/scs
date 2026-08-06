// Holiday note planner — pure math for the seasonal inventory line of credit.
//
// The shop reups weekly and most stock turns in about a week. For the holiday
// season the shelf runs at an elevated level for a handful of weeks, funded by
// a single-draw note, then sells back down to base. simulateNote walks that
// window week by week; buildSeasonDefaults reads the suggested inputs straight
// from the ledger so the scenario starts from what actually happened.

const round2 = n => Math.round(n * 100) / 100
const pad2 = n => String(n).padStart(2, '0')

// Mechanics: the whole draw goes on the shelf at week 0 (the bump). During the
// season each week's incremental sales are re-bought at cost to hold the shelf
// level, so the season's weekly cash contribution is the margin alone. At
// season end re-buying stops and the bump liquidates by displacing base reup
// purchases — freed cash retires the note. Sell-through scales both the season
// sales AND the wind-down pace: slow product sells slowly after Christmas too,
// which is exactly how a note stretches past its expected maturity.
export function simulateNote({
  draw,
  weeks = 6,
  extraSalesPerWeek,
  grossMarginPct,
  sellThroughPct = 100,
  aprPct = 8.5,
  originationPct = 2,
  baseWeeklyCogs = 0,
}) {
  if (!(draw > 0) || !(weeks > 0)) return null
  const gm = (Number(grossMarginPct) || 0) / 100
  const st = Math.max(0, Math.min(1, (Number(sellThroughPct) || 0) / 100))
  const planned = Math.max(0, Number(extraSalesPerWeek) || 0)

  const weeklyRevenue = planned * st
  const weeklyMargin  = round2(weeklyRevenue * gm)

  const windPace = (Number(baseWeeklyCogs) || 0) * st
  const windDownWeeks = windPace > 0 ? Math.ceil(draw / windPace) : 1
  const weeksOut = weeks + windDownWeeks

  const interest    = round2(draw * ((Number(aprPct) || 0) / 100) * (weeksOut * 7) / 365)
  const origination = round2(draw * ((Number(originationPct) || 0) / 100))
  const totalCost   = round2(interest + origination)

  const incRevenue     = round2(weeklyRevenue * weeks)
  const incGrossProfit = round2(incRevenue * gm)
  const netBenefit     = round2(incGrossProfit - totalCost)
  const coverage       = totalCost > 0 ? incGrossProfit / totalCost : null

  // How much of the planned season has to materialize just to pay for the note.
  const breakevenSales = gm > 0 ? round2(totalCost / gm) : null
  const plannedSeason  = planned * weeks
  const breakevenSellThroughPct = breakevenSales != null && plannedSeason > 0
    ? round2(breakevenSales / plannedSeason * 100)
    : null

  // Weekly series for the chart: the note balance, the bump still on the shelf,
  // and the cumulative net benefit (fee out at week 0, margin in each season
  // week, interest out when the note is repaid).
  const series = []
  let cum = -origination
  let bumpLeft = draw
  for (let w = 0; w <= weeksOut; w++) {
    if (w >= 1 && w <= weeks) cum += weeklyMargin
    if (w > weeks) bumpLeft = Math.max(0, bumpLeft - windPace)
    const repaid = w === weeksOut
    if (repaid) cum -= interest
    series.push({
      week: w,
      outstanding: repaid ? 0 : draw,
      stock: w <= weeks ? draw : round2(bumpLeft),
      netBenefit: round2(cum),
    })
  }

  return {
    weeksOut, windDownWeeks, interest, origination, totalCost,
    incRevenue, incGrossProfit, netBenefit, coverage,
    breakevenSales, breakevenSellThroughPct, weeklyMargin, series,
  }
}

// Suggested inputs from the ledger: each past season's uplift over its own
// Sep–Oct baseline, this year's growth vs the same trailing months last year,
// the trailing gross margin, and the base weekly reup spend the wind-down
// displaces. `monthlyPL` rows come from insights.buildMonthlyPL.
export function buildSeasonDefaults({ monthlyPL, now, seasonWeeks = 6 }) {
  const byPeriod = new Map(monthlyPL.map(r => [r.period, r]))
  const thisYear = now.getFullYear()

  const seasons = []
  const years = [...new Set(monthlyPL.map(r => r.year))].sort()
  years.forEach(y => {
    if (y >= thisYear) return // this season is the one being planned
    const rev = m => byPeriod.get(`${y}-${pad2(m)}`)?.revenue ?? null
    const base = [rev(9), rev(10)].filter(v => v != null)
    const baseline = base.length ? base.reduce((s, v) => s + v, 0) / base.length : null
    const nov = rev(11), dec = rev(12)
    if (!baseline || baseline <= 0 || (nov == null && dec == null)) return
    const uplift = ((nov ?? baseline) - baseline) + ((dec ?? baseline) - baseline)
    seasons.push({
      year: y, baseline: round2(baseline), nov, dec,
      uplift: round2(uplift),
      upliftPct: round2(uplift / (baseline * 2) * 100),
    })
  })

  // Trailing 3 complete months vs the same months a year earlier.
  const trailingMonths = []
  for (let i = 3; i >= 1; i--) {
    const d = new Date(thisYear, now.getMonth() - i, 1)
    trailingMonths.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`)
  }
  const sumOf = (periods, field) => periods.reduce((s, p) => {
    const r = byPeriod.get(p)
    return r == null ? null : (s == null ? null : s + r[field])
  }, 0)
  const prevMonths = trailingMonths.map(p => `${+p.slice(0, 4) - 1}${p.slice(4)}`)
  const cur = sumOf(trailingMonths, 'revenue')
  const prev = sumOf(prevMonths, 'revenue')
  const growth = cur != null && prev > 0
    ? Math.min(5, Math.max(0.2, cur / prev))
    : null

  const gpSum  = sumOf(trailingMonths, 'grossProfit')
  const gmPct  = cur > 0 && gpSum != null ? round2(gpSum / cur * 100) : null
  const cogsSum = sumOf(trailingMonths, 'cogs')
  const baseWeeklyCogs = cogsSum != null ? round2(cogsSum / 3 / 4.33) : null

  const lastSeason = seasons[seasons.length - 1] ?? null
  const suggestedExtraPerWeek = lastSeason && lastSeason.uplift > 0
    ? Math.round(lastSeason.uplift * (growth ?? 1) / seasonWeeks / 50) * 50
    : null
  // Roughly 1.5 weeks of the extra product on the shelf at cost.
  const suggestedDraw = suggestedExtraPerWeek != null && gmPct != null
    ? Math.max(1000, Math.round(suggestedExtraPerWeek * (1 - gmPct / 100) * 1.5 / 500) * 500)
    : null

  return { seasons, growth, gmPct, baseWeeklyCogs, trailingMonths, suggestedExtraPerWeek, suggestedDraw }
}
