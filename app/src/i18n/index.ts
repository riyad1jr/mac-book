import { useCallback, useEffect, useMemo, useState } from 'react'
import { amPhrases } from './phrases'

export type Language = 'en' | 'am'

export const LANGUAGES: { code: Language; label: string; native: string }[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'am', label: 'Amharic', native: 'አማርኛ' },
]

export const STORAGE_KEY = 'mame-language'

export function loadLanguage(): Language {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'en' || saved === 'am') return saved
  return 'en'
}

const en = {
  'nav.overview': 'Overview',
  'nav.sales': 'Sales',
  'nav.purchases': 'Purchases',
  'nav.items': 'Items',
  'nav.customers': 'Customers',
  'nav.suppliers': 'Suppliers',
  'nav.expenses': 'Expenses',
  'nav.reports': 'Reports',
  'nav.graph': 'Graph View',
  'nav.settings': 'Settings',
  'topbar.language': 'Language',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
  'common.save': 'Save',
  'common.add': 'Add',
  'common.search': 'Search',
  'common.details': 'Details',
  'common.previous': 'Previous',
  'common.next': 'Next',
  'common.pageOf': 'Page',
  'common.exportPdf': 'Export PDF',
  'common.branch': 'Branch',
  'common.workspace': 'Workspace',
  'heading.purchases': 'Purchases',
  'heading.purchasesDesc': 'Stock you bought, what it cost and what you still owe suppliers.',
  'heading.sales': 'Sales',
  'heading.salesDesc': 'Record sales, see payments and credit by day, week, month or year.',
  'heading.items': 'Items',
  'heading.itemsDesc': 'Add, edit, and delete every item in your catalog.',
  'heading.customers': 'Customers',
  'heading.customersDesc': 'Your customers, what they bought and what they still owe.',
  'heading.suppliers': 'Suppliers',
  'heading.suppliersDesc': 'Keep your suppliers organized and ready to deliver.',
  'heading.expenses': 'Expenses',
  'heading.expensesDesc': 'Rent, Isuzu transport, daily labor, utilities — so the profit number tells the truth.',
  'heading.reports': 'Reports & Analytics',
  'heading.reportsDesc': 'Sales, payments, purchase spend and profit for any period, with PDF export.',
  'heading.graph': 'Graph View',
  'heading.graphDesc': 'Interactive visuals, trends, and operational breakdown at a glance.',
  'heading.settings': 'Settings',
  'heading.settingsDesc': 'Your shop details, backups and data.',
  'action.recordPurchase': 'Record purchase',
  'action.recordSale': 'Record sale',
  'action.addCustomer': 'Add customer',
  'action.addSupplier': 'Add supplier',
  'action.addExpense': 'Add expense',
  'action.addItem': 'Add item manually',
  'action.backToPurchases': 'Back to purchases',
  'empty.search': 'No purchases match your search.',
} as const

export type TranslationKey = keyof typeof en

