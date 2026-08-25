import { useState } from 'react'
import { useStore, newId } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import type { Product, ProductType } from '@/lib/types'
import { Sheet, Button, Field, Input, Select } from '@/components/ui'

export function ProductForm({ open, onClose, existing, defaultType }: { open: boolean; onClose: () => void; existing?: Product; defaultType: ProductType }) {
  const { dispatch } = useStore()
  const { t } = useLang()
  const [name, setName] = useState(existing?.name ?? '')
  const [hindi, setHindi] = useState(existing?.hindi ?? '')
  const [type, setType] = useState<ProductType>(existing?.type ?? defaultType)
  const [packKg, setPackKg] = useState(existing?.packKg ?? 50)
  const [rate, setRate] = useState(existing?.rate ?? 0)
  const [hsn, setHsn] = useState(existing?.hsn ?? '2309')
  const [opening, setOpening] = useState(existing?.openingStock ?? 0)
  const [reorder, setReorder] = useState(existing?.reorderLevel ?? 0)
  const [err, setErr] = useState('')

  const isFinished = type === 'finished'

  function save() {
    if (!name.trim()) { setErr(t('common.required')); return }
    const product: Product = {
      id: existing?.id ?? newId(isFinished ? 'p' : 'r'),
      type,
      name: name.trim(),
      hindi: hindi.trim() || undefined,
      unit: isFinished ? 'bag' : 'kg',
      packKg: isFinished ? (packKg || 50) : 1,
      rate: rate || 0,
      hsn: hsn.trim() || undefined,
      openingStock: opening || 0,
      reorderLevel: reorder || 0,
    }
    dispatch(existing ? { type: 'updateProduct', product } : { type: 'addProduct', product })
    onClose()
  }

  return (
    <Sheet open={open} onClose={onClose} title={existing ? t('inv.editProduct') : t('inv.addProduct')} footer={<Button full size="lg" onClick={save}>{t('common.save')}</Button>}>
      <div className="space-y-4">
        <Field label={t('inv.productName')}>
          <Input value={name} autoFocus onChange={(e) => { setName(e.target.value); setErr('') }} />
          {err && <div className="mt-1 text-xs font-semibold text-rose-600">{err}</div>}
        </Field>
        <Field label={t('inv.nameHindi')} hint={t('common.optional')}><Input className="hi" value={hindi} onChange={(e) => setHindi(e.target.value)} /></Field>
        <Field label={t('inv.type')}>
          <Select value={type} onChange={(e) => setType(e.target.value as ProductType)}>
            <option value="finished">{t('inv.finishedGoods')}</option>
            <option value="raw">{t('inv.rawMaterial')}</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {isFinished && <Field label={t('inv.packKg')}><Input type="number" inputMode="numeric" value={packKg} onChange={(e) => setPackKg(Number(e.target.value))} /></Field>}
          <Field label={t('inv.rate')}><Input type="number" inputMode="numeric" value={rate || ''} onChange={(e) => setRate(Number(e.target.value))} placeholder="0" /></Field>
          {isFinished && <Field label={t('inv.hsn')} hint={t('common.optional')}><Input value={hsn} onChange={(e) => setHsn(e.target.value)} /></Field>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('inv.openingStock')}><Input type="number" inputMode="numeric" value={opening || ''} onChange={(e) => setOpening(Number(e.target.value))} placeholder="0" /></Field>
          <Field label={t('inv.reorderLevel')}><Input type="number" inputMode="numeric" value={reorder || ''} onChange={(e) => setReorder(Number(e.target.value))} placeholder="0" /></Field>
        </div>
      </div>
    </Sheet>
  )
}
