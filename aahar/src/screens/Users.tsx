import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import type { Role } from '@/lib/types'
import { Card, PageHeader, Badge, Avatar, Button, SectionTitle } from '@/components/ui'
import { Icon } from '@/components/icons'

const ROLE_ACCESS: Record<Role, { label: string; can: string; tone: 'green' | 'blue' | 'amber' | 'violet' | 'gray' }> = {
  owner: { label: 'Owner', can: 'Everything, incl. settings, users, audit & edits', tone: 'green' },
  admin: { label: 'Admin', can: 'All operations & reports; user management', tone: 'violet' },
  accountant: { label: 'Accountant', can: 'Payments, ledgers, rokad, expenses, statements', tone: 'blue' },
  sales: { label: 'Sales', can: 'Create sales, view customers & stock', tone: 'amber' },
  store: { label: 'Store', can: 'Inward, stock adjustments, low-stock', tone: 'amber' },
  production: { label: 'Production', can: 'Record batches, consumption, wastage', tone: 'amber' },
  dispatch: { label: 'Dispatch', can: 'Assign trucks, mark delivered, POD', tone: 'amber' },
  viewer: { label: 'View only', can: 'Read dashboards & reports; no changes', tone: 'gray' },
}

export function Users() {
  const { state } = useStore()
  const nav = useNavigate()
  return (
    <div className="mx-auto max-w-3xl">
      <button onClick={() => nav('/settings')} className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-ink-500 hover:text-ink-700"><Icon.back className="h-4 w-4" /> Settings</button>
      <PageHeader title="Users & roles" hindi="यूज़र" sub="Who can do what — every financial change is signed and logged."
        action={<Button className="hidden sm:inline-flex"><Icon.plus className="h-5 w-5" /> Add user</Button>} />

      <SectionTitle>Team</SectionTitle>
      <Card className="mb-5 divide-y divide-line">
        {state.users.map((u) => {
          const acc = ROLE_ACCESS[u.role]
          return (
            <div key={u.id} className="flex items-center gap-3 px-4 py-3.5">
              <Avatar name={u.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-ink-900">{u.name}</span>
                  {u.id === state.currentUserId && <Badge tone="green">You</Badge>}
                  {!u.active && <Badge tone="gray">Inactive</Badge>}
                </div>
                <div className="text-xs text-ink-400">{u.phone}</div>
              </div>
              <Badge tone={acc.tone}>{acc.label}</Badge>
            </div>
          )
        })}
      </Card>

      <SectionTitle>What each role can do</SectionTitle>
      <Card className="divide-y divide-line">
        {(Object.keys(ROLE_ACCESS) as Role[]).map((role) => {
          const acc = ROLE_ACCESS[role]
          return (
            <div key={role} className="flex items-start gap-3 px-4 py-3">
              <Badge tone={acc.tone}>{acc.label}</Badge>
              <p className="flex-1 text-sm text-ink-700">{acc.can}</p>
            </div>
          )
        })}
      </Card>
    </div>
  )
}
