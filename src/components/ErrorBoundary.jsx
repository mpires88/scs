import { Component } from 'react'
import { T } from '../lib/theme'

// Catches render errors in the main view so the sidebar stays usable and the
// user sees a readable message instead of a white screen.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidUpdate(prevProps) {
    // Reset when the user navigates to a different view
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 28, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
        <div style={{ background: '#FDE8E8', border: '1px solid #F5C2C2', borderRadius: 6, padding: '14px 18px', maxWidth: 560 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#991B1B', marginBottom: 6 }}>
            Something went wrong on this page
          </div>
          <div style={{ fontSize: 11.5, color: '#991B1B', fontFamily: 'monospace', marginBottom: 12, wordBreak: 'break-word' }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '6px 14px', background: T.navy, color: '#fff', border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 500, cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
}
