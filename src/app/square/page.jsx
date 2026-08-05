'use client'

// Kept so existing links to /square still work — opens the combined page on
// the Square Reports tab.
import TransactionsHub from '../../components/TransactionsHub'
import { CLIENT_ID } from '../../lib/client'

export default function SquareReportsPage() {
  return <TransactionsHub clientId={CLIENT_ID} defaultTab="square" />
}
