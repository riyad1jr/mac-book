import { toEthiopianDate } from './ethiopianCalendar'

/* ---------------------------------------------------------------
   One meaning for "today / this week / this month / this year",
   used by every screen and PDF.

   Before, Sales used Ethiopian months and Monday weeks while Reports,
   Graph, Purchases and Expenses used European months and Sunday weeks,
   so the same "This month" gave different totals on different screens
   (and Expenses showed an Ethiopian month name over a European month).
   --------------------------------------------------------------- */

export type PeriodKey = 'day' | 'week' | 'month' | 'year' | 'all'

/** Local calendar date "YYYY-MM-DD" (toISOString is UTC: 3 hours behind in Ethiopia). */
export const localISO = (date = new Date()) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10)

const ethOf = (iso: string) => toEthiopianDate(new Date(`${iso}T12:00:00`))

/** Monday of the week containing `date`, as "YYYY-MM-DD". */
export const weekStartISO = (date = new Date()) =>
  localISO(new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7)))

/** Is this record date inside the period (Ethiopian month/year, Monday weeks)? */
export function inPeriod(isoDate: string | undefined, key: PeriodKey, now = new Date()): boolean {
  if (!isoDate) return false
  const date = isoDate.slice(0, 10)
  const today = localISO(now)
  if (key === 'all') return true
  if (key === 'day') return date === today
  if (key === 'week') return date >= weekStartISO(now) && date <= today
  const a = ethOf(date)
  const b = ethOf(today)
  if (key === 'month') return a.year === b.year && a.month === b.month
  return a.year === b.year
}

/** "Meskerem 2019" for the current Ethiopian month. */
export const currentEthMonthLabel = (now = new Date()) => {
  const e = toEthiopianDate(now)
  return `${e.monthNameEn} ${e.year}`
}
