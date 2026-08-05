'use client'

import FinancialStatements from '../../components/FinancialStatements'
import { CLIENT_ID } from '../../lib/client'

export default function FinancialStatementsPage() {
  return <FinancialStatements clientId={CLIENT_ID} />
}
