import { useState, useEffect, useCallback, useMemo, Fragment, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { normKey, buildCatIndex, suggestCat, clusterGroups } from '../lib/merchantClustering'
import {
  parseBankCSV, parseDate, fingerprint, autoDetectCols,
  DATE_FORMATS, STANDARD_FIELDS, DEFAULT_CFG, loadAllMappings, saveBankMapping,
} from '../lib/csv'
import { dominantCat, buildDescCatMap, resolveImportCategory, groupStatus } from '../lib/categorize'
import { getSetting } from '../lib/settings'
import { matchLedgerAccount } from '../lib/balanceSheet'
import CategoryInput from './CategoryInput'
import { T, fmt2 } from '../lib/theme'

export default function ImportModal({ clientId, allCats, groupedCats = null, existingTxns, onDone, onClose }) {
  const [step,       setStep]       = useState('upload')
  const [source,     setSource]     = useState('csv')
  const [dragOver,   setDragOver]   = useState(false)
  const [csv,        setCsv]        = useState(null)
  const [cfg,        setCfg]        = useState(DEFAULT_CFG)
  const [stmt,       setStmt]       = useState(null)
  const [stmtBusy,   setStmtBusy]   = useState(false)
  const [withInt,    setWithInt]    = useState(true)
  // Physical bank/card accounts (client_settings 'ledger_accounts'). Picking one
  // stamps its canonical feed label, so a statement can't invent a new spelling
  // and split one account into two balance-sheet lines.
  const [registry,   setRegistry]   = useState([])
  const [acctChoice, setAcctChoice] = useState('')   // '' | '__raw__' | '__column__' | registry key
  const [rawLabel,   setRawLabel]   = useState('')   // label detected on the statement
  const [mapError,   setMapError]   = useState('')
  const [parsed,     setParsed]     = useState([])
  const [parseErrs,  setParseErrs]  = useState([])
  const [catLoading, setCatLoading] = useState(false)
  const [toInsert,   setToInsert]   = useState([])
  const [dupCount,   setDupCount]   = useState(0)
  const [newGroups,  setNewGroups]  = useState([])
  const [catAssign,  setCatAssign]  = useState({})
  // Groups the user actually edited. Only those override the per-row category
  // the source file supplied — see resolveImportCategory.
  const [catTouched, setCatTouched] = useState({})
  const [expanded,   setExpanded]   = useState({})
  const [result,     setResult]     = useState(null)
  const [showInstr,  setShowInstr]  = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    getSetting(clientId, 'ledger_accounts', []).catch(() => [])
      .then(v => { if (!cancelled) setRegistry(Array.isArray(v) ? v : []) })
    return () => { cancelled = true }
  }, [clientId])

  // The value written to bank_transactions.account. Always a label the registry
  // already matches, so the balance sheet folds the rows into the right line.
  const feedLabel = useCallback(choice => {
    if (choice === '__raw__') return rawLabel.trim()
    const entry = registry.find(e => e.key === choice)
    if (!entry) return ''
    return (entry.matches || []).map(m => (m || '').trim()).find(Boolean) || (entry.label || '').trim()
  }, [registry, rawLabel])

  const handleFile = useCallback(async file => {
    if (!file) return
    const name = file.name.toLowerCase()

    // Card statement PDFs arrive already normalized (date/description/amount),
    // so they skip column mapping and go straight to a review step.
    if (name.endsWith('.pdf')) {
      setMapError(''); setStmtBusy(true)
      try {
        const { extractPdfLines, parseCardStatement } = await import('../lib/pdfStatement')
        const result = parseCardStatement(await extractPdfLines(await file.arrayBuffer()))
        if (!result.rows.length && !result.interest.length) {
          setMapError('No transactions found in this PDF. It may be a scanned image, or a statement layout this reader does not know — export a CSV from your bank instead.')
          return
        }
        // Pre-select the account whose registry entry already claims the label
        // printed on the statement; otherwise offer the raw label as-is.
        const detected = result.card.label || ''
        const matched = matchLedgerAccount(registry, detected)
        setSource('pdf'); setStmt(result); setRawLabel(detected)
        setAcctChoice(matched ? matched.key : (detected ? '__raw__' : ''))
        setWithInt(true); setStep('statement')
      } catch (e) {
        setMapError(`Could not read the PDF: ${e.message}`)
      } finally { setStmtBusy(false) }
      return
    }

    if (!name.endsWith('.csv')) { setMapError('Please select a .csv or .pdf file'); return }
    const reader = new FileReader()
    reader.onload = e => {
      const data = parseBankCSV(e.target.result)
      if (!data.headers.length) { setMapError('Could not parse CSV — no headers found'); return }

      const { cols, splitAmounts } = autoDetectCols(data.headers)
      const base = DEFAULT_CFG()
      setSource('csv')
      setCsv(data); setCfg({ ...base, cols: { ...base.cols, ...cols }, splitAmounts }); setMapError(''); setStep('mapping')
    }
    reader.readAsText(file)
  }, [registry])

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
    const { cols, dateFormat, splitAmounts, debitsPositive, bankName, catSource } = cfg
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
      // A chosen account applies to the whole file and beats the mapped column,
      // which is what a single-account statement export needs.
      const chosenAcct = acctChoice && acctChoice !== '__column__' ? feedLabel(acctChoice) : ''
      rows.push({
        transaction_date: date, description: rawDesc, amount,
        ...(chosenAcct                                  ? { account:      chosenAcct                    }
          : cols.account      && raw[cols.account]      ? { account:      raw[cols.account].trim()      } : {}),
        ...(cols.reference_id && raw[cols.reference_id] ? { reference_id: raw[cols.reference_id].trim() } : {}),
        // Dropping the category here is what lets the suggestion engine fill it:
        // resolveImportCategory only falls back to the group's category — the
        // suggested one — when the row itself carries none.
        ...(catSource !== 'suggest' && cols.category && raw[cols.category]
          ? { category: raw[cols.category].trim() } : {}),
        ...(clientId !== null ? { client_id: clientId } : {}),
      })
    })
    setParsed(rows); setParseErrs(errors); setStep('categorize')
  }

  // Rows the statement will contribute, in date order. Kept as a memo so the
  // review table and the import share one source of truth.
  const stmtRows = useMemo(() => {
    if (!stmt) return []
    const acct = feedLabel(acctChoice)
    return [...stmt.rows, ...(withInt ? stmt.interest : [])]
      .filter(r => r.transaction_date)
      .map(r => ({
        transaction_date: r.transaction_date,
        description: r.description,
        amount: r.amount,
        ...(acct ? { account: acct } : {}),
        ...(clientId !== null ? { client_id: clientId } : {}),
      }))
      .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date))
  }, [stmt, acctChoice, feedLabel, withInt, clientId])

  const onApplyStatement = () => {
    // A row with no date means the billing period never parsed — surface it
    // rather than dropping the transaction on the floor.
    const undated = [...stmt.rows, ...(withInt ? stmt.interest : [])].filter(r => !r.transaction_date)
    setParsed(stmtRows)
    setParseErrs(undated.map(r => ({ line: '—', msg: `Could not determine a date for "${r.description}"` })))
    setStep('categorize')
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
          // A cluster holding several source categories is left blank on
          // purpose: every row keeps its own. Pre-filling the dominant one
          // would show a category the import is not going to use.
          if (groupStatus(g.txns, t => (t.category || '').trim()).kind === 'mixed') return
          const importedCat = dominantCat(g.txns)
          if (importedCat)         initAssign[g.key] = importedCat
          else if (g.suggestedCat) initAssign[g.key] = g.suggestedCat
        })

        setToInsert(newRows); setDupCount(dupes.length)
        setNewGroups(clusters); setCatAssign(initAssign)
      } catch (e) {
        alert('Error: ' + e.message); setStep(source === 'pdf' ? 'statement' : 'mapping')
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
        const touched = !!catTouched[group.key]
        group.txns.forEach(row => txnCatMap.set(row, resolveImportCategory(row, cat, touched)))
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

  // Counted per row, not per group: a group left blank because its rows carry
  // their own categories is fully categorized, and saying otherwise would push
  // the user to overwrite exactly the rows this is meant to protect.
  const uncatCount = useMemo(() => {
    let n = 0
    newGroups.forEach(g => {
      const cat = (catAssign[g.key] || '').trim()
      const touched = !!catTouched[g.key]
      g.txns.forEach(row => { if (!resolveImportCategory(row, cat, touched)) n++ })
    })
    return n
  }, [newGroups, catAssign, catTouched])

  return (
    <div style={m.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={m.modal}>
        <div style={m.head}>
          <h3 style={m.title}>
            {step === 'upload'     && 'Import Transactions'}
            {step === 'mapping'    && 'Map Columns'}
            {step === 'statement'  && 'Review Statement'}
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
                style={{ ...m.dropzone, ...(dragOver ? m.dropzoneOn : {}), ...(stmtBusy ? { cursor: 'default' } : {}) }}
                onDrop={e => { e.preventDefault(); setDragOver(false); if (!stmtBusy) handleFile(e.dataTransfer.files[0]) }}
                onDragOver={e => { e.preventDefault(); if (!stmtBusy) setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onClick={() => { if (!stmtBusy) fileRef.current.click() }}
              >
                {stmtBusy ? (
                  <>
                    <div style={m.spinner} />
                    <p style={{ fontSize: 13, margin: '14px 0 0', color: T.charcoal }}>Reading statement…</p>
                  </>
                ) : (
                  <>
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#A08A3C" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 14 }}>
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                      <line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 11 15 14"/>
                    </svg>
                    <p style={{ fontSize: 14, margin: '0 0 5px', color: T.navy, fontWeight: 500 }}>
                      Drag &amp; drop a CSV or PDF file, or <strong>click to browse</strong>
                    </p>
                    <p style={{ fontSize: 11, color: T.charcoal, margin: 0, opacity: .7 }}>
                      Bank CSV exports map columns next · card statement PDFs are read automatically
                    </p>
                  </>
                )}
                <input ref={fileRef} type="file" accept=".csv,.pdf" style={{ display: 'none' }}
                  onChange={e => handleFile(e.target.files[0])} />
              </div>

              {mapError && <div style={{ ...m.errBox, marginTop: 14, marginBottom: 0 }}>{mapError}</div>}

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

                    <p style={m.instrTitle}>Capital One card (PDF statement)</p>
                    <ol style={m.instrList}>
                      <li>Log in to <strong>capitalone.com</strong> and open the card account</li>
                      <li>Go to <strong>Statements</strong> (or <strong>View Statements</strong>)</li>
                      <li>Pick the billing period and click <strong>Download PDF</strong></li>
                      <li>Upload the PDF here — dates, descriptions and amounts are read automatically</li>
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

              <ISection title="Account">
                <IRow label={<>Account<span style={{ color: '#dc2626' }}> *</span></>}>
                  <AccountSelect
                    registry={registry} value={acctChoice}
                    onChange={key => {
                      setAcctChoice(key)
                      // A card export carries the issuer's own taxonomy, which
                      // means nothing in this chart — default those to
                      // suggestions. Still overridable below.
                      const entry = registry.find(e => e.key === key)
                      if (entry) setProp('catSource', entry.type === 'card' ? 'suggest' : 'file')
                    }}
                    columnOption={!!cfg.cols.account}
                  />
                </IRow>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 0 232px' }}>
                  Which real bank or card account this file came from. Applies to every row
                  {cfg.cols.account ? ' and overrides the mapped Account column.' : '.'}
                </p>
              </ISection>

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

                <IRow label="Category from">
                  <select style={m.select} value={cfg.catSource}
                    onChange={e => setProp('catSource', e.target.value)}>
                    <option value="file">The file&apos;s Category column</option>
                    <option value="suggest">Suggest from previous transactions</option>
                  </select>
                </IRow>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 0 232px' }}>
                  {cfg.catSource === 'suggest'
                    ? <>The file&apos;s categories are ignored. Each row is matched on its description
                        against how you filed that merchant before — right for card exports, whose
                        categories are the issuer&apos;s, not yours.</>
                    : cfg.cols.category
                      ? <>Each row keeps the category in the file. Rows with none fall back to a suggestion.</>
                      : <>No Category column is mapped, so every row will be suggested from your history anyway.</>}
                </p>
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

          {/* Step 2b: Statement review (PDF) */}
          {step === 'statement' && stmt && (
            <div>
              <p style={m.sub}>
                {stmt.card.product || 'Card statement'}
                {stmt.card.last4 && <> ending in {stmt.card.last4}</>}
                {stmt.cycle && <> · {stmt.cycle.start} → {stmt.cycle.end}</>}
              </p>

              {stmt.warnings.length > 0 && (
                <div style={m.warnBox}>
                  <strong>Check these before importing:</strong>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                    {stmt.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              <ISection title="Statement">
                <IRow label={<>Account<span style={{ color: '#dc2626' }}> *</span></>}>
                  <AccountSelect
                    registry={registry} value={acctChoice} onChange={setAcctChoice}
                    rawLabel={rawLabel} rawHint="detected on this statement"
                  />
                </IRow>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px 232px' }}>
                  {acctChoice === '__raw__'
                    ? <>Not one of your accounts — these rows will show as unmapped on the balance sheet. Add it on the Chart of Accounts page to fold it in.</>
                    : <>Stored on every row so card spending stays separable from the bank account.</>}
                </p>
                {stmt.interest.length > 0 && (
                  <>
                    <IRow label="Import interest charge">
                      <input type="checkbox" checked={withInt} onChange={e => setWithInt(e.target.checked)} />
                    </IRow>
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 0 232px' }}>
                      {stmt.interest.map(i => `${i.description} ${fmt2(i.amount)}`).join(', ')} — dated to the statement close.
                    </p>
                  </>
                )}
              </ISection>

              <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 6 }}>
                <table style={m.table}>
                  <thead>
                    <tr>
                      <th style={m.th}>Date</th>
                      <th style={{ ...m.th, width: '99%' }}>Description</th>
                      <th style={{ ...m.th, width: 110, textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stmtRows.map((r, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                        <td style={{ ...m.td, whiteSpace: 'nowrap' }}>{r.transaction_date}</td>
                        <td style={{ ...m.td, maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</td>
                        <td style={{ ...m.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: r.amount < 0 ? '#dc2626' : '#16a34a' }}>
                          {fmt2(r.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 11, color: T.charcoal, opacity: .7, margin: '8px 0 0' }}>
                {stmtRows.length} row{stmtRows.length !== 1 ? 's' : ''} · charges are negative, payments and refunds positive.
                Duplicates are checked in the next step.
              </p>

              <div style={m.actions}>
                <button style={m.btnSec} onClick={() => { setStmt(null); setStep('upload') }}>← Back</button>
                <button style={m.btnPri} onClick={onApplyStatement}>Continue →</button>
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
                            {uncatCount} transaction{uncatCount !== 1 ? 's' : ''} without a category — they will import uncategorized. Use the <strong>Uncategorized</strong> filter on the transaction list to finish later.
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
                              const status = groupStatus(g.txns, t => (t.category || '').trim())
                              const mixed  = !catTouched[g.key] && status.kind === 'mixed'
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
                                        {mixed && (
                                          <span
                                            style={m.mixedBadge}
                                            title={`These transactions came in under ${status.distinct.size} different categories (${[...status.distinct].join(', ')}). Each row keeps its own. Typing a category here files all ${g.txns.length} of them under that one instead.`}
                                          >{status.distinct.size} categories kept</span>
                                        )}
                                      </div>
                                    </td>
                                    <td style={m.td}>
                                      <CategoryInput
                                        value={cat}
                                        onChange={val => {
                                          setCatAssign(p => ({ ...p, [g.key]: val }))
                                          setCatTouched(p => ({ ...p, [g.key]: true }))
                                        }}
                                        categories={allCats}
                                        groups={groupedCats}
                                        style={isSugg ? { border: '1px solid #a78bfa', background: '#faf5ff' } : {}}
                                      />
                                    </td>
                                    <td style={{ ...m.td, textAlign: 'right', color: '#9ca3af', fontSize: 13 }}>{g.txns.length}</td>
                                    <td style={{ ...m.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: g.total < 0 ? '#dc2626' : '#16a34a' }}>
                                      {fmt2(g.total)}
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
                                                  <td style={{ ...m.td, padding: '4px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: r.amount < 0 ? '#dc2626' : '#16a34a' }}>
                                                    {fmt2(r.amount)}
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
                    <button style={m.btnSec} onClick={() => setStep(source === 'pdf' ? 'statement' : 'mapping')}>← Back</button>
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

// Picks the physical bank/card account a file belongs to, from the ledger-account
// registry. Free text is deliberately not offered: every new spelling of an
// account becomes its own balance-sheet line, so the list is the whole point.
// `rawLabel` is the one exception — a label a statement printed that the registry
// doesn't know yet, kept selectable so an import is never blocked by setup.
function AccountSelect({ registry, value, onChange, rawLabel = '', rawHint = '', columnOption = false }) {
  const known = registry.some(e => e.key === value)
  return (
    <>
      <select style={m.select} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">— no account —</option>
        {registry.map(e => (
          <option key={e.key} value={e.key}>
            {e.label}{e.type ? ` (${e.type})` : ''}
          </option>
        ))}
        {columnOption && <option value="__column__">Use the mapped Account column</option>}
        {rawLabel && !known && (
          <option value="__raw__">{rawLabel}{rawHint ? ` — ${rawHint}` : ''}</option>
        )}
      </select>
      {registry.length === 0 && (
        <p style={{ fontSize: 11, color: '#92400E', margin: '5px 0 0' }}>
          No bank or card accounts set up yet — add them on the Chart of Accounts page so
          imports land on the right balance-sheet line.
        </p>
      )}
    </>
  )
}

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
  mixedBadge: { flexShrink: 0, fontSize: 10, fontWeight: 600, color: '#92400E', background: '#FEF3C7', borderRadius: 3, padding: '1px 6px', whiteSpace: 'nowrap', cursor: 'help' },
  expandBtn:  { background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 10, padding: '2px 5px', lineHeight: 1 },
  unbundleBtn:{ fontSize: 11, padding: '1px 5px', background: 'none', border: `1px solid ${T.border}`, borderRadius: 3, cursor: 'pointer', color: '#6b7280', lineHeight: 1.4 },
  dropzone:   { border: `2px dashed ${T.border}`, borderRadius: 8, padding: '52px 24px', textAlign: 'center', cursor: 'pointer', background: T.page, userSelect: 'none', transition: 'border-color .2s, background .2s' },
  dropzoneOn: { border: `2px dashed ${T.navy}`, background: '#EBF1F7' },
  spinner:    { display: 'inline-block', width: 28, height: 28, border: `2px solid ${T.border}`, borderTopColor: T.navy, borderRadius: '50%', animation: 'spin .7s linear infinite' },
  errBox:     { background: '#FDE8E8', border: '1px solid #F5C2C2', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#991B1B', marginBottom: 14 },
  warnBox:    { background: '#FEF6E7', border: '1px solid #F3D9A4', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#92400E', marginBottom: 14 },
  instrWrap:  { marginTop: 14, border: `1px solid ${T.border}`, borderRadius: 6, overflow: 'hidden' },
  instrToggle:{ display: 'flex', alignItems: 'center', width: '100%', padding: '9px 12px', background: T.page, border: 'none', cursor: 'pointer', fontSize: 12, color: T.charcoal, fontWeight: 500, gap: 4 },
  instrBody:  { padding: '14px 16px', background: '#fff', borderTop: `1px solid ${T.border}` },
  instrTitle: { fontSize: 12, fontWeight: 600, color: T.navy, margin: '0 0 6px' },
  instrList:  { fontSize: 12, color: T.charcoal, margin: '0 0 12px', paddingLeft: 20, lineHeight: 1.7 },
}
