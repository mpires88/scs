import { useState, useEffect, useRef } from 'react'
import { T } from '../lib/theme'

// Checkbox dropdown for picking several values from a short list.
//
// `value` is the selected subset; an empty one means "no filter", and the
// trigger says so ("All accounts") rather than showing nothing. Options are
// plain strings — the list is meant for a handful of names, not thousands.
export default function MultiSelect({ options, value, onChange, noun = 'items', allLabel = null, style = {}, title }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const chosen = new Set(value)

  useEffect(() => {
    if (!open) return
    const onDown = e => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    const onKey  = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = opt => onChange(chosen.has(opt) ? value.filter(v => v !== opt) : [...value, opt])

  const label = chosen.size === 0 ? (allLabel ?? `All ${noun}`)
    : chosen.size === 1 ? value[0]
    : `${chosen.size} ${noun}`

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{ ...trigger, ...style, ...(chosen.size ? triggerActive : {}) }}
      >
        <span style={ellipsis}>{label}</span>
        <span style={{ marginLeft: 6, fontSize: 8, opacity: .6, flexShrink: 0 }}>▼</span>
      </button>

      {open && (
        <div role="listbox" aria-multiselectable="true" style={menu}>
          {options.map(opt => (
            <label key={opt} style={row}>
              <input type="checkbox" checked={chosen.has(opt)} onChange={() => toggle(opt)} />
              <span style={ellipsis} title={opt}>{opt}</span>
            </label>
          ))}
          {options.length === 0 && <div style={{ ...row, color: '#9ca3af', cursor: 'default' }}>Nothing to choose from</div>}
          {chosen.size > 0 && (
            <button type="button" onClick={() => onChange([])} style={clearBtn}>Clear selection</button>
          )}
        </div>
      )}
    </div>
  )
}

// Longhand border, not the shorthand: `triggerActive` overrides borderColor,
// and React warns when a longhand disappears on re-render while a shorthand
// for the same property is still set.
const trigger = {
  display: 'inline-flex', alignItems: 'center', maxWidth: '100%', padding: '5px 9px',
  borderWidth: 1, borderStyle: 'solid', borderColor: T.border, borderRadius: 5, fontSize: 11, color: T.charcoal,
  background: '#fff', cursor: 'pointer', textAlign: 'left', lineHeight: 'normal',
}
const triggerActive = { borderColor: T.navy, color: T.navy, fontWeight: 500 }
const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
// Absolute, not a portal: the toolbar it lives in has no clipping ancestor, and
// 500 clears the tables below it while staying under the import modal (1000).
const menu = {
  position: 'absolute', top: 'calc(100% + 3px)', left: 0, zIndex: 500, minWidth: '100%', maxWidth: 320,
  maxHeight: 280, overflowY: 'auto', background: '#fff', border: `1px solid ${T.border}`,
  borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.14)', padding: '4px 0',
}
const row = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 11.5,
  color: T.charcoal, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
}
const clearBtn = {
  display: 'block', width: 'calc(100% - 16px)', margin: '4px 8px 2px', padding: '4px 8px',
  background: '#fff', color: T.charcoal, border: `1px solid ${T.border}`, borderRadius: 4,
  fontSize: 10.5, cursor: 'pointer',
}
