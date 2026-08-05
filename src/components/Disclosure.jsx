// LEAF preparation disclosure — the SSARS-style no-assurance legend that must
// accompany anything leaving this app on paper. One source of truth for the
// wording, two faces:
//
// - DisclosureBanner: the on-screen banner at the top of Financial Statements.
// - PrintDisclosure: mounted ONCE in Shell and invisible on screen. In print it
//   becomes a fixed footer, and fixed elements repeat on every printed page —
//   so every page of anything printed from anywhere in the app carries the
//   legend, including print paths added later, with no per-page wiring.

import { T } from '../lib/theme'

export const DISCLOSURE_TEXT =
  'These financial statements were prepared by LEAF. No assurance is provided on these financial statements.'

// On-screen banner. Hidden in print, where the repeating footer takes over.
export function DisclosureBanner() {
  return (
    <>
      <style>{`@media print { .leaf-banner { display: none !important } }`}</style>
      <div className="leaf-banner" style={{
        display: 'flex', gap: 10, alignItems: 'baseline',
        background: '#FBF6E7', borderBottom: `1px solid ${T.border}`,
        padding: '9px 28px', fontSize: 11.5, color: '#7A6829',
      }}>
        <strong style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: T.gold, whiteSpace: 'nowrap' }}>
          Disclosure
        </strong>
        <span style={{ fontStyle: 'italic' }}>{DISCLOSURE_TEXT}</span>
      </div>
    </>
  )
}

// Print-only legend, fixed to the bottom of every printed page. The solid
// background and rule keep it legible even when a dense page runs close to it.
export function PrintDisclosure() {
  return (
    <>
      <style>{`
        .leaf-print-legend { display: none; }
        @media print {
          .leaf-print-legend {
            display: block !important;
            position: fixed; bottom: 0; left: 0; right: 0;
            padding: 3px 0 0; background: #fff;
            border-top: 1px solid #bbb;
            font-size: 8.5pt; font-style: italic; color: #333;
            text-align: center;
          }
          /* Room for the legend after the last line of content. */
          main { padding-bottom: 36px !important; }
        }
      `}</style>
      <div className="leaf-print-legend">{DISCLOSURE_TEXT}</div>
    </>
  )
}
