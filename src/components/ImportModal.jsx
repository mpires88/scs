import { useState, useEffect, useCallback, useMemo, Fragment, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { normKey, buildCatIndex, suggestCat, clusterGroups } from '../lib/merchantClustering'
import {
  parseBankCSV, parseDate, fingerprint, autoDetectCols,
  DATE_FORMATS, STANDARD_FIELDS, DEFAULT_CFG, loadAllMappings, saveBankMapping,
} from '../lib/csv'
import { dominantCat, buildDescCatMap } from '../lib/categorize'
import CategoryInput from './CategoryInput'
import { T } from '../lib/theme'

export default function ImportModal({ clientId, allCats, groupedCats = null, existingTxns, onDone, onClose }) {
  const [step,       setStep]       = useState('upload')
  const [dragOver,   setDragOver]   = useState(false)
  const [csv,        setCsv]        = useState(null)
  const [cfg,        setCfg]        = useState(DEFAULT_CFG)
  const [mapError,   setMapError]   = useState('')
  const [parsed,     setParsed]     = useState([])
  const [parseErrs,  setParseErrs]  = useState([])
  const [catLoading, setCatLoading] = useState(false)
  const [toInsert,   setToInsert]   = useState([])
  const [dupCount,   setDupCount]   = useState(0)
  const [newGroups,  setNewGroups]  = useState([])
  const [catAssign,  setCatAssign]  = useState({})
  const [expanded,   setExpanded]   = useState({})
  const [result,     setResult]     = useState(null)
  const [showInstr,  setShowInstr]  = useState(false)
  const fileRef = useRef(null)

  const handleFile = useCallback(file => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.csv')) { setMapError('Please select a .csv file'); return }
    const reader = new FileReader()
    reader.onload = e => {
      const data = parseBankCSV(e.target.result)
      if (!data.headers.length) { setMapError('Could not parse CSV — no headers found'); return }

      const { cols, splitAmounts } = autoDetectCols(data.headers)
      const base = DEFAULT_CFG()
      setCsv(data); setCfg({ ...base, cols: { ...base.cols, ...cols }, splitAmounts }); setMapError(''); setStep('mapping')
    }
    reader.readAsText(file)
  }, [])

  const unbundle = useCallback((fromGroupKey, row) => {
    const uniqueKey = `unbundled_${Date.now()}_${Math.random().toString(36).slice(2)}`
    setNewGroups(gs => {
      const updated = gs.map(g => {
        if (g.key !== fromGroupKey) return g
        const remaining = g.txns.filter(t => t !== row)
        return { ...g, txns: remaining, total: remaining.reduce((s, t) => s + t.amount, 0) }
      }).filter(g => g.txns.length > 0)
      return [...updated, { key: uniqueKey, displayDesc: row.description, txns: [row], total: row.amount, suggestedCat: '', variants: [] }]
    })
    setCatAssign(prev => ({ ...prev, [uniqueKey]: prev[fromGroupKey] ?? '' }))
  }, [])

  const setCol  = (key, val) => { setCfg(c => ({ ...c, cols: { ...c.cols, [key]: val } })); setMapError('') }
  const setProp = (key, val) => setCfg(c => ({ ...c, [key]: val }))

  const onApplyMapping = () => {
    const { cols, dateFormat, splitAmounts, debitsPositive, bankName } = cfg
    if (!cols.transaction_date)                      { setMapError('Please map the Date column'); return }
    if (!cols.description)                           { setMapError('Please map the Description column'); return }
    if (!splitAmounts && !cols.amount)               { setMapError('Please map the Amount column'); return }
    if (splitAmounts && !cols.debit && !cols.credit) { setMapError('Please map at least one of Debit or Credit'); return }
    setMapError('')
    if (bankName.trim()) saveBankMapping(bankName.trim(), cfg)

    const errors = [], rows = []
    csv.rows.forEach((raw, i) => {
      const line = i + 2
      const rawDate = raw[cols.transaction_date] || ''
      const date = parseDate(rawDate, dateFormat)
      if (!date) { errors.push({ line, msg: `Invalid date "${rawDate}"` }); return }
      const rawDesc = (raw[cols.description] || '').trim()
      if (!rawDesc) { errors.push({ line, msg: 'Empty description' }); return }
      let amount
      if (splitAmounts) {
        const credit = parseFloat((raw[cols.credit] || '0').replace(/[$,\s]/g, '')) || 0
        const debit  = parseFloat((raw[cols.debit]  || '0').replace(/[$,\s]/g, '')) || 0
        amount = credit - debit
      } else {
        const rawAmt = (raw[cols.amount] || '').replace(/[$,\s]/g, '')
        amount = parseFloat(rawAmt)
        if (isNaN(amount)) { errors.push({ line, msg: `Invalid amount "${raw[cols.amount]}"` }); return }
        if (debitsPositive) amount = -amount
      }
      rows.push({
        transaction_date: date, description: rawDesc, amount,
        ...(cols.account      && raw[cols.account]      ? { account:      raw[cols.account].trim()      } : {}),
        ...(cols.reference_id && raw[cols.reference_id] ? { reference_id: raw[cols.reference_id].trim() } : {}),
        ...(cols.category     && raw[cols.category]     ? { category:     raw[cols.category].trim()     } : {}),
        ...(clientId !== null ? { client_id: clientId } : {}),
      })
    })
    setParsed(rows); setParseErrs(errors); setStep('categorize')
  }

  // Build dedup + suggestions when entering categorize step
  useEffect(() => {
    if (step !== 'categorize') return
    let cancelled = false
    const run = async () => {
      setCatLoading(true)
      try {
        // Count existing occurrences per fingerprint (not just presence) so a
        // second legitimate identical transaction on the same day still imports.
        const existingCount = {}
        existingTxns.forEach(r => {
          const fp = fingerprint(r)
          existingCount[fp] = (existingCount[fp] || 0) + 1
        })
        const descCatMap = buildDescCatMap(existingTxns)
        if (cancelled) return

        const seenCount = {}
        const newRows = [], dupes = []
        parsed.forEach(row => {
          const fp = fingerprint(row)
          seenCount[fp] = (seenCount[fp] || 0) + 1
          // Only skip while the database already holds at least this many copies
          if (seenCount[fp] <= (existingCount[fp] || 0)) dupes.push(row)
          else newRows.push(row)
        })

        const catIdx = buildCatIndex(descCatMap)
        const groupMap = {}
        newRows.forEach(row => {
          const key = normKey(row.description)
          if (!groupMap[key]) groupMap[key] = {
            key, displayDesc: row.description, txns: [], total: 0,
            suggestedCat: suggestCat(key, catIdx),
          }
          groupMap[key].txns.push(row)
          groupMap[key].total += row.amount
        })

        const rawGroups = Object.values(groupMap).sort((a, b) => a.key.localeCompare(b.key))
        const { clusters } = clusterGroups(rawGroups)

        const initAssign = {}
        clusters.forEach(g => {
          const importedCat = dominantCat(g.txns)
          if (importedCat)         initAssign[g.key] = importedCat
          else if (g.suggestedCat) initAssign[g.key] = g.suggestedCat
        })

        setToInsert(newRows); setDupCount(dupes.length)
        setNewGroups(clusters); setCatAssign(initAssign)
      } catch (e) {
        alert('Error: ' + e.message); setStep('mapping')
      } finally {
        if (!cancelled) setCatLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  const doUpload = async () => {
    setStep('uploading')
    try {
      // Build per-row category map using object identity so unbundled rows get their own category
      const txnCatMap = new Map()
      newGroups.forEach(group => {
        const cat = (catAssign[group.key] || '').trim()
        group.txns.forEach(row => txnCatMap.set(row, cat))
      })
      const rowsToSave = toInsert.map(row => {
        const cat = txnCatMap.get(row) || ''
        return cat ? { ...row, category: cat } : row
      })
      let inserted = 0; const errs = []
      for (let i = 0; i < rowsToSave.length; i += 500) {
        const { data, error } = await supabase
          .from('bank_transactions')
          .insert(rowsToSave.slice(i, i + 500))
          .select()
        if (error) errs.push(error.message)
        else inserted += data?.length ?? 0
      }
      setResult({ inserted, skipped: dupCount, errors: errs, parseErrors: parseErrs })
      setStep('result')
    } catch (e) {
      setResult({ inserted: 0, skipped: dupCount, errors: [e.message], parseErrors: parseErrs })
      setStep('result')
    }
  }

  const savedBanks = Object.keys(loadAllMappings())
  const colOptions = csv ? csv.headers.map(h => <option key={h} value={h}>{h}</option>) : []
  const bankDDVal  = savedBanks.includes(cfg.bankName) ? cfg.bankName : ''

  const uncatCount = useMemo(
    () => newGroups.filter(g => !(catAssign[g.key] || '').trim()).length,
    [newGroups, catAssign]
  )

  return (
    <div style={m.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={m.modal}>
        <div style={m.head}>
          <h3 style={m.title}>
            {step === 'upload'     && 'Import CSV'}
            {step === 'mapping'    && 'Map Columns'}
            {step === 'categorize' && 'Preview & Categorize'}
            {step === 'uploading'  && 'Uploading…'}
            {step === 'result'     && 'Import Complete'}
          </h3>
          <button style={m.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={m.body}>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

          {/* Step 1: Upload */}
          {step === 'upload' && (
            <div>
              <div
                style={{ ...m.dropzone, ...(dragOver ? m.dropzoneOn : {}) }}
                onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]) }}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onClick={() => fileRef.current.click()}
              >
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#A08A3C" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 14 }}>
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  <line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 11 15 14"/>
                </svg>
                <p style={{ fontSize: 14, margin: '0 0 5px', color: T.navy, fontWeight: 500 }}>
                  Drag &amp; drop a CSV file, or <strong>click to browse</strong>
                </p>
                <p style={{ fontSize: 11, color: T.charcoal, margin: 0, opacity: .7 }}>
                  Supports most bank CSV exports — column mapping happens next
                </p>
                <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
                  onChange={e => handleFile(e.target.files[0])} />
              </div>

              {/* Collapsible instructions */}
              <div style={m.instrWrap}>
                <button style={m.instrToggle} onClick={() => setShowInstr(v => !v)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5, flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  How to download your bank statement
                  <span style={{ marginLeft: 'auto', fontSize: 11 }}>{showInstr ? '▲' : '▼'}</span>
                </button>

                {showInstr && (
                  <div style={m.instrBody}>
                    <p style={m.instrTitle}>Freedom Checking / Brookline Bank</p>
                    <ol style={m.instrList}>
                      <li>Log in to <strong>online.brooklinebank.com</strong></li>
                      <li>Go to <strong>Accounts</strong> and select your checking account</li>
                      <li>Click <strong>Activity &amp; Statements</strong> → <strong>Download Activity</strong></li>
                      <li>Set the date range for the month you want to import</li>
                      <li>Choose <strong>CSV</strong> as the format and click <strong>Download</strong></li>
                      <li>Upload the downloaded file here — column mapping is automatic</li>
                    </ol>

                    <p style={m.instrTitle}>Other banks</p>
                    <ol style={m.instrList}>
                      <li>Log in to your bank&apos;s online portal</li>
                      <li>Navigate to your account activity or transaction history</li>
                      <li>Look for an <strong>Export</strong> or <strong>Download</strong> option</li>
                      <li>Select <strong>CSV</strong> format and your date range, then download</li>
                      <li>Upload the file here — you&apos;ll map columns in the next step</li>
                    </ol>

                    <p style={{ fontSize: 12, color: '#9ca3af', margin: '8px 0 0' }}>
                      The system automatically detects most formats. If columns aren&apos;t mapped correctly you can adjust them manually in the next step.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 2: Column mapping */}
          {step === 'mapping' && csv && (
            <div>
              <p style={m.sub}>
                {csv.rows.length} rows
                {csv.skipped > 0 && <> · {csv.skipped} summary row{csv.skipped !== 1 ? 's' : ''} skipped</>}
                {' '}· columns: <em>{csv.headers.join(', ')}</em>
              </p>

              <ISection title="Bank">
                <IRow label="Saved banks">
                  <select style={m.select} value={bankDDVal}
                    onChange={e => {
                      const val = e.target.value; if (!val) return
                      const all = loadAllMappings()
                      if (all[val]) setCfg({ ...all[val], bankName: val })
                      else setProp('bankName', val)
                    }}>
                    <option value="">— Select to load saved mapping —</option>
                    {savedBanks.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </IRow>
                <IRow label="Bank name (to save)">
                  <input style={m.input} value={cfg.bankName} onChange={e => setProp('bankName', e.target.value)}
                    placeholder="e.g. Chase Checking" />
                </IRow>
              </ISection>

              <ISection title="Map CSV Columns">
                {STANDARD_FIELDS.filter(f => !(cfg.splitAmounts && f.key === 'amount')).map(f => {
                  const req = f.key === 'transaction_date' || f.key === 'description' || (f.key === 'amount' && !cfg.splitAmounts)
                  return (
                    <IRow key={f.key} label={<>{f.label}{req && <span style={{ color: '#dc2626' }}> *</span>}</>}>
                      <select style={m.select} value={cfg.cols[f.key]} onChange={e => setCol(f.key, e.target.value)}>
                        <option value="">— not mapped —</option>{colOptions}
                      </select>
                    </IRow>
                  )
                })}
              </ISection>

              <ISection title="Date Format">
                <IRow label={<>Format<span style={{ color: '#dc2626' }}> *</span></>}>
                  <select style={m.select} value={cfg.dateFormat} onChange={e => setProp('dateFormat', e.target.value)}>
                    {DATE_FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </IRow>
                {cfg.cols.transaction_date && csv.rows[0] && (
                  <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0 232px' }}>
                    Preview: &quot;{csv.rows[0][cfg.cols.transaction_date]}&quot; →{' '}
                    <strong>{parseDate(csv.rows[0][cfg.cols.transaction_date], cfg.dateFormat) || '⚠ invalid'}</strong>
                  </p>
                )}
              </ISection>

              <ISection title="Amount Handling">
                <IRow label="Split debit / credit columns">
                  <input type="checkbox" checked={cfg.splitAmounts} onChange={e => setProp('splitAmounts', e.target.checked)} />
                </IRow>
                {cfg.splitAmounts ? (
                  <>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px 232px' }}>Net = credit − debit</p>
                    <IRow label="Credit column (money in)">
                      <select style={m.select} value={cfg.cols.credit} onChange={e => setCol('credit', e.target.value)}>
                        <option value="">— not mapped —</option>{colOptions}
                      </select>
                    </IRow>
                    <IRow label="Debit column (money out)">
                      <select style={m.select} value={cfg.cols.debit} onChange={e => setCol('debit', e.target.value)}>
                        <option value="">— not mapped —</option>{colOptions}
                      </select>
                    </IRow>
                  </>
                ) : (
                  <>
                    <IRow label="Debits shown as positive numbers">
                      <input type="checkbox" checked={cfg.debitsPositive} onChange={e => setProp('debitsPositive', e.target.checked)} />
                    </IRow>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 0 232px' }}>Sign will be flipped if enabled.</p>
                  </>
                )}
              </ISection>

              {mapError && (
                <div style={{ ...m.errBox, marginTop: 12 }}>{mapError}</div>
              )}
              <div style={m.actions}>
                <button style={m.btnSec} onClick={() => setStep('upload')}>← Back</button>
                <button style={m.btnPri} onClick={onApplyMapping}>Continue →</button>
              </div>
            </div>
          )}

          {/* Step 3: Categorize */}
          {step === 'categorize' && (
            <div>
              {catLoading ? (
                <div style={{ textAlign: 'center', padding: '48px 0' }}>
                  <div style={m.spinner} />
                  <p style={{ color: '#6b7280', marginTop: 12 }}>Checking for duplicates…</p>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                    <StatCard label="New transactions"   value={toInsert.length}   color="#2563eb" />
                    <StatCard label="Duplicates skipped" value={dupCount}          color="#d97706" />
                    <StatCard label="Parse errors"       value={parseErrs.length}  color={parseErrs.length ? '#dc2626' : '#9ca3af'} />
                  </div>

                  {parseErrs.length > 0 && (
                    <div style={m.errBox}>
                      <strong>{parseErrs.length} row(s) could not be parsed:</strong>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                        {parseErrs.slice(0, 8).map((e, i) => <li key={i}>Line {e.line}: {e.msg}</li>)}
                        {parseErrs.length > 8 && <li>…and {parseErrs.length - 8} more</li>}
                      </ul>
                    </div>
                  )}

                  {toInsert.length === 0 ? (
                    <p style={{ color: '#6b7280', fontSize: 14, padding: '16px 0' }}>
                      All {dupCount} rows already exist — nothing new to import.
                    </p>
                  ) : (
                    <>
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {Object.keys(catAssign).length > 0 && <span>Purple dot = category suggested from previous transactions. Change any before importing.</span>}
                        {uncatCount > 0 && (
                          <span style={{ color: '#d97706' }}>
                            {uncatCount} group{uncatCount !== 1 ? 's' : ''} without a category — they will import uncategorized. Use the <strong>Uncategorized</strong> filter on the transaction list to finish later.
                          </span>
                        )}
                      </div>
                      <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
                        <table style={m.table}>
                          <thead>
                            <tr>
                              <th style={m.th}>Description</th>
                              <th style={{ ...m.th, minWidth: 220 }}>Category</th>
                              <th style={{ ...m.th, width: 60, textAlign: 'right' }}>Txns</th>
                              <th style={{ ...m.th, width: 100, textAlign: 'right' }}>Total</th>
                              <th style={{ ...m.th, width: 36 }}></th>
                            </tr>
                          </thead>
                          <tbody>
                            {newGroups.map((g, i) => {
                              const cat    = catAssign[g.key] ?? ''
                              const isSugg = cat !== '' && cat === g.suggestedCat
                              const isExp  = !!expanded[g.key]
                              return (
                                <Fragment key={g.key}>
                                  <tr style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                                    <td style={{ ...m.td, maxWidth: 0, width: '99%', overflow: 'hidden' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                                        {isSugg && <span style={m.suggDot} />}
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          {g.displayDesc}
                                        </span>
                                        {g.variants?.length > 0 && (
                                          <span style={m.badge}>+{g.variants.length} similar</span>
                                        )}
                                      </div>
                                    </td>
                                    <td style={m.td}>
                                      <CategoryInput
                                        value={cat}
                                        onChange={val => setCatAssign(p => ({ ...p, [g.key]: val }))}
                                        categories={allCats}
                                        groups={groupedCats}
                                        style={isSugg ? { border: '1px solid #a78bfa', background: '#faf5ff' } : {}}
                                      />
                                    </td>
                                    <td style={{ ...m.td, textAlign: 'right', color: '#9ca3af', fontSize: 13 }}>{g.txns.length}</td>
                                    <td style={{ ...m.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: g.total < 0 ? '#dc2626' : '#16a34a' }}>
                                      {g.total.toFixed(2)}
                                    </td>
                                    <td style={m.td}>
                                      <button style={m.expandBtn} onClick={() => setExpanded(p => ({ ...p, [g.key]: !p[g.key] }))}>
                                        {isExp ? '▲' : '▼'}
                                      </button>
                                    </td>
                                  </tr>
                                  {isExp && (
                                    <tr>
                                      <td colSpan={5} style={{ padding: 0, background: '#f0f9ff', borderBottom: '2px solid #bae6fd' }}>
                                        <div style={{ padding: '8px 12px 10px 16px' }}>
                                          {g.variants?.length > 0 && (
                                            <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 6px' }}>
                                              <strong>Grouped:</strong> {[g.displayDesc, ...g.variants].join(', ')}
                                            </p>
                                          )}
                                          <table style={{ ...m.table, fontSize: 12 }}>
                                            <thead>
                                              <tr>
                                                {['Date', 'Description', 'Amount', ''].map((h, hi) => (
                                                  <th key={hi} style={{ ...m.th, background: '#e0f2fe', padding: '5px 8px', fontSize: 11 }}>{h}</th>
                                                ))}
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {g.txns.map((r, ri) => (
                                                <tr key={ri} style={{ background: '#fff' }}>
                                                  <td style={{ ...m.td, padding: '4px 8px', whiteSpace: 'nowrap' }}>{r.transaction_date}</td>
                                                  <td style={{ ...m.td, padding: '4px 8px', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</td>
                                                  <td style={{ ...m.td, padding: '4px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.amount < 0 ? '#dc2626' : '#16a34a' }}>
                                                    {r.amount.toFixed(2)}
                                                  </td>
                                                  <td style={{ ...m.td, padding: '2px 6px', width: 28 }}>
                                                    {g.txns.length > 1 && (
                                                      <button
                                                        title="Move to its own category group"
                                                        style={m.unbundleBtn}
                                                        onClick={() => unbundle(g.key, r)}
                                                      >↗</button>
                                                    )}
                                                  </td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  <div style={m.actions}>
                    <button style={m.btnSec} onClick={() => setStep('mapping')}>← Back</button>
                    {toInsert.length > 0 && (
                      <button style={m.btnPri} onClick={doUpload}>
                        Import {toInsert.length} transaction{toInsert.length !== 1 ? 's' : ''}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 4: Uploading */}
          {step === 'uploading' && (
            <div style={{ textAlign: 'center', padding: '48px 0' }}>
              <div style={m.spinner} />
              <p style={{ color: '#6b7280', marginTop: 16 }}>Uploading transactions…</p>
            </div>
          )}

          {/* Step 5: Result */}
          {step === 'result' && result && (
            <div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                <StatCard label="Imported"      value={result.inserted}                 color="#16a34a" />
                <StatCard label="Duplicates"    value={result.skipped}                  color="#d97706" />
                <StatCard label="Parse errors"  value={result.parseErrors?.length ?? 0} color="#9ca3af" />
                <StatCard label="Insert errors" value={result.errors.length}            color={result.errors.length ? '#dc2626' : '#9ca3af'} />
              </div>
              {result.errors.length > 0 && (
                <div style={m.errBox}>
                  <strong>Insert errors:</strong>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                    {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
              <div style={m.actions}>
                <button style={m.btnPri} onClick={onDone}>Done</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ISection({ title, children }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '14px 16px', marginBottom: 12 }}>
      <h4 style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '.05em', margin: '0 0 10px' }}>{title}</h4>
      {children}
    </div>
  )
}

function IRow({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, minHeight: 34 }}>
      <label style={{ minWidth: 220, fontSize: 13, fontWeight: 500, color: '#374151', flexShrink: 0 }}>{label}</label>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ flex: '1 1 100px', minWidth: 100, background: '#fff', border: '1px solid #e2e8f0', borderTop: `3px solid ${color}`, borderRadius: 8, padding: '12px 14px', textAlign: 'center' }}>
      <div style={{ fontSize: 26, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{label}</div>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const m = {
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(27,58,92,.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 1000, padding: '40px 16px', overflowY: 'auto' },
  modal:      { background: '#fff', borderRadius: 8, width: '100%', maxWidth: 800, boxShadow: '0 20px 60px rgba(0,0,0,.18)', display: 'flex', flexDirection: 'column' },
  head:       { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: `1px solid ${T.border}` },
  title:      { fontSize: 14, fontWeight: 600, color: T.navy, margin: 0 },
  closeBtn:   { background: 'none', border: 'none', fontSize: 15, color: '#9ca3af', cursor: 'pointer', padding: '3px 7px', borderRadius: 4 },
  body:       { padding: '20px 22px', overflowY: 'auto' },
  sub:        { fontSize: 11, color: T.charcoal, margin: '0 0 14px' },
  input:      { width: '100%', padding: '5px 9px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 12, color: T.charcoal, background: '#fff', outline: 'none', boxSizing: 'border-box' },
  select:     { width: '100%', padding: '5px 9px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 12, color: T.charcoal, background: '#fff', outline: 'none' },
  actions:    { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18, paddingTop: 14, borderTop: `1px solid ${T.border}` },
  btnPri:     { padding: '7px 20px', background: T.navy, color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 500, cursor: 'pointer' },
  btnSec:     { padding: '7px 18px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 12, fontWeight: 500, cursor: 'pointer' },
  table:      { width: '100%', borderCollapse: 'collapse' },
  th:         { background: T.page, padding: '7px 10px', textAlign: 'left', fontWeight: 700, borderBottom: `2px solid ${T.border}`, fontSize: 9.5, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' },
  td:         { padding: '7px 10px', borderBottom: `1px solid ${T.border}`, verticalAlign: 'middle', fontSize: 12, color: T.charcoal },
  suggDot:    { flexShrink: 0, width: 6, height: 6, borderRadius: '50%', background: T.gold, display: 'inline-block' },
  badge:      { flexShrink: 0, fontSize: 10, fontWeight: 500, color: '#4A7BA7', background: '#E8EFF5', borderRadius: 3, padding: '1px 6px', whiteSpace: 'nowrap', cursor: 'default' },
  expandBtn:  { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 10, padding: '2px 5px', lineHeight: 1 },
  unbundleBtn:{ fontSize: 11, padding: '1px 5px', background: 'none', border: `1px solid ${T.border}`, borderRadius: 3, cursor: 'pointer', color: '#6b7280', lineHeight: 1.4 },
  dropzone:   { border: `2px dashed ${T.border}`, borderRadius: 8, padding: '52px 24px', textAlign: 'center', cursor: 'pointer', background: T.page, userSelect: 'none', transition: 'border-color .2s, background .2s' },
  dropzoneOn: { borderColor: T.navy, background: '#EBF1F7' },
  spinner:    { display: 'inline-block', width: 28, height: 28, border: `2px solid ${T.border}`, borderTopColor: T.navy, borderRadius: '50%', animation: 'spin .7s linear infinite' },
  errBox:     { background: '#FDE8E8', border: '1px solid #F5C2C2', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#991B1B', marginBottom: 14 },
  instrWrap:  { marginTop: 14, border: `1px solid ${T.border}`, borderRadius: 6, overflow: 'hidden' },
  instrToggle:{ display: 'flex', alignItems: 'center', width: '100%', padding: '9px 12px', background: T.page, border: 'none', cursor: 'pointer', fontSize: 12, color: T.charcoal, fontWeight: 500, gap: 4 },
  instrBody:  { padding: '14px 16px', background: '#fff', borderTop: `1px solid ${T.border}` },
  instrTitle: { fontSize: 12, fontWeight: 600, color: T.navy, margin: '0 0 6px' },
  instrList:  { fontSize: 12, color: T.charcoal, margin: '0 0 12px', paddingLeft: 20, lineHeight: 1.7 },
}
