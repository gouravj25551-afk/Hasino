import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
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
  const { state, dispatch } = useStore()
  const { t, lang, setLang } = useLang()
  const nav = useNavigate()
  const b = state.business
  const rem = b.reminders

  const setWa = (on: boolean) => dispatch({ type: 'updateBusiness', business: { ...b, whatsappConnected: on } })
  const setRem = (patch: Partial<typeof rem>) => dispatch({ type: 'updateBusiness', business: { ...b, reminders: { ...rem, ...patch } } })

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t('set.title')} sub={t('set.sub')} />

      {/* Language */}
      <Card className="mb-4 p-5">
        <SectionTitle>{t('set.language')}</SectionTitle>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-ink-500">{t('set.languageSub')}</p>
          <div className="flex shrink-0 rounded-xl border border-line p-1">
            <button onClick={() => setLang('en')} className={`rounded-lg px-4 py-1.5 text-sm font-bold transition ${lang === 'en' ? 'bg-brand-600 text-white' : 'text-ink-500'}`}>English</button>
            <button onClick={() => setLang('hi')} className={`hi rounded-lg px-4 py-1.5 text-sm font-bold transition ${lang === 'hi' ? 'bg-brand-600 text-white' : 'text-ink-500'}`}>हिंदी</button>
          </div>
        </div>
      </Card>

      {/* Business profile */}
      <Card className="mb-4 p-5">
        <SectionTitle>{t('set.businessProfile')}</SectionTitle>
        <div className="flex items-center gap-4">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-600 text-white"><Icon.production className="h-7 w-7" /></span>
          <div>
            <div className="text-lg font-bold text-ink-900">{b.name}</div>
            <div className="hi text-sm text-ink-400">{b.hindi}</div>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {[[t('set.gstin'), b.gstin], [t('set.phone'), b.phone], [t('set.address'), b.address], [t('set.cityState'), `${b.city}, ${b.state}`]].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-line py-1.5"><dt className="text-ink-400">{k}</dt><dd className="font-semibold text-ink-900">{v}</dd></div>
          ))}
        </dl>
      </Card>

      {/* WhatsApp */}
      <Card className="mb-4 p-5">
        <SectionTitle>{t('set.whatsapp')}</SectionTitle>
        <div className="flex items-start gap-3 rounded-xl bg-canvas p-3">
          <Icon.whatsapp className="mt-0.5 h-6 w-6 shrink-0 text-brand-600" />
          <div className="flex-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-ink-900">{t('set.whatsappName')}</span>
              <Badge tone={b.whatsappConnected ? 'green' : 'gray'}>{b.whatsappConnected ? t('set.connected') : t('set.notConnected')}</Badge>
            </div>
            <p className="mt-1 text-ink-500">{t('set.whatsappBody')}</p>
          </div>
          <Toggle on={b.whatsappConnected} onClick={() => setWa(!b.whatsappConnected)} />
        </div>
      </Card>

      {/* Reminders */}
      <Card className="mb-4 p-5">
        <SectionTitle>{t('set.reminders')}</SectionTitle>
        <div className="divide-y divide-line">
          <RowToggle label={t('set.remEngine')} sub={t('set.remEngineSub')} on={rem.enabled} onClick={() => setRem({ enabled: !rem.enabled })} />
          <RowToggle label={t('set.remDispatch')} sub={t('set.remDispatchSub')} on={rem.onDispatch} onClick={() => setRem({ onDispatch: !rem.onDispatch })} />
          <RowToggle label={t('set.remDue')} sub={t('set.remDueSub')} on={rem.onDueDate} onClick={() => setRem({ onDueDate: !rem.onDueDate })} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-canvas p-3"><div className="text-ink-400">{t('set.overdueEvery')}</div><div className="font-bold text-ink-900">{t('rem.days', { n: rem.overdueEveryDays })}</div></div>
          <div className="rounded-xl bg-canvas p-3"><div className="text-ink-400">{t('set.quietHours')}</div><div className="font-bold text-ink-900">{rem.quietHours}</div></div>
        </div>
        <p className="mt-2 text-xs text-ink-400">{t('set.antiSpam', { n: rem.maxPerInvoicePerDay })}</p>
      </Card>

      {/* Admin links */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card onClick={() => nav('/users')} className="flex items-center gap-3 p-4">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon.users className="h-5 w-5" /></span>
          <div className="flex-1"><div className="font-semibold text-ink-900">{t('set.usersRoles')}</div><div className="text-xs text-ink-400">{t('set.usersCount', { n: state.users.length })}</div></div>
          <Icon.chevron className="h-5 w-5 text-ink-400" />
        </Card>
        <Card onClick={() => nav('/audit')} className="flex items-center gap-3 p-4">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon.audit className="h-5 w-5" /></span>
          <div className="flex-1"><div className="font-semibold text-ink-900">{t('set.auditLog')}</div><div className="text-xs text-ink-400">{t('set.auditCount', { n: state.audit.length })}</div></div>
          <Icon.chevron className="h-5 w-5 text-ink-400" />
        </Card>
      </div>

      {/* Data */}
      <Card className="mt-4 p-5">
        <SectionTitle>{t('set.data')}</SectionTitle>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-ink-500">{t('set.resetSub')}</p>
          <Button variant="outline" className="shrink-0" onClick={() => { if (confirm(t('set.resetConfirm'))) dispatch({ type: 'reset' }) }}>{t('set.resetData')}</Button>
        </div>
      </Card>
    </div>
  )
}

function RowToggle({ label, sub, on, onClick }: { label: string; sub: string; on: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1"><div className="font-semibold text-ink-900">{label}</div><div className="text-xs text-ink-400">{sub}</div></div>
      <Toggle on={on} onClick={onClick} />
    </div>
  )
}
