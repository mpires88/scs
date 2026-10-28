// Cover page for the printed Financial Statements: what period they cover, what
// is in the pack, and a plain-English guide to reading each statement. Print
// only — on screen the statements speak for themselves and /help goes deeper.
// The LEAF disclosure isn't repeated here: PrintDisclosure footers every page.

import { T } from '../lib/theme'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

const ymLabel = ym => {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

// The period the columns actually span, in words.
export function periodLabel({ period, year, columns }) {
  if (!columns?.length) return year ? String(year) : ''
  const first = columns[0], last = columns[columns.length - 1]
  if (period === 'yearly') return first === last ? `Year ${first}` : `Years ${first} – ${last}`
  if (period === 'all')    return first === last ? ymLabel(first) : `${ymLabel(first)} – ${ymLabel(last)}`
  return first === last
    ? `${MONTHS[first - 1]} ${year}`
    : `${MONTHS[first - 1]} – ${MONTHS[last - 1]} ${year}`
}

const GUIDE = {
  kpi: {
    title: 'Key Performance Indicators',
    asks: 'How healthy is the business, at a glance?',
    body: [
      'Ratios drawn from the three statements that follow, so a trend shows up without reading every line.',
      'Gross margin is what is left of each sales dollar after the cost of the cards sold. Operating margin is what is left after rent, payroll and every other operating cost as well.',
      'Breakeven coverage above 100% means the period paid for its fixed costs. Revenue vs last year compares each period with the same one a year earlier.',
    ],
  },
  pl: {
    title: 'Profit & Loss Statement',
    asks: 'Did the shop make money?',
    body: [
      'Reads top to bottom: revenue, less sales tax and returns, gives net revenue; less the cost of goods sold gives gross profit; less operating expenses gives operating income; other income and expenses then give net income, the bottom line.',
      'Profit is not the same as cash. Inventory bought this month becomes a cost only as it sells, so a big buying month can show a profit while the bank balance falls.',
    ],
  },
  bs: {
    title: 'Balance Sheet',
    asks: 'What does the shop own and owe?',
    body: [
      'A snapshot at each month end rather than activity over the month. Assets (cash in the bank, inventory on the shelf) on one side; liabilities (card balances, loans, sales tax due) and equity on the other.',
      'The two sides always agree: Total Assets equals Liabilities + Equity. Retained earnings is the running total of every net income to date.',
    ],
  },
  cf: {
    title: 'Cash Flow Statement',
    asks: 'Where did the cash actually go?',
    body: [
      'Only money that moved through a bank account counts, sorted into operating (running the shop), investing and financing (loans, owner money in and out).',
      'It explains why the bank balance changed even when the P&L shows a profit. A card purchase counts when the card bill is paid, not when the charge is made.',
    ],
  },
}

export default function StatementsCover({ shared, include }) {
  const sections = ['kpi', 'pl', 'bs', 'cf'].filter(k => include[k])
  const prepared = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  return (
    <div style={{ padding: '28px 40px 0', color: T.charcoal }}>
      <div style={{ borderBottom: `2px solid ${T.navy}`, paddingBottom: 14, marginBottom: 18 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.gold, textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Sports Card Station
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 600, color: T.navy, margin: '4px 0 2px' }}>Financial Statements</h1>
        <div style={{ fontSize: 14, color: T.charcoal }}>{periodLabel(shared)}</div>
        <div style={{ fontSize: 11, color: 'rgba(74,74,74,0.7)', marginTop: 6 }}>
          Prepared by LEAF · {prepared}
        </div>
      </div>

      <h2 style={h2}>In this pack</h2>
      <ol style={{ margin: '0 0 18px', paddingLeft: 20, fontSize: 12, lineHeight: 1.7 }}>
        {sections.map(k => <li key={k}>{GUIDE[k].title}</li>)}
      </ol>

      <h2 style={h2}>How to read these statements</h2>
      {sections.map(k => (
        <div key={k} style={{ marginBottom: 12, breakInside: 'avoid' }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: T.navy }}>
            {GUIDE[k].title} <span style={{ fontWeight: 400, fontStyle: 'italic', color: 'rgba(74,74,74,0.75)' }}>— {GUIDE[k].asks}</span>
          </div>
          {GUIDE[k].body.map((p, i) => (
            <p key={i} style={{ fontSize: 11, lineHeight: 1.55, margin: '3px 0 0' }}>{p}</p>
          ))}
        </div>
      ))}

      <h2 style={{ ...h2, marginTop: 16 }}>Conventions</h2>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, lineHeight: 1.6 }}>
        <li>Amounts are in whole dollars. Figures in (parentheses) are negative.</li>
        <li>A dash (—) means there was no activity on that line in that period.</li>
        <li>All figures are built from the shop&apos;s categorized bank and card transactions, plus month-end entries for cost of goods sold, sales tax and Square fees.</li>
        <li>Each statement starts on a new page and covers the same period, so the columns line up from one to the next.</li>
      </ul>
    </div>
  )
}

const h2 = {
  fontSize: 10, fontWeight: 700, color: T.gold, textTransform: 'uppercase',
  letterSpacing: '.06em', margin: '0 0 6px',
}
