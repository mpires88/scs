import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { T } from '../lib/theme'

export default function Login() {
  const [email,   setEmail]   = useState('')
  const [sent,    setSent]    = useState(false)
  const [sending, setSending] = useState(false)
  const [error,   setError]   = useState('')

  const sendLink = async e => {
    e.preventDefault()
    if (!email.trim()) return
    setSending(true); setError('')
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      // Never auto-create accounts: RLS trusts every authenticated user, so a
      // self-service signup would hand a stranger full access to the books.
      options: { emailRedirectTo: window.location.origin, shouldCreateUser: false },
    })
    setSending(false)
    if (err) setError(/signups? not allowed/i.test(err.message)
      ? 'No account exists for that email. The owner can add you in Supabase → Authentication → Users.'
      : err.message)
    else setSent(true)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.page, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', colorScheme: 'light' }}>
      <div style={{ width: '100%', maxWidth: 380, background: T.card, border: `1px solid ${T.border}`, borderTop: `3px solid ${T.gold}`, borderRadius: 8, padding: '32px 32px 28px' }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: T.navy }}>SCS Finance</div>
        <div style={{ fontSize: 11, color: 'rgba(74,74,74,0.6)', marginBottom: 24 }}>Sports Card Station</div>

        {sent ? (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.navy, marginBottom: 8 }}>Check your email</div>
            <p style={{ fontSize: 12.5, color: T.charcoal, lineHeight: 1.6, margin: 0 }}>
              A sign-in link was sent to <strong>{email}</strong>. Click it to open the app.
            </p>
            <button
              style={{ marginTop: 16, background: 'none', border: 'none', color: T.steel, fontSize: 11.5, cursor: 'pointer', padding: 0 }}
              onClick={() => { setSent(false) }}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={sendLink}>
            <label style={{ fontSize: 11, fontWeight: 600, color: T.charcoal, display: 'block', marginBottom: 6 }}>
              Email address
            </label>
            <input
              type="email"
              autoFocus
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: `1px solid ${T.border}`, borderRadius: 5, fontSize: 13, color: T.navy, background: '#fff', outline: 'none', marginBottom: 12 }}
            />
            {error && (
              <div style={{ background: '#FDE8E8', border: '1px solid #F5C2C2', borderRadius: 5, padding: '8px 12px', fontSize: 11.5, color: '#991B1B', marginBottom: 12 }}>
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={sending}
              style={{ width: '100%', padding: '9px 0', background: T.navy, color: '#fff', border: 'none', borderRadius: 5, fontSize: 12.5, fontWeight: 500, cursor: 'pointer', opacity: sending ? 0.6 : 1 }}
            >
              {sending ? 'Sending…' : 'Email me a sign-in link'}
            </button>
            <p style={{ fontSize: 10.5, color: 'rgba(74,74,74,0.55)', lineHeight: 1.6, marginTop: 14, marginBottom: 0 }}>
              No password needed — a one-time link is emailed to you.
              Locked out during local development? Set <code>NEXT_PUBLIC_DISABLE_AUTH=true</code> in <code>.env</code>.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
