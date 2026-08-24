// Domain model for Aahar — the feed-factory operating system.
// Amounts are in rupees (numbers). Quantities are kept in each product's own
// unit; the pack size (kg per bag) lets us convert to weight when needed.

export type ID = string
export type PartyKind = 'customer' | 'supplier'
export type ProductType = 'raw' | 'finished'
export type Unit = 'bag' | 'kg' | 'ton'
export type PayMode = 'cash' | 'upi' | 'bank' | 'cheque' | 'other'
export type SaleStatus = 'pending' | 'dispatched' | 'delivered'
export type Role =
  | 'owner'
  | 'admin'
  | 'accountant'
  | 'sales'
  | 'store'
  | 'production'
  | 'dispatch'
  | 'viewer'

export interface Party {
  id: ID
  kind: PartyKind
  name: string
  phone: string
  city: string
  gstin?: string
  /** Positive = customer owes us / we owe supplier, at go-live. */
  openingBalance: number
  creditLimit?: number
  creditDays: number
  notes?: string
  since: string
}

export interface Product {
  id: ID
  type: ProductType
  name: string
  hindi?: string
  unit: Unit
  /** kg per selling unit (per bag). Used for kg/ton conversions. */
  packKg: number
  rate: number
  hsn?: string
  openingStock: number
  reorderLevel: number
}

export interface SaleLine {
  productId: ID
  qty: number
  unit: Unit
  rate: number
}

export interface Sale {
  id: ID
  no: string
  partyId: ID
  date: string
  lines: SaleLine[]
  creditDays: number
  /** Amount collected at the moment of sale (cash/UPI at the gate). */
  paidNow: number
  paidMode?: PayMode
  vehicle?: string
  driver?: string
  driverPhone?: string
  transportCost?: number
  status: SaleStatus
  note?: string
  createdBy: ID
}

export interface PurchaseLine {
  productId: ID
  qty: number
  unit: Unit
  rate: number
}

export interface Purchase {
  id: ID
  no: string
  partyId: ID
  date: string
  lines: PurchaseLine[]
  creditDays: number
  paidNow: number
  paidMode?: PayMode
  note?: string
  createdBy: ID
}

export interface Payment {
  id: ID
  partyId: ID
  direction: 'in' | 'out'
  amount: number
  mode: PayMode
  date: string
  ref?: string
  note?: string
  createdBy: ID
}

export interface Expense {
  id: ID
  category: string
  amount: number
  date: string
  mode: PayMode
  note?: string
  enteredBy: ID
}

export interface BomLine {
  productId: ID
  kgPerTon: number
}

export interface Bom {
  productId: ID
  lines: BomLine[]
}

export interface ProductionBatch {
  id: ID
  batchNo: string
  productId: ID
  date: string
  outputBags: number
  consumption: { productId: ID; kg: number }[]
  wastageKg: number
  note?: string
  createdBy: ID
}

export interface User {
  id: ID
  name: string
  phone: string
  role: Role
  active: boolean
}

export interface AuditEntry {
  id: ID
  at: string
  userId: ID
  entity: string
  entityId: string
  action: 'create' | 'edit' | 'delete'
  field?: string
  oldValue?: string
  newValue?: string
  reason?: string
}

export interface ReminderSettings {
  enabled: boolean
  onDispatch: boolean
  onDueDate: boolean
  overdueEveryDays: number
  quietHours: string
  maxPerInvoicePerDay: number
}

export interface Business {
  name: string
  hindi: string
  gstin: string
  phone: string
  address: string
  city: string
  state: string
  whatsappConnected: boolean
  reminders: ReminderSettings
}

export interface AppState {
  business: Business
  users: User[]
  currentUserId: ID
  parties: Party[]
  products: Product[]
  sales: Sale[]
  purchases: Purchase[]
  payments: Payment[]
  expenses: Expense[]
  boms: Bom[]
  batches: ProductionBatch[]
  audit: AuditEntry[]
}

// ---- Derived shapes (never stored — always computed from the above) ----

export type ReceivableStatus =
  | 'paid'
  | 'partial'
  | 'upcoming'
  | 'dueTomorrow'
  | 'dueToday'
  | 'overdue'

export interface Receivable {
  sale: Sale
  party: Party
  gross: number
  paid: number
  outstanding: number
  dueDate: string
  daysToDue: number
  status: ReceivableStatus
}

export interface LedgerRow {
  date: string
  kind: string
  particulars: string
  ref?: string
  debit: number
  credit: number
  balance: number
}

export interface StockRow {
  product: Product
  opening: number
  inQty: number
  outQty: number
  onHand: number
  valuation: number
  low: boolean
}
