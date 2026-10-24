export const moneyFormatter = new Intl.NumberFormat('en-ET', { style: 'currency', currency: 'ETB', maximumFractionDigits: 2 })
// Intl puts a non-breaking space between 'ETB' and the digits, which stops a
// very large value from ever wrapping at the one safe point. Use a normal
// space; the digits themselves are still kept together by the CSS.
export const money = { format: (n: number) => moneyFormatter.format(n).replace(/\u00a0/g, ' ') }
export const dateLabel = (date: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00`))
export const localDate = (date = new Date()) => { const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return offsetDate.toISOString().slice(0, 10) }
