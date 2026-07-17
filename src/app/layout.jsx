import './globals.css'
import Shell from '../components/Shell'

export const metadata = {
  title: 'SCS Finance',
  description: 'Bookkeeping and profitability dashboard for Sports Card Station',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  )
}
