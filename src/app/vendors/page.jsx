'use client'

import Vendors from '../../components/Vendors'
import { CLIENT_ID } from '../../lib/client'

export default function VendorsPage() {
  return <Vendors clientId={CLIENT_ID} />
}
