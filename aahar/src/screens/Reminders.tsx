import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { receivables } from '@/lib/select'
import { money } from '@/lib/money'
import { relDue } from '@/lib/date'
import { Card, PageHeader, Badge, Button, SectionTitle } from '@/components/ui'
import { Icon } from '@/components/icons'

export function Reminders() {
  const { state } = useStore()
  const nav = useNavigate()
  const r = state.business.reminders

  const queue = useMemo(() => {
    return receivables(state)
      .filter((x) => x.outstanding > 0.5 && (x.status === 'overdue' || x.status === 'dueToday' || x.status === 'dueTomorrow'))
      .sort((a, b) => a.daysToDue - b.daysToDue)
  }, [state])

  function messageFor(name: string, amount: number, no: string, status: string): string {
    if (status === 'overdue') return `Namaste ${name}, your payment of ${money(amount)} for invoice ${no} is overdue. Please arrange payment. — ${state.business.name}`
    return `Namaste ${name}, your payment of ${money(amount)} for invoice ${no} is due ${status === 'dueToday' ? 'today' : 'tomorrow'}. — ${state.business.name}`
  }

  return (
    <div>
      <PageHeader title="Reminders" hindi="रिमाइंडर" sub="Automated, throttled, and only over the official WhatsApp API."
        action={<Button variant="outline" className="hidden sm:inline-flex" onClick={() => nav('/settings')}><Icon.settings className="h-5 w-5" /> Configure</Button>} />

      {/* Status banner */}
      <Card className={`mb-4 flex items-center gap-3 p-4 ${state.business.whatsappConnected ? 'bg-brand-50' : 'bg-amber-50'}`}>
        <Icon.whatsapp className={`h-6 w-6 shrink-0 ${state.business.whatsappConnected ? 'text-brand-600' : 'text-amber-600'}`} />
        <div className="flex-1 text-sm">
          <div className="font-semibold text-ink-900">{state.business.whatsappConnected ? 'WhatsApp Business API connected' : 'WhatsApp not connected yet'}</div>
          <div className="text-ink-500">{state.business.whatsappConnected ? 'Reminders send automatically as utility templates.' : 'Connect the official API in Settings to auto-send. Until then, tap Send to open WhatsApp.'}</div>
        </div>
        {!state.business.whatsappConnected && <Button size="sm" onClick={() => nav('/settings')}>Connect</Button>}
      </Card>

      {/* Config summary */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { k: 'Engine', v: r.enabled ? 'On' : 'Off', t: r.enabled },
          { k: 'On dispatch', v: r.onDispatch ? 'Yes' : 'No', t: r.onDispatch },
          { k: 'Overdue every', v: `${r.overdueEveryDays} days`, t: true },
          { k: 'Max / invoice / day', v: String(r.maxPerInvoicePerDay), t: true },
        ].map((c) => (
          <div key={c.k} className="card p-3">
            <div className="text-xs font-semibold uppercase text-ink-400">{c.k}</div>
            <div className={`mt-1 font-bold ${c.t ? 'text-brand-700' : 'text-ink-500'}`}>{c.v}</div>
          </div>
        ))}
      </div>

      <SectionTitle>Scheduled now · {queue.length}</SectionTitle>
      {queue.length === 0 ? (
        <Card className="p-8 text-center text-sm text-ink-400">No reminders due. The scheduler is quiet ✅</Card>
      ) : (
        <div className="space-y-3">
          {queue.map((x) => {
            const msg = messageFor(x.party.name, x.outstanding, x.sale.no, x.status)
            const overdue = x.status === 'overdue'
            const waLink = `https://wa.me/${x.party.phone.replace(/\D/g, '')}?text=${encodeURIComponent(msg)}`
            return (
              <Card key={x.sale.id} className="p-4">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-ink-900">{x.party.name}</span>
                  <Badge tone={overdue ? 'red' : 'amber'}>{overdue ? 'Overdue reminder' : 'Due reminder'}</Badge>
                  <span className="ml-auto font-bold tabular text-ink-900">{money(x.outstanding)}</span>
                </div>
                <div className="mt-2 rounded-xl bg-canvas px-3 py-2.5 text-sm text-ink-700">{msg}</div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs text-ink-400">{x.sale.no} · due {relDue(x.dueDate)} · utility template</span>
                  <a href={waLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white">
                    <Icon.whatsapp className="h-4 w-4" /> Send
                  </a>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <Card className="mt-4 p-4 text-sm text-ink-500">
        <div className="mb-1 flex items-center gap-2 font-semibold text-ink-700"><Icon.warn className="h-4 w-4 text-amber-500" /> Why official API only</div>
        Unofficial WhatsApp automation gets the business number <span className="font-semibold">permanently banned</span>. Aahar sends only pre-approved <span className="font-semibold">utility templates</span> through Meta’s Cloud API / a BSP — free inside the customer’s 24-hour reply window — and never more than {r.maxPerInvoicePerDay}× per invoice per day, respecting quiet hours ({r.quietHours}) and opt-outs.
      </Card>
    </div>
  )
}
