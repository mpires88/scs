'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { supabase } from '../lib/supabase'
import { UnsavedChangesContext, useUnsavedChanges } from '../lib/unsavedChanges'
import Login from './Login'
import ErrorBoundary from './ErrorBoundary'

const AUTH_DISABLED = process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true'

// ─── SVG Icons ────────────────────────────────────────────────────────────────

const iconProps = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' }

function IconGrid() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
    </svg>
  )
}

function IconCreditCard() {
  return (
    <svg {...iconProps}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  )
}

function IconStatement() {
  return (
    <svg {...iconProps}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  )
}

function IconScale() {
  return (
    <svg {...iconProps}>
      <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="M7 21h10" />
      <path d="M12 3v18" />
      <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
    </svg>
  )
}

function IconTag() {
  return (
    <svg {...iconProps}>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  )
}

function IconBook() {
  return (
    <svg {...iconProps}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

function IconSquare() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="9" x2="15" y2="9" /><line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="15" x2="13" y2="15" />
    </svg>
  )
}

function IconCheckCircle() {
  return (
    <svg {...iconProps}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

function IconCalendar() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

function IconSliders() {
  return (
    <svg {...iconProps}>
      <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  )
}

function IconHelp() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

// ─── Nav config ───────────────────────────────────────────────────────────────

const NAV = [
  { group: null,      href: '/',             label: 'Dashboard',         Icon: IconGrid       },
  { group: null,      href: '/transactions', label: 'Transactions',      Icon: IconCreditCard },
  { group: null,      href: '/close',        label: 'Month-End Close',   Icon: IconCheckCircle },
  { group: 'Reports', href: '/pl',           label: 'P&L Statement',     Icon: IconStatement  },
  { group: 'Reports', href: '/balance',      label: 'Balance Sheet',     Icon: IconScale      },
  { group: 'Reports', href: '/year-end',     label: 'Year-End',          Icon: IconCalendar   },
  { group: 'Reports', href: '/buys',         label: 'Inventory Buys',    Icon: IconTag        },
  { group: 'Admin',   href: '/accounts',     label: 'Chart of Accounts', Icon: IconBook       },
  { group: 'Admin',   href: '/square',       label: 'Square Reports',    Icon: IconSquare     },
  { group: 'Admin',   href: '/settings',     label: 'Settings',          Icon: IconSliders    },
]

// Pinned to the bottom of the rail rather than sitting in a group — it's
// reference material, not part of the bookkeeping flow.
const NAV_FOOTER = [
  { href: '/help', label: 'How Your Books Work', Icon: IconHelp },
]

// ─── Shell: sidebar + auth gate + error boundary ──────────────────────────────

export default function Shell({ children }) {
  const pathname = usePathname()
  const [session, setSession] = useState(AUTH_DISABLED ? null : undefined) // undefined = still checking
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (AUTH_DISABLED) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (!AUTH_DISABLED) {
    if (session === undefined) return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F5F4F0' }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        <div style={{ width: 28, height: 28, border: '2px solid #D9D6CF', borderTopColor: '#1B3A5C', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
      </div>
    )
    if (!session) return <Login />
  }

  return (
    <UnsavedChangesContext.Provider value={{ dirty, setDirty }}>
    <div style={{ display: 'flex', minHeight: '100vh', background: '#F5F4F0', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' }}>

      {/* ── Sidebar ── */}
      <aside style={{ width: 200, flexShrink: 0, background: '#1B3A5C', display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100vh' }}>

        {/* Brand */}
        <div style={{ padding: '16px 14px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', lineHeight: 1.3 }}>SCS Finance</div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>Sports Card Station</div>
        </div>

        {/* Navigation */}
        <nav style={{ flex: 1, padding: '10px 8px', overflowY: 'auto' }}>
          {NAV.map((item, i) => {
            const prevGroup = i > 0 ? NAV[i - 1].group : undefined
            return (
              <div key={item.href}>
                {item.group && item.group !== prevGroup && (
                  <div style={{ margin: '14px 0 4px 8px', fontSize: 8.5, fontWeight: 700, color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', letterSpacing: '1.3px' }}>
                    {item.group}
                  </div>
                )}
                <NavItem item={item} active={pathname === item.href} />
              </div>
            )
          })}
        </nav>

        {/* Pinned footer nav */}
        <div style={{ padding: '6px 8px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          {NAV_FOOTER.map(item => (
            <NavItem key={item.href} item={item} active={pathname === item.href} />
          ))}
        </div>

        {/* Session footer */}
        {!AUTH_DISABLED && session && (
          <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.45)', marginBottom: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.user?.email}
            </div>
            <button
              onClick={() => supabase.auth.signOut()}
              style={{ background: 'none', border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.65)', fontSize: 10, padding: '3px 10px', borderRadius: 4, cursor: 'pointer' }}
            >
              Sign out
            </button>
          </div>
        )}
      </aside>

      {/* ── Main content ── */}
      <main style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
        <ErrorBoundary resetKey={pathname}>
          {children}
        </ErrorBoundary>
      </main>
    </div>
    </UnsavedChangesContext.Provider>
  )
}

function NavItem({ item, active }) {
  const { href, label, Icon } = item
  const [hover, setHover] = useState(false)
  const { dirty } = useUnsavedChanges()
  return (
    <Link
      href={href}
      onClick={e => {
        if (dirty && !active && !confirm('You have unsaved category changes. Leave without saving?')) e.preventDefault()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '5px 8px',
        marginBottom: 1, textDecoration: 'none',
        background: active ? 'rgba(255,255,255,0.08)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        borderLeft: active ? '2px solid #A08A3C' : '2px solid transparent',
        color: active ? '#fff' : hover ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.6)',
        fontSize: 11.5, fontWeight: active ? 500 : 400,
        textAlign: 'left', borderRadius: '0 4px 4px 0',
        transition: 'background .15s, color .15s',
      }}
    >
      <Icon />
      {label}
    </Link>
  )
}
