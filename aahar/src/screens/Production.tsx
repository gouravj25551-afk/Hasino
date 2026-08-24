import { useStore } from '@/lib/data/store'
import { productName } from '@/lib/select'
import { num } from '@/lib/money'
import { fmtFull } from '@/lib/date'
import { Card, PageHeader, Badge, SectionTitle, Stat } from '@/components/ui'
import { Icon } from '@/components/icons'

export function Production() {
  const { state } = useStore()
  const batches = state.batches.slice().sort((a, b) => (a.date < b.date ? 1 : -1))
  const totalBags = batches.reduce((s, b) => s + b.outputBags, 0)
  const totalWaste = batches.reduce((s, b) => s + b.wastageKg, 0)

  return (
    <div>
      <PageHeader title="Production" hindi="उत्पादन" sub="Batches, recipes (BOM) and raw-material consumption." />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="Batches" value={batches.length} sub="this month" tone="green" icon="production" />
        <Stat label="Bags produced" value={num(totalBags)} sub="finished goods" tone="blue" icon="box" />
        <Stat label="Wastage" value={`${num(totalWaste)} kg`} sub="across batches" tone="amber" icon="warn" />
      </div>

      <SectionTitle>Production batches</SectionTitle>
      <div className="space-y-3">
        {batches.map((b) => {
          const bom = state.boms.find((x) => x.productId === b.productId)
          const tons = (b.outputBags * 50) / 1000
          return (
            <Card key={b.id} className="p-4">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon.production className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-ink-900">{b.batchNo}</span>
                    <Badge tone="green">{num(b.outputBags)} bags</Badge>
                  </div>
                  <div className="text-sm text-ink-500">{productName(state, b.productId)} · {fmtFull(b.date)}</div>
                </div>
              </div>

              {b.note && <div className="mt-2 rounded-lg bg-canvas px-3 py-1.5 text-xs text-ink-500">QC: {b.note}</div>}

              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase text-ink-400">
                      <th className="pb-1 font-semibold">Raw material</th>
                      <th className="pb-1 text-right font-semibold">Expected</th>
                      <th className="pb-1 text-right font-semibold">Actual</th>
                      <th className="pb-1 text-right font-semibold">Diff</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {b.consumption.map((c) => {
                      const perTon = bom?.lines.find((l) => l.productId === c.productId)?.kgPerTon ?? 0
                      const expected = Math.round(perTon * tons)
                      const diff = c.kg - expected
                      return (
                        <tr key={c.productId}>
                          <td className="py-1.5 text-ink-700">{productName(state, c.productId)}</td>
                          <td className="py-1.5 text-right tabular text-ink-400">{num(expected)}</td>
                          <td className="py-1.5 text-right tabular font-semibold text-ink-900">{num(c.kg)}</td>
                          <td className={`py-1.5 text-right tabular ${diff > 0 ? 'text-rose-600' : diff < 0 ? 'text-brand-600' : 'text-ink-400'}`}>{diff > 0 ? '+' : ''}{num(diff)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 text-xs text-ink-400">Wastage {num(b.wastageKg)} kg · Expected columns computed from the {productName(state, b.productId)} recipe.</div>
            </Card>
          )
        })}
      </div>

      <Card className="mt-4 p-4">
        <SectionTitle>Recipes · BOM</SectionTitle>
        <p className="mb-3 text-sm text-ink-500">Per 1 ton of finished feed. Recording a batch uses this to compute expected consumption.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {state.boms.map((bom) => (
            <div key={bom.productId} className="rounded-xl border border-line p-3">
              <div className="mb-2 font-semibold text-ink-900">{productName(state, bom.productId)}</div>
              <ul className="space-y-1 text-sm">
                {bom.lines.map((l) => (
                  <li key={l.productId} className="flex justify-between">
                    <span className="text-ink-500">{productName(state, l.productId)}</span>
                    <span className="tabular font-semibold text-ink-700">{num(l.kgPerTon)} kg</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
