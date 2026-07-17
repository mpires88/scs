'use client'

import ChartOfAccounts from '../../components/ChartOfAccounts'
import { CLIENT_ID } from '../../lib/client'

export default function AccountsPage() {
  return <ChartOfAccounts clientId={CLIENT_ID} />
}
