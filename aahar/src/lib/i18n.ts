// Lightweight bilingual labels. The UI shows English as the primary label with a
// Devanagari hint where it helps a non-technical user — no framework needed.

export interface Bi {
  en: string
  hi: string
}

export const bi = (en: string, hi: string): Bi => ({ en, hi })

export const L = {
  dashboard: bi('Dashboard', 'डैशबोर्ड'),
  sales: bi('Sales', 'बिक्री'),
  khata: bi('Khata', 'खाता'),
  customers: bi('Customers', 'ग्राहक'),
  payments: bi('Payments', 'भुगतान'),
  purchases: bi('Purchases', 'खरीद'),
  inventory: bi('Inventory', 'स्टॉक'),
  production: bi('Production', 'उत्पादन'),
  dispatch: bi('Dispatch', 'डिस्पैच'),
  rokad: bi('Rokad', 'रोकड़'),
  expenses: bi('Expenses', 'खर्च'),
  reports: bi('Reports', 'रिपोर्ट'),
  reminders: bi('Reminders', 'रिमाइंडर'),
  settings: bi('Settings', 'सेटिंग'),
  users: bi('Users', 'यूज़र'),
  audit: bi('Audit log', 'ऑडिट'),
  newSale: bi('New Sale', 'नई बिक्री'),
  more: bi('More', 'और'),
  home: bi('Home', 'होम'),
}
