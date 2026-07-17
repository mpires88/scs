'use client'

import SquareReports from '../../components/SquareReports'
import { CLIENT_ID } from '../../lib/client'

export default function SquareReportsPage() {
  return <SquareReports clientId={CLIENT_ID} />
}
