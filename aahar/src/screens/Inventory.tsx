import { useState } from 'react'
import { useStore } from '@/lib/data/store'
import { stockRows } from '@/lib/select'
import type { ProductType } from '@/lib/types'
import { money, moneyShort, num } from '@/lib/money'
import { Card, PageHeader, Segmented, Badge, Stat } from '@/components/ui'
import { Icon } from '@/components/icons'
import { cn } from '@/lib/cn'

export function Inventory() {
  const { state } = useStore()
  const [tab, setTab] = useState<ProductType>('finished')
  const rows = stockRows(state, tab)
  const allValue = stockRows(state).reduce((s, r) => s + r.valuation, 0)
  const lowCount = stockRows(state).filter((r) => r.low).length
  const fgBags = stockRows(state, 'finished').reduce((s, r) => s + r.onHand, 0)

  return (
    <div>
      <PageHeader title="Inventory" hindi="स्टॉक" sub="Live stock — moves the moment a sale or batch is saved." />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="Stock value" value={moneyShort(allValue)} sub="RM + FG" tone="green" icon="inventory" />
        <Stat label="Finished bags" value={num(fgBags)} sub="ready to sell" tone="blue" icon="box" />
        <Stat label="Low stock" value={lowCount} sub="need reorder" tone={lowCount ? 'amber' : 'gray'} icon="warn" />
      </div>

      <div className="mb-4 sm:w-72">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'finished', label: 'Finished goods' },
            { value: 'raw', label: 'Raw material' },
          ]}
        />
      </div>

      <Card className="divide-y divide-line">
        {rows.map((r) => (
          <div key={r.product.id} className="px-4 py-3.5">
            <div className="flex items-center gap-3">
              <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg', r.low ? 'bg-amber-50 text-amber-600' : 'bg-brand-50 text-brand-600')}>
                {r.product.type === 'finished' ? <Icon.box className="h-5 w-5" /> : <Icon.inventory className="h-5 w-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-ink-900">{r.product.name}</span>
                  {r.low && <Badge tone="amber">Low</Badge>}
                </div>
                <div className="hi text-xs text-ink-400">{r.product.hindi} · {r.product.unit === 'bag' ? `${r.product.packKg}kg bag` : 'per kg'}</div>
              </div>
              <div className="text-right">
                <div className={cn('text-lg font-bold tabular', r.low ? 'text-amber-700' : 'text-ink-900')}>{num(r.onHand)} <span className="text-xs font-medium text-ink-400">{r.product.unit}</span></div>
                <div className="text-xs text-ink-400">{money(r.valuation)}</div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs">
              <div className="rounded-lg bg-canvas py-1.5"><div className="font-bold tabular text-ink-700">{num(r.opening)}</div><div className="text-ink-400">opening</div></div>
              <div className="rounded-lg bg-canvas py-1.5"><div className="font-bold tabular text-brand-600">+{num(r.inQty)}</div><div className="text-ink-400">{r.product.type === 'finished' ? 'produced' : 'purchased'}</div></div>
              <div className="rounded-lg bg-canvas py-1.5"><div className="font-bold tabular text-rose-600">−{num(r.outQty)}</div><div className="text-ink-400">{r.product.type === 'finished' ? 'sold' : 'consumed'}</div></div>
              <div className="rounded-lg bg-canvas py-1.5"><div className="font-bold tabular text-ink-900">{num(r.onHand)}</div><div className="text-ink-400">on hand</div></div>
            </div>
            {r.low && (
              <div className="mt-2 text-xs font-semibold text-amber-700">Below reorder level of {num(r.product.reorderLevel)} {r.product.unit} — arrange stock.</div>
            )}
          </div>
        ))}
      </Card>
    </div>
  )
}
