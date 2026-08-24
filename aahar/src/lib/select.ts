// Pure derivations over AppState. Nothing here mutates; every balance, stock
// level, receivable, cash figure and dashboard number is COMPUTED from the raw
// transactions in state. This is the "single source of truth" the report calls
// for — screens never store a balance, they ask for it here.

import type {
  AppState,
  ID,
  LedgerRow,
  Party,
  Product,
  Receivable,
  ReceivableStatus,
  Sale,
  StockRow,
} from '@/lib/types'
import { TODAY, addDays, daysBetween } from '@/lib/date'

export function lineTotal(lines: { qty: number; rate: number }[]): number {
  return lines.reduce((s, l) => s + l.qty * l.rate, 0)
}

export const saleTotal = (s: Sale): number => lineTotal(s.lines)
export const dueDate = (s: Sale): string => addDays(s.date, s.creditDays)

export function byId<T extends { id: ID }>(list: T[], id: ID): T | undefined {
  return list.find((x) => x.id === id)
}

export function partyName(state: AppState, id: ID): string {
  return byId(state.parties, id)?.name ?? 'Unknown'
}
export function productName(state: AppState, id: ID): string {
  return byId(state.products, id)?.name ?? 'Unknown'
}
export function userName(state: AppState, id: ID): string {
  return byId(state.users, id)?.name ?? 'Unknown'
}

// ---------------------------------------------------------------- Party ledger

/**
 * A running-balance ledger for one party. Debit raises what a customer owes us
 * (a sale); credit lowers it (a payment in). For a supplier the sign convention
 * is the same on the "we owe" axis: a purchase is a debit against us, a payment
 * out is a credit.
 */
export function partyLedger(state: AppState, partyId: ID): { rows: LedgerRow[]; balance: number } {
  const party = byId(state.parties, partyId)
  if (!party) return { rows: [], balance: 0 }

  type Raw = { date: string; kind: string; particulars: string; ref?: string; debit: number; credit: number; sort: number }
  const raw: Raw[] = []

  raw.push({ date: party.since, kind: 'Opening', particulars: 'Opening balance', debit: party.openingBalance, credit: 0, sort: 0 })

  for (const s of state.sales.filter((x) => x.partyId === partyId)) {
    raw.push({ date: s.date, kind: 'Sale', particulars: describeSale(state, s), ref: s.no, debit: saleTotal(s), credit: 0, sort: 1 })
    if (s.paidNow > 0) raw.push({ date: s.date, kind: 'Payment', particulars: `Paid at sale (${s.paidMode ?? 'cash'})`, ref: s.no, debit: 0, credit: s.paidNow, sort: 2 })
  }
  for (const p of state.purchases.filter((x) => x.partyId === partyId)) {
    raw.push({ date: p.date, kind: 'Purchase', particulars: `Purchase ${p.no}`, ref: p.no, debit: lineTotal(p.lines), credit: 0, sort: 1 })
    if (p.paidNow > 0) raw.push({ date: p.date, kind: 'Payment', particulars: `Paid on purchase (${p.paidMode ?? 'cash'})`, ref: p.no, debit: 0, credit: p.paidNow, sort: 2 })
  }
  for (const pm of state.payments.filter((x) => x.partyId === partyId)) {
    const label = pm.direction === 'in' ? 'Payment received' : 'Payment made'
    raw.push({ date: pm.date, kind: 'Payment', particulars: `${label} (${pm.mode})`, ref: pm.ref, debit: 0, credit: pm.amount, sort: 3 })
  }

  raw.sort((a, b) => (a.date === b.date ? a.sort - b.sort : a.date < b.date ? -1 : 1))

  let bal = 0
  const rows: LedgerRow[] = raw.map((r) => {
    bal += r.debit - r.credit
    return { date: r.date, kind: r.kind, particulars: r.particulars, ref: r.ref, debit: r.debit, credit: r.credit, balance: bal }
  })
  return { rows, balance: bal }
}

export function outstanding(state: AppState, partyId: ID): number {
  return partyLedger(state, partyId).balance
}

function describeSale(state: AppState, s: Sale): string {
  const first = s.lines[0]
  const name = first ? productName(state, first.productId) : 'Goods'
  const extra = s.lines.length > 1 ? ` +${s.lines.length - 1}` : ''
  return `${name}${extra}`
}

// ------------------------------------------------------------- Receivables

