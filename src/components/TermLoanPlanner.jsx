'use client'

// Term Loan Planner — the lender's view of a LEAF term loan to the shop.
//
// One advance at closing settles the back taxes, the credit cards and the
// accountant's bill; the rest
// lands in the shop's bank account as winter working capital. Rate, term,
// amortization and closing date are all free inputs. The page answers what the
// payment is, what is left at maturity, and whether the shop's own cash flow
// carries it — and how much the owner can be paid on top. Math in lib/termLoan.js; this file is presentation.

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { supabase, fetchAll } from '../lib/supabase'
import { fetchAccounts } from '../lib/chartOfAccounts'
import { getSetting, setSetting } from '../lib/settings'
import { buildBalanceSheet, balanceSheetYears } from '../lib/balanceSheet'
import { buildTermLoan, buildLoanSeeds, maxOwnerPay } from '../lib/termLoan'
import { T, MON, fmt, fmt2, fmtK, fmtYm } from '../lib/theme'
import InfoTip from './InfoTip'
import CommitInput from './CommitInput'

const SCENARIO_KEY = 'term_loan_scenario'

const pad2 = n => String(n).padStart(2, '0')
const fmtDate = iso => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return `${MON[m]} ${d}, ${y}`
}
const firstOfNextMonth = now => {
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`
}

// Ledger figures where the books have them; the loan is sized to clear the
// payoffs and leave a round $15k of working capital. The accountant's bill and
// the owner's $700 of payroll are known figures the ledger doesn't break out.
const seedsToInputs = (s, now = new Date()) => {
  const backTaxes  = Math.max(0, Math.round(s?.taxPayable ?? 0))
  const cardPayoff = Math.max(0, Math.round(s?.cardBalance ?? 0))
  const accountantPayable = 4500
  return {
    amount:          Math.ceil((backTaxes + cardPayoff + accountantPayable + 15000) / 1000) * 1000,
    aprPct:          8.5,
    termMonths:      36,
    amortMonths:     36,
    closingDate:     firstOfNextMonth(now),
    originationPct:  0,
    backTaxes,
    cardPayoff,
    accountantPayable,
    openingCash:     Math.max(0, Math.round(s?.cash ?? 0)),
    monthlyFreeCash: Math.max(0, Math.round(s?.avgFreeCash ?? 0)),
    ownerPayCurrent:  700,
    ownerPayProposed: 700,
    payrollTaxPct:    7.65,
    dscrTarget:       1.25,
    cashFloor:        5000,
    benefitLimit:     1210, // 2026 SSDI trial-work line
    ssdiBenefit:      0,
  }
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

export default function TermLoanPlanner({ clientId }) {
  const [seeds,   setSeeds]   = useState(null)
  const [inputs,  setInputs]  = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [msg,     setMsg]     = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        // No category filter: uncategorized rows are still cash movements.
        const [rows, coa, reg, saved] = await Promise.all([
          fetchAll(() => supabase.from('bank_transactions')
            .select('transaction_date, amount, category, account')
            .eq('client_id', clientId)
            .order('transaction_date').order('id')),
          fetchAccounts(clientId),
          getSetting(clientId, 'ledger_accounts', []).catch(() => []),
          getSetting(clientId, SCENARIO_KEY, null).catch(() => null),
        ])
        if (cancelled) return
        const registry = Array.isArray(reg) ? reg : []
        const years = balanceSheetYears(rows ?? [])
        const bs = buildBalanceSheet({ txns: rows ?? [], accounts: coa.accounts, year: years[years.length - 1], registry })
        const s = buildLoanSeeds({ txns: rows ?? [], accounts: coa.accounts, registry, bs, now: new Date() })
        setSeeds(s)
        // Saved scenario wins, field by field, so a newly added input still
        // gets its ledger default.
        setInputs({ ...seedsToInputs(s), ...(saved ?? {}) })
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [clientId])

  const save = useCallback(async (next, note) => {
    setInputs(next); setMsg('')
    try { await setSetting(clientId, SCENARIO_KEY, next); setMsg(note) }
    catch (e) { alert('Could not save: ' + e.message) }
  }, [clientId])

  const setField = useCallback((key, val) => save({ ...inputs, [key]: val }, '✓ Scenario saved'), [inputs, save])
  const resetToLedger = useCallback(() => save(seedsToInputs(seeds), '✓ Reset to ledger defaults'), [seeds, save])

  const loan = useMemo(() => inputs ? buildTermLoan(inputs) : null, [inputs])
  const payCap = useMemo(() => inputs ? maxOwnerPay(inputs, inputs) : null, [inputs])

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

  const chartData = loan?.series.map(p => ({ ...p, label: fmtYm(p.date.slice(0, 7)) })) ?? []
  const short = loan && loan.toBank < 0
  const covered = loan && loan.dscr != null && loan.dscr >= 1
  const cashOk = loan && loan.minCash.amount >= 0

  const row = (key, label, suffix, tip) => (
    <div key={key} style={inputRow}>
      <span style={inputLabel}>
        {label}
        <InfoTip title={label}>{tip}</InfoTip>
      </span>
      <CommitInput value={inputs[key]} suffix={suffix} onCommit={v => setField(key, v)} />
    </div>
  )

  return (
    <div style={{ background: T.page, minHeight: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' }}>
      <style>{`@media print { aside, .tl-controls { display:none !important } body { background:#fff !important } .tl-schedule { max-height:none !important; overflow:visible !important } }`}</style>

      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 28px', background: T.card, borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
            Term Loan Planner
            <InfoTip title="Term Loan Planner">
              LEAF advances a term loan to the shop. At closing the money settles the back taxes,
              the credit cards and the accountant’s bill, and whatever is left goes to the shop’s bank account as working
              capital for the winter. The loan then repays in level monthly payments.
            </InfoTip>
          </h2>
          <p style={{ fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 }}>
            LEAF term loan — taxes and cards settled at closing, the remainder to the bank
          </p>
        </div>
        <div className="tl-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {msg && <span style={{ fontSize: 11, color: T.success, fontWeight: 500 }}>{msg}</span>}
          <button onClick={resetToLedger} style={btnSec} disabled={!seeds}>Use ledger defaults</button>
          <button onClick={() => window.print()} style={btnSec}>🖨 Print / PDF</button>
        </div>
      </header>

      <div style={{ padding: '20px 28px 48px', maxWidth: 1020 }}>

        {/* Verdict */}
        {loan && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
            <div style={{ ...card, borderTop: `3px solid ${T.navy}` }}>
              <div style={cardLabel}>Monthly payment</div>
              <div style={cardBig}>{fmt2(loan.payment)}</div>
              <div style={cardSub}>
                {loan.months} payments, first on {fmtDate(loan.schedule[0].date)}
                {loan.oddInterest ? ` (${fmt2(loan.schedule[0].payment)} with the odd days)` : ''}
              </div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${short ? T.danger : T.success}` }}>
              <div style={cardLabel}>To the bank at closing</div>
              <div style={{ ...cardBig, color: short ? T.danger : T.navy }}>{fmt(loan.toBank)}</div>
              <div style={cardSub}>
                {short ? 'the payoffs exceed the loan' : `after ${fmt(loan.taxes + loan.cards + loan.accountant + loan.fee)} of payoffs${loan.fee ? ' and fee' : ''}`}
              </div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${T.gold}` }}>
              <div style={cardLabel}>Interest to LEAF</div>
              <div style={cardBig}>{fmt(loan.totalInterest)}</div>
              <div style={cardSub}>
                {loan.fee ? `plus ${fmt(loan.fee)} origination` : `over ${loan.months} months`}
              </div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${loan.balloon ? T.amber : T.steel}` }}>
              <div style={cardLabel}>{loan.balloon ? 'Balloon at maturity' : 'Paid off'}</div>
              <div style={cardBig}>{loan.balloon ? fmt(loan.balloon) : fmtDate(loan.maturityDate)}</div>
              <div style={cardSub}>
                {loan.balloon ? `due ${fmtDate(loan.maturityDate)}` : 'fully amortizing — nothing left at maturity'}
              </div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${covered ? T.success : T.danger}` }}>
              <div style={cardLabel}>DSCR · cash basis</div>
              <div style={{ ...cardBig, color: covered ? T.success : T.danger }}>{loan.dscr != null ? `${loan.dscr.toFixed(2)}×` : '—'}</div>
              <div style={cardSub}>{fmt(loan.freeCash)}/mo of free cash{loan.raise ? ' after the raise' : ''} vs. the payment</div>
            </div>
            <div style={{ ...card, borderTop: `3px solid ${cashOk ? T.steel : T.danger}` }}>
              <div style={cardLabel}>Lowest bank balance</div>
              <div style={{ ...cardBig, color: cashOk ? T.navy : T.danger }}>{fmt(loan.minCash.amount)}</div>
              <div style={cardSub}>{fmtDate(loan.minCash.date)}</div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>

          {/* Inputs */}
          <div style={{ ...panel, flex: '0 1 330px', minWidth: 290 }}>
            <div style={panelLabel}>The loan</div>
            {inputs && <>
              {row('amount', 'Loan amount', '$', 'The single advance at closing.')}
              {row('aprPct', 'Rate', '%', 'Annual rate. Interest accrues monthly on the balance outstanding.')}
              {row('termMonths', 'Term', 'mo', 'When the loan matures. Whatever is still owed then comes due in one payment.')}
              {row('amortMonths', 'Amortization', 'mo', 'The period the payment is sized on. Equal to the term, the loan pays itself off; longer than the term, the payment is smaller and a balloon is left at maturity.')}
              <div style={inputRow}>
                <span style={inputLabel}>
                  Closing date
                  <InfoTip title="Closing date">The day the money arrives. Payments fall on the first of the month: close before the 15th and the first is due the first of next month; close on or after the 15th and it is due the month after that. Interest for the odd days rides on the first payment.</InfoTip>
                </span>
                <input
                  type="date"
                  value={inputs.closingDate}
                  onChange={e => { if (e.target.value) setField('closingDate', e.target.value) }}
                  style={{ padding: '3px 6px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 12, color: T.charcoal, background: '#fff', outline: 'none', fontFamily: 'inherit' }}
                />
              </div>
              {row('originationPct', 'Origination fee', '%', 'Optional. Taken out of the proceeds at closing rather than added to the loan.')}

              <div style={{ ...panelLabel, marginTop: 16 }}>Where the money goes</div>
              {row('backTaxes', 'Back taxes', '$', 'Paid straight from the proceeds at closing.')}
              {row('cardPayoff', 'Credit cards', '$', 'Card balances paid off at closing. Use the statement balances — the card feed in the ledger is only as current as its last import.')}
              {row('accountantPayable', 'Accountant payable', '$', 'The accountant’s bill for the owner’s project, paid straight from the proceeds at closing.')}
              <div style={{ ...inputRow, borderBottom: 'none' }}>
                <span style={{ ...inputLabel, fontWeight: 600, color: T.navy }}>Remainder to the bank</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: short ? T.danger : T.navy, fontVariantNumeric: 'tabular-nums' }}>
                  {loan ? fmt(loan.toBank) : '—'}
                </span>
              </div>

              <div style={{ ...panelLabel, marginTop: 16 }}>The shop’s cash</div>
              {row('openingCash', 'Bank balance at closing', '$', 'What is in the shop’s bank account just before the loan funds.')}
              {row('monthlyFreeCash', 'Free cash / month', '$', 'What the bank account gains in an ordinary month before card payments and before this loan’s payment, at the owner’s current pay. With the cards paid off, this is what services the loan.')}

              <div style={{ ...panelLabel, marginTop: 16 }}>Owner pay</div>
              {row('ownerPayCurrent', 'Current pay / month', '$', 'What the owner is paid through payroll today. The free cash above already has this taken out.')}
              {row('ownerPayProposed', 'Proposed pay / month', '$', 'Gross monthly pay after the raise. Only the increase over current pay comes out of free cash.')}
              {row('payrollTaxPct', 'Employer payroll tax', '%', 'The shop’s share of payroll tax on the raise — 7.65% Social Security and Medicare, more if state unemployment applies.')}
              {row('dscrTarget', 'Coverage to keep', '×', 'Free cash after the raise must cover the loan payment this many times over. 1.25× is the usual lender floor; 1.00× is breakeven.')}
              {row('cashFloor', 'Lowest bank balance', '$', 'The bank balance the shop should never drop below while the loan is outstanding.')}
              {row('benefitLimit', 'SSDI earnings limit', '$', 'Gross monthly pay that keeps his SSDI untouched. 2026: $1,210 is the trial-work line (above it a month uses one of nine trial months); $1,690 is substantial gainful activity (above it, once the trial months are spent, the check stops). The lines rise each January — $1,270 for trial work in 2027. SSA can also count the value of the work he does in the business, not just payroll. 0 turns the limit off.')}
              {row('ssdiBenefit', 'SSDI check / month', '$', 'His monthly SSDI benefit. With it, the page works out the pay that would fully replace it — the point at which the earnings limit can come off.')}
            </>}
            {seeds && (
              <p style={{ fontSize: 10.5, color: '#9ca3af', margin: '9px 0 0', lineHeight: 1.5 }}>
                The ledger{seeds.asOf ? <> through {fmtYm(seeds.asOf)}</> : null} carries {fmt(seeds.taxPayable)} of sales tax payable,{' '}
                {fmt(seeds.cardBalance)} owed on cards and {fmt(seeds.cash)} in the bank.
              </p>
            )}
          </div>

          <div style={{ flex: '1 1 420px', minWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Owner raise */}
            {loan && payCap && (() => {
              const capBox = (label, value, sub, on) => (
                <div style={{ flex: '1 1 150px', minWidth: 150, padding: '9px 12px', border: `1px solid ${on ? T.navy : T.border}`, borderRadius: 6, background: '#fff' }}>
                  <div style={cardLabel}>{label}</div>
                  <div style={{ ...cardBig, color: value < inputs.ownerPayCurrent ? T.danger : T.navy }}>
                    {fmt(value)}<span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>/mo</span>
                  </div>
                  <div style={cardSub}>{sub}</div>
                </div>
              )
              const target = Math.max(0, Math.floor(payCap.max))
              const over = inputs.ownerPayProposed > payCap.max + 0.5
              const rep = payCap.replacement
              const tighter = {
                coverage: 'Coverage is the tighter limit.',
                cash: 'The bank balance is the tighter limit — it runs into the floor before coverage does.',
                benefit: <>The SSDI limit is the tighter one — the shop could carry up to <strong>{fmt(payCap.withoutBenefit)}</strong>, but more than {fmt(inputs.benefitLimit)} would start to cost him benefits.</>,
              }[payCap.binding]
              return (
                <div style={panel}>
                  <div style={{ ...panelLabel, display: 'flex', alignItems: 'center', gap: 5 }}>
                    How much can the owner be paid?
                    <InfoTip title="Owner pay">
                      The free cash the shop has been earning already pays the owner {fmt(inputs.ownerPayCurrent)}/month.
                      Every dollar of raise, plus the employer’s payroll tax on it, comes out of the same cash that
                      services the loan. Two ceilings: one the shop can keep up indefinitely, and one that only
                      lasts as long as the working capital from the loan does.
                    </InfoTip>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {capBox('Sustainable', payCap.byCoverage, `keeps coverage at ${Number(inputs.dscrTarget).toFixed(2)}×`, payCap.binding === 'coverage')}
                    {capBox('While the cash lasts', payCap.byCash, `bank never below ${fmt(inputs.cashFloor)} through ${fmtDate(loan.maturityDate)}`, payCap.binding === 'cash')}
                    {payCap.byBenefit != null && capBox('SSDI limit', payCap.byBenefit, 'keeps his benefit untouched', payCap.binding === 'benefit')}
                  </div>
                  <p style={{ fontSize: 11, color: T.charcoal, opacity: .85, margin: '10px 0 0', lineHeight: 1.6 }}>
                    {payCap.max < inputs.ownerPayCurrent
                      ? <>At these terms the shop can’t keep paying the current <strong>{fmt(inputs.ownerPayCurrent)}</strong> and pass both tests — the ceiling is <strong>{fmt(payCap.max)}</strong>.</>
                      : <>The owner can go up to about <strong>{fmt(payCap.max)}/month</strong>, a raise of <strong>{fmt(payCap.max - inputs.ownerPayCurrent)}</strong> that costs the shop {fmt((payCap.max - inputs.ownerPayCurrent) * (1 + inputs.payrollTaxPct / 100))}/month with payroll tax.</>}
                    {' '}{tighter}
                    {loan.raise ? <> The proposed <strong>{fmt(inputs.ownerPayProposed)}</strong> is {over ? <span style={{ color: T.danger, fontWeight: 600 }}>over that ceiling</span> : 'within it'}; the cards above, the chart and the coverage figures all include it.</> : null}
                  </p>
                  {payCap.byBenefit != null && (
                    <p style={{ fontSize: 11, color: T.charcoal, opacity: .85, margin: '8px 0 0', lineHeight: 1.6, paddingTop: 8, borderTop: '1px solid #F0EEE9' }}>
                      {!rep
                        ? <>Enter his monthly SSDI check to see what pay would replace it.</>
                        : rep.ready
                          ? <>Replacing the benefit takes about <strong>{fmt(rep.pay)}/month</strong> gross — the {fmt(inputs.benefitLimit)} he can earn now plus the check, grossed up for the FICA wages carry. <span style={{ color: T.success, fontWeight: 600 }}>The shop can carry that on these terms</span>, so the limit could come off.</>
                          : <>Replacing the benefit takes about <strong>{fmt(rep.pay)}/month</strong> gross — the {fmt(inputs.benefitLimit)} he can earn now plus the check, grossed up for the FICA wages carry. To pay that and keep coverage at {Number(inputs.dscrTarget).toFixed(2)}×, free cash needs to reach <strong>{fmt(rep.freeNeeded)}/month</strong>, <span style={{ color: T.danger, fontWeight: 600 }}>{fmt(rep.shortfall)} more</span> than the shop earns now. Until then, stay under the limit.</>}
                    </p>
                  )}
                  <div className="tl-controls" style={{ marginTop: 8 }}>
                    <button style={btnSec} disabled={target === inputs.ownerPayProposed}
                      onClick={() => setField('ownerPayProposed', target)}>
                      Set proposed pay to {fmt(target)}
                    </button>
                  </div>
                </div>
              )
            })()}

            {/* Balance curve */}
            <div style={panel}>
              <div style={panelLabel}>The loan and the bank account</div>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: T.charcoal }} minTickGap={24} />
                  <YAxis tickFormatter={v => fmtK(v)} tick={{ fontSize: 10, fill: T.charcoal }} width={52} />
                  <Tooltip content={<ChartTip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={0} stroke={T.charcoal} strokeOpacity={0.45} />
                  <Area type="monotone" dataKey="loanBalance" name="Loan balance" fill={T.steel} fillOpacity={0.14} stroke={T.steel} strokeWidth={1} />
                  <Line type="monotone" dataKey="cash" name="Shop bank balance" stroke={T.success} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <p style={{ fontSize: 10.5, color: '#9ca3af', margin: '6px 0 0', lineHeight: 1.5 }}>
                The bank balance starts at closing with the remainder added, then each month gains the free
                cash and pays the loan{loan?.balloon ? '; the balloon comes out at maturity' : ''}. It assumes
                every month is an ordinary one — the table below shows how uneven they really are.
              </p>
            </div>

            {/* What the ledger says */}
            {seeds && seeds.history.length > 0 && (
              <div style={panel}>
                <div style={panelLabel}>What the ledger says</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
                    <tbody>
                      <tr>
                        <th style={{ ...hHead, textAlign: 'left' }}>Month</th>
                        {seeds.history.map(h => <th key={h.ym} style={hHead}>{fmtYm(h.ym)}</th>)}
                        <th style={hHead}>Avg</th>
                      </tr>
                      <tr style={{ borderTop: '1px solid #F0EEE9' }}>
                        <td style={hName}>Free cash</td>
                        {seeds.history.map(h => (
                          <td key={h.ym} style={{ ...hCell, color: h.freeCash < 0 ? T.danger : T.charcoal }}>{fmtK(h.freeCash)}</td>
                        ))}
                        <td style={{ ...hCell, fontWeight: 600, color: T.navy }}>{fmt(seeds.avgFreeCash)}</td>
                      </tr>
                      <tr style={{ borderTop: '1px solid #F0EEE9' }}>
                        <td style={hName}>Card payments</td>
                        {seeds.history.map(h => <td key={h.ym} style={hCell}>{h.cardPayments ? fmtK(h.cardPayments) : '—'}</td>)}
                        <td style={{ ...hCell, fontWeight: 600, color: T.navy }}>{fmt(seeds.avgCardPayments)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p style={{ fontSize: 11, color: T.charcoal, opacity: .85, margin: '10px 0 0', lineHeight: 1.6 }}>
                  Free cash is what the bank account actually gained each month, leaving out card payments
                  and transfers to savings. The shop has been sending the cards about{' '}
                  <strong>{fmt(seeds.avgCardPayments)}/month</strong>
                  {loan ? <>; this loan asks for <strong>{fmt2(loan.payment)}</strong></> : null}.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Debt service coverage */}
        {loan && seeds?.earnings && (() => {
          const e = seeds.earnings
          const ads = loan.annualDebtService
          const ratio = v => ads > 0 ? v / ads : null
          const cashBasis = loan.freeCash * 12
          // A payroll raise is an expense, so it comes off the earnings too.
          const raiseYr = loan.raiseCost * 12
          const ebitda = e.ebitda - raiseYr, afterDraws = e.afterDraws - raiseYr
          const line = (label, value, opts = {}) => (
            <tr key={label} style={{ borderTop: opts.rule ? `1px solid ${T.border}` : '1px solid #F0EEE9' }}>
              <td style={{ ...sName, fontWeight: opts.bold ? 600 : 400, color: opts.bold ? T.navy : T.charcoal }}>{label}</td>
              <td style={{ ...sCell, fontWeight: opts.bold ? 600 : 400, color: opts.bold ? T.navy : T.charcoal }}>{fmt(value)}</td>
            </tr>
          )
          const dscrBox = (label, r, sub) => (
            <div style={{ flex: '1 1 150px', minWidth: 150, padding: '9px 12px', border: `1px solid ${T.border}`, borderRadius: 6, background: '#fff' }}>
              <div style={cardLabel}>{label}</div>
              <div style={{ ...cardBig, color: r == null ? T.navy : r >= 1.25 ? T.success : r >= 1 ? T.amber : T.danger }}>
                {r != null ? `${r.toFixed(2)}×` : '—'}
              </div>
              <div style={cardSub}>{sub}</div>
            </div>
          )
          return (
            <div style={{ ...panel, marginTop: 16 }}>
              <div style={{ ...panelLabel, display: 'flex', alignItems: 'center', gap: 5 }}>
                Debt service coverage
                <InfoTip title="Debt service coverage">
                  What the shop earns in a year divided by what this loan asks for in a year. Above 1.00× the
                  shop covers the payments; lenders usually want 1.25× or better. Three ways of measuring
                  the top of the fraction, from most generous to most conservative.
                </InfoTip>
              </div>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12, flex: '0 1 330px', minWidth: 270 }}>
                  <tbody>
                    {line(`Net income, last ${e.months} months${e.months < 12 ? ' (annualized)' : ''}`, e.netIncome)}
                    {line('+ Interest expense', e.interest)}
                    {line('+ Depreciation & amortization', e.depAmort)}
                    {raiseYr ? line('− Owner raise with payroll tax', -raiseYr) : null}
                    {line('EBITDA', ebitda, { bold: true, rule: true })}
                    {line('− Owner draws', -e.ownerDraws)}
                    {line('After owner draws', afterDraws, { bold: true, rule: true })}
                    {line('Annual debt service', ads, { bold: true, rule: true })}
                  </tbody>
                </table>
                <div style={{ flex: '1 1 380px', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {dscrBox('DSCR · EBITDA', ratio(ebitda), `${fmt(ebitda)} ÷ ${fmt(ads)}`)}
                  {dscrBox('DSCR · after draws', ratio(afterDraws), `${fmt(afterDraws)} ÷ ${fmt(ads)}`)}
                  {dscrBox('DSCR · cash basis', ratio(cashBasis), `${fmt(cashBasis)} of free cash ÷ ${fmt(ads)}`)}
                </div>
              </div>
              <p style={{ fontSize: 11, color: T.charcoal, opacity: .85, margin: '10px 0 0', lineHeight: 1.6 }}>
                Annual debt service is the first twelve months of payments{loan.months <= 12 && loan.balloon ? ', balloon included' : ''}.
                The earnings figures come off the P&amp;L, whose cost of goods is an estimate until the quarterly
                count trues it up, and profit that went back onto the shelf as inventory is not cash. The cash
                basis uses the free cash entered above — what the bank account actually gained, less any raise — and is the
                one to lean on.
              </p>
            </div>
          )
        })()}

        {/* Payment schedule */}
        {loan && (
          <div style={{ ...panel, marginTop: 16 }}>
            <div style={panelLabel}>Payment schedule</div>
            <div className="tl-schedule" style={{ maxHeight: 340, overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%', maxWidth: 640 }}>
                <thead>
                  <tr>
                    {['#', 'Date', 'Payment', 'Interest', 'Principal', 'Balance'].map((h, i) => (
                      <th key={h} style={{ ...sHead, textAlign: i < 2 ? 'left' : 'right' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderTop: '1px solid #F0EEE9' }}>
                    <td style={sName}>—</td>
                    <td style={sName}>{fmtDate(inputs.closingDate)} · closing</td>
                    <td style={sCell} /><td style={sCell} /><td style={sCell} />
                    <td style={sCell}>{fmt2(inputs.amount)}</td>
                  </tr>
                  {loan.schedule.map(r => (
                    <tr key={r.n} style={{ borderTop: '1px solid #F0EEE9' }}>
                      <td style={sName}>{r.n}</td>
                      <td style={sName}>{fmtDate(r.date)}</td>
                      <td style={sCell}>{fmt2(r.payment)}</td>
                      <td style={sCell}>{fmt2(r.interest)}</td>
                      <td style={sCell}>{fmt2(r.principal)}</td>
                      <td style={sCell}>{fmt2(r.balance)}</td>
                    </tr>
                  ))}
                  {loan.balloon > 0 && (
                    <tr style={{ borderTop: '1px solid #F0EEE9' }}>
                      <td style={sName} />
                      <td style={{ ...sName, color: T.amber, fontWeight: 600 }}>{fmtDate(loan.maturityDate)} · balloon</td>
                      <td style={{ ...sCell, color: T.amber, fontWeight: 600 }}>{fmt2(loan.balloon)}</td>
                      <td style={sCell} />
                      <td style={sCell}>{fmt2(loan.balloon)}</td>
                      <td style={sCell}>{fmt2(0)}</td>
                    </tr>
                  )}
                  <tr style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={sName} />
                    <td style={{ ...sName, fontWeight: 600, color: T.navy }}>Total</td>
                    <td style={{ ...sCell, fontWeight: 600, color: T.navy }}>{fmt2(loan.totalRepaid)}</td>
                    <td style={{ ...sCell, fontWeight: 600, color: T.navy }}>{fmt2(loan.totalInterest)}</td>
                    <td style={{ ...sCell, fontWeight: 600, color: T.navy }}>{fmt2(inputs.amount)}</td>
                    <td style={sCell} />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const card       = { flex: '1 1 150px', minWidth: 150, background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: '11px 14px' }
const cardLabel  = { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }
const cardBig    = { fontSize: 21, fontWeight: 600, color: T.navy, lineHeight: 1.1 }
const cardSub    = { fontSize: 10.5, color: 'rgba(74,74,74,0.65)', marginTop: 4, lineHeight: 1.45 }
const panel      = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 7, padding: '13px 16px' }
const panelLabel = { fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 9 }
const inputRow   = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #F0EEE9' }
const inputLabel = { fontSize: 12, color: T.charcoal, display: 'inline-flex', alignItems: 'center', gap: 5 }
const hHead      = { padding: '4px 0 4px 12px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }
const hName      = { padding: '4px 0', color: T.navy, fontWeight: 600, whiteSpace: 'nowrap' }
const hCell      = { padding: '4px 0 4px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.charcoal, whiteSpace: 'nowrap' }
const sHead      = { padding: '4px 14px 4px 0', fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: T.card }
const sName      = { padding: '4px 14px 4px 0', color: T.charcoal, whiteSpace: 'nowrap' }
const sCell      = { padding: '4px 14px 4px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.charcoal }
const btnSec     = { padding: '5px 12px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 10.5, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }
