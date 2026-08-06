'use client'

// Holiday Planner — the lender's view of the seasonal inventory note.
//
// The shop lifts its shelf level for the holiday weeks on a single-draw note,
// sells the bump down after Christmas, and repays. This page seeds the whole
// scenario from the ledger (last seasons' uplift, this year's growth, trailing
// margin), lets every assumption be overridden, and answers the one question
// that matters: incremental gross profit less interest and fees, and how little
// of the plan has to sell for the note to pay for itself. Math in
// lib/locPlanner.js; this file is presentation.

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { supabase, fetchAll } from '../lib/supabase'
import { fetchSectionMap } from '../lib/chartOfAccounts'
import { getSetting, setSetting } from '../lib/settings'
import { buildMonthlyPL } from '../lib/insights'
import { simulateNote, buildSeasonDefaults } from '../lib/locPlanner'
import { T, MON, fmt, fmt2, fmtK } from '../lib/theme'
import InfoTip from './InfoTip'

const SCENARIO_KEY = 'loc_scenario'

const defaultsToInputs = d => ({
  draw:              d?.suggestedDraw ?? 10000,
  weeks:             6,
  extraSalesPerWeek: d?.suggestedExtraPerWeek ?? 3000,
  grossMarginPct:    d?.gmPct ?? 13,
  sellThroughPct:    100,
  aprPct:            8.5,
  originationPct:    2,
})

// Commit on blur or Enter, Escape reverts — same contract as Settings inputs,
// so a half-typed number never drives the simulation or a network write.
function CommitInput({ value, onCommit, suffix = '', width = 86 }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = () => {
    const n = parseFloat(String(draft).replace(/[$,%\s]/g, ''))
    if (!isNaN(n) && n >= 0 && n !== value) onCommit(n)
    else setDraft(String(value))
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(String(value))
        }}
        style={{ width, padding: '4px 8px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 12, color: T.charcoal, background: '#fff', outline: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
      />
      {suffix && <span style={{ fontSize: 11, color: '#9ca3af' }}>{suffix}</span>}
    </span>
  )
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 6, padding: '8px 11px', fontSize: 11, boxShadow: '0 4px 14px rgba(0,0,0,.1)' }}>
      <div style={{ fontWeight: 600, color: T.navy, marginBottom: 4 }}>{label}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.stroke ?? p.fill, padding: '1px 0' }}>
          {p.name}: <strong>{fmt(p.value)}</strong>
        </div>
      ))}
    </div>
  )
}

