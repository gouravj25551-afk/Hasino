import { createContext, useContext, useReducer, type ReactNode, createElement } from 'react'
import type { AppState, Sale, Payment, Expense, AuditEntry } from '@/lib/types'
import { seed } from '@/lib/data/seed'
import { TODAY } from '@/lib/date'

// A single in-memory store. Actions mutate the raw transaction lists only —
// every balance/stock/receivable is re-derived by lib/select.ts on read, so one
// action (e.g. addSale) updates the khata, stock, receivables, rokad, reminders
// and dashboard at once. This mirrors the real backend shape the report defines.

type Action =
  | { type: 'addSale'; sale: Sale }
  | { type: 'addPayment'; payment: Payment }
  | { type: 'addExpense'; expense: Expense }
  | { type: 'setStatus'; saleId: string; status: Sale['status'] }
  | { type: 'audit'; entry: AuditEntry }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'addSale':
      return {
        ...state,
        sales: [action.sale, ...state.sales],
        audit: [audit(state, 'Sale', action.sale.id, `Created ${action.sale.no}`), ...state.audit],
      }
    case 'addPayment':
      return {
        ...state,
        payments: [action.payment, ...state.payments],
        audit: [audit(state, 'Payment', action.payment.id, `Recorded ${money(action.payment.amount)}`), ...state.audit],
      }
    case 'addExpense':
      return {
        ...state,
        expenses: [action.expense, ...state.expenses],
        audit: [audit(state, 'Expense', action.expense.id, `${action.expense.category} ${money(action.expense.amount)}`), ...state.audit],
      }
    case 'setStatus':
      return {
        ...state,
        sales: state.sales.map((s) => (s.id === action.saleId ? { ...s, status: action.status } : s)),
      }
    case 'audit':
      return { ...state, audit: [action.entry, ...state.audit] }
    default:
      return state
  }
}

function money(n: number): string {
  return '₹' + new Intl.NumberFormat('en-IN').format(Math.round(n))
}

function audit(state: AppState, entity: string, entityId: string, reason: string): AuditEntry {
  return {
    id: 'au-' + Math.random().toString(36).slice(2, 8),
    at: TODAY + 'T' + new Date().toTimeString().slice(0, 8),
    userId: state.currentUserId,
    entity,
    entityId,
    action: 'create',
    reason,
  }
}

interface Store {
  state: AppState
  dispatch: React.Dispatch<Action>
}

const StoreCtx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, seed)
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
  const nums = state.sales.map((s) => Number(s.no.replace(/\D/g, ''))).filter((n) => !Number.isNaN(n))
  const next = (nums.length ? Math.max(...nums) : 1000) + 1
  return `INV-${next}`
}
