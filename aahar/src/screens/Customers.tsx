import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { outstanding } from '@/lib/select'
import type { PartyKind } from '@/lib/types'
import { money } from '@/lib/money'
import { Card, PageHeader, SearchBox, Segmented, Avatar, Empty } from '@/components/ui'
import { Icon } from '@/components/icons'

export function Customers() {
  const { state } = useStore()
  const nav = useNavigate()
  const [kind, setKind] = useState<PartyKind>('customer')
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    return state.parties
      .filter((p) => p.kind === kind)
      .map((p) => ({ p, bal: outstanding(state, p.id) }))
      .filter(({ p }) => (p.name + p.city + p.phone).toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => b.bal - a.bal)
  }, [state, kind, q])

  const totalOut = rows.reduce((s, r) => s + Math.max(0, r.bal), 0)

  return (
    <div>
      <PageHeader
        title="Khata"
        hindi="खाता"
        sub={`${rows.length} ${kind === 'customer' ? 'customers' : 'suppliers'} · ${kind === 'customer' ? 'to collect' : 'to pay'} ${money(totalOut)}`}
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="sm:w-52">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'customer', label: 'Customers' },
              { value: 'supplier', label: 'Suppliers' },
            ]}
          />
        </div>
        <div className="flex-1">
          <SearchBox value={q} onChange={setQ} placeholder="Search name, city, phone…" />
        </div>
      </div>

      <Card className="divide-y divide-line">
        {rows.length === 0 ? (
          <Empty icon="khata" title="No accounts found" sub="Try a different search or add a new party." />
        ) : (
          rows.map(({ p, bal }) => (
            <button key={p.id} onClick={() => nav('/customers/' + p.id)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-canvas">
              <Avatar name={p.name} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-ink-900">{p.name}</div>
                <div className="text-xs text-ink-400">{p.city} · {p.phone}</div>
              </div>
              <div className="text-right">
                <div className={`font-bold tabular ${bal > 0 ? 'text-rose-600' : bal < 0 ? 'text-brand-600' : 'text-ink-400'}`}>{money(Math.abs(bal))}</div>
                <div className="text-[11px] font-semibold text-ink-400">
                  {bal > 0 ? (kind === 'customer' ? 'to collect' : 'to pay') : bal < 0 ? 'advance' : 'settled'}
                </div>
              </div>
              <Icon.chevron className="h-5 w-5 text-ink-400" />
            </button>
          ))
        )}
      </Card>

      {kind === 'customer' && (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-700">
          <Icon.whatsapp className="h-5 w-5 shrink-0" />
          Tap any customer to open their digital khata, record a payment, or share the statement on WhatsApp.
        </div>
      )}
    </div>
  )
}
