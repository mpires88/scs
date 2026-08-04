import { useState, useEffect } from 'react'
import { supabase, fetchAll } from '../lib/supabase'
import { BooksGuideContent } from './BooksGuide'
import FollowTheCase from './FollowTheCase'
import { T } from '../lib/theme'

// Full-page presentation of the books explainer. The Dashboard drawer shows the
// written guide; this page leads with the interactive walkthrough, which needs
// more width than the drawer has.
//
// It reads a little live data for two reasons: to decide whether the "you
// aren't recording COGS" section applies, and to close the walkthrough with the
// shop's real position instead of a figure that silently goes stale.
export default function HelpGuide({ clientId }) {
  const [noCogs, setNoCogs] = useState(false)
  const [stats,  setStats]  = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [accts, rows] = await Promise.all([
          supabase.from('categories').select('name, pl_section').eq('client_id', clientId),
          fetchAll(() => supabase.from('bank_transactions')
            .select('transaction_date, amount, category')
            .eq('client_id', clientId).not('category', 'is', null).neq('category', '')
            .order('transaction_date').order('id')),
        ])
        if (cancelled) return

        const section = new Map((accts.data ?? []).map(a => [a.name, a.pl_section]))
        const cogsNames = new Set([...section].filter(([, s]) => s === 'Cost of Goods Sold').map(([n]) => n))
        setNoCogs(!rows.some(t => cogsNames.has(t.category)))

        const years = rows.map(t => +(t.transaction_date || '').slice(0, 4)).filter(Boolean)
        const year = years.length ? Math.max(...years) : null
        if (!year) return

        let inventory = 0, buys = 0, revenue = 0
        rows.forEach(t => {
          if (+(t.transaction_date || '').slice(0, 4) !== year) return
          const sec = section.get(t.category)
          const amt = Number(t.amount) || 0
          // Money moving onto the shelf: spend booked to a balance-sheet asset.
          if (sec === 'Current Assets' && amt < 0) { inventory += -amt; buys += 1 }
          if (sec === 'Revenue') revenue += amt
        })
        setStats({ year, inventory, buys, revenue })
      } catch {
        // The guide reads fine without either — never block the page on this.
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

      <div style={{ padding: '20px 28px 48px', maxWidth: 860 }}>
        <FollowTheCase stats={stats} />
        <BooksGuideContent noCogs={noCogs} />
      </div>
    </div>
  )
}
