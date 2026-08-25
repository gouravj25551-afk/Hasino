import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import { dashboard, openReceivables, stockRows, saleTotal, partyName } from '@/lib/select'
import { money, moneyShort, num } from '@/lib/money'
import { fmtFull, relDue, TODAY } from '@/lib/date'
import { Card, Stat, Badge, SectionTitle } from '@/components/ui'
import { Icon } from '@/components/icons'
import { statusKey, receivableTone, pname } from '@/lib/labels'

export function Dashboard() {
  const { state } = useStore()
  const { t, lang } = useLang()
  const nav = useNavigate()
  const d = dashboard(state)
  const recs = openReceivables(state)
    .filter((r) => r.status === 'overdue' || r.status === 'dueToday' || r.status === 'dueTomorrow')
    .sort((a, b) => a.daysToDue - b.daysToDue)
    .slice(0, 5)
  const lowStock = stockRows(state).filter((s) => s.low)
  const me = state.users.find((u) => u.id === state.currentUserId)

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-ink-500">{t('dash.namaste', { name: me?.name?.split(' ')[0] ?? '' })} 🙏</p>
        <h1 className="text-2xl font-bold text-ink-900">{state.business.name}</h1>
        <p className="text-sm text-ink-400">{fmtFull(TODAY)}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('dash.todaySales')} value={money(d.todaySales)} tone="green" icon="sales" />
        <Stat label={t('dash.collections')} value={money(d.todayCollections)} tone="blue" icon="rupee" />
        <Stat label={t('dash.cashInHand')} value={money(d.cashInHand)} tone="amber" icon="rokad" />
        <Stat label={t('dash.expenses')} value={money(d.todayExpenses)} tone="gray" icon="expenses" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <SectionTitle>{t('dash.receivables')}</SectionTitle>
          <div className="text-3xl font-bold tabular text-ink-900">{money(d.totalReceivable)}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => nav('/payments')} className="rounded-xl bg-rose-50 px-3 py-2 text-left">
              <div className="text-xs font-semibold text-rose-600">{t('dash.overdue')}</div>
              <div className="text-lg font-bold tabular text-rose-700">{money(d.overdue)}</div>
            </button>
            <button onClick={() => nav('/payments')} className="rounded-xl bg-amber-50 px-3 py-2 text-left">
              <div className="text-xs font-semibold text-amber-600">{t('dash.dueToday')}</div>
              <div className="text-lg font-bold tabular text-amber-700">{money(d.dueToday)}</div>
            </button>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>{t('dash.payable')}</SectionTitle>
          <div className="text-3xl font-bold tabular text-ink-900">{money(d.totalPayable)}</div>
          <p className="mt-2 text-sm text-ink-500">{t('dash.payableSub', { n: state.parties.filter((p) => p.kind === 'supplier').length })}</p>
          <button onClick={() => nav('/purchases')} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-600">
            {t('dash.viewPurchases')} <Icon.chevron className="h-4 w-4" />
          </button>
        </Card>

        <Card className="p-5">
          <SectionTitle>{t('dash.thisMonth')}</SectionTitle>
          <div className="text-3xl font-bold tabular text-ink-900">{moneyShort(d.monthSales)}</div>
          <p className="mt-2 text-sm text-ink-500">{t('dash.monthSub', { n: state.sales.length })}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg bg-canvas px-3 py-2">
              <div className="font-bold tabular text-ink-900">{num(d.finishedBags)}</div>
              <div className="text-xs text-ink-500">{t('dash.bagsInStock')}</div>
            </div>
            <div className="rounded-lg bg-canvas px-3 py-2">
              <div className="font-bold tabular text-ink-900">{d.pendingDispatch}</div>
              <div className="text-xs text-ink-500">{t('dash.pendingDispatch')}</div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle action={<button onClick={() => nav('/payments')} className="text-sm font-semibold text-brand-600">{t('common.all')}</button>}>
            {t('dash.needsCollection')}
          </SectionTitle>
          {recs.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">{t('dash.allClear')} ✅</p>
          ) : (
            <div className="divide-y divide-line">
              {recs.map((r) => (
                <button key={r.sale.id} onClick={() => nav('/customers/' + r.party.id)} className="flex w-full items-center gap-3 py-3 text-left">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-ink-900">{r.party.name}</div>
                    <div className="text-xs text-ink-400">{r.sale.no} · {relDue(r.dueDate, lang)}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold tabular text-ink-900">{money(r.outstanding)}</div>
                    <Badge tone={receivableTone[r.status]}>{t(statusKey[r.status])}</Badge>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <SectionTitle action={<button onClick={() => nav('/inventory')} className="text-sm font-semibold text-brand-600">{t('common.all')}</button>}>
            {t('dash.lowStock')}
          </SectionTitle>
          {lowStock.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">{t('dash.stockHealthy')} ✅</p>
          ) : (
            <div className="divide-y divide-line">
              {lowStock.map((s) => (
                <div key={s.product.id} className="flex items-center gap-3 py-3">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-amber-50 text-amber-600"><Icon.warn className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-ink-900">{pname(s.product, lang)}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold tabular text-amber-700">{num(s.onHand)} {s.product.unit === 'bag' ? t('common.bags') : t('common.kg')}</div>
                    <div className="text-xs text-ink-400">{t('dash.reorder', { n: num(s.product.reorderLevel) })}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-5">
        <SectionTitle action={<button onClick={() => nav('/sales')} className="text-sm font-semibold text-brand-600">{t('dash.allSales')}</button>}>
          {t('dash.recentSales')}
        </SectionTitle>
        <div className="divide-y divide-line">
          {state.sales.slice(0, 6).map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-3">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon.sales className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-ink-900">{partyName(state, s.partyId)}</div>
                <div className="text-xs text-ink-400">{s.no} · {relDue(s.date, lang)}</div>
              </div>
              <div className="font-bold tabular text-ink-900">{money(saleTotal(s))}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