export default function HolidayPlanner({ clientId }) {
  const [monthlyPL, setMonthlyPL] = useState([])
  const [inputs,    setInputs]    = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)
  const [msg,       setMsg]       = useState('')

  const defaults = useMemo(
    () => monthlyPL.length ? buildSeasonDefaults({ monthlyPL, now: new Date() }) : null,
    [monthlyPL]
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const [rows, coa, saved] = await Promise.all([
          fetchAll(() => supabase.from('bank_transactions')
            .select('transaction_date, amount, category')
            .eq('client_id', clientId).not('category', 'is', null).neq('category', '')
            .order('transaction_date').order('id')),
          fetchSectionMap(clientId),
          getSetting(clientId, SCENARIO_KEY, null).catch(() => null),
        ])
        if (cancelled) return
        const pl = buildMonthlyPL({ txns: rows ?? [], sectionMap: coa.map })
        setMonthlyPL(pl)
        setInputs(saved ?? defaultsToInputs(buildSeasonDefaults({ monthlyPL: pl, now: new Date() })))
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [clientId])

  const setField = useCallback(async (key, val) => {
    const next = { ...inputs, [key]: val }
    setInputs(next); setMsg('')
    try { await setSetting(clientId, SCENARIO_KEY, next); setMsg('✓ Scenario saved') }
    catch (e) { alert('Could not save: ' + e.message) }
  }, [clientId, inputs])

  const resetToLedger = useCallback(async () => {
    const next = defaultsToInputs(defaults)
    setInputs(next); setMsg('')
    try { await setSetting(clientId, SCENARIO_KEY, next); setMsg('✓ Reset to ledger defaults') }
    catch (e) { alert('Could not save: ' + e.message) }
  }, [clientId, defaults])

  const sim = useMemo(
    () => inputs ? simulateNote({ ...inputs, baseWeeklyCogs: defaults?.baseWeeklyCogs ?? 0 }) : null,
    [inputs, defaults]
  )

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300, background: T.page }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={{ width: 28, height: 28, border: `2px solid ${T.border}`, borderTopColor: T.navy, borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
    </div>
  )

  if (error) return (
    <div style={{ padding: 28 }}>
      <div style={{ background: '#FDE8E8', border: '1px solid #F5C2C2', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: '#991B1B' }}>
        Failed to load: {error}
      </div>
    </div>
  )

  const chartData = sim?.series.map(p => ({ ...p, label: `Wk ${p.week}` })) ?? []
  const good = sim && sim.netBenefit > 0

  return (
    <div style={{ background: T.page, minHeight: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' }}>
      <style>{`@media print { aside, .hp-controls { display:none !important } body { background:#fff !important } }`}</style>

      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 28px', background: T.card, borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
            Holiday Planner
            <InfoTip title="Holiday Planner">
              A single-draw note puts extra product on the shelf for the holiday weeks; the bump
              sells down after Christmas and the note is repaid. This page weighs the extra gross
              profit against the interest and fees, seeded from the shop’s own ledger.
            </InfoTip>
          </h2>
          <p style={{ fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 }}>
            Seasonal inventory note — what the extra stock earns vs. what the money costs
          </p>
        </div>
        <div className="hp-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {msg && <span style={{ fontSize: 11, color: T.success, fontWeight: 500 }}>{msg}</span>}
          <button onClick={resetToLedger} style={btnSec} disabled={!defaults}>Use ledger defaults</button>
          <button onClick={() => window.print()} style={btnSec}>🖨 Print / PDF</button>
        </div>
      </header>

      <div style={{ padding: '20px 28px 48px', maxWidth: 1020 }}>

        {/* Verdict */}
        {sim && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
            <div style={{ ...card, borderTop: `3px solid ${good ? T.success : T.danger}` }}>
              <div style={cardLabel}>Net benefit</div>
              <div style={{ ...cardBig, color: good ? T.success : T.danger }}>{fmt(sim.netBenefit)}</div>
              <div style={cardSub}>{fmt(sim.incGrossProfit)} extra gross profit − {fmt2(sim.totalCost)} financing</div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${T.navy}` }}>
              <div style={cardLabel}>Coverage</div>
              <div style={cardBig}>{sim.coverage ? `${sim.coverage.toFixed(1)}×` : '—'}</div>
              <div style={cardSub}>extra profit vs. the cost of the note</div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${T.gold}` }}>
              <div style={cardLabel}>All-in cost</div>
              <div style={cardBig}>{fmt2(sim.totalCost)}</div>
              <div style={cardSub}>{fmt2(sim.origination)} origination + {fmt2(sim.interest)} interest</div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${T.steel}` }}>
              <div style={cardLabel}>Breakeven</div>
              <div style={cardBig}>{sim.breakevenSellThroughPct != null ? `${Math.round(sim.breakevenSellThroughPct)}%` : '—'}</div>
              <div style={cardSub}>{sim.breakevenSales != null ? `${fmt(sim.breakevenSales)} of extra sales covers the note` : 'needs a margin above zero'}</div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${T.amber}` }}>
              <div style={cardLabel}>Note outstanding</div>
              <div style={cardBig}>~{sim.weeksOut} wks</div>
              <div style={cardSub}>{inputs.weeks} season + {sim.windDownWeeks} selling the bump down</div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>

          {/* Inputs */}
          <div style={{ ...panel, flex: '0 1 330px', minWidth: 290 }}>
            <div style={panelLabel}>Scenario</div>
            {inputs && [
              ['draw',              'Note amount',        '$',    'The single draw — all of it goes onto the shelf at season start.'],
              ['weeks',             'Season length',      'wks',  'How many weeks the shelf stays at the elevated level.'],
              ['extraSalesPerWeek', 'Extra sales / week', '$',    'Incremental revenue the bump should generate weekly, at full sell-through.'],
              ['grossMarginPct',    'Gross margin',       '%',    'Margin on the extra sales. Ledger default is the trailing three months.'],
              ['sellThroughPct',    'Sell-through',       '%',    'The risk dial: how much of the plan actually sells. It slows the wind-down too — slow product stays slow after Christmas.'],
              ['aprPct',            'APR',                '%',    'Interest accrues for as long as the note is outstanding, wind-down included.'],
              ['originationPct',    'Origination fee',    '%',    'Charged on the draw up front. At these rates it is most of the cost.'],
            ].map(([key, label, suffix, tip]) => (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #F0EEE9' }}>
                <span style={{ fontSize: 12, color: T.charcoal, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  {label}
                  <InfoTip title={label}>{tip}</InfoTip>
                </span>
                <CommitInput value={inputs[key]} suffix={suffix} onCommit={v => setField(key, v)} />
              </div>
            ))}
            {defaults?.baseWeeklyCogs != null && (
              <p style={{ fontSize: 10.5, color: '#9ca3af', margin: '9px 0 0', lineHeight: 1.5 }}>
                Wind-down assumes the unsold bump displaces the shop’s ~{fmtK(defaults.baseWeeklyCogs)}/week
                base reup spend until the note is repaid.
              </p>
            )}
          </div>

          {/* Cash curve */}
          <div style={{ ...panel, flex: '1 1 420px', minWidth: 360 }}>
            <div style={panelLabel}>The note, week by week</div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: T.charcoal }} />
                <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize: 10, fill: T.charcoal }} width={52} />
                <Tooltip content={<ChartTip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={0} stroke={T.border} />
                <Area type="stepAfter" dataKey="outstanding" name="Note outstanding" fill={T.steel} fillOpacity={0.14} stroke={T.steel} strokeWidth={1} />
                <Line type="stepAfter" dataKey="stock" name="Bump on the shelf" stroke={T.gold} strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                <Line type="monotone" dataKey="netBenefit" name="Cumulative net benefit" stroke={T.success} strokeWidth={2} dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
            <p style={{ fontSize: 10.5, color: '#9ca3af', margin: '6px 0 0', lineHeight: 1.5 }}>
              The origination fee is paid at week 0, each season week adds its margin, and the interest
              settles when the bump has sold down and the note is repaid.
            </p>
          </div>
        </div>

        {/* What history says */}
        {defaults && defaults.seasons.length > 0 && (
          <div style={{ ...panel, marginTop: 16 }}>
            <div style={panelLabel}>What history says</div>
            <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['Season', 'Sep–Oct base /mo', 'Nov', 'Dec', 'Season uplift'].map((h, i) => (
                    <th key={h} style={{ padding: '4px 14px 4px 0', textAlign: i === 0 ? 'left' : 'right', fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {defaults.seasons.map(s => (
                  <tr key={s.year} style={{ borderTop: '1px solid #F0EEE9' }}>
                    <td style={{ padding: '4px 14px 4px 0', color: T.navy, fontWeight: 600 }}>{MON[11]}–{MON[12]} {s.year}</td>
                    <td style={hCell}>{fmt(s.baseline)}</td>
                    <td style={hCell}>{s.nov == null ? '—' : fmt(s.nov)}</td>
                    <td style={hCell}>{s.dec == null ? '—' : fmt(s.dec)}</td>
                    <td style={{ ...hCell, color: s.uplift >= 0 ? T.success : T.danger, fontWeight: 600 }}>
                      {s.uplift >= 0 ? '+' : ''}{fmt(s.uplift)} ({s.upliftPct >= 0 ? '+' : ''}{Math.round(s.upliftPct)}%)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 11, color: T.charcoal, opacity: .85, margin: '10px 0 0', lineHeight: 1.6 }}>
              Ledger defaults: last season’s {fmt(defaults.seasons[defaults.seasons.length - 1].uplift)} uplift
              {defaults.growth ? <> × this year’s growth of {defaults.growth.toFixed(2)}×</> : null} over 6 weeks
              {defaults.suggestedExtraPerWeek != null ? <> ≈ <strong>{fmt(defaults.suggestedExtraPerWeek)}/week</strong> of extra sales</> : null}
              {defaults.gmPct != null ? <>, at the trailing {defaults.gmPct.toFixed(1)}% gross margin</> : null}.
              Margins ride on the COGS estimates until the quarterly count trues them up.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

const card      = { flex: '1 1 150px', minWidth: 150, background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: '11px 14px' }
const cardLabel = { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }
const cardBig   = { fontSize: 21, fontWeight: 600, color: T.navy, lineHeight: 1.1 }
const cardSub   = { fontSize: 10.5, color: 'rgba(74,74,74,0.65)', marginTop: 4, lineHeight: 1.45 }
const panel     = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: '13px 16px' }
const panelLabel = { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 9 }
const hCell     = { padding: '4px 14px 4px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.charcoal }
const btnSec    = { padding: '5px 12px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 10.5, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }
