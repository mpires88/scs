import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase, fetchAll } from '../lib/supabase'
import { T, fmt2, fmt } from '../lib/theme'

const SOURCES    = ['Card show', 'Collection buy', 'Distributor', 'Retail arbitrage', 'Other']
const CATEGORIES = ['Sealed Products', 'Singles', 'Supplies', 'Other']

const today = () => new Date().toISOString().slice(0, 10)

export default function Buys({ clientId }) {
  const [buys,       setBuys]       = useState([])
  const [loading,    setLoading]    = useState(true)
  const [tableMissing, setTableMissing] = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [msg,        setMsg]        = useState('')

  const [form, setForm] = useState({ buy_date: today(), description: '', category: 'Singles', source: 'Card show', cost: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await fetchAll(() => supabase.from('inventory_buys')
        .select('id, buy_date, description, category, source, cost')
        .eq('client_id', clientId).order('buy_date', { ascending: false }))
      setBuys(rows)
      setTableMissing(false)
    } catch {
      setTableMissing(true)  // table doesn't exist until migration.sql is run
      setBuys([])
    }
    setLoading(false)
  }, [clientId])

  useEffect(() => { load() }, [load])

  const addBuy = async e => {
    e.preventDefault()
    const cost = parseFloat(String(form.cost).replace(/[$,\s]/g, ''))
    if (!form.description.trim() || isNaN(cost) || !form.buy_date) return
    setSaving(true); setMsg('')
    try {
      const { error } = await supabase.from('inventory_buys').insert({
        client_id: clientId,
        buy_date: form.buy_date,
        description: form.description.trim(),
        category: form.category,
        source: form.source,
        cost,
      })
      if (error) throw error
      setForm(f => ({ ...f, description: '', cost: '' }))
      setMsg('✓ Buy logged')
      await load()
    } catch (err) { alert('Could not save: ' + err.message) }
    setSaving(false)
  }

  const deleteBuy = async id => {
    if (!confirm('Delete this buy?')) return
    const { error } = await supabase.from('inventory_buys').delete().eq('client_id', clientId).eq('id', id)
    if (error) { alert('Delete failed: ' + error.message); return }
    setBuys(prev => prev.filter(b => b.id !== id))
  }

  // ── Summaries ──────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const year  = String(new Date().getFullYear())
    const month = today().slice(0, 7)
    const inYear  = buys.filter(b => (b.buy_date || '').startsWith(year))
    const inMonth = buys.filter(b => (b.buy_date || '').startsWith(month))
    const sum = rows => rows.reduce((s, b) => s + (Number(b.cost) || 0), 0)
    const byCat = {}
    inYear.forEach(b => { const c = b.category || 'Other'; byCat[c] = (byCat[c] || 0) + (Number(b.cost) || 0) })
    return { year, month: sum(inMonth), ytd: sum(inYear), byCat }
  }, [buys])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:300, background:T.page }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={{ width:28, height:28, border:`2px solid ${T.border}`, borderTopColor:T.navy, borderRadius:'50%', animation:'spin .7s linear infinite' }} />
    </div>
  )

  return (
    <div style={{ background:T.page, minHeight:'100%', fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme:'light' }}>
      <header style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'14px 28px', background:T.card, borderBottom:`1px solid ${T.border}` }}>
        <div>
          <h2 style={{ fontSize:14, fontWeight:600, color:T.navy, margin:'0 0 2px' }}>Inventory Buys</h2>
          <p style={{ fontSize:11, color:'rgba(74,74,74,0.65)', margin:0 }}>
            Log card-show and collection purchases so COGS — and your real margins — stay honest.
            {msg && <> · <span style={{ color:T.success, fontWeight:500 }}>{msg}</span></>}
          </p>
        </div>
      </header>

      <div style={{ padding:'20px 28px', maxWidth:920 }}>

        {tableMissing ? (
          <div style={{ background:'#FEF3C7', border:'1px solid #FCD34D', borderRadius:6, padding:'12px 16px', fontSize:12, color:'#92400E', lineHeight:1.7 }}>
            <strong>One-time setup needed:</strong> the <code>inventory_buys</code> table doesn&apos;t exist yet.
            Open your Supabase dashboard → SQL Editor, paste the contents of <code>supabase/migration.sql</code>,
            and run it. Then reload this page.
          </div>
        ) : (
          <>
            {/* Summary tiles */}
            <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:20 }}>
              <Tile label="This Month" value={fmt(stats.month)} color={T.steel} />
              <Tile label={`${stats.year} Total`} value={fmt(stats.ytd)} color={T.navy} />
              {Object.entries(stats.byCat).sort((a, b) => b[1] - a[1]).map(([cat, sum]) => (
                <Tile key={cat} label={`${stats.year} · ${cat}`} value={fmt(sum)} color={T.gold} />
              ))}
            </div>

            {/* Add form */}
            <form onSubmit={addBuy} style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'flex-end', background:T.card, border:`1px solid ${T.border}`, borderRadius:7, padding:'14px 16px', marginBottom:20 }}>
              <Field label="Date">
                <input type="date" style={inp} value={form.buy_date}
                  onChange={e => setForm(f => ({ ...f, buy_date: e.target.value }))} required />
              </Field>
              <Field label="What did you buy?" grow>
                <input style={inp} placeholder="e.g. Vintage collection — 3 boxes of 80s Topps"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))} required />
              </Field>
              <Field label="Category">
                <select style={inp} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Source">
                <select style={inp} value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))}>
                  {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Cost">
                <input style={{ ...inp, width:100 }} placeholder="$250" value={form.cost}
                  onChange={e => setForm(f => ({ ...f, cost: e.target.value }))} required />
              </Field>
              <button type="submit" disabled={saving}
                style={{ padding:'7px 18px', background:T.navy, color:'#fff', border:'none', borderRadius:5, fontSize:11.5, fontWeight:500, cursor:'pointer', opacity: saving ? .6 : 1 }}>
                {saving ? 'Saving…' : '+ Log Buy'}
              </button>
            </form>

            {/* Buy list */}
            {buys.length === 0 ? (
              <p style={{ textAlign:'center', color:'#9ca3af', fontSize:13, padding:'32px 0' }}>
                No buys logged yet. Cash purchases at shows never hit your bank feed cleanly —
                log them here so your margins include them.
              </p>
            ) : (
              <div style={{ overflowX:'auto', background:T.card, border:`1px solid ${T.border}`, borderRadius:7 }}>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr>
                      {['Date', 'Description', 'Category', 'Source', 'Cost', ''].map((h, i) => (
                        <th key={i} style={{ textAlign: i === 4 ? 'right' : i === 5 ? 'center' : 'left', padding:'7px 12px', background:T.page, fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.06em', whiteSpace:'nowrap', borderBottom:`2px solid ${T.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {buys.map((b, i) => (
                      <tr key={b.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb', borderBottom:`1px solid ${T.border}` }}>
                        <td style={{ padding:'7px 12px', fontSize:11.5, color:T.charcoal, whiteSpace:'nowrap' }}>{b.buy_date}</td>
                        <td style={{ padding:'7px 12px', fontSize:12, color:T.navy, maxWidth:340, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.description}</td>
                        <td style={{ padding:'7px 12px', fontSize:11.5, color:T.charcoal, whiteSpace:'nowrap' }}>{b.category || '—'}</td>
                        <td style={{ padding:'7px 12px', fontSize:11.5, color:T.charcoal, whiteSpace:'nowrap' }}>{b.source || '—'}</td>
                        <td style={{ padding:'7px 12px', fontSize:11.5, textAlign:'right', fontVariantNumeric:'tabular-nums', color:T.danger }}>{fmt2(b.cost)}</td>
                        <td style={{ padding:'7px 12px', textAlign:'center' }}>
                          <button onClick={() => deleteBuy(b.id)} title="Delete"
                            style={{ background:'none', border:'none', color:'#9ca3af', cursor:'pointer', fontSize:13, padding:'2px 6px' }}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, color }) {
  return (
    <div style={{ flex:'1 1 140px', minWidth:130, background:T.card, border:`1px solid ${T.border}`, borderTop:`3px solid ${color}`, borderRadius:7, padding:'12px 14px' }}>
      <div style={{ fontSize:9, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:18, fontWeight:600, color:T.navy }}>{value}</div>
    </div>
  )
}

function Field({ label, children, grow = false }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4, flex: grow ? '1 1 220px' : '0 0 auto' }}>
      <label style={{ fontSize:9.5, fontWeight:700, color:T.gold, textTransform:'uppercase', letterSpacing:'.06em' }}>{label}</label>
      {children}
    </div>
  )
}

const inp = { padding:'6px 9px', border:`1px solid ${T.border}`, borderRadius:5, fontSize:12, color:T.charcoal, background:'#fff', outline:'none', boxSizing:'border-box' }
