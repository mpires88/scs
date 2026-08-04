import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { BooksGuideContent } from './BooksGuide'
import { T } from '../lib/theme'

// Full-page presentation of the books explainer. The Dashboard drawer shows the
// same material; this exists so it's reachable from anywhere in the app.
//
// The only thing it fetches is whether COGS has ever been booked — that gates a
// section of the guide, and a head-count query is cheaper than loading the
// transaction list just to answer a yes/no.
export default function HelpGuide({ clientId }) {
  const [noCogs, setNoCogs] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data: cogsAccounts } = await supabase.from('categories')
          .select('name').eq('client_id', clientId).eq('pl_section', 'Cost of Goods Sold')
        const names = (cogsAccounts ?? []).map(a => a.name)
        if (!names.length) { if (!cancelled) setNoCogs(true); return }
        const { count } = await supabase.from('bank_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('client_id', clientId).in('category', names)
        if (!cancelled) setNoCogs((count ?? 0) === 0)
      } catch {
        // The guide reads fine without the contextual section — never block on this.
      }
    })()
    return () => { cancelled = true }
  }, [clientId])

  return (
    <div style={{ background: T.page, minHeight: '100%', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' }}>
      <header style={{ padding: '14px 28px', background: T.card, borderBottom: `1px solid ${T.border}` }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 2px' }}>How your books work</h2>
        <p style={{ fontSize: 11, color: 'rgba(74,74,74,0.65)', margin: 0 }}>
          Where the money goes, and why cash isn&apos;t the scoreboard
        </p>
      </header>

      <div style={{ padding: '20px 28px 48px', maxWidth: 760 }}>
        <BooksGuideContent noCogs={noCogs} />
      </div>
    </div>
  )
}
