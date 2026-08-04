import { useState, useEffect, useRef } from 'react'
import { T } from '../lib/theme'

// Small ⓘ affordance that explains where a number comes from.
//
// Opens on hover for mouse users and on click for touch/keyboard users, so the
// explanation is reachable either way. Everything is a <span> because these sit
// inside <h3> and card labels, where a <div> would be invalid markup.
export default function InfoTip({ title, children, width = 290 }) {
  const [open,  setOpen]  = useState(false)
  const [hover, setHover] = useState(false)
  const [flip,  setFlip]  = useState(false)
  const ref = useRef(null)

  const shown = open || hover

  useEffect(() => {
    if (!open) return
    const onDoc = e => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const onKey = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Anchor to whichever side keeps the panel on screen — KPI cards are narrow
  // and the rightmost one would otherwise push the popover off the viewport.
  useEffect(() => {
    if (!shown || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setFlip(r.left + width + 24 > window.innerWidth)
  }, [shown, width])

  return (
    <span
      ref={ref}
      style={sx.wrap}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-label={title ? `About ${title}` : 'Where this number comes from'}
        aria-expanded={shown}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        style={{ ...sx.dot, ...(shown ? sx.dotOn : {}) }}
      >i</button>

      {shown && (
        <span role="tooltip" style={{ ...sx.pop, width, ...(flip ? { right: 0 } : { left: 0 }) }}>
          {title && <span style={sx.popTitle}>{title}</span>}
          <span style={sx.popBody}>{children}</span>
        </span>
      )}
    </span>
  )
}

const sx = {
  wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle' },
  dot: {
    flexShrink: 0, width: 13, height: 13, borderRadius: '50%', padding: 0,
    // Longhands, not the `border` shorthand: dotOn swaps borderColor on hover,
    // and React 19 warns when a shorthand and its longhand both animate.
    borderWidth: 1, borderStyle: 'solid', borderColor: T.border,
    background: 'transparent', color: 'rgba(74,74,74,0.55)',
    fontSize: 9, fontWeight: 700, fontStyle: 'italic', fontFamily: 'Georgia, serif',
    lineHeight: 1, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    textTransform: 'none', letterSpacing: 0,
  },
  dotOn: { borderColor: T.navy, background: T.navy, color: '#fff' },
  pop: {
    position: 'absolute', top: 'calc(100% + 7px)', zIndex: 200,
    display: 'block', background: '#fff', border: `1px solid ${T.border}`,
    borderRadius: 7, boxShadow: '0 10px 30px rgba(27,58,92,.16)', padding: '10px 13px',
    textTransform: 'none', letterSpacing: 'normal', textAlign: 'left', cursor: 'default',
  },
  popTitle: { display: 'block', fontSize: 10.5, fontWeight: 700, color: T.navy, marginBottom: 4 },
  popBody:  { display: 'block', fontSize: 11, lineHeight: 1.65, color: T.charcoal, fontWeight: 400 },
}
