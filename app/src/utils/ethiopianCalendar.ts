/**
 * Pure 100% Offline Ethiopian Calendar (Ge'ez) Conversion Utility
 * Converts between Gregorian Calendar (GC) and Ethiopian Calendar (EC).
 */

export const ETHIOPIAN_MONTHS = [
  { nameEn: 'Meskerem', nameAm: 'መስከረም', index: 1 },
  { nameEn: 'Tikimt', nameAm: 'ጥቅምት', index: 2 },
  { nameEn: 'Hidar', nameAm: 'ሕዳር', index: 3 },
  { nameEn: 'Tahsas', nameAm: 'ታኅሣሥ', index: 4 },
  { nameEn: 'Ter', nameAm: 'ጥር', index: 5 },
  { nameEn: 'Yakatit', nameAm: 'የካቲት', index: 6 },
  { nameEn: 'Megabit', nameAm: 'መጋቢት', index: 7 },
  { nameEn: 'Miazia', nameAm: 'ሚያዝያ', index: 8 },
  { nameEn: 'Ginbot', nameAm: 'ግንቦት', index: 9 },
  { nameEn: 'Sene', nameAm: 'ሰኔ', index: 10 },
  { nameEn: 'Hamle', nameAm: 'ሐምሌ', index: 11 },
  { nameEn: 'Nehase', nameAm: 'ነሐሴ', index: 12 },
  { nameEn: 'Pagumē', nameAm: 'ጳጉሜ', index: 13 },
]

export interface EthiopianDate {
  year: number
  month: number // 1-13
  day: number // 1-30 (1-5/6 for Pagumē)
  monthNameEn: string
  monthNameAm: string
}

/**
 * Converts a Gregorian Date object to Ethiopian Date
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Gregorian date on which Ethiopian year `ethYear` begins (Meskerem 1).
 *
 * Meskerem 1 falls on 11 September, or on 12 September when the FOLLOWING
 * Gregorian year is a leap year. The previous code tested the current
 * Gregorian year instead, and the forward and backward conversions used
 * different rules, so they disagreed with each other on 508 days out of
 * every six years.
 *
 * Ethiopian year E begins in Gregorian year E + 7, and E + 8 is the leap
 * year, so the shift applies exactly when E is divisible by 4. That is the
 * same condition that gives the preceding year (E - 1) a six-day Pagume.
 */
function ethiopianNewYearUTC(ethYear: number): number {
  return Date.UTC(ethYear + 7, 8, ethYear % 4 === 0 ? 12 : 11)
}

/** Midnight UTC for the calendar day shown on a Date, ignoring its time. */
function calendarDayUTC(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
}

export function toEthiopianDate(gregorianDate: Date = new Date()): EthiopianDate {
  const target = calendarDayUTC(gregorianDate)

  // Start from the likely Ethiopian year, then step until the date sits
  // inside it. At most one step is ever needed.
  let ethYear = gregorianDate.getFullYear() - 7
  while (target < ethiopianNewYearUTC(ethYear)) ethYear -= 1
  while (target >= ethiopianNewYearUTC(ethYear + 1)) ethYear += 1

  const dayOfYear = Math.round((target - ethiopianNewYearUTC(ethYear)) / MS_PER_DAY)
  const ethMonth = Math.floor(dayOfYear / 30) + 1
  const ethDay = (dayOfYear % 30) + 1

  const monthObj = ETHIOPIAN_MONTHS[ethMonth - 1] || ETHIOPIAN_MONTHS[0]
  return {
    year: ethYear,
    month: ethMonth,
    day: ethDay,
    monthNameEn: monthObj.nameEn,
    monthNameAm: monthObj.nameAm,
  }
}

/**
 * Converts an Ethiopian date (year, month 1-13, day 1-30) back to a Gregorian
 * Date. Exactly inverts toEthiopianDate.
 */
export function toGregorianDate(ethYear: number, ethMonth: number, ethDay: number): Date {
  const offset = (ethMonth - 1) * 30 + (ethDay - 1)
  return new Date(ethiopianNewYearUTC(ethYear) + offset * MS_PER_DAY)
}

/**
 * Returns number of days in a given Ethiopian month & year
 */
export function getEthiopianMonthDays(ethYear: number, ethMonth: number): number {
  if (ethMonth < 13) return 30
  // Pagume: 6 days if ethYear % 4 === 3 (meaning next GC year is leap), else 5
  return (ethYear % 4 === 3) ? 6 : 5
}

/**
 * Formats a Date into a dual Gregorian & Ethiopian date string
 * e.g. "የካቲት 1, 2018 E.C. (Feb 8, 2026)"
 */
/**
 * Read a stored date. "2026-10-06" on its own is treated by JavaScript as
 * midnight UTC, which on a computer whose time zone is behind UTC (many
 * Windows PCs default to an American zone) is still the previous day - the
 * Ethiopian date then came out one day early. Date-only strings are read as
 * local midday instead, which is the same calendar day in every time zone.
 */
export function parseStoredDate(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value)
}

/** Gregorian "YYYY-MM-DD" for an Ethiopian date (via the checked conversion above). */
export function ethiopianToIso(ethYear: number, ethMonth: number, ethDay: number): string {
  return toGregorianDate(ethYear, ethMonth, ethDay).toISOString().slice(0, 10)
}

export function formatDualDate(dateInput: Date | string = new Date(), lang: 'am' | 'en' = 'am'): string {
  const d = typeof dateInput === 'string' ? parseStoredDate(dateInput) : dateInput
  if (isNaN(d.getTime())) return String(dateInput)

  const eth = toEthiopianDate(d)
  const monthName = lang === 'am' ? eth.monthNameAm : eth.monthNameEn

  const gcFormatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${monthName} ${eth.day}, ${eth.year} E.C. (${gcFormatted})`
}

