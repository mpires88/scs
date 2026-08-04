'use client'

import ReportsBS from '../../components/ReportsBS'
import { CLIENT_ID } from '../../lib/client'

export default function BalanceSheetPage() {
  return <ReportsBS clientId={CLIENT_ID} />
}
