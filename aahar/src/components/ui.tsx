import { useEffect, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { Icon } from '@/components/icons'

// ---------------------------------------------------------------- Buttons

type BtnProps = {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle'
  size?: 'sm' | 'md' | 'lg'
  type?: 'button' | 'submit'
  disabled?: boolean
  className?: string
  full?: boolean
}

export function Button({ children, onClick, variant = 'primary', size = 'md', type = 'button', disabled, className, full }: BtnProps) {
  const base = 'inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition active:scale-[.98] disabled:opacity-40 disabled:pointer-events-none'
  const sizes = { sm: 'h-9 px-3 text-sm', md: 'h-11 px-4 text-[15px]', lg: 'h-14 px-6 text-base' }
  const variants = {
    primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
    outline: 'border border-line bg-surface text-ink-900 hover:bg-canvas',
    ghost: 'text-ink-700 hover:bg-canvas',
    subtle: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cn(base, sizes[size], variants[variant], full && 'w-full', className)}>
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- Cards

export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={cn('card', onClick && 'cursor-pointer hover:border-brand-200 transition', className)}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------- Badges / chips

const tones = {
  green: 'bg-brand-50 text-brand-700',
  red: 'bg-rose-50 text-rose-700',
  amber: 'bg-amber-50 text-amber-700',
  blue: 'bg-sky-50 text-sky-700',
  gray: 'bg-canvas text-ink-500',
  violet: 'bg-violet-50 text-violet-700',
}
export type Tone = keyof typeof tones

export function Badge({ children, tone = 'gray', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold', tones[tone], className)}>{children}</span>
}

export function Dot({ tone = 'gray' }: { tone?: Tone }) {
  const c = { green: 'bg-brand-500', red: 'bg-rose-500', amber: 'bg-amber-500', blue: 'bg-sky-500', gray: 'bg-ink-400', violet: 'bg-violet-500' }[tone]
  return <span className={cn('inline-block h-2 w-2 rounded-full', c)} />
}

// ---------------------------------------------------------------- Stat tile

export function Stat({ label, value, sub, tone = 'gray', icon }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; icon?: keyof typeof Icon }) {
  const I = icon ? Icon[icon] : null
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</div>
        {I && (
          <span className={cn('grid h-7 w-7 place-items-center rounded-lg', tones[tone])}>
            <I className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-bold tabular text-ink-900">{value}</div>
      {sub != null && <div className="mt-0.5 text-sm text-ink-500">{sub}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- Fields

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-semibold text-ink-700">{label}</span>
        {hint && <span className="text-xs text-ink-400">{hint}</span>}
      </div>
      {children}
    </label>
  )
}

const fieldClass = 'w-full h-12 rounded-xl border border-line bg-surface px-3.5 text-[15px] text-ink-900 outline-none transition focus:border-brand-400 focus:ring-4 focus:ring-brand-100 placeholder:text-ink-400'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldClass, props.className)} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(fieldClass, 'appearance-none pr-9', props.className)} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(fieldClass, 'h-auto py-3 min-h-24 resize-none', props.className)} />
}

// ---------------------------------------------------------------- Page header

export function PageHeader({ title, hindi, sub, action }: { title: string; hindi?: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-ink-900">
          {title} {hindi && <span className="hi text-lg font-medium text-ink-400">· {hindi}</span>}
        </h1>
        {sub && <p className="mt-0.5 text-sm text-ink-500">{sub}</p>}
      </div>
      {action}
    </div>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">{children}</h2>
      {action}
    </div>
  )
}

// ---------------------------------------------------------------- Search

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <Icon.search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-400" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Search…'}
        className={cn(fieldClass, 'pl-11')}
      />
    </div>
  )
}

// ---------------------------------------------------------------- Avatar

export function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360
  return (
    <span
      className={cn('grid place-items-center rounded-full text-sm font-bold text-white', className ?? 'h-10 w-10')}
      style={{ background: `hsl(${hue} 45% 42%)` }}
    >
      {initials}
    </span>
  )
}

// ---------------------------------------------------------------- Sheet / modal

export function Sheet({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-ink-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className={cn('relative z-10 flex max-h-[92vh] w-full flex-col rounded-t-3xl bg-surface shadow-2xl sm:rounded-3xl rise', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="text-lg font-bold text-ink-900">{title}</div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-ink-400 hover:bg-canvas">
            <Icon.close className="h-5 w-5" />
          </button>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Empty state

export function Empty({ icon = 'box', title, sub }: { icon?: keyof typeof Icon; title: string; sub?: string }) {
  const I = Icon[icon]
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span className="mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-canvas text-ink-400">
        <I className="h-7 w-7" />
      </span>
      <div className="font-semibold text-ink-700">{title}</div>
      {sub && <div className="mt-1 max-w-xs text-sm text-ink-400">{sub}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- Segmented

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="no-bar flex gap-1 overflow-x-auto rounded-xl bg-canvas p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'shrink-0 rounded-lg px-3.5 py-1.5 text-sm font-semibold transition',
            value === o.value ? 'bg-surface text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-700',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