function statusFor(outstandingAmt: number, gross: number, days: number): ReceivableStatus {
  if (outstandingAmt <= 0.5) return 'paid'
  // Time wins over "partial": a part-paid invoice that is due/overdue is still
  // due/overdue on its balance. 'partial' only describes a part-paid invoice
  // that has not yet reached its due date.
  if (days < 0) return 'overdue'
  if (days === 0) return 'dueToday'
  if (days === 1) return 'dueTomorrow'
  if (outstandingAmt < gross - 0.5) return 'partial'
  return 'upcoming'
}

/**
 * Allocates each party's stand-alone payments FIFO against their open sales
 * (oldest first, after clearing any opening balance). Produces one receivable
 * per sale with its own due date and status.
 */
export function receivables(state: AppState): Receivable[] {
  const out: Receivable[] = []
  for (const party of state.parties.filter((p) => p.kind === 'customer')) {
    let pool =
      state.payments.filter((p) => p.partyId === party.id && p.direction === 'in').reduce((s, p) => s + p.amount, 0)
    // Opening balance is the oldest debt — payments clear it first.
    pool = Math.max(0, pool - Math.max(0, party.openingBalance))

    const sales = state.sales.filter((s) => s.partyId === party.id).sort((a, b) => (a.date < b.date ? -1 : 1))
    for (const sale of sales) {
      const gross = saleTotal(sale)
      let remaining = gross - sale.paidNow
      const applied = Math.min(pool, remaining)
      remaining -= applied
      pool -= applied
      const due = dueDate(sale)
      const days = daysBetween(TODAY, due)
      out.push({
        sale,
        party,
        gross,
        paid: gross - remaining,
        outstanding: Math.max(0, remaining),
        dueDate: due,
        daysToDue: days,
        status: statusFor(remaining, gross, days),
      })
    }
  }
  return out
}

export function openReceivables(state: AppState): Receivable[] {
  return receivables(state).filter((r) => r.outstanding > 0.5)
}

// ------------------------------------------------------------------- Stock

export function stockRows(state: AppState, type?: Product['type']): StockRow[] {
  const products = state.products.filter((p) => (type ? p.type === type : true))
  return products.map((product) => {
    let inQty = product.openingStock
    let outQty = 0

    if (product.type === 'finished') {
      for (const b of state.batches.filter((x) => x.productId === product.id)) inQty += b.outputBags
      for (const s of state.sales) for (const l of s.lines.filter((x) => x.productId === product.id)) outQty += toUnit(l.qty, l.unit, product)
    } else {
      for (const p of state.purchases) for (const l of p.lines.filter((x) => x.productId === product.id)) inQty += toUnit(l.qty, l.unit, product)
      for (const b of state.batches) for (const c of b.consumption.filter((x) => x.productId === product.id)) outQty += c.kg
    }

    const onHand = inQty - outQty
    return {
      product,
      opening: product.openingStock,
      inQty: inQty - product.openingStock,
      outQty,
      onHand,
      valuation: onHand * unitCost(product),
      low: onHand <= product.reorderLevel,
    }
  })
}

/** Convert a quantity expressed in some unit into the product's own stock unit. */
function toUnit(qty: number, unit: string, product: Product): number {
  if (unit === product.unit) return qty
  const kg = unit === 'ton' ? qty * 1000 : unit === 'bag' ? qty * product.packKg : qty
  if (product.unit === 'kg') return kg
  if (product.unit === 'bag') return kg / product.packKg
  return kg / 1000
}

function unitCost(product: Product): number {
  // Finished goods are valued at ~78% of list (a rough factory cost); raw at rate.
  return product.type === 'finished' ? product.rate * 0.78 : product.rate
}

// -------------------------------------------------------------- Daily rokad

export interface RokadDay {
  date: string
  openingCash: number
  cashIn: number
  cashOut: number
  closingCash: number
  byMode: Record<string, number>
}

/** Cash movements only (mode === 'cash'); other modes reported separately. */
export function rokad(state: AppState, date: string): RokadDay {
  const cashInSales = state.sales.filter((s) => s.date === date && s.paidMode === 'cash').reduce((a, s) => a + s.paidNow, 0)
  const cashInPay = state.payments.filter((p) => p.date === date && p.direction === 'in' && p.mode === 'cash').reduce((a, p) => a + p.amount, 0)
  const cashOutPay = state.payments.filter((p) => p.date === date && p.direction === 'out' && p.mode === 'cash').reduce((a, p) => a + p.amount, 0)
  const cashOutExp = state.expenses.filter((e) => e.date === date && e.mode === 'cash').reduce((a, e) => a + e.amount, 0)

  const cashIn = cashInSales + cashInPay
  const cashOut = cashOutPay + cashOutExp

  // Opening = accumulated cash before `date`. A real system carries the prior
  // close; here we sum everything strictly earlier for a stable demo figure.
  const opening = accumulatedCash(state, date)

  const byMode: Record<string, number> = {}
  for (const m of ['cash', 'upi', 'bank', 'cheque', 'other']) byMode[m] = 0
  for (const p of state.payments.filter((p) => p.date === date && p.direction === 'in')) byMode[p.mode] += p.amount
  for (const s of state.sales.filter((s) => s.date === date && s.paidNow > 0)) byMode[s.paidMode ?? 'cash'] += s.paidNow

  return { date, openingCash: opening, cashIn, cashOut, closingCash: opening + cashIn - cashOut, byMode }
}

