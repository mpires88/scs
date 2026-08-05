import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// This project has no eslint-plugin-react, so ESLint does not treat `<Foo />`
// as a reference to `Foo`: an unimported component passes lint, passes the
// build, and only explodes at runtime when that branch renders. A statement
// that renders after its data loads won't even fail an SSR smoke check.
//
// A missing `import InfoTip` shipped exactly that way. This walks the JSX
// instead, so the next one fails here.

const SRC = path.join(process.cwd(), 'src')
const REACT_BUILTIN = new Set(['Fragment', 'Suspense', 'StrictMode', 'Profiler'])

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name)
  return e.isDirectory() ? walk(p) : (p.endsWith('.jsx') ? [p] : [])
})

// Names bound anywhere a component could legitimately come from: imports,
// declarations, and destructuring (`const { Icon } = item` then `<Icon />`).
function boundNames(src) {
  const out = new Set(REACT_BUILTIN)
  const add = list => list.split(',').forEach(x => {
    const n = x.trim().split(/\s+as\s+/).pop()?.trim()
    if (n && /^[A-Za-z_$]/.test(n)) out.add(n)
  })
  for (const m of src.matchAll(/import\s+([A-Za-z0-9_$]+)\s*(?:,|from)/g)) out.add(m[1])
  for (const m of src.matchAll(/import\s*(?:[A-Za-z0-9_$]+\s*,\s*)?\{([^}]*)\}\s*from/g)) add(m[1])
  for (const m of src.matchAll(/(?:function|class)\s+([A-Za-z0-9_$]+)/g)) out.add(m[1])
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g)) out.add(m[1])
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) add(m[1])
  for (const m of src.matchAll(/\(\s*\{([^}]*)\}\s*\)\s*=>/g)) add(m[1])
  return out
}

// Capitalised JSX tags only — lowercase ones are DOM elements. `<a.b />` counts
// as a reference to `a`, so take the root of a member expression.
const usedComponents = src =>
  new Set([...src.matchAll(/<([A-Z][A-Za-z0-9_$]*)(?:\.[A-Za-z0-9_$]+)*[\s/>]/g)].map(m => m[1]))

describe('every JSX component is actually in scope', () => {
  const files = walk(SRC)

  it('finds JSX files to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files.map(f => [path.relative(process.cwd(), f), f]))('%s', (_rel, file) => {
    const src = fs.readFileSync(file, 'utf8')
    const missing = [...usedComponents(src)].filter(n => !boundNames(src).has(n)).sort()
    expect(missing).toEqual([])
  })
})
