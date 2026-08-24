import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { Card, PageHeader, Button, SectionTitle, Badge } from '@/components/ui'
import { Icon } from '@/components/icons'

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? 'bg-brand-600' : 'bg-line'}`} role="switch" aria-checked={on}>
      <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  )
}

export function Settings() {
  const { state } = useStore()
  const nav = useNavigate()
  const b = state.business
  const [wa, setWa] = useState(b.whatsappConnected)
  const [rem, setRem] = useState(b.reminders)

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" hindi="सेटिंग" sub="Business profile, reminders, WhatsApp, users and audit." />

      {/* Business profile */}
      <Card className="mb-4 p-5">
        <SectionTitle>Business profile</SectionTitle>
        <div className="flex items-center gap-4">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-600 text-white"><Icon.production className="h-7 w-7" /></span>
          <div>
            <div className="text-lg font-bold text-ink-900">{b.name}</div>
            <div className="hi text-sm text-ink-400">{b.hindi}</div>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {[['GSTIN', b.gstin], ['Phone', b.phone], ['Address', b.address], ['City / State', `${b.city}, ${b.state}`]].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-line py-1.5">
              <dt className="text-ink-400">{k}</dt><dd className="font-semibold text-ink-900">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {/* WhatsApp */}
      <Card className="mb-4 p-5">
        <SectionTitle>WhatsApp automation</SectionTitle>
        <div className="flex items-start gap-3 rounded-xl bg-canvas p-3">
          <Icon.whatsapp className="mt-0.5 h-6 w-6 shrink-0 text-brand-600" />
          <div className="flex-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-ink-900">Official WhatsApp Business API</span>
              <Badge tone={wa ? 'green' : 'gray'}>{wa ? 'Connected' : 'Not connected'}</Badge>
            </div>
            <p className="mt-1 text-ink-500">Sends parchis, receipts and reminders as approved utility templates via Meta’s Cloud API or a BSP (Gupshup / Wati / AiSensy). Never an unofficial method — that risks a permanent ban.</p>
          </div>
          <Toggle on={wa} onClick={() => setWa(!wa)} />
        </div>
      </Card>

      {/* Reminders */}
      <Card className="mb-4 p-5">
        <SectionTitle>Payment reminders</SectionTitle>
        <div className="divide-y divide-line">
          <RowToggle label="Reminder engine" sub="Master switch for all automated reminders" on={rem.enabled} onClick={() => setRem({ ...rem, enabled: !rem.enabled })} />
          <RowToggle label="Send parchi on dispatch" sub="Digital parchi to the customer when goods leave" on={rem.onDispatch} onClick={() => setRem({ ...rem, onDispatch: !rem.onDispatch })} />
          <RowToggle label="Remind on due date" sub="A gentle nudge the day payment is due" on={rem.onDueDate} onClick={() => setRem({ ...rem, onDueDate: !rem.onDueDate })} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-canvas p-3"><div className="text-ink-400">Overdue reminder every</div><div className="font-bold text-ink-900">{rem.overdueEveryDays} days</div></div>
          <div className="rounded-xl bg-canvas p-3"><div className="text-ink-400">Quiet hours</div><div className="font-bold text-ink-900">{rem.quietHours}</div></div>
        </div>
        <p className="mt-2 text-xs text-ink-400">Anti-spam cap: at most {rem.maxPerInvoicePerDay} reminder per invoice per day.</p>
      </Card>

      {/* Admin links */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card onClick={() => nav('/users')} className="flex items-center gap-3 p-4">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon.users className="h-5 w-5" /></span>
          <div className="flex-1"><div className="font-semibold text-ink-900">Users & roles</div><div className="text-xs text-ink-400">{state.users.length} users</div></div>
          <Icon.chevron className="h-5 w-5 text-ink-400" />
        </Card>
        <Card onClick={() => nav('/audit')} className="flex items-center gap-3 p-4">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon.audit className="h-5 w-5" /></span>
          <div className="flex-1"><div className="font-semibold text-ink-900">Audit log</div><div className="text-xs text-ink-400">{state.audit.length} events tracked</div></div>
          <Icon.chevron className="h-5 w-5 text-ink-400" />
        </Card>
      </div>

      <div className="mt-6 flex justify-end">
        <Button variant="outline"><Icon.check className="h-5 w-5" /> Changes saved</Button>
      </div>
    </div>
  )
}

function RowToggle({ label, sub, on, onClick }: { label: string; sub: string; on: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1">
        <div className="font-semibold text-ink-900">{label}</div>
        <div className="text-xs text-ink-400">{sub}</div>
      </div>
      <Toggle on={on} onClick={onClick} />
    </div>
  )
}
