import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import { saleTotal, partyName, dueDate, receivables } from '@/lib/select'
import { money } from '@/lib/money'
import { fmtFull } from '@/lib/date'
import { Card, PageHeader, SearchBox, Button, Badge, Empty } from '@/components/ui'
import { Icon } from '@/components/icons'
import { statusKey, receivableTone, saleStatusKey } from '@/lib/labels'

const statusTone = { pending: 'gray', dispatched: 'blue', delivered: 'green' } as const

export function Sales() {
  const { state, dispatch } = useStore()
  const { t } = useLang()
  const nav = useNavigate()
  const [q, setQ] = useState('')

  const recIndex = useMemo(() => {
    const m = new Map<string, ReturnType<typeof receivables>[number]>()
    for (const r of receivables(state)) m.set(r.sale.id, r)
    return m
  }, [state])

  const sales = state.sales
    .filter((s) => (s.no + partyName(state, s.partyId)).toLowerCase().includes(q.toLowerCase()))
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const total = sales.reduce((s, x) => s + saleTotal(x), 0)

  function remove(id: string) {
    if (confirm(t('sales.deleteConfirm'))) dispatch({ type: 'deleteSale', id })
  }

  return (
    <div>
      <PageHeader title={t('sales.title')} sub={t('sales.count', { n: sales.length, amt: money(total) })}
        action={<Button className="hidden sm:inline-flex" onClick={() => nav('/sales/new')}><Icon.plus className="h-5 w-5" /> {t('nav.newSale')}</Button>} />

      <div className="mb-4"><SearchBox value={q} onChange={setQ} placeholder={t('sales.searchPlaceholder')} /></div>

      {sales.length === 0 ? (
        <Card><Empty icon="sales" title={t('sales.empty')} sub={t('sales.emptySub')} /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {sales.map((s) => {
            const rec = recIndex.get(s.id)
            return (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3.5">
                <button onClick={() => nav('/parchi/' + s.id)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink-900">{s.no}</span>
                    <Badge tone={statusTone[s.status]}>{t(saleStatusKey[s.status])}</Badge>
                  </div>
                  <div className="truncate text-sm text-ink-500">{partyName(state, s.partyId)}</div>
                  <div className="text-xs text-ink-400">{fmtFull(s.date)} · {t('common.due')} {fmtFull(dueDate(s))}</div>
                </button>
                <div className="text-right">
                  <div className="font-bold tabular text-ink-900">{money(saleTotal(s))}</div>
                  {rec && <Badge tone={receivableTone[rec.status]}>{t(statusKey[rec.status])}</Badge>}
                </div>
                <button onClick={() => nav('/parchi/' + s.id)} className="grid h-9 w-9 place-items-center rounded-lg text-ink-400 hover:bg-canvas" aria-label={t('sale.parchi')}><Icon.print className="h-5 w-5" /></button>
                <button onClick={() => remove(s.id)} className="grid h-9 w-9 place-items-center rounded-lg text-ink-400 hover:bg-rose-50 hover:text-rose-500" aria-label={t('common.delete')}><Icon.close className="h-4 w-4" /></button>
              </div>
            )
          })}
        </Card>
      )}
    </div>
  )
}
