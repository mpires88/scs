'use client'

// Projections — what the next few years look like if the shop grows, and what
// that means for paying the owner the target (default $4,000/month, the level
// at which SSDI is given up).
//
// Growth, cost-of-goods and expense assumptions are this page's own and save
// under `projection_scenario`. The owner-pay figures and the term loan are
// shared with the Term Loan Planner: they are read from, and written back to,
// `term_loan_scenario`, so the two pages never disagree about his pay.
// Math in lib/projections.js; this file is presentation.

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend, Cell,
} from 'recharts'
import Link from 'next/link'
import { supabase, fetchAll } from '../lib/supabase'
import { fetchAccounts } from '../lib/chartOfAccounts'
import { getSetting, setSetting } from '../lib/settings'
import { buildProjectionBase, buildProjection, projectionDefaults } from '../lib/projections'
import { buildTermLoan } from '../lib/termLoan'
import { T, fmt, fmtK, fmtYm, fmtPeriod } from '../lib/theme'
import InfoTip from './InfoTip'
import CommitInput from './CommitInput'

const SCENARIO_KEY = 'projection_scenario'
const LOAN_KEY = 'term_loan_scenario'

// Owner-pay defaults when the Term Loan Planner has never been saved; they
// match that page's own defaults.
const OWNER_DEFAULTS = {
  ownerPayCurrent: 700, ownerPayProposed: 700, ownerPayTarget: 4000,
  payrollTaxPct: 7.65, dscrTarget: 1.25, ownerPayStepDate: '',
  ssdiOn: true, ssdiBenefit: 0,
}


function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#fff', border: `1px solid ${T.border}`, borderRadius: 6, padding: '8px 11px', fontSize: 11, boxShadow: '0 4px 14px rgba(0,0,0,.1)' }}>
      <div style={{ fontWeight: 600, color: T.navy, marginBottom: 4 }}>{label}</div>
      {payload.filter(p => p.value != null).map(p => (
        <div key={p.dataKey} style={{ color: T.charcoal, padding: '1px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.payload?.fillOf?.[p.dataKey] ?? p.stroke ?? p.fill }} />
          {p.name}: <strong>{fmt(p.value)}</strong>
        </div>
      ))}
    </div>
  )
}

