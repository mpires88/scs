'use client'

import TransactionsHub from '../../components/TransactionsHub'
import { CLIENT_ID } from '../../lib/client'

export default function TransactionsPage() {
  return <TransactionsHub clientId={CLIENT_ID} />
}
