import { useState } from 'react'
import { useStore, newId } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import type { PayMode, Expense } from '@/lib/types'
import type { TKey } from '@/lib/translations'
import { money } from '@/lib/money'
import { TODAY, fmtFull } from '@/lib/date'
import { userName } from '@/lib/select'
import { Card, PageHeader, Button, Stat, Sheet, Field, Input, Select, SectionTitle } from '@/components/ui'
import { Icon } from '@/components/icons'
import { payModes, modeKey } from '@/lib/labels'

// Category value stored is the canonical English id; display is translated.
const CATS: { id: string; key: TKey }[] = [
  { id: 'Diesel / Fuel', key: 'exp.cat.fuel' },
  { id: 'Labour', key: 'exp.cat.labour' },
  { id: 'Electricity', key: 'exp.cat.electricity' },
  { id: 'Maintenance', key: 'exp.cat.maintenance' },
  { id: 'Packaging', key: 'exp.cat.packaging' },
  { id: 'Transport', key: 'exp.cat.transport' },
  { id: 'Office', key: 'exp.cat.office' },
  { id: 'Repairs', key: 'exp.cat.repairs' },
  { id: 'Miscellaneous', key: 'exp.cat.misc' },
]

export function Expenses() {
  const { state, dispatch } = useStore()
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<Expense | null>(null)

  const catLabel = (id: string) => { const c = CATS.find((x) => x.id === id); return c ? t(c.key) : id }
  const expenses = state.expenses.slice().sort((a, b) => (a.date < b.date ? 1 : -1))
  const today = expenses.filter((e) => e.date === TODAY).reduce((s, e) => s + e.amount, 0)
  const month = expenses.filter((e) => e.date.startsWith(TODAY.slice(0, 7))).reduce((s, e) => s + e.amount, 0)

  function remove(e: Expense) { if (confirm(t('exp.deleteConfirm'))) dispatch({ type: 'deleteExpense', id: e.id }) }

  return (
    <div>
      <PageHeader title={t('exp.title')} sub={t('exp.sub')}
        action={<Button className="hidden sm:inline-flex" onClick={() => setOpen(true)}><Icon.plus className="h-5 w-5" /> {t('exp.add')}</Button>} />

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat label={t('exp.todayTotal')} value={money(today)} tone="amber" icon="expenses" />
        <Stat label={t('exp.monthTotal')} value={money(month)} tone="gray" icon="reports" />
      </div>

      <SectionTitle>{t('exp.recent')}</SectionTitle>
      <Card className="divide-y divide-line">
        {expenses.map((e) => (
          <div key={e.id} className="flex items-center gap-3 px-4 py-3.5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-canvas text-ink-500"><Icon.expenses className="h-5 w-5" /></span>
            <button onClick={() => setEdit(e)} className="min-w-0 flex-1 text-left">
              <div className="truncate font-semibold text-ink-900">{catLabel(e.category)}</div>
              <div className="text-xs text-ink-400">{fmtFull(e.date)} · {t(modeKey[e.mode])} · {t('exp.by', { name: userName(state, e.enteredBy) })}</div>
              {e.note && <div className="truncate text-xs text-ink-400">{e.note}</div>}
            </button>
            <div className="font-bold tabular text-rose-600">− {money(e.amount)}</div>
            <button onClick={() => remove(e)} className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 hover:bg-rose-50 hover:text-rose-500" aria-label={t('common.delete')}><Icon.close className="h-4 w-4" /></button>
          </div>
        ))}
      </Card>

      <div className="no-print fixed bottom-24 right-4 z-30 sm:hidden">
        <button onClick={() => setOpen(true)} className="grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-lg"><Icon.plus className="h-6 w-6" /></button>
      </div>

      {(open || edit) && <ExpenseSheet existing={edit ?? undefined} onClose={() => { setOpen(false); setEdit(null) }} />}
    </div>
  )
}

function ExpenseSheet({ existing, onClose }: { existing?: Expense; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const { t } = useLang()
  const [category, setCategory] = useState(existing?.category ?? CATS[0].id)
  const [amount, setAmount] = useState(existing?.amount ?? 0)
  const [mode, setMode] = useState<PayMode>(existing?.mode ?? 'cash')
  const [note, setNote] = useState(existing?.note ?? '')
  const [err, setErr] = useState('')

  function save() {
    if (amount <= 0) { setErr(t('common.mustBePositive')); return }
    if (existing) dispatch({ type: 'updateExpense', expense: { ...existing, category, amount, mode, note: note || undefined } })
    else dispatch({ type: 'addExpense', expense: { id: newId('ex'), category, amount, mode, date: TODAY, note: note || undefined, enteredBy: state.currentUserId } })
    onClose()
  }

  return (
    <Sheet open onClose={onClose} title={t('exp.add')} footer={<Button full size="lg" onClick={save}>{t('common.save')} · {money(amount)}</Button>}>
      <div className="space-y-4">
        <Field label={t('exp.category')}>
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATS.map((c) => <option key={c.id} value={c.id}>{t(c.key)}</option>)}
          </Select>
        </Field>
        <Field label={t('pay.amount')}>
          <Input type="number" inputMode="numeric" autoFocus min={0} value={amount || ''} onChange={(e) => { setAmount(Number(e.target.value)); setErr('') }} placeholder="0" />
          {err && <div className="mt-1 text-xs font-semibold text-rose-600">{err}</div>}
        </Field>
        <Field label={t('exp.paidBy')}>
          <div className="flex flex-wrap gap-2">
            {payModes.map((m) => (<button key={m} onClick={() => setMode(m)} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${mode === m ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-line text-ink-500'}`}>{t(modeKey[m])}</button>))}
          </div>
        </Field>
        <Field label={t('sale.note')} hint={t('common.optional')}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Sheet>
  )
}
