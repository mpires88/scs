'use client'

import Transactions from '../../components/Transactions'
import { CLIENT_ID } from '../../lib/client'

export default function TransactionsPage() {
  return <Transactions clientId={CLIENT_ID} />
}