function accumulatedCash(state: AppState, before: string): number {
  let bal = 50000 // opening float in the drawer at go-live
  const earlier = (d: string) => d < before
  for (const s of state.sales) if (earlier(s.date) && s.paidMode === 'cash') bal += s.paidNow
  for (const p of state.payments) if (earlier(p.date) && p.mode === 'cash') bal += p.direction === 'in' ? p.amount : -p.amount
  for (const e of state.expenses) if (earlier(e.date) && e.mode === 'cash') bal -= e.amount
  return bal
}

// --------------------------------------------------------------- Dashboard

export interface Dashboard {
  todaySales: number
  todayCollections: number
  todayExpenses: number
  todayDispatches: number
  cashInHand: number
  totalReceivable: number
  overdue: number
  dueToday: number
  totalPayable: number
  monthSales: number
  lowStock: number
  pendingDispatch: number
  finishedBags: number
}

export function dashboard(state: AppState): Dashboard {
  const recs = receivables(state)
  const totalReceivable = state.parties
    .filter((p) => p.kind === 'customer')
    .reduce((a, p) => a + Math.max(0, outstanding(state, p.id)), 0)
  const totalPayable = state.parties
    .filter((p) => p.kind === 'supplier')
    .reduce((a, p) => a + Math.max(0, outstanding(state, p.id)), 0)

  const todaySales =
    state.sales.filter((s) => s.date === TODAY).reduce((a, s) => a + saleTotal(s), 0)
  const todayCollections =
    state.payments.filter((p) => p.date === TODAY && p.direction === 'in').reduce((a, p) => a + p.amount, 0) +
    state.sales.filter((s) => s.date === TODAY).reduce((a, s) => a + s.paidNow, 0)
  const todayExpenses = state.expenses.filter((e) => e.date === TODAY).reduce((a, e) => a + e.amount, 0)

  const month = TODAY.slice(0, 7)
  const monthSales = state.sales.filter((s) => s.date.startsWith(month)).reduce((a, s) => a + saleTotal(s), 0)

  const finished = stockRows(state, 'finished')
  const raw = stockRows(state, 'raw')

  return {
    todaySales,
    todayCollections,
    todayExpenses,
    todayDispatches: state.sales.filter((s) => s.date === TODAY && s.status !== 'pending').length,
    cashInHand: rokad(state, TODAY).closingCash,
    totalReceivable,
    overdue: recs.filter((r) => r.status === 'overdue').reduce((a, r) => a + r.outstanding, 0),
    dueToday: recs.filter((r) => r.status === 'dueToday').reduce((a, r) => a + r.outstanding, 0),
    totalPayable,
    monthSales,
    lowStock: [...finished, ...raw].filter((s) => s.low).length,
    pendingDispatch: state.sales.filter((s) => s.status === 'pending').length,
    finishedBags: finished.reduce((a, s) => a + s.onHand, 0),
  }
}

// ------------------------------------------------------------------ Ageing

export interface Ageing {
  party: Party
  total: number
  current: number
  d1_30: number
  d31_60: number
  d60plus: number
}

export function ageing(state: AppState): Ageing[] {
  const groups = new Map<ID, Ageing>()
  for (const r of openReceivables(state)) {
    let g = groups.get(r.party.id)
    if (!g) {
      g = { party: r.party, total: 0, current: 0, d1_30: 0, d31_60: 0, d60plus: 0 }
      groups.set(r.party.id, g)
    }
    g.total += r.outstanding
    const overdueDays = -r.daysToDue
    if (overdueDays <= 0) g.current += r.outstanding
    else if (overdueDays <= 30) g.d1_30 += r.outstanding
    else if (overdueDays <= 60) g.d31_60 += r.outstanding
    else g.d60plus += r.outstanding
  }
  return [...groups.values()].sort((a, b) => b.total - a.total)
}
