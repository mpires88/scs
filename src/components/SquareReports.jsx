import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { T, fmt2 as fmt, fmtPeriod } from '../lib/theme'

// ─── Quoted-printable decoder (handles multi-byte UTF-8) ──────────────────────

function decodeQP(str) {
  str = str.replace(/=\r?\n/g, '')
  let result = '', i = 0
  while (i < str.length) {
    if (str[i] === '=' && /[0-9A-Fa-f]/.test(str[i+1]||'') && /[0-9A-Fa-f]/.test(str[i+2]||'')) {
      const bytes = []
      while (str[i] === '=' && /[0-9A-Fa-f]/.test(str[i+1]||'') && /[0-9A-Fa-f]/.test(str[i+2]||'')) {
        bytes.push(parseInt(str.slice(i+1, i+3), 16)); i += 3
      }
      try { result += new TextDecoder('utf-8').decode(new Uint8Array(bytes)) }
      catch { result += bytes.map(b => String.fromCharCode(b)).join('') }
    } else { result += str[i++] }
  }
  return result
}

// ─── .eml parser ─────────────────────────────────────────────────────────────

function parseSquareEml(text) {
  // Period from header metadata
  const beginMatch = text.match(/X-Metadata-begin-time:\s*(\d{4}-\d{2}-\d{2})/)
  let period = beginMatch ? beginMatch[1].slice(0, 7) : null

  // Fallback: parse subject line "Square Sales Report: Apr 1 - Apr 30"
  if (!period) {
    const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' }
    const sub = text.match(/Subject:.*?Square Sales Report.*?(\w{3})\s+\d.*?(\d{4})/)
    if (sub && MONTHS[sub[1]]) period = `${sub[2]}-${MONTHS[sub[1]]}`
  }

  const htmlIdx = text.search(/<!DOCTYPE|<html/i)
  if (htmlIdx === -1) return { error: 'No HTML body found in file' }

  const html = decodeQP(text.slice(htmlIdx))
  const doc  = new DOMParser().parseFromString(html, 'text/html')

  const parseAmt = s => {
    s = (s || '').trim()
    const neg = s.startsWith('(') && s.endsWith(')')
    return parseFloat(s.replace(/[$,\s()]/g, '')) * (neg ? -1 : 1) || 0
  }

  const findVal = label => {
    for (const td of doc.querySelectorAll('td'))
      if (td.textContent.trim() === label && td.nextElementSibling)
        return parseAmt(td.nextElementSibling.textContent)
    return 0
  }

  const findPrefix = prefix => {
    for (const td of doc.querySelectorAll('td'))
      if (td.textContent.trim().startsWith(prefix) && td.nextElementSibling)
        return parseAmt(td.nextElementSibling.textContent)
    return 0
  }

  // Categories live between the "Category Sales" and "Item Sales" section headers
  const categories = []
  let inCat = false
  for (const td of doc.querySelectorAll('td')) {
    const t = td.textContent.trim().replace(/\u00A0/g, ' ')
    if (t === 'Category Sales') { inCat = true; continue }
    if (t === 'Item Sales')       { break }
    if (!inCat) continue
    const m = t.match(/^(.+?)\s*[××x]\s*(\d+)$/)
    if (m && td.nextElementSibling)
      categories.push({ name: m[1].trim(), count: parseInt(m[2]), amount: parseAmt(td.nextElementSibling.textContent) })
  }

  return {
    period,
    grossSales:   findVal('Gross Sales'),
    returns:      findVal('Returns'),
    discounts:    findVal('Discounts & Comps'),
    netSales:     findVal('Net Sales'),
    taxCollected: findVal('Tax'),
    fees:         Math.abs(findVal('Fees')),
    netTotal:     findVal('Net Total'),
    cashAmount:   findPrefix('Cash'),
    cardAmount:   findPrefix('Card'),
    categories,
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SquareReports({ clientId }) {
  const [reports,  setReports]  = useState([])
  const [loading,  setLoading]  = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [preview,  setPreview]  = useState(null)
  const [saving,   setSaving]   = useState(false)
  const [msg,      setMsg]      = useState('')
  const fileRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('square_reports')
      .select('*')
      .eq('client_id', clientId)
      .order('period', { ascending: false })
    setReports(data ?? [])
    setLoading(false)
  }, [clientId])

  useEffect(() => { load() }, [load])

  const handleFile = useCallback(file => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.eml')) { alert('Please select a .eml file'); return }
    const reader = new FileReader()
    reader.onload = e => {
      const parsed = parseSquareEml(e.target.result)
      if (parsed.error)  { alert('Could not parse email: ' + parsed.error); return }
      if (!parsed.period){ alert('Could not determine the month from this email.'); return }
      setPreview(parsed); setMsg('')
    }
    reader.readAsText(file)
  }, [])

  const save = async () => {
    if (!preview) return
    setSaving(true)
    try {
      const { error } = await supabase.from('square_reports').upsert({
        client_id:    clientId,
        period:       preview.period,
        gross_sales:  preview.grossSales,
        returns:      preview.returns,
        discounts:    preview.discounts,
        net_sales:    preview.netSales,
        tax_collected: preview.taxCollected,
        fees:         preview.fees,
        net_total:    preview.netTotal,
        cash_amount:  preview.cashAmount,
        card_amount:  preview.cardAmount,
        categories:   preview.categories,
      }, { onConflict: 'client_id,period' })
      if (error) throw error
      setMsg(`✓ ${fmtPeriod(preview.period)} saved`)
      setPreview(null)
      load()
    } catch (e) { alert('Save failed: ' + e.message) }
    finally { setSaving(false) }
  }

  const deleteReport = async id => {
    if (!confirm('Delete this report?')) return
    const { error } = await supabase.from('square_reports').delete()
      .eq('client_id', clientId).eq('id', id)
    if (error) { alert('Delete failed: ' + error.message); return }
    load()
  }

  return (
    <div style={{ background: T.page, minHeight: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>

      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 28px', background: T.card, borderBottom: `1px solid ${T.border}` }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 2px' }}>Square Reports</h2>
          <p style={{ fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 }}>
            {reports.length} month{reports.length !== 1 ? 's' : ''} uploaded
            {msg && <> · <span style={{ color: T.success, fontWeight: 500 }}>{msg}</span></>}
          </p>
        </div>
        <button
          style={{ padding: '6px 14px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' }}
          onClick={() => fileRef.current?.click()}
        >
          ↑ Upload .eml
        </button>
        <input ref={fileRef} type="file" accept=".eml" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
      </header>

      <div style={{ padding: '20px 28px', maxWidth: 860 }}>

        {/* Drop zone */}
        {!preview && (
          <div
            style={{
              border: `2px dashed ${dragOver ? T.navy : T.border}`,
              borderRadius: 8, padding: '40px 24px', textAlign: 'center',
              background: dragOver ? '#EBF1F7' : T.card,
              cursor: 'pointer', marginBottom: 24,
              transition: 'border-color .2s, background .2s',
            }}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]) }}
            onClick={() => fileRef.current?.click()}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={T.gold} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              <line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 11 15 14"/>
            </svg>
            <p style={{ fontSize: 13, color: T.navy, fontWeight: 500, margin: '0 0 4px' }}>
              Drag &amp; drop your Square Sales Report email, or <strong>click to browse</strong>
            </p>
            <p style={{ fontSize: 11, color: T.charcoal, opacity: .6, margin: 0 }}>
              Save the email from your inbox as a .eml file, then upload it here each month
            </p>
          </div>
        )}

        {/* Preview */}
        {preview && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: '18px 20px', marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: T.navy, margin: 0 }}>
                Preview — {fmtPeriod(preview.period)}
              </h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ padding: '5px 14px', background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 11, cursor: 'pointer' }}
                  onClick={() => setPreview(null)}>Cancel</button>
                <button style={{ padding: '5px 16px', background: T.navy, color: '#fff', border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer', opacity: saving ? .6 : 1 }}
                  disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save Report'}</button>
              </div>
            </div>

            {/* Summary numbers */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {[
                { label: 'Gross Sales',   value: preview.grossSales,   color: T.navy   },
                { label: 'Tax Collected', value: preview.taxCollected, color: '#D97706' },
                { label: 'Square Fees',   value: preview.fees,         color: T.danger  },
                { label: 'Net Payout',    value: preview.netTotal,     color: T.success },
              ].map(c => (
                <div key={c.label} style={{ flex: '1 1 120px', background: '#fff', border: `1px solid ${T.border}`, borderTop: `3px solid ${c.color}`, borderRadius: 6, padding: '10px 12px' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{c.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: T.navy }}>{fmt(c.value)}</div>
                </div>
              ))}
            </div>

            {/* Payment methods */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 14, fontSize: 12, color: T.charcoal }}>
              <span>Cash: <strong>{fmt(preview.cashAmount)}</strong></span>
              <span>Card: <strong>{fmt(preview.cardAmount)}</strong></span>
            </div>

            {/* Category breakdown */}
            {preview.categories.length > 0 && (
              <div>
                <div style={{ fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Category Sales</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Category', 'Items Sold', 'Revenue'].map((h, i) => (
                        <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '4px 8px', background: T.page, fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.categories.map((c, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                        <td style={{ padding: '5px 8px', fontSize: 12, color: T.charcoal }}>{c.name}</td>
                        <td style={{ padding: '5px 8px', fontSize: 12, color: T.charcoal, textAlign: 'right' }}>{c.count.toLocaleString()}</td>
                        <td style={{ padding: '5px 8px', fontSize: 12, color: T.charcoal, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(c.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Saved reports */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{ display: 'inline-block', width: 24, height: 24, border: `2px solid ${T.border}`, borderTopColor: T.navy, borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
          </div>
        ) : reports.length === 0 ? (
          !preview && (
            <p style={{ textAlign: 'center', color: '#9ca3af', fontSize: 13, padding: '20px 0' }}>
              No reports uploaded yet. Drop your first Square .eml above.
            </p>
          )
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Month', 'Gross Sales', 'Tax', 'Fees', 'Net Payout', 'Top Category', ''].map((h, i) => (
                  <th key={i} style={{ textAlign: i === 0 ? 'left' : i === 6 ? 'center' : 'right', padding: '7px 10px', background: T.page, fontSize: 9.5, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.06em', borderBottom: `2px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reports.map((r, i) => {
                const cats = Array.isArray(r.categories) ? r.categories : []
                const top = [...cats].sort((a, b) => b.amount - a.amount)[0]
                return (
                  <tr key={r.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: '8px 10px', fontSize: 13, fontWeight: 500, color: T.navy }}>{fmtPeriod(r.period)}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.charcoal }}>{fmt(r.gross_sales)}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#D97706' }}>{fmt(r.tax_collected)}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.danger }}>{fmt(r.fees)}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: T.success }}>{fmt(r.net_total)}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12, textAlign: 'right', color: T.charcoal }}>
                      {top ? `${top.name} (${fmt(top.amount)})` : '—'}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                      <button onClick={() => deleteReport(r.id)}
                        style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 13, padding: '2px 6px' }}
                        title="Delete">✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
