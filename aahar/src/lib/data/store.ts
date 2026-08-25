import { createContext, useContext, useEffect, useReducer, type ReactNode, createElement } from 'react'
import type { AppState, Party, Product, Sale, Purchase, Payment, Expense, AuditEntry, Business } from '@/lib/types'
import { seed } from '@/lib/data/seed'
import { TODAY } from '@/lib/date'

// A single on-device store. Actions mutate the raw transaction lists; every
// balance/stock/receivable is re-derived by lib/select.ts on read, so one
// action updates the khata, stock, receivables, rokad, reminders and dashboard
// at once. State is persisted to localStorage, so it survives an app restart —
// this is the app's real datastore (no server needed for a single-till mill).

const STORAGE_KEY = 'aahar.state.v1'

type Action =
  | { type: 'addParty'; party: Party }
  | { type: 'updateParty'; party: Party }
  | { type: 'deleteParty'; id: string }
  | { type: 'addProduct'; product: Product }
  | { type: 'updateProduct'; product: Product }
  | { type: 'deleteProduct'; id: string }
  | { type: 'addSale'; sale: Sale }
  | { type: 'updateSale'; sale: Sale; reason?: string }
  | { type: 'deleteSale'; id: string; reason?: string }
  | { type: 'addPurchase'; purchase: Purchase }
  | { type: 'addPayment'; payment: Payment }
  | { type: 'updatePayment'; payment: Payment; oldAmount: number; reason?: string }
  | { type: 'deletePayment'; id: string; reason?: string }
  | { type: 'addExpense'; expense: Expense }
  | { type: 'updateExpense'; expense: Expense }
  | { type: 'deleteExpense'; id: string }
  | { type: 'setStatus'; saleId: string; status: Sale['status'] }
  | { type: 'updateBusiness'; business: Business }
  | { type: 'reset' }

function money(n: number): string {
  return '₹' + new Intl.NumberFormat('en-IN').format(Math.round(n))
}

