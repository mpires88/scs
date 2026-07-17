'use client'

import Buys from '../../components/Buys'
import { CLIENT_ID } from '../../lib/client'

export default function BuysPage() {
  return <Buys clientId={CLIENT_ID} />
}
