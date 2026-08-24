import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Icon, type IconName } from '@/components/icons'
import { cn } from '@/lib/cn'
import { useStore } from '@/lib/data/store'
import { dashboard } from '@/lib/select'
import { Avatar } from '@/components/ui'

interface NavItem {
  to: string
  label: string
  hindi: string
  icon: IconName
  badge?: number
}

function useNav(): { primary: NavItem[]; secondary: NavItem[] } {
  const { state } = useStore()
  const d = dashboard(state)
  return {
    primary: [
      { to: '/', label: 'Dashboard', hindi: 'डैशबोर्ड', icon: 'dashboard' },
      { to: '/sales', label: 'Sales', hindi: 'बिक्री', icon: 'sales' },
      { to: '/customers', label: 'Khata', hindi: 'खाता', icon: 'khata' },
      { to: '/payments', label: 'Payments', hindi: 'भुगतान', icon: 'rupee' },
      { to: '/purchases', label: 'Purchases', hindi: 'खरीद', icon: 'purchase' },
      { to: '/inventory', label: 'Inventory', hindi: 'स्टॉक', icon: 'inventory', badge: d.lowStock || undefined },
      { to: '/production', label: 'Production', hindi: 'उत्पादन', icon: 'production' },
      { to: '/dispatch', label: 'Dispatch', hindi: 'डिस्पैच', icon: 'dispatch', badge: d.pendingDispatch || undefined },
      { to: '/rokad', label: 'Rokad', hindi: 'रोकड़', icon: 'rokad' },
      { to: '/expenses', label: 'Expenses', hindi: 'खर्च', icon: 'expenses' },
      { to: '/reports', label: 'Reports', hindi: 'रिपोर्ट', icon: 'reports' },
    ],
    secondary: [
      { to: '/reminders', label: 'Reminders', hindi: 'रिमाइंडर', icon: 'bell' },
      { to: '/settings', label: 'Settings', hindi: 'सेटिंग', icon: 'settings' },
    ],
  }
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 text-white shadow-sm">
        <Icon.production className="h-5 w-5" />
      </span>
      <div className="leading-tight">
        <div className="text-[15px] font-extrabold tracking-tight text-ink-900">Aahar</div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">Feed Factory OS</div>
      </div>
    </div>
  )
}

function SideLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cn(
          'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-semibold transition',
          isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-canvas',
        )
      }
    >
      {({ isActive }) => {
        const I = Icon[item.icon]
        return (
          <>
            <I className={cn('h-5 w-5', isActive ? 'text-brand-600' : 'text-ink-400 group-hover:text-ink-700')} />
            <span className="flex-1">{item.label}</span>
            {item.badge ? (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white">{item.badge}</span>
            ) : null}
          </>
        )
      }}
    </NavLink>
  )
}

export function Layout() {
  const { primary, secondary } = useNav()
  const { state } = useStore()
  const nav = useNavigate()
  const loc = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  const me = state.users.find((u) => u.id === state.currentUserId)

  const bottom: NavItem[] = [
    { to: '/', label: 'Home', hindi: 'होम', icon: 'dashboard' },
    { to: '/sales', label: 'Sales', hindi: 'बिक्री', icon: 'sales' },
    { to: '/customers', label: 'Khata', hindi: 'खाता', icon: 'khata' },
    { to: '/rokad', label: 'Rokad', hindi: 'रोकड़', icon: 'rokad' },
  ]

  return (
    <div className="min-h-full lg:flex">
      {/* Desktop sidebar */}
      <aside className="no-print sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="px-5 py-5">
          <Brand />
        </div>
        <nav className="scroll-thin flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {primary.map((i) => (
            <SideLink key={i.to} item={i} />
          ))}
          <div className="my-3 border-t border-line" />
          {secondary.map((i) => (
            <SideLink key={i.to} item={i} />
          ))}
        </nav>
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
            <Avatar name={me?.name ?? 'User'} className="h-9 w-9" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-semibold text-ink-900">{me?.name}</div>
              <div className="text-xs capitalize text-ink-400">{me?.role}</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="no-print sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface/90 px-4 py-3 backdrop-blur lg:px-8">
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => nav('/reminders')}
              className="relative grid h-11 w-11 place-items-center rounded-xl text-ink-500 hover:bg-canvas"
              aria-label="Reminders"
            >
              <Icon.bell className="h-5 w-5" />
              <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-rose-500" />
            </button>
            <button
              onClick={() => nav('/sales/new')}
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-4 text-[15px] font-bold text-white shadow-sm transition hover:bg-brand-700 active:scale-[.98]"
            >
              <Icon.plus className="h-5 w-5" />
              <span className="hidden sm:inline">New Sale</span>
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-5 lg:px-8 lg:pb-10">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {bottom.slice(0, 2).map((i) => (
          <BottomLink key={i.to} item={i} />
        ))}
        <button
          onClick={() => nav('/sales/new')}
          className="relative -mt-5 flex flex-1 flex-col items-center"
          aria-label="New sale"
        >
          <span className="grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-lg ring-4 ring-surface">
            <Icon.plus className="h-7 w-7" />
          </span>
        </button>
        {bottom.slice(2).map((i) => (
          <BottomLink key={i.to} item={i} />
        ))}
        <button
          onClick={() => setMoreOpen(true)}
          className={cn('flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold', 'text-ink-400')}
        >
          <Icon.menu className="h-5 w-5" />
          More
        </button>
      </nav>

      {moreOpen && (
        <div className="no-print fixed inset-0 z-50 lg:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-ink-900/40 backdrop-blur-sm" />
          <div className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-surface p-4 pb-8 rise" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-line" />
            <div className="grid grid-cols-3 gap-2">
              {[...primary.slice(3), ...secondary]
                .filter((i) => !bottom.some((b) => b.to === i.to))
                .map((i) => {
                  const I = Icon[i.icon]
                  const active = loc.pathname === i.to
                  return (
                    <button
                      key={i.to}
                      onClick={() => {
                        nav(i.to)
                        setMoreOpen(false)
                      }}
                      className={cn('flex flex-col items-center gap-1.5 rounded-2xl border border-line p-3', active && 'border-brand-200 bg-brand-50')}
                    >
                      <I className={cn('h-6 w-6', active ? 'text-brand-600' : 'text-ink-500')} />
                      <span className="text-xs font-semibold text-ink-700">{i.label}</span>
                    </button>
                  )
                })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function BottomLink({ item }: { item: NavItem }) {
  const I = Icon[item.icon]
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cn('flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold', isActive ? 'text-brand-700' : 'text-ink-400')
      }
    >
      <I className="h-5 w-5" />
      {item.label}
    </NavLink>
  )
}
