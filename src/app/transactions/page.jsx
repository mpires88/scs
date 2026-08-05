'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import TransactionsHub from '../../components/TransactionsHub'
import { readTxnParams } from '../../lib/txnLink'
import { CLIENT_ID } from '../../lib/client'

// Reports deep-link here with a category and month range. useSearchParams reads
// them without the hydration mismatch that reading window.location directly
// would cause, and needs a Suspense boundary to keep the route static.
function TransactionsWithFilters() {
  const initialFilters = readTxnParams(useSearchParams())
  return <TransactionsHub clientId={CLIENT_ID} initialFilters={initialFilters} />
}

export default function TransactionsPage() {
  return (
    <Suspense fallback={null}>
      <TransactionsWithFilters />
    </Suspense>
  )
}
