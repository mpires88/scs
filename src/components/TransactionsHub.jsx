'use client'

// Transactions and Square Reports behind one header and a tab switch — the
// same pattern as FinancialStatements.
//
// Each tab keeps its own data fetch and controls; this only supplies the
// shared title bar (via their `headerLeft` prop) and decides which is on
// screen. A tab is mounted the first time it's opened and then kept mounted
// but hidden — crucially, that means pending category assignments survive a
// hop over to check a Square report and back.

import { useState } from 'react'
import Transactions from './Transactions'
import SquareReports from './SquareReports'
import { T } from '../lib/theme'

const TABS = [
  { key: 'categorize', label: 'Categorize', hint: 'Import bank activity and assign categories' },
  { key: 'square',     label: 'Square Reports', hint: 'Monthly Square sales report emails' },
]

export default function TransactionsHub({ clientId, defaultTab = 'categorize' }) {
  const [tab, setTab] = useState(defaultTab)
  const [seen, setSeen] = useState({ [defaultTab]: true })

  const open = key => { setTab(key); setSeen(s => (s[key] ? s : { ...s, [key]: true })) }

  const headerLeft = (
    <div>
      <h2 style={{ fontSize: 14, fontWeight: 600, color: T.navy, margin: '0 0 6px' }}>Transactions</h2>
      <div style={{ display: 'flex', gap: 4 }}>
        {TABS.map(t => {
          const on = tab === t.key
          return (
            <button
              key={t.key} onClick={() => open(t.key)} title={t.hint}
              style={{
                padding: '4px 12px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                border: `1px solid ${on ? T.navy : T.border}`,
                background: on ? T.navy : '#fff',
                color: on ? '#fff' : T.charcoal,
                fontWeight: on ? 600 : 400,
              }}
            >{t.label}</button>
          )
        })}
      </div>
    </div>
  )

  return (
    <>
      {seen.categorize && (
        <div style={{ display: tab === 'categorize' ? 'block' : 'none', height: '100%' }}>
          <Transactions clientId={clientId} headerLeft={headerLeft} />
        </div>
      )}
      {seen.square && (
        <div style={{ display: tab === 'square' ? 'block' : 'none', height: '100%' }}>
          <SquareReports clientId={clientId} headerLeft={headerLeft} />
        </div>
      )}
    </>
  )
}
