import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import { userName } from '@/lib/select'
import { Card, PageHeader, Badge, Avatar } from '@/components/ui'
import { Icon } from '@/components/icons'

function fmtAt(at: string): string {
  const [d, tm] = at.split('T')
  return `${d} · ${(tm ?? '').slice(0, 5)}`
}

export function AuditLog() {
  const { state } = useStore()
  const { t } = useLang()
  const nav = useNavigate()
  const entries = state.audit.slice().sort((a, b) => (a.at < b.at ? 1 : -1))
  const actionLabel = { create: t('aud.create'), edit: t('aud.edit'), delete: t('aud.delete') }

  return (
    <div className="mx-auto max-w-3xl">
      <button onClick={() => nav('/settings')} className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-ink-500 hover:text-ink-700"><Icon.back className="h-4 w-4" /> {t('nav.settings')}</button>
      <PageHeader title={t('aud.title')} sub={t('aud.sub')} />

      <Card className="divide-y divide-line">
        {entries.map((e) => (
          <div key={e.id} className="flex gap-3 px-4 py-3.5">
            <Avatar name={userName(state, e.userId)} className="h-9 w-9 text-xs" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink-900">{userName(state, e.userId)}</span>
                <Badge tone={e.action === 'edit' ? 'amber' : e.action === 'delete' ? 'red' : 'green'}>{actionLabel[e.action]}</Badge>
                <span className="text-sm text-ink-500">{e.entity} <span className="text-ink-400">{e.entityId}</span></span>
              </div>
              {e.field && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-ink-400">{e.field}:</span>
                  <span className="rounded bg-rose-50 px-2 py-0.5 font-semibold text-rose-700 line-through">{e.oldValue}</span>
                  <Icon.chevron className="h-4 w-4 text-ink-400" />
                  <span className="rounded bg-brand-50 px-2 py-0.5 font-semibold text-brand-700">{e.newValue}</span>
                </div>
              )}
              {e.reason && <div className="mt-1 text-sm text-ink-500">“{e.reason}”</div>}
              <div className="mt-1 text-xs text-ink-400">{fmtAt(e.at)}</div>
            </div>
          </div>
        ))}
      </Card>
    </div>
  )
}