const am: Record<TranslationKey, string> = {
  'nav.overview': 'አጠቃላይ እይታ',
  'nav.sales': 'ሽያጭ',
  'nav.purchases': 'ግዢ',
  'nav.items': 'እቃዎች',
  'nav.customers': 'ደንበኞች',
  'nav.suppliers': 'አቅራቢዎች',
  'nav.expenses': 'ወጪዎች',
  'nav.reports': 'ሪፖርቶች',
  'nav.graph': 'ግራፍ እይታ',
  'nav.settings': 'ቅንብሮች',
  'topbar.language': 'ቋንቋ',
  'common.cancel': 'ሰርዝ',
  'common.close': 'ዝጋ',
  'common.edit': 'አርትዕ',
  'common.delete': 'ሰርዝ',
  'common.save': 'አስቀምጥ',
  'common.add': 'ጨምር',
  'common.search': 'ፈልግ',
  'common.details': 'ዝርዝር',
  'common.previous': 'ቀዳሚ',
  'common.next': 'ቀጣይ',
  'common.pageOf': 'ገጽ',
  'common.exportPdf': 'PDF አስተላልፍ',
  'common.branch': 'ቅርንጫፍ',
  'common.workspace': 'የስራ ቦታ',
  'heading.purchases': 'ግዢ',
  'heading.purchasesDesc': 'የገዙት እቃ፣ ዋጋው እና ለአቅራቢዎች ያለብዎት ዕዳ።',
  'heading.sales': 'ሽያጭ',
  'heading.salesDesc': 'ሽያጭ ይመዝግቡ፣ ክፍያና ብድር በቀን፣ በሳምንት፣ በወር ወይም በዓመት ይመልከቱ።',
  'heading.items': 'እቃዎች',
  'heading.itemsDesc': 'በካታሎጋችሁ ውስጥ እያንዳንዱን እቃ ያክሉ፣ ያርትዑ እና ይሰርዙ።',
  'heading.customers': 'ደንበኞች',
  'heading.customersDesc': 'ደንበኞችዎ፣ የገዙት እና ያለባቸው ዕዳ።',
  'heading.suppliers': 'አቅራቢዎች',
  'heading.suppliersDesc': 'አቅራቢዎችዎን በደንብ የተደራጁ እና ለማድረስ ዝግጁ ያድርጉ።',
  'heading.expenses': 'ወጪዎች',
  'heading.expensesDesc': 'ኪራይ፣ ኢሱዙ ትራንስፖርት፣ የዕለት ሠራተኛ፣ መገልገያዎች — ስለዚህ የትርፍ ቁጥሩ እውነቱን ይናገራል።',
  'heading.reports': 'ሪፖርቶች እና ትንታኔ',
  'heading.reportsDesc': 'ሽያጭ፣ ክፍያዎች፣ የግዢ ወጪ እና ትርፍ ለማንኛውም ጊዜ፣ በPDF ማውጣት ጋር።',
  'heading.graph': 'ግራፍ እይታ',
  'heading.graphDesc': 'መስተጋብራዊ ምስሎች፣ አዝማሚያዎች እና የአሰራር ክፍፍል በአንድ እይታ።',
  'heading.settings': 'ቅንብሮች',
  'heading.settingsDesc': 'የሱቅዎ መረጃ፣ ምትኬዎች እና ዳታ።',
  'action.recordPurchase': 'ግዢ ይመዝገቡ',
  'action.recordSale': 'ሽያጭ ይመዝገቡ',
  'action.addCustomer': 'ደንበኛ ያክሉ',
  'action.addSupplier': 'አቅራቢ ያክሉ',
  'action.addExpense': 'ወጪ ያክሉ',
  'action.addItem': 'እቃ በእጅ ያክሉ',
  'action.backToPurchases': 'ወደ ግዢ ይመለሱ',
  'empty.search': 'ከፍለጋዎ ጋር የሚዛመዱ ግዢዎች የሉም።',
}

const dictionaries: Record<Language, Record<TranslationKey, string>> = { en, am }

// Module-level current language so tx() can be called from any component
// without threading props. App re-renders every child on language change.
let currentLanguage: Language = loadLanguage()

/** Translate by English source text. Falls back to the English. */
export function tx(text: string): string {
  if (currentLanguage === 'am') return amPhrases[text] ?? text
  return text
}

export function useLanguage() {
  const [language, setLanguage] = useState<Language>(loadLanguage)
  currentLanguage = language

  const setLanguageSafe = useCallback((lang: Language) => {
    setLanguage(lang)
    localStorage.setItem(STORAGE_KEY, lang)
  }, [])

  // Reflect the active language onto <html lang="..."> so the CSS can
  // adjust the type scale for Ethiopic script, and so the browser picks
  // the right font and line-breaking rules.
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  const t = useCallback(
    (key: TranslationKey) => dictionaries[language][key] ?? en[key],
    [language],
  )

  const locale = useMemo(
    () => (language === 'am' ? 'am-ET' : 'en-ET'),
    [language],
  )

  return { language, setLanguageSafe, t, locale }
}
