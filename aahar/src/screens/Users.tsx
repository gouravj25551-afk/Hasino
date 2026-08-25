import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import type { Role } from '@/lib/types'
import type { TKey } from '@/lib/translations'
import { Card, PageHeader, Badge, Avatar, Button, SectionTitle } from '@/components/ui'
import { Icon } from '@/components/icons'
import { roleKey } from '@/lib/labels'
import type { Tone } from '@/components/ui'

const roleTone: Record<Role, Tone> = {
  owner: 'green', admin: 'violet', accountant: 'blue', sales: 'amber', store: 'amber', production: 'amber', dispatch: 'amber', viewer: 'gray',
}
const roleCanKey: Record<Role, TKey> = {
  owner: 'role.owner.can', admin: 'role.admin.can', accountant: 'role.accountant.can', sales: 'role.sales.can', store: 'role.store.can', production: 'role.production.can', dispatch: 'role.dispatch.can', viewer: 'role.viewer.can',
}
const ROLES: Role[] = ['owner', 'admin', 'accountant', 'sales', 'store', 'production', 'dispatch', 'viewer']

export function Users() {
  const { state } = useStore()
  const { t } = useLang()
  const nav = useNavigate()
  return (
    <div className="mx-auto max-w-3xl">
      <button onClick={() => nav('/settings')} className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-ink-500 hover:text-ink-700"><Icon.back className="h-4 w-4" /> {t('nav.settings')}</button>
      <PageHeader title={t('usr.title')} sub={t('usr.sub')}
        action={<Button className="hidden sm:inline-flex"><Icon.plus className="h-5 w-5" /> {t('usr.addUser')}</Button>} />

      <SectionTitle>{t('usr.team')}</SectionTitle>
      <Card className="mb-5 divide-y divide-line">
        {state.users.map((u) => (
          <div key={u.id} className="flex items-center gap-3 px-4 py-3.5">
            <Avatar name={u.name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-semibold text-ink-900">{u.name}</span>
                {u.id === state.currentUserId && <Badge tone="green">{t('usr.you')}</Badge>}
                {!u.active && <Badge tone="gray">{t('usr.inactive')}</Badge>}
              </div>
              <div className="text-xs text-ink-400">{u.phone}</div>
            </div>
            <Badge tone={roleTone[u.role]}>{t(roleKey[u.role])}</Badge>
          </div>
        ))}
      </Card>

      <SectionTitle>{t('usr.whatEachCan')}</SectionTitle>
      <Card className="divide-y divide-line">
        {ROLES.map((role) => (
          <div key={role} className="flex items-start gap-3 px-4 py-3">
            <Badge tone={roleTone[role]}>{t(roleKey[role])}</Badge>
            <p className="flex-1 text-sm text-ink-700">{t(roleCanKey[role])}</p>
          </div>
        ))}
      </Card>
    </div>
  )
}
