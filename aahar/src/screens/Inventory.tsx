import { useState } from 'react'
import { useStore } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import { stockRows } from '@/lib/select'
import type { ProductType, Product } from '@/lib/types'
import { money, moneyShort, num } from '@/lib/money'
import { Card, PageHeader, Segmented, Badge, Stat, Button } from '@/components/ui'
import { Icon } from '@/components/icons'
import { cn } from '@/lib/cn'
import { pname } from '@/lib/labels'
import { ProductForm } from '@/components/ProductForm'

export function Inventory() {
  const { state, dispatch } = useStore()
  const { t, lang } = useLang()
  const [tab, setTab] = useState<ProductType>('finished')
  const [addOpen, setAddOpen] = useState(false)
  const [edit, setEdit] = useState<Product | null>(null)

  const rows = stockRows(state, tab)
  const allValue = stockRows(state).reduce((s, r) => s + r.valuation, 0)
  const lowCount = stockRows(state).filter((r) => r.low).length
  const fgBags = stockRows(state, 'finished').reduce((s, r) => s + r.onHand, 0)

  function remove(p: Product) { if (confirm(t('inv.deleteConfirm'))) dispatch({ type: 'deleteProduct', id: p.id }) }

  return (
    <div>
      <PageHeader title={t('inv.title')} sub={t('inv.sub')}
        action={<Button className="hidden sm:inline-flex" onClick={() => setAddOpen(true)}><Icon.plus className="h-5 w-5" /> {t('inv.addProduct')}</Button>} />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label={t('inv.stockValue')} value={moneyShort(allValue)} tone="green" icon="inventory" />
        <Stat label={t('inv.finishedBags')} value={num(fgBags)} tone="blue" icon="box" />
        <Stat label={t('inv.lowStock')} value={lowCount} tone={lowCount ? 'amber' : 'gray'} icon="warn" />
      </div>

      <div className="mb-4 sm:w-72">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'finished', label: t('inv.finishedGoods') }, { value: 'raw', label: t('inv.rawMaterial') }]} />
      </div>

      <Card className="divide-y divide-line">
        {rows.map((r) => (
          <div key={r.product.id} className="px-4 py-3.5">
            <div className="flex items-center gap-3">
              <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg', r.low ? 'bg-amber-50 text-amber-600' : 'bg-brand-50 text-brand-600')}>
                {r.product.type === 'finished' ? <Icon.box className="h-5 w-5" /> : <Icon.inventory className="h-5 w-5" />}
              </span>
              <button onClick={() => setEdit(r.product)} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-ink-900">{pname(r.product, lang)}</span>
                  {r.low && <Badge tone="amber">{t('inv.low')}</Badge>}
                </div>
                <div className="text-xs text-ink-400">{r.product.unit === 'bag' ? t('inv.bagOf', { n: r.product.packKg }) : t('inv.perKg')}</div>
              </button>
              <div className="text-right">
                <div className={cn('text-lg font-bold tabular', r.low ? 'text-amber-700' : 'text-ink-900')}>{num(r.onHand)} <span className="text-xs font-medium text-ink-400">{r.product.unit === 'bag' ? t('common.bags') : t('common.kg')}</span></div>
                <div className="text-xs text-ink-400">{money(r.valuation)}</div>
              </div>
              <button onClick={() => remove(r.product)} className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-rose-50 hover:text-rose-500" aria-label={t('common.delete')}><Icon.close className="h-4 w-4" /></button>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs">
              <div className="rounded-lg bg-canvas py-1.5"><div className="font-bold tabular text-ink-700">{num(r.opening)}</div><div className="text-ink-400">{t('inv.opening')}</div></div>
              <div className="rounded-lg bg-canvas py-1.5"><div className="font-bold tabular text-brand-600">+{num(r.inQty)}</div><div className="text-ink-400">{r.product.type === 'finished' ? t('inv.produced') : t('inv.purchased')}</div></div>
              <div className="rounded-lg bg-canvas py-1.5"><div className="font-bold tabular text-rose-600">−{num(r.outQty)}</div><div className="text-ink-400">{r.product.type === 'finished' ? t('inv.sold') : t('inv.consumed')}</div></div>
              <div className="rounded-lg bg-canvas py-1.5"><div className="font-bold tabular text-ink-900">{num(r.onHand)}</div><div className="text-ink-400">{t('inv.onHand')}</div></div>
            </div>
            {r.low && <div className="mt-2 text-xs font-semibold text-amber-700">{t('inv.belowReorder', { n: num(r.product.reorderLevel) })}</div>}
          </div>
        ))}
      </Card>

      <div className="no-print fixed bottom-24 right-4 z-30 sm:hidden">
        <button onClick={() => setAddOpen(true)} className="grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-lg"><Icon.plus className="h-6 w-6" /></button>
      </div>

      {addOpen && <ProductForm open={addOpen} onClose={() => setAddOpen(false)} defaultType={tab} />}
      {edit && <ProductForm open={!!edit} onClose={() => setEdit(null)} existing={edit} defaultType={edit.type} />}
    </div>
  )
}
