import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

// Dropdown category picker.
// Props:
//   categories  — flat string[]  (used when groups is absent)
//   groups      — [{section, accounts}]  (COA-grouped; shows section headers)
// Typing stays local until an explicit commit — dropdown click, Enter, or a
// blur whose text exactly matches a known category. A stray "xyz" abandoned
// with a click elsewhere reverts instead of becoming a pending assignment.
// Free text (a category not in the chart of accounts) commits via Enter only.
export default function CategoryInput({ value, onChange, categories = [], groups = null, placeholder = '— no category —', style = {} }) {
  const [open,  setOpen]  = useState(false)
  const [query, setQuery] = useState(value ?? '')
  const [prevValue, setPrevValue] = useState(value)
  const [pos,   setPos]   = useState(null)
  const wrapRef = useRef(null)
  const dropRef = useRef(null)

  // Sync the text box when the controlled value changes (render-time adjustment,
  // per React docs, instead of an effect)
  if (value !== prevValue) {
    setPrevValue(value)
    setQuery(value ?? '')
  }

  const allNames = useMemo(
    () => (groups ? groups.flatMap(g => g.accounts) : categories),
    [groups, categories]
  )

  // Build display items: either flat or grouped
  const displayItems = buildDisplayItems(groups, categories, query)

  const commit = cat => {
    setQuery(cat)
    setOpen(false)
    if (cat !== (value ?? '')) onChange(cat)
  }

  const revert = () => {
    setQuery(value ?? '')
    setOpen(false)
  }

  const handleChange = e => {
    setQuery(e.target.value)
    openMenu()
  }

  const handleKeyDown = e => {
    if (e.key === 'Escape') revert()
    if (e.key === 'Enter') {
      const q = query.trim()
      // Empty Enter means "clear", not "pick the first of every category"
      const firstAccount = q ? displayItems.find(x => x.type === 'account') : null
      commit(firstAccount ? firstAccount.name : q)
    }
  }

  const handleBlur = () => {
    const q = query.trim()
    if (q === (value ?? '')) return
    const match = allNames.find(n => n.toLowerCase() === q.toLowerCase())
    if (match) commit(match)
    else revert()
  }

  const hasItems = displayItems.some(x => x.type === 'account')

  // The menu renders into <body> rather than next to the input, because the
  // transaction tables sit inside `overflow-x: auto` wrappers — which per CSS
  // also clip vertically, chopping the list off on the lower rows. A portal has
  // no ancestor that can clip it, so position has to be measured by hand.
  const place = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom
    const above = r.top
    // Drop upward only when there's genuinely more room up there.
    const flip = below < 200 && above > below
    setPos({
      left: r.left,
      width: r.width,
      top: flip ? null : r.bottom + 2,
      bottom: flip ? window.innerHeight - r.top + 2 : null,
      maxHeight: Math.max(120, Math.min(260, (flip ? above : below) - 12)),
    })
  }, [])

  // Measured when the menu opens rather than in an effect, so there's no
  // second render just to place it. Both updates land in one batch.
  const openMenu = useCallback(() => { place(); setOpen(true) }, [place])

  useEffect(() => {
    if (!open) return
    // Capture phase so inner scrollers (the table wrapper) are caught too, not
    // just the window — otherwise the menu detaches from its input on scroll.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  useEffect(() => {
    const handler = e => {
      if (wrapRef.current?.contains(e.target)) return
      if (dropRef.current?.contains(e.target)) return   // portal is outside wrapRef
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', ...style }}>
      <input
        style={inp}
        value={query}
        onChange={handleChange}
        onFocus={openMenu}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={placeholder}
        autoComplete="off"
      />

      {open && hasItems && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropRef}
          style={{
            ...drop,
            left: pos.left, width: pos.width, maxHeight: pos.maxHeight,
            ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }),
          }}
        >
          {displayItems.map((item, i) =>
            item.type === 'header' ? (
              <div key={`h-${i}`} style={header}>{item.section}</div>
            ) : (
              <div
                key={item.name}
                style={acct}
                onMouseDown={() => commit(item.name)}
                onMouseEnter={e => e.currentTarget.style.background = '#f3f4f6'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {groups ? <span style={{ paddingLeft: 8 }}>{item.name}</span> : item.name}
              </div>
            )
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

function buildDisplayItems(groups, categories, query) {
  const q = query.trim().toLowerCase()

  if (groups) {
    const items = []
    for (const { section, accounts } of groups) {
      const filtered = q ? accounts.filter(a => a.toLowerCase().includes(q)) : accounts
      if (!filtered.length) continue
      items.push({ type: 'header', section })
      filtered.forEach(name => items.push({ type: 'account', name }))
    }
    return items
  }

  const filtered = q ? categories.filter(c => c.toLowerCase().includes(q)) : categories
  return filtered.map(name => ({ type: 'account', name }))
}

const inp    = { width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, color: '#111827', background: '#fff', outline: 'none', boxSizing: 'border-box' }
// Fixed, not absolute: the menu lives in <body>, so it positions against the
// viewport. z-index clears the import modal (1000) and the guide drawer (900),
// which would otherwise paint over a portal that comes later in the DOM.
const drop   = { position: 'fixed', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.14)', zIndex: 3000, overflowY: 'auto' }
const header = { padding: '5px 10px 3px', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em', background: '#f9fafb', borderBottom: '1px solid #f3f4f6', userSelect: 'none', position: 'sticky', top: 0 }
const acct   = { padding: '7px 10px', fontSize: 13, color: '#111827', cursor: 'pointer', background: 'transparent', userSelect: 'none' }