function audit(state: AppState, entity: string, entityId: string, action: AuditEntry['action'], extra?: Partial<AuditEntry>): AuditEntry {
  return {
    id: 'au-' + Math.random().toString(36).slice(2, 8),
    at: TODAY + 'T' + new Date().toTimeString().slice(0, 8),
    userId: state.currentUserId,
    entity,
    entityId,
    action,
    ...extra,
  }
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'addParty':
      return { ...state, parties: [action.party, ...state.parties], audit: [audit(state, 'Party', action.party.id, 'create', { reason: `Added ${action.party.name}` }), ...state.audit] }
    case 'updateParty':
      return { ...state, parties: state.parties.map((p) => (p.id === action.party.id ? action.party : p)), audit: [audit(state, 'Party', action.party.id, 'edit', { reason: `Edited ${action.party.name}` }), ...state.audit] }
    case 'deleteParty': {
      const p = state.parties.find((x) => x.id === action.id)
      return { ...state, parties: state.parties.filter((x) => x.id !== action.id), audit: [audit(state, 'Party', action.id, 'delete', { reason: `Deleted ${p?.name ?? ''}` }), ...state.audit] }
    }
    case 'addProduct':
      return { ...state, products: [...state.products, action.product], audit: [audit(state, 'Product', action.product.id, 'create', { reason: `Added ${action.product.name}` }), ...state.audit] }
    case 'updateProduct':
      return { ...state, products: state.products.map((p) => (p.id === action.product.id ? action.product : p)), audit: [audit(state, 'Product', action.product.id, 'edit', { reason: `Edited ${action.product.name}` }), ...state.audit] }
    case 'deleteProduct': {
      const p = state.products.find((x) => x.id === action.id)
      return { ...state, products: state.products.filter((x) => x.id !== action.id), audit: [audit(state, 'Product', action.id, 'delete', { reason: `Deleted ${p?.name ?? ''}` }), ...state.audit] }
    }
    case 'addSale':
      return { ...state, sales: [action.sale, ...state.sales], audit: [audit(state, 'Sale', action.sale.id, 'create', { reason: `Created ${action.sale.no}` }), ...state.audit] }
    case 'updateSale':
      return { ...state, sales: state.sales.map((s) => (s.id === action.sale.id ? action.sale : s)), audit: [audit(state, 'Sale', action.sale.id, 'edit', { reason: action.reason ?? `Edited ${action.sale.no}` }), ...state.audit] }
    case 'deleteSale': {
      const s = state.sales.find((x) => x.id === action.id)
      return { ...state, sales: state.sales.filter((x) => x.id !== action.id), audit: [audit(state, 'Sale', action.id, 'delete', { reason: action.reason ?? `Deleted ${s?.no ?? ''}` }), ...state.audit] }
    }
    case 'addPurchase':
      return { ...state, purchases: [action.purchase, ...state.purchases], audit: [audit(state, 'Purchase', action.purchase.id, 'create', { reason: `Created ${action.purchase.no}` }), ...state.audit] }
    case 'addPayment':
      return { ...state, payments: [action.payment, ...state.payments], audit: [audit(state, 'Payment', action.payment.id, 'create', { reason: `Recorded ${money(action.payment.amount)}` }), ...state.audit] }
    case 'updatePayment':
      return { ...state, payments: state.payments.map((p) => (p.id === action.payment.id ? action.payment : p)), audit: [audit(state, 'Payment', action.payment.id, 'edit', { field: 'amount', oldValue: money(action.oldAmount), newValue: money(action.payment.amount), reason: action.reason }), ...state.audit] }
    case 'deletePayment': {
      const p = state.payments.find((x) => x.id === action.id)
      return { ...state, payments: state.payments.filter((x) => x.id !== action.id), audit: [audit(state, 'Payment', action.id, 'delete', { reason: action.reason ?? `Deleted payment ${p ? money(p.amount) : ''}` }), ...state.audit] }
    }
    case 'addExpense':
      return { ...state, expenses: [action.expense, ...state.expenses], audit: [audit(state, 'Expense', action.expense.id, 'create', { reason: `${action.expense.category} ${money(action.expense.amount)}` }), ...state.audit] }
    case 'updateExpense':
      return { ...state, expenses: state.expenses.map((e) => (e.id === action.expense.id ? action.expense : e)), audit: [audit(state, 'Expense', action.expense.id, 'edit', { reason: `Edited ${action.expense.category}` }), ...state.audit] }
    case 'deleteExpense':
      return { ...state, expenses: state.expenses.filter((e) => e.id !== action.id), audit: [audit(state, 'Expense', action.id, 'delete', { reason: 'Deleted expense' }), ...state.audit] }
    case 'setStatus':
      return { ...state, sales: state.sales.map((s) => (s.id === action.saleId ? { ...s, status: action.status } : s)) }
    case 'updateBusiness':
      return { ...state, business: action.business }
    case 'reset':
      return structuredClone(seed)
    default:
      return state
  }
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as AppState
  } catch {
    /* corrupt or unavailable storage — fall back to seed */
  }
  return structuredClone(seed)
}

interface Store {
  state: AppState
  dispatch: React.Dispatch<Action>
}

const StoreCtx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage full or blocked — keep running from memory */
    }
  }, [state])

  return createElement(StoreCtx.Provider, { value: { state, dispatch } }, children)
}

export function useStore(): Store {
  const s = useContext(StoreCtx)
  if (!s) throw new Error('useStore must be used inside <StoreProvider>')
  return s
}

export function newId(prefix: string): string {
  return prefix + '-' + Math.random().toString(36).slice(2, 8)
}

export function nextInvoiceNo(state: AppState): string {
  return nextNo(state.sales.map((s) => s.no), 'INV', 1000)
}
export function nextPurchaseNo(state: AppState): string {
  return nextNo(state.purchases.map((p) => p.no), 'PUR', 500)
}
function nextNo(existing: string[], prefix: string, base: number): string {
  const nums = existing.map((n) => Number(n.replace(/\D/g, ''))).filter((n) => !Number.isNaN(n))
  return `${prefix}-${(nums.length ? Math.max(...nums) : base) + 1}`
}
