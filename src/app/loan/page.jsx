'use client'

import TermLoanPlanner from '../../components/TermLoanPlanner'
import { CLIENT_ID } from '../../lib/client'

export default function LoanPage() {
  return <TermLoanPlanner clientId={CLIENT_ID} />
}
