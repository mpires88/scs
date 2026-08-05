'use client'

// KPI band for the combined Financial Statements page — one row per indicator,
// on exactly the columns the three statements below share (lib/kpis.js does the
// math). It only exists on the combined page, so unlike the statements it has
// no standalone fetch path: everything arrives through `data` and `shared`.

import { useEffect, useMemo } from 'react'
import { buildKpis } from '../lib/kpis'
import { T, MON, fmtYm, STMT } from '../lib/theme'
import InfoTip from './InfoTip'

const fmtVal = (v, fmt) => {
  if (v == null || isNaN(v)) return '—'
  if (fmt === 'pct')       return `${v.toFixed(1)}%`
  if (fmt === 'pctSigned') return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
  const str = Math.abs(Math.round(v)).toLocaleString()   // money, statement-style
  return v < 0 ? `(${str})` : str
}

const colorFor = (v, fmt) => {
  if (v == null || isNaN(v)) return '#C0BDB7'
  if (fmt === 'pctSigned' || fmt === 'money') return v < 0 ? T.danger : T.success
  return T.charcoal
}

export default function ReportsKPI({ shared = null, data = null, csvSink = null }) {
  const kpis = useMemo(
    () => (data && shared) ? buildKpis({
      txns: data.txns, accounts: data.accounts, registry: data.registry,
      columns: shared.columns, period: shared.period, year: shared.year,
    }) : null,
    [data, shared]
  )
  const year = shared?.year
  const colLabel = m => kpis.yearly ? String(m) : kpis.allDates ? fmtYm(m) : `${MON[m]} ${String(year).slice(2)}`

  const buildCsvLines = () => {
    if (!kpis) return null
    const num = (v, fmt) => v == null ? '' : (fmt === 'money' ? v.toFixed(2) : v.toFixed(1))
    return [
      ['KPI', ...kpis.columns.map(colLabel), 'Period'],
      ...kpis.rows.map(r => [r.label, ...kpis.columns.map(c => num(r.byCol[c], r.fmt)), num(r.total, r.fmt)]),
    ]
  }
  // eslint-disable-next-line react-hooks/immutability -- csvSink is a ref; mutating .current is its contract
  useEffect(() => { if (csvSink) csvSink.current.kpi = buildCsvLines })

  if (!kpis) return null

  return (
    <div style={{ background: T.page, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' }}>
      <header style={{ padding: '8px 28px', background: T.card, borderBottom: `1px solid ${T.border}` }}>
        <h2 style={{ fontSize: 12, fontWeight: 600, color: T.navy, margin: '0 0 1px' }}>Key Performance Indicators</h2>
        <p style={{ fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 }}>
          Sports Card Station · margins, breakeven, stock and cash — derived from the three statements below
        </p>
      </header>

      <div style={{ padding: '14px 28px 20px' }}>
        <div className="stmt-scroll" style={{ display: 'inline-block', verticalAlign: 'top', maxWidth: '100%', overflowX: 'auto', background: T.card, border: `1px solid ${T.border}`, borderRadius: 7 }}>
          <table style={{ borderCollapse: 'collapse', width: 'auto', tableLayout: 'fixed', fontSize: 11.5 }}>
            <thead>
              <tr>
                <th style={{ ...cell.th, textAlign: 'left', width: STMT.label, minWidth: STMT.label, maxWidth: STMT.label, position: 'sticky', left: 0, background: T.page, zIndex: 1 }}>KPI</th>
                {kpis.columns.map(m => (
                  <th key={m} style={{ ...cell.th, textAlign: 'right', width: kpis.yearly ? STMT.numWide : STMT.num, minWidth: kpis.yearly ? STMT.numWide : STMT.num }}>
                    {colLabel(m)}
                  </th>
                ))}
                <th style={{ ...cell.th, textAlign: 'right', width: STMT.total, minWidth: STMT.total, borderLeft: `2px solid ${T.border}` }}>Period</th>
              </tr>
            </thead>
            <tbody>
              {kpis.rows.map(r => (
                <tr key={r.key} style={{ borderBottom: '1px solid #F0EEE9' }}>
                  <td style={{ ...cell.td, position: 'sticky', left: 0, background: T.card }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                      <InfoTip title={r.label}>{r.note}</InfoTip>
                    </span>
                  </td>
                  {kpis.columns.map(m => (
                    <td key={m} style={{ ...cell.num, color: colorFor(r.byCol[m], r.fmt) }}>{fmtVal(r.byCol[m], r.fmt)}</td>
                  ))}
                  <td style={{ ...cell.num, borderLeft: `2px solid ${T.border}`, fontWeight: 600, color: colorFor(r.total, r.fmt) }}>
                    {fmtVal(r.total, r.fmt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const cell = {
  th:  { padding: '6px 8px', background: T.page, fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap', borderBottom: `2px solid ${T.border}` },
  td:  { padding: '3px 8px', fontSize: 11.5, color: T.charcoal, whiteSpace: 'nowrap', maxWidth: STMT.label, overflow: 'hidden', textOverflow: 'ellipsis' },
  num: { padding: '3px 8px', fontSize: 11.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden' },
}
