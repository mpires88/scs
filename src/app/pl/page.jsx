'use client'

// Kept so existing links to /pl still work — the P&L is the first statement
// on the combined page.
import FinancialStatements from '../../components/FinancialStatements'
import { CLIENT_ID } from '../../lib/client'

export default function PLStatementPage() {
  return <FinancialStatements clientId={CLIENT_ID} />
}
