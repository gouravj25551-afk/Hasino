import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { saleTotal, dueDate, byId } from '@/lib/select'
import { money, moneyExact } from '@/lib/money'
import { fmtFull } from '@/lib/date'
import { Icon } from '@/components/icons'

function inWords(n: number): string {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const two = (x: number): string => (x < 20 ? a[x] : `${b[Math.floor(x / 10)]}${x % 10 ? ' ' + a[x % 10] : ''}`)
  const three = (x: number): string => (x >= 100 ? `${a[Math.floor(x / 100)]} Hundred${x % 100 ? ' ' + two(x % 100) : ''}` : two(x))
  n = Math.round(n)
  if (n === 0) return 'Zero'
  const cr = Math.floor(n / 1e7); n %= 1e7
  const lk = Math.floor(n / 1e5); n %= 1e5
  const th = Math.floor(n / 1e3); n %= 1e3
  const parts = [cr && `${three(cr)} Crore`, lk && `${three(lk)} Lakh`, th && `${three(th)} Thousand`, n && three(n)].filter(Boolean)
  return parts.join(' ')
}

export function Parchi() {
  const { id } = useParams()
  const { state } = useStore()
  const nav = useNavigate()
  const sale = state.sales.find((s) => s.id === id)
  if (!sale) return <div className="p-8 text-center text-ink-500">Parchi not found. <button className="text-brand-600" onClick={() => nav('/sales')}>Back to sales</button></div>

  const party = byId(state.parties, sale.partyId)!
  const b = state.business
  const total = saleTotal(sale)
  const bags = sale.lines.reduce((s, l) => s + l.qty, 0)
  const needsEway = total >= 50000

  return (
    <div className="min-h-full bg-canvas py-6">
      {/* Action bar */}
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center gap-2 px-4">
        <button onClick={() => nav(-1)} className="inline-flex items-center gap-1 text-sm font-semibold text-ink-500 hover:text-ink-700"><Icon.back className="h-4 w-4" /> Back</button>
        <div className="ml-auto flex gap-2">
          <a href={`https://wa.me/${party.phone.replace(/\D/g, '')}?text=${encodeURIComponent(`Namaste ${party.name}, parchi ${sale.no} for ${money(total)} (${bags} bags). Due ${fmtFull(dueDate(sale))}. — ${b.name}`)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-bold text-white"><Icon.whatsapp className="h-4 w-4" /> Send digital</a>
          <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-bold text-ink-900"><Icon.print className="h-4 w-4" /> Print</button>
        </div>
      </div>

      {/* The sheet */}
      <div className="print-sheet mx-auto max-w-3xl bg-white px-8 py-8 shadow-sm ring-1 ring-line" style={{ minHeight: '60vh' }}>
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-brand-600 text-white"><Icon.production className="h-6 w-6" /></span>
            <div>
              <div className="text-xl font-extrabold text-ink-900">{b.name}</div>
              <div className="hi text-sm text-ink-500">{b.hindi}</div>
              <div className="text-xs text-ink-500">{b.address}, {b.city}, {b.state}</div>
              <div className="text-xs text-ink-500">GSTIN {b.gstin} · {b.phone}</div>
            </div>
          </div>
          <div className="text-right">
            <div className="inline-block rounded-md bg-ink-900 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">Tax Invoice / Parchi</div>
            <div className="mt-2 text-sm"><span className="text-ink-400">No: </span><span className="font-bold text-ink-900">{sale.no}</span></div>
            <div className="text-sm"><span className="text-ink-400">Date: </span><span className="font-semibold text-ink-900">{fmtFull(sale.date)}</span></div>
          </div>
        </div>

        {/* Parties */}
        <div className="grid grid-cols-2 gap-6 py-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-ink-400">Bill to</div>
            <div className="mt-1 text-base font-bold text-ink-900">{party.name}</div>
            <div className="text-sm text-ink-500">{party.city}</div>
            <div className="text-sm text-ink-500">{party.phone}</div>
            {party.gstin && <div className="text-sm text-ink-500">GSTIN {party.gstin}</div>}
          </div>
          <div className="text-sm">
            <div className="text-xs font-bold uppercase tracking-wide text-ink-400">Transport</div>
            <Line k="Vehicle" v={sale.vehicle ?? '—'} />
            <Line k="Driver" v={sale.driver ?? '—'} />
            <Line k="Payment terms" v={`${sale.creditDays} days credit`} />
            <Line k="Due date" v={fmtFull(dueDate(sale))} />
          </div>
        </div>

        {/* Items */}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-ink-900 text-left">
              <th className="py-2 font-bold text-ink-900">#</th>
              <th className="py-2 font-bold text-ink-900">Item</th>
              <th className="py-2 text-center font-bold text-ink-900">HSN</th>
              <th className="py-2 text-right font-bold text-ink-900">Qty</th>
              <th className="py-2 text-right font-bold text-ink-900">Rate</th>
              <th className="py-2 text-right font-bold text-ink-900">Amount</th>
            </tr>
          </thead>
          <tbody>
            {sale.lines.map((l, i) => {
              const p = byId(state.products, l.productId)
              return (
                <tr key={i} className="border-b border-line">
                  <td className="py-2.5 text-ink-500">{i + 1}</td>
                  <td className="py-2.5">
                    <div className="font-semibold text-ink-900">{p?.name}</div>
                    <div className="hi text-xs text-ink-400">{p?.hindi} · {p?.packKg}kg bag</div>
                  </td>
                  <td className="py-2.5 text-center text-ink-500">{p?.hsn ?? '—'}</td>
                  <td className="py-2.5 text-right tabular text-ink-900">{l.qty} {l.unit}</td>
                  <td className="py-2.5 text-right tabular text-ink-900">{money(l.rate)}</td>
                  <td className="py-2.5 text-right tabular font-semibold text-ink-900">{money(l.qty * l.rate)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* Totals */}
        <div className="mt-4 flex justify-end">
          <div className="w-full max-w-xs space-y-1.5 text-sm">
            <Row k={`Total (${bags} bags)`} v={money(total)} />
            {sale.paidNow > 0 && <Row k="Paid now" v={`− ${money(sale.paidNow)}`} />}
            <div className="flex justify-between border-t-2 border-ink-900 pt-2 text-base font-extrabold text-ink-900">
              <span>Balance due</span><span className="tabular">{moneyExact(total - sale.paidNow)}</span>
            </div>
          </div>
        </div>
        <div className="mt-2 text-sm text-ink-500"><span className="font-semibold text-ink-700">In words:</span> Rupees {inWords(total - sale.paidNow)} only.</div>

        {needsEway && (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="font-bold">e-Way bill required:</span> consignment value ≥ ₹50,000. Generate the e-way bill before the goods move.
          </div>
        )}

        {sale.note && <div className="mt-3 text-sm text-ink-500"><span className="font-semibold text-ink-700">Note:</span> {sale.note}</div>}

        {/* Footer */}
        <div className="mt-8 flex items-end justify-between">
          <div className="text-xs text-ink-400">
            <div>Goods once sold will not be taken back unless agreed.</div>
            <div>This is a digital parchi generated by Aahar · {b.name}.</div>
          </div>
          <div className="text-center">
            <div className="h-12 w-40 border-b border-ink-900" />
            <div className="mt-1 text-xs font-semibold text-ink-500">Authorised signatory</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Line({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><span className="text-ink-400">{k}</span><span className="font-semibold text-ink-900">{v}</span></div>
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><span className="text-ink-500">{k}</span><span className="tabular font-semibold text-ink-900">{v}</span></div>
}
