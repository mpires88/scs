'use client'

import { useState, useEffect } from 'react'
import { T } from '../lib/theme'

// Commit on blur or Enter, Escape reverts — same contract as Settings inputs,
// so a half-typed number never drives the simulation or a network write.
export default function CommitInput({ value, onCommit, suffix = '', width = 86 }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = () => {
    const n = parseFloat(String(draft).replace(/[$,%\s]/g, ''))
    if (!isNaN(n) && n >= 0 && n !== value) onCommit(n)
    else setDraft(String(value))
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(String(value))
        }}
        style={{ width, padding: '4px 8px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 12, color: T.charcoal, background: '#fff', outline: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
      />
      {suffix && <span style={{ fontSize: 11, color: '#9ca3af' }}>{suffix}</span>}
    </span>
  )
}
