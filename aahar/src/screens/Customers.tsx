import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import { outstanding } from '@/lib/select'
import type { PartyKind } from '@/lib/types'
import { money } from '@/lib/money'
import { Card, PageHeader, SearchBox, Segmented, Avatar, Empty, Button } from '@/components/ui'
import { Icon } from '@/components/icons'
import { PartyForm } from '@/components/PartyForm'

export function Customers() {
  const { state } = useStore()
  const { t } = useLang()
  const nav = useNavigate()
  const [kind, setKind] = useState<PartyKind>('customer')
  const [q, setQ] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const rows = useMemo(() => {
    return state.parties
      .filter((p) => p.kind === kind)
      .map((p) => ({ p, bal: outstanding(state, p.id) }))
      .filter(({ p }) => (p.name + p.city + p.phone).toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => b.bal - a.bal)
  }, [state, kind, q])

  const totalOut = rows.reduce((s, r) => s + Math.max(0, r.bal), 0)
  const sub = kind === 'customer' ? t('cust.subCollect', { n: rows.length, amt: money(totalOut) }) : t('cust.subPay', { n: rows.length, amt: money(totalOut) })

  return (
    <div>
      <PageHeader title={t('cust.title')} sub={sub}
        action={<Button className="hidden sm:inline-flex" onClick={() => setAddOpen(true)}><Icon.plus className="h-5 w-5" /> {kind === 'customer' ? t('cust.addCustomer') : t('cust.addSupplier')}</Button>} />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="sm:w-52">
          <Segmented value={kind} onChange={setKind} options={[{ value: 'customer', label: t('cust.customers') }, { value: 'supplier', label: t('cust.suppliers') }]} />
        </div>
        <div className="flex-1"><SearchBox value={q} onChange={setQ} placeholder={t('cust.searchPlaceholder')} /></div>
      </div>

      <Card className="divide-y divide-line">
        {rows.length === 0 ? (
          <Empty icon="khata" title={t('cust.noneFound')} sub={t('cust.noneSub')} />
        ) : (
          rows.map(({ p, bal }) => (
            <button key={p.id} onClick={() => nav('/customers/' + p.id)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-canvas">
              <Avatar name={p.name} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-ink-900">{p.name}</div>
                <div className="text-xs text-ink-400">{p.city}{p.city && p.phone ? ' · ' : ''}{p.phone}</div>
              </div>
              <div className="text-right">
                <div className={`font-bold tabular ${bal > 0 ? 'text-rose-600' : bal < 0 ? 'text-brand-600' : 'text-ink-400'}`}>{money(Math.abs(bal))}</div>
                <div className="text-[11px] font-semibold text-ink-400">
                  {bal > 0 ? (kind === 'customer' ? t('cust.toCollect') : t('cust.toPay')) : bal < 0 ? t('cust.advance') : t('cust.settled')}
                </div>
              </div>
              <Icon.chevron className="h-5 w-5 text-ink-400" />
            </button>
          ))
        )}
      </Card>

      <div className="no-print fixed bottom-24 right-4 z-30 sm:hidden">
        <button onClick={() => setAddOpen(true)} className="grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-lg"><Icon.plus className="h-6 w-6" /></button>
      </div>

      <PartyForm open={addOpen} onClose={() => setAddOpen(false)} kind={kind} />
    </div>
  )
}