export default function ProjectionsPlanner({ clientId }) {
  const [base,    setBase]    = useState(null)
  const [inputs,  setInputs]  = useState(null)
  const [loanSc,  setLoanSc]  = useState(null) // the saved term-loan scenario, as stored
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [msg,     setMsg]     = useState('')
  const [view,    setView]    = useState(0)    // year index, or 'all' for the summary

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const [rows, coa, saved, loanSaved] = await Promise.all([
          fetchAll(() => supabase.from('bank_transactions')
            .select('transaction_date, amount, category')
            .eq('client_id', clientId).not('category', 'is', null).neq('category', '')
            .order('transaction_date').order('id')),
          fetchAccounts(clientId),
          getSetting(clientId, SCENARIO_KEY, null).catch(() => null),
          getSetting(clientId, LOAN_KEY, null).catch(() => null),
        ])
        if (cancelled) return
        const b = buildProjectionBase({ txns: rows ?? [], accounts: coa.accounts, now: new Date() })
        setBase(b)
        setInputs({ ...projectionDefaults(b), ...(saved ?? {}) })
        setLoanSc(loanSaved)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [clientId])

  const owner = useMemo(() => ({ ...OWNER_DEFAULTS, ...(loanSc ?? {}) }), [loanSc])

  const setFields = useCallback(async patch => {
    const next = { ...inputs, ...patch }
    setInputs(next); setMsg('')
    try { await setSetting(clientId, SCENARIO_KEY, next); setMsg('✓ Scenario saved') }
    catch (e) { alert('Could not save: ' + e.message) }
  }, [clientId, inputs])
  const setField = useCallback((key, val) => setFields({ [key]: val }), [setFields])

  // Owner fields live with the term loan so both pages share them.
  const setOwner = useCallback(async (key, val) => {
    const next = { ...(loanSc ?? {}), [key]: val }
    setLoanSc(next); setMsg('')
    try { await setSetting(clientId, LOAN_KEY, next); setMsg('✓ Saved — shared with the Term Loan Planner') }
    catch (e) { alert('Could not save: ' + e.message) }
  }, [clientId, loanSc])

  const loan = useMemo(() => loanSc ? buildTermLoan(loanSc) : null, [loanSc])

  const proj = useMemo(() => {
    if (!base || !inputs) return null
    return buildProjection(base, {
      ...inputs,
      ownerPayCurrent: owner.ownerPayCurrent,
      ownerPayNow:     owner.ownerPayProposed,
      ownerPayTarget:  owner.ownerPayTarget,
      drawsNow:        inputs.drawsNow,
      drawsAfter:      inputs.drawsAfter,
      ssdiBenefit:     owner.ssdiOn !== false ? owner.ssdiBenefit : 0,
      payrollTaxPct:   owner.payrollTaxPct,
      dscrTarget:      owner.dscrTarget,
      stepYm:          owner.ownerPayStepDate ? owner.ownerPayStepDate.slice(0, 7) : null,
      loan:            inputs.includeLoan ? loan : null,
    })
  }, [base, inputs, owner, loan])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300, background: T.page }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={{ width: 28, height: 28, border: `2px solid ${T.border}`, borderTopColor: T.navy, borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
    </div>
  )

  if (error || !base) return (
    <div style={{ padding: 28 }}>
      <div style={{ background: '#FDE8E8', border: '1px solid #F5C2C2', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: '#991B1B' }}>
        {error ? `Failed to load: ${error}` : 'The ledger has no complete months to project from yet.'}
      </div>
    </div>
  )

  const row = (key, label, suffix, tip, opts = {}) => (
    <div key={key} style={inputRow}>
      <span style={inputLabel}>
        {label}
        <InfoTip title={label}>{tip}</InfoTip>
      </span>
      <CommitInput value={opts.owner ? owner[key] : inputs[key]} suffix={suffix} allowNegative={opts.negative}
        onCommit={v => (opts.owner ? setOwner : setField)(key, v)} />
    </div>
  )

  const gross = 1 + (Number(owner.payrollTaxPct) || 0) / 100
  const target = proj?.target ?? 0
  const y1 = proj?.years[0]
  const scheduled = owner.ownerPayStepDate ? owner.ownerPayStepDate.slice(0, 7) : null
  const growthNeeded = proj?.revenueNeeded ? (proj.revenueNeeded / proj.baselineRev - 1) * 100 : null
  const loanActive = inputs.includeLoan && loan
  const ssdiOn = owner.ssdiOn !== false
  const ssdi = ssdiOn ? Number(owner.ssdiBenefit) || 0 : 0

  // Revenue chart: the baseline year as actuals, then the projection.
  const revData = [
    ...base.months.map(m => ({ label: fmtYm(m.ym), actual: m.netRev, projected: null })),
    ...(proj?.rows ?? []).map(r => ({ label: fmtYm(r.ym), actual: null, projected: r.netRev })),
  ]
  const capData = (proj?.rows ?? []).map(r => ({
    label: fmtYm(r.ym), month: r.capacity, avg12: r.capacity12,
    fillOf: { month: r.capacity < 0 ? T.danger : '#C9D6E3' },
  }))


  return (
    <div style={{ background: T.page, minHeight: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' }}>
      <style>{`@media print { aside, .pj-controls { display:none !important } body { background:#fff !important } }`}</style>

      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 28px', background: T.card, borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
            Projections
            <InfoTip title="Projections">
              Starts from the last twelve complete months of the P&amp;L ({fmtYm(base.startYm)}–{fmtYm(base.endYm)}),
              grows revenue by the rates you set, holds cost of goods at a share of revenue and raises
              expenses each year. Each month keeps last year’s seasonality. The owner’s pay — with the
              employer’s payroll tax — is modeled on its own so the page can show when the target pay fits.
            </InfoTip>
          </h2>
          <p style={{ fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 }}>
            Growth scenarios, month by month — and when the owner can step up to {fmt(target)}/month
          </p>
        </div>
        <div className="pj-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {msg && <span style={{ fontSize: 11, color: T.success, fontWeight: 500 }}>{msg}</span>}
          <button onClick={() => window.print()} style={btnSec}>🖨 Print / PDF</button>
        </div>
      </header>

      <div style={{ padding: '20px 28px 48px', maxWidth: 1100 }}>

        {/* Verdict */}
        {proj && y1 && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
            <div style={{ ...card, borderTop: `3px solid ${T.navy}` }}>
              <div style={cardLabel}>Year 1 net revenue</div>
              <div style={cardBig}>{fmt(y1.netRev)}</div>
              <div style={cardSub}>vs {fmt(proj.baselineRev)} the last 12 months</div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${T.gold}` }}>
              <div style={cardLabel}>Year 1 gross profit</div>
              <div style={cardBig}>{fmt(y1.grossProfit)}</div>
              <div style={cardSub}>{fmt(y1.grossProfit / 12)}/mo after {Number(inputs.cogsPct).toFixed(1)}% cost of goods</div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${y1.capacity >= target ? T.success : T.danger}` }}>
              <div style={cardLabel}>Owner pay the shop can carry · yr 1</div>
              <div style={{ ...cardBig, color: y1.capacity >= target ? T.success : y1.capacity < 0 ? T.danger : T.navy }}>
                {fmt(y1.capacity)}<span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>/mo</span>
              </div>
              <div style={cardSub}>gross, plus {fmt(Math.max(0, y1.capacity) * (gross - 1))} payroll tax and {fmt(inputs.drawsAfter)} draws{loanActive ? ` · loan at ${Number(owner.dscrTarget).toFixed(2)}×` : ''}</div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${T.steel}` }}>
              <div style={cardLabel}>To the owner each month</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={cardBig}>{fmt(Number(owner.ownerPayProposed) + Number(inputs.drawsNow) + ssdi)}</span>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>→</span>
                <span style={cardBig}>{fmt(target + Number(inputs.drawsAfter))}</span>
              </div>
              <div style={cardSub}>
                today {fmt(owner.ownerPayProposed)} payroll + {fmt(inputs.drawsNow)} draws{ssdi ? ` + ${fmt(ssdi)} SSDI` : ''};
                at target {fmt(target)} payroll + {fmt(inputs.drawsAfter)} draws
              </div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${proj.earliest ? T.success : T.danger}` }}>
              <div style={cardLabel}>{fmt(target)}/mo sustainable from</div>
              <div style={{ ...cardBig, color: proj.earliest ? T.navy : T.danger }}>
                {proj.earliest ? fmtPeriod(proj.earliest) : 'Not in view'}
              </div>
              <div style={cardSub}>
                {proj.earliest
                  ? 'the first month whose next 12 months average enough'
                  : `not within ${inputs.years} years at these rates`}
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>

          {/* Inputs */}
          <div style={{ ...panel, flex: '0 1 320px', minWidth: 290 }}>
            <div style={panelLabel}>Growth</div>
            {row('growthFirstPct', 'Revenue growth next year', '%', 'How much more net revenue the first projected year brings than the last twelve months, month for month. Negative for a decline.', { negative: true })}
            {row('growthAfterPct', 'Revenue growth each year after', '%', 'Growth in every following year, compounding on the year before.', { negative: true })}
            {row('cogsPct', 'Cost of goods', '% of rev', `Cost of goods as a share of net revenue, held flat. The ledger’s last twelve months ran ${base.cogsPct != null ? base.cogsPct.toFixed(1) + '%' : '—'} (months whose cost of goods isn’t booked yet are left out).`)}
            {row('expenseGrowthPct', 'Expense growth per year', '%', `Operating expenses, other than the owner’s pay, rise this much a year. They start from the last twelve months’ average of ${fmt(base.opexAvg)}/month, less the owner’s current pay and its payroll tax: ${fmt(proj?.opexExOwner)}/month.`, { negative: true })}
            {row('years', 'Years to project', 'yrs', 'How far ahead to look, 1–10 years.')}
            {row('drawsNow', 'Owner draws / month', '$', `What the owner takes out besides payroll — the car payment, its insurance, gas. The last twelve months averaged ${fmt(base.drawsAvg)}/month. Draws aren’t an expense and carry no payroll tax, but they leave the bank, so they come out of the cash and out of what’s left for pay.`)}
            {row('drawsAfter', 'Draws after the step-up', '$', 'Draws once he is at the target pay — lower if he starts paying the car and gas out of his own pay. The pay-capacity figures use this one.')}
            <div className="pj-controls" style={{ margin: '6px 0 0', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {base.cogsPct != null && Math.abs(inputs.cogsPct - base.cogsPct) > 0.05 && (
                <button style={btnSec} onClick={() => setField('cogsPct', base.cogsPct)}>Use the ledger’s {base.cogsPct.toFixed(1)}% cost of goods</button>
              )}
              {base.drawsAvg > 0 && inputs.drawsNow !== Math.round(base.drawsAvg) && (
                <button style={btnSec} onClick={() => setFields({ drawsNow: Math.round(base.drawsAvg), drawsAfter: Math.round(base.drawsAvg) })}>Use the ledger’s {fmt(base.drawsAvg)} draws</button>
              )}
            </div>

            <div style={{ ...panelLabel, marginTop: 16, display: 'flex', alignItems: 'center', gap: 5 }}>
              Owner pay
              <InfoTip title="Shared with the Term Loan Planner">These figures are the same ones the Term Loan Planner uses; changing them here changes them there.</InfoTip>
            </div>
            {row('ownerPayCurrent', 'Pay in the books today', '$', 'What the last twelve months’ payroll paid the owner each month. It is taken out of the baseline expenses (with its payroll tax) so pay can be modeled on its own.', { owner: true })}
            {row('ownerPayProposed', 'Pay until the step-up', '$', 'Gross monthly pay before the step-up — kept under the SSDI line.', { owner: true })}
            {row('ownerPayTarget', 'Target pay', '$', 'Gross monthly pay after the step-up, where SSDI is given up.', { owner: true })}
            <div style={inputRow}>
              <span style={inputLabel}>
                Count SSDI
                <InfoTip title="Count SSDI">On: his SSDI check counts in what he receives each month until the step-up, and the payroll figures are labeled as what SSDI measures. Off: no check — for when the benefit has ended. Shared with the Term Loan Planner.</InfoTip>
              </span>
              <input type="checkbox" checked={ssdiOn} onChange={e => setOwner('ssdiOn', e.target.checked)} />
            </div>
            {ssdiOn && row('ssdiBenefit', 'SSDI check / month', '$', 'His monthly SSDI benefit. It counts in what he receives until the step-up, when it ends.', { owner: true })}
            {row('payrollTaxPct', 'Employer payroll tax', '%', 'The shop’s share of payroll tax on the owner’s pay — 7.65% Social Security and Medicare, more if state unemployment applies. Every month’s owner cost includes it.', { owner: true })}
            {row('dscrTarget', 'Loan coverage to keep', '×', 'While the term loan is outstanding, what is left for the owner must leave the loan payment covered this many times over.', { owner: true })}
            <div style={inputRow}>
              <span style={inputLabel}>
                Include the term loan
                <InfoTip title="Include the term loan">Uses the payments from the Term Loan Planner’s scenario. Turn it off to see the shop without the loan.</InfoTip>
              </span>
              <input type="checkbox" checked={!!inputs.includeLoan} onChange={e => setField('includeLoan', e.target.checked)} />
            </div>
            <p style={{ fontSize: 10.5, color: '#9ca3af', margin: '9px 0 0', lineHeight: 1.5 }}>
              {loan
                ? <>Loan: {fmt(loan.payment)}/month from {fmtPeriod(loan.schedule[0].date.slice(0, 7))} through {fmtPeriod(loan.maturityDate.slice(0, 7))}{loan.balloon ? `, ${fmt(loan.balloon)} balloon` : ''}. <Link href="/loan" style={{ color: T.steel }}>Edit the loan</Link></>
                : <>No term loan scenario saved yet. <Link href="/loan" style={{ color: T.steel }}>Set one up</Link></>}
            </p>
          </div>

          <div style={{ flex: '1 1 460px', minWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Owner pay answer */}
            {proj && (
              <div style={panel}>
                <div style={{ ...panelLabel, display: 'flex', alignItems: 'center', gap: 5 }}>
                  Can he be paid {fmt(target)}/month?
                  <InfoTip title="Owner-pay capacity">
                    Each month, what is left of gross profit after operating expenses, owner draws
                    ({fmt(inputs.drawsAfter)}/month after the step-up) and the loan payment
                    (times the coverage target), divided by 1 + the employer’s payroll-tax rate — the most gross
                    pay that month could carry. Bars are single months; the line averages the twelve months
                    starting at each one, which is the test for whether a pay level holds up through the slow season.
                  </InfoTip>
                </div>
                <ResponsiveContainer width="100%" height={230}>
                  <ComposedChart data={capData} margin={{ top: 14, right: 12, bottom: 0, left: 0 }} barCategoryGap={2}>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: T.charcoal }} minTickGap={24} />
                    <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize: 10, fill: T.charcoal }} width={52} />
                    <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(27,58,92,0.05)' }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <ReferenceLine y={0} stroke={T.charcoal} strokeOpacity={0.45} />
                    <ReferenceLine y={target} stroke={T.gold} strokeDasharray="4 3"
                      label={{ value: `Target ${fmt(target)}`, position: 'insideTopLeft', fontSize: 10, fill: T.gold }} />
                    {scheduled && <ReferenceLine x={fmtYm(scheduled)} stroke={T.gold} strokeOpacity={0.6} />}
                    <Bar dataKey="month" name="Single month" fill="#C9D6E3" radius={[3, 3, 0, 0]}>
                      {capData.map((d, i) => <Cell key={i} fill={d.fillOf.month} />)}
                    </Bar>
                    <Line type="monotone" dataKey="avg12" name="Next-12-month average" stroke={T.navy} strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
                <p style={{ fontSize: 11, color: T.charcoal, opacity: .85, margin: '8px 0 0', lineHeight: 1.6 }}>
                  {proj.earliest
                    ? <>At these rates the shop can carry <strong>{fmt(target)}/month</strong> — {fmt(target * gross)} with payroll tax, plus {fmt(inputs.drawsAfter)} of draws — from <strong>{fmtPeriod(proj.earliest)}</strong> on.</>
                    : <>At these rates the shop doesn’t reach <strong>{fmt(target)}/month</strong> ({fmt(target * gross)} with payroll tax, plus {fmt(inputs.drawsAfter)} of draws) within {inputs.years} years.</>}
                  {' '}
                  {proj.revenueNeeded != null && (growthNeeded > 0
                    ? <>To carry it from the first projected year, that year’s net revenue would need to be about <strong>{fmt(proj.revenueNeeded)}</strong> — <strong>{growthNeeded.toFixed(0)}% growth</strong> over the last twelve months at {Number(inputs.cogsPct).toFixed(1)}% cost of goods.</>
                    : <>Year-one revenue already covers it.</>)}
                </p>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '10px 0 0' }}>
                  {[
                    ['Today', owner.ownerPayProposed, inputs.drawsNow, ssdi],
                    ['At the target', target, inputs.drawsAfter, 0],
                  ].map(([label, pay, dr, check]) => (
                    <div key={label} style={{ flex: '1 1 220px', padding: '8px 12px', border: `1px solid ${T.border}`, borderRadius: 6, background: '#fff' }}>
                      <div style={cardLabel}>{label}</div>
                      <table style={{ borderCollapse: 'collapse', fontSize: 11.5, width: '100%' }}>
                        <tbody>
                          <tr><td style={tName}>Payroll {ssdiOn && <span style={{ color: '#9ca3af' }}>(what SSDI counts)</span>}</td><td style={tCell}>{fmt(pay)}</td></tr>
                          <tr><td style={tName}>Draws <span style={{ color: '#9ca3af' }}>(car, insurance, gas)</span></td><td style={tCell}>{fmt(dr)}</td></tr>
                          {ssdiOn && <tr><td style={tName}>SSDI check</td><td style={tCell}>{check ? fmt(check) : '—'}</td></tr>}
                          <tr style={{ borderTop: `1px solid ${T.border}` }}>
                            <td style={{ ...tName, fontWeight: 600, color: T.navy }}>To him in all</td>
                            <td style={{ ...tCell, fontWeight: 600, color: T.navy }}>{fmt(Number(pay) + Number(dr) + check)}</td>
                          </tr>
                          <tr><td style={{ ...tName, color: '#6b7280' }}>Shop’s cost, with payroll tax</td><td style={{ ...tCell, color: '#6b7280' }}>{fmt(pay * gross + Number(dr))}</td></tr>
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
                {ssdiOn && <p style={{ fontSize: 10.5, color: '#9ca3af', margin: '6px 0 0', lineHeight: 1.5 }}>
                  The SSDI earnings limit is measured on payroll. SSA can, however, treat personal costs the shop
                  pays for an owner as part of his pay, so the draws are worth raising with his benefits counselor.
                  {ssdi > 0 && <> At the step-up the {fmt(ssdi)} check ends, so what reaches him changes by {fmt(target + Number(inputs.drawsAfter) - Number(owner.ownerPayProposed) - Number(inputs.drawsNow) - ssdi)}/month, before income tax.</>}
                </p>}
                <p style={{ fontSize: 11, color: T.charcoal, opacity: .85, margin: '6px 0 0', lineHeight: 1.6 }}>
                  {scheduled
                    ? <>The step-up is scheduled for <strong>{fmtPeriod(scheduled)}</strong> (set on the Term Loan Planner); the tables below use it.{' '}
                        {proj.earliest && scheduled < proj.earliest && <span style={{ color: T.danger, fontWeight: 600 }}>That is before the shop can sustain it. </span>}</>
                    : <>Nothing is scheduled, so the tables below step up at the earliest sustainable month{proj.earliest ? '' : ' — which doesn’t come, so they stay at today’s pay'}.{' '}</>}
                  <span className="pj-controls">
                    {proj.earliest && scheduled !== proj.earliest && (
                      <button style={btnSec} onClick={() => setOwner('ownerPayStepDate', `${proj.earliest}-01`)}>Schedule the step-up for {fmtPeriod(proj.earliest)}</button>
                    )}
                    {scheduled && <> <button style={btnSec} onClick={() => setOwner('ownerPayStepDate', '')}>Clear the date</button></>}
                  </span>
                </p>
              </div>
            )}

            {/* Revenue */}
            <div style={panel}>
              <div style={panelLabel}>Net revenue by month</div>
              <ResponsiveContainer width="100%" height={210}>
                <ComposedChart data={revData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: T.charcoal }} minTickGap={24} />
                  <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize: 10, fill: T.charcoal }} width={52} />
                  <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(27,58,92,0.05)' }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="actual" name="Last 12 months (ledger)" stackId="rev" fill="#A9A49B" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="projected" name="Projected" stackId="rev" fill={T.steel} radius={[3, 3, 0, 0]} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Month by month */}
        {proj && (
          <div style={{ ...panel, marginTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              <div style={{ ...panelLabel, marginBottom: 0 }}>Month by month</div>
              <div className="pj-controls" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {proj.years.map(y => (
                  <button key={y.yr} onClick={() => setView(y.yr)} style={view === y.yr ? tabOn : tabOff}>Year {y.yr + 1}</button>
                ))}
                <button onClick={() => setView('all')} style={view === 'all' ? tabOn : tabOff}>By year</button>
              </div>
            </div>
            {(() => {
              const yearView = view === 'all'
              const cols = yearView ? proj.years : proj.rows.filter(r => r.yr === (proj.years[view] ? view : 0))
              const total = yearView ? null : proj.years[proj.years[view] ? view : 0]
              const colLabel = c => yearView ? `Year ${c.yr + 1}` : fmtYm(c.ym)
              const lines = [
                { k: 'netRev',      label: 'Net revenue' },
                { k: 'cogs',        label: 'Cost of goods', neg: true },
                { k: 'grossProfit', label: 'Gross profit', bold: true, rule: true },
                { k: 'opex',        label: 'Operating expenses', neg: true, tip: 'Everything but the owner’s pay.' },
                { k: 'beforeOwner', label: 'Before owner pay', bold: true, rule: true },
                { k: 'ownerPay',    label: 'Owner pay (gross)', neg: true },
                { k: 'payrollTax',  label: 'Employer payroll tax', neg: true },
                { k: 'interest',    label: 'Loan interest', neg: true, hide: !loanActive },
                { k: 'netIncome',   label: 'Net income', bold: true, rule: true, tip: 'Before income tax.' },
                { k: 'draws',       label: 'Owner draws', neg: true, tip: 'Car, insurance, gas — out of cash, not an expense, no payroll tax.' },
                { k: 'payment',     label: 'Loan payment (principal + interest)', neg: true, hide: !loanActive, tip: 'Interest is already in net income; the cash line takes the whole payment.' },
                { k: 'balloon',     label: 'Loan balloon', neg: true, hide: !loanActive || !proj.rows.some(r => r.balloon) },
                { k: 'cashLeft',    label: 'Cash left over', bold: true, rule: true, tip: 'Before income tax and before any inventory build-up growth needs.' },
                { k: 'cumCash',     label: 'Running total', hide: yearView, muted: true },
                { k: 'ssdi',        label: 'SSDI check', muted: true, rule: true, hide: !ssdi, tip: 'His benefit, paid until the step-up. Not shop money — shown so the total below is everything he receives.' },
                { k: 'toOwner',     label: ssdi ? 'To the owner (payroll + draws + SSDI)' : 'To the owner (payroll + draws)', muted: true, rule: !ssdi, tip: ssdiOn ? 'Gross payroll, draws and any SSDI check — everything that reaches him. SSDI looks at the payroll part.' : 'Gross payroll plus draws — everything that reaches him.' },
                { k: 'capacity',    label: yearView ? 'Pay it can carry (avg / mo)' : 'Pay it can carry', muted: true, tip: 'The most gross owner pay this month could carry, payroll tax and loan coverage included.' },
              ].filter(l => !l.hide)
              const cell = (key, v, l, extra = {}) => {
                const val = l.neg ? -v : v
                return (
                  <td key={key} style={{ ...tCell, fontWeight: l.bold ? 600 : 400, color: val < 0 && (l.bold || l.muted) ? T.danger : l.muted ? '#6b7280' : l.bold ? T.navy : T.charcoal, ...extra }}>
                    {v ? (val < 0 ? `(${fmt(-val).slice(1)})` : fmt(val).slice(1)) : '—'}
                  </td>
                )
              }
              return (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
                    <thead>
                      <tr>
                        <th style={{ ...tHead, textAlign: 'left', position: 'sticky', left: 0, background: T.card }}>{yearView ? '' : `${fmtYm(cols[0].ym)}–${fmtYm(cols[cols.length - 1].ym)}`}</th>
                        {cols.map(c => (
                          <th key={yearView ? c.yr : c.ym} style={{ ...tHead, color: !yearView && c.ownerPay === target && target > 0 ? T.navy : T.gold }}>{colLabel(c)}</th>
                        ))}
                        {total && <th style={{ ...tHead, borderLeft: `1px solid ${T.border}` }}>Year</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map(l => (
                        <tr key={l.k} style={{ borderTop: l.rule ? `1px solid ${T.border}` : '1px solid #F0EEE9' }}>
                          <td style={{ ...tName, fontWeight: l.bold ? 600 : 400, color: l.bold ? T.navy : l.muted ? '#6b7280' : T.charcoal, position: 'sticky', left: 0, background: T.card }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{l.label}{l.tip && <InfoTip title={l.label}>{l.tip}</InfoTip>}</span>
                          </td>
                          {cols.map(c => cell(yearView ? c.yr : c.ym, c[l.k], l))}
                          {total && (l.k === 'cumCash'
                            ? <td style={{ ...tCell, borderLeft: `1px solid ${T.border}` }} />
                            : cell('total', total[l.k], l, { borderLeft: `1px solid ${T.border}`, fontWeight: 600 }))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })()}
            <p style={{ fontSize: 10.5, color: '#9ca3af', margin: '8px 0 0', lineHeight: 1.5 }}>
              Owner cost each month is gross pay plus {Number(owner.payrollTaxPct)}% employer payroll tax; draws come on top, out of cash. Months in navy headings pay the
              {' '}{fmt(target)} target. Income tax is left out, and so is the cash growth ties up: more sales means more
              inventory on the shelf, bought before it sells. The year column for “Pay it can carry” is the year’s monthly average.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

const card       = { flex: '1 1 170px', minWidth: 170, background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: '11px 14px' }
const cardLabel  = { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }
const cardBig    = { fontSize: 21, fontWeight: 600, color: T.navy, lineHeight: 1.1 }
const cardSub    = { fontSize: 10.5, color: 'rgba(74,74,74,0.65)', marginTop: 4, lineHeight: 1.45 }
const panel      = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: '13px 16px' }
const panelLabel = { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 9 }
const inputRow   = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #F0EEE9', gap: 8 }
const inputLabel = { fontSize: 12, color: T.charcoal, display: 'inline-flex', alignItems: 'center', gap: 5 }
const tHead      = { padding: '4px 0 4px 12px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }
const tName      = { padding: '4px 10px 4px 0', whiteSpace: 'nowrap' }
const tCell      = { padding: '4px 0 4px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const btnSec     = { padding: '5px 12px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 10.5, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }
const tabOn      = { ...btnSec, background: T.navy, color: '#fff', borderColor: T.navy }
const tabOff     = btnSec
