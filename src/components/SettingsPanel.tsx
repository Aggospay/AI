import { useState } from 'react'
import { parseUsdc } from '@/onchain-money'
import { toast } from 'sonner'
import { usdc } from '@/lib/format'
import { useAction, useApi } from '@/lib/hooks'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/en'
import { Badge, Btn, Card, Field, inputCls, Toggle } from './ui'

type Raw = {
  risk: Record<string, string | number | boolean | string[]>
  pricing: Record<string, number>
  offers: Record<string, string | number | string[]>
  watch: { collections: string[]; scanIntervalSec: number }
  mint: { quantity: number; requireSecondaryReference: boolean }
}

type Draft = Record<string, string>

const AMOUNTS: Array<[string, MessageKey]> = [
  ['risk.maxMintPrice', 'u.usdcPerToken'],
  ['risk.maxPurchasePrice', 'u.usdcPerToken'],
  ['risk.minNetProfit', 'u.usdcPerTrade'],
  ['risk.maxDailySpend', 'u.usdc'],
  ['risk.maxWeeklySpend', 'u.usdc'],
  ['risk.maxExposurePerCollection', 'u.usdc'],
  ['risk.maxGasCostPerTx', 'u.usdc'],
  ['offers.maxCapitalInOffers', 'u.usdc'],
]
const NUMBERS: Array<[string, MessageKey | '']> = [
  ['risk.minRoiBps', 'u.bpsPct'],
  ['risk.maxTokensPerCollection', ''],
  ['risk.maxCollectionAllocationBps', 'u.bps'],
  ['risk.minCollectionScore', 'u.0to100'],
  ['risk.minScoreCoverage', 'u.0to1'],
  ['risk.minLiquiditySales', 'u.liquidityWindow'],
  ['risk.minDistinctBuyers', ''],
  ['risk.maxPriceAgeSec', 'u.seconds'],
  ['pricing.undercutTicks', 'u.ticks001'],
  ['pricing.repriceCooldownSec', 'u.seconds'],
  ['pricing.maxRepricesPerHour', ''],
  ['pricing.raiseThresholdTicks', 'u.ticks'],
  ['pricing.resaleHaircutBps', 'u.bps'],
  ['offers.incrementTicks', 'u.ticks'],
  ['offers.maxOpenOffers', ''],
  ['offers.durationSec', 'u.seconds'],
  ['mint.quantity', ''],
]
const LISTS: string[] = ['risk.allowlist', 'risk.blocklist', 'watch.collections']

const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o)

function toDraft(raw: Raw): Draft {
  const d: Draft = {}
  for (const [p] of AMOUNTS) d[p] = usdc(String(get(raw, p)), 3)
  for (const [p] of NUMBERS) d[p] = String(get(raw, p))
  for (const p of LISTS) d[p] = ((get(raw, p) as string[]) ?? []).join(', ')
  return d
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let cur = target
  keys.slice(0, -1).forEach((k) => {
    cur[k] = (cur[k]) ?? {}
    cur = cur[k] as Record<string, unknown>
  })
  cur[keys[keys.length - 1]] = value
}

function ToggleRow({ label, hint, path, raw }: { label: MessageKey; hint: MessageKey; path: string; raw: Raw }) {
  const { t } = useI18n()
  const save = useAction<unknown>('/settings', 'PATCH')
  const value = get(raw, path) === true
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0"><div className="text-sm font-medium">{t(label)}</div><div className="text-xs text-[var(--subtle)]">{t(hint)}</div></div>
      <Toggle label={t(label)} checked={value} onChange={(v) => { const b: Record<string, unknown> = {}; setPath(b, path, v); save.mutate(b) }} />
    </div>
  )
}

export function SettingsPanel() {
  const { t, td } = useI18n()
  const settings = useApi<Raw>('settings', '/settings', 15_000)
  const save = useAction<unknown>('/settings', 'PATCH', t('st.saved'))
  // `edits` holds unsaved changes only; untouched fields always reflect the server.
  const [edits, setEdits] = useState<Draft | null>(null)
  if (!settings.data) return <Card>{t('st.loading')}</Card>
  const draft: Draft = { ...toDraft(settings.data), ...(edits ?? {}) }
  const dirty = edits !== null

  const onSave = () => {
    const body: Record<string, unknown> = {}
    try {
      for (const [p] of AMOUNTS) setPath(body, p, parseUsdc(draft[p] || '0').toString())
      for (const [p] of NUMBERS) {
        const n = Number(draft[p])
        if (!Number.isFinite(n)) throw new Error(t('st.invalidNumber', { p: td(`f.${p}`, p) }))
        setPath(body, p, n)
      }
      for (const p of LISTS) setPath(body, p, (draft[p] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('st.invalid'))
      return
    }
    save.mutate(body, { onSuccess: () => setEdits(null) })
  }

  const field = (p: string, hint: string, wide = false) => (
    <Field key={p} label={td(`f.${p}`, p)} hint={hint}>
      <input value={draft[p] ?? ''} inputMode={wide ? 'text' : 'decimal'} onChange={(e) => setEdits({ ...(edits ?? {}), [p]: e.target.value })} className={`${inputCls} ${wide ? 'mono' : ''}`} />
    </Field>
  )

  return (
    <div className="space-y-5">
      <Card title={t('st.limits')} aside={dirty ? <Badge tone="warn">{t('st.unsaved')}</Badge> : undefined}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {AMOUNTS.map(([p, h]) => field(p, t(h)))}
          {NUMBERS.map(([p, h]) => field(p, h ? t(h) : ''))}
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {LISTS.map((p) => field(p, t('st.commaHint'), true))}
        </div>
        <div className="mt-5 flex gap-2">
          <Btn variant="primary" busy={save.isPending} disabled={!dirty} onClick={onSave}>{t('st.save')}</Btn>
          <Btn disabled={!dirty} onClick={() => setEdits(null)}>{t('st.discard')}</Btn>
        </div>
      </Card>

      <Card title={t('st.safety')}>
        <div className="divide-y divide-[var(--border)]">
          <ToggleRow path="risk.requireVerifiedCollection" label="sw.verified.l" hint="sw.verified.h" raw={settings.data} />
          <ToggleRow path="mint.requireSecondaryReference" label="sw.secondary.l" hint="sw.secondary.h" raw={settings.data} />
          <ToggleRow path="risk.allowFixtureCounterparties" label="sw.harness.l" hint="sw.harness.h" raw={settings.data} />
        </div>
        {get(settings.data, 'risk.allowFixtureCounterparties') === true && (
          <p className="mt-3 rounded-xl bg-[rgba(232,196,109,0.12)] p-3 text-sm text-[var(--warn)]">
            {t('st.harnessWarn')}
          </p>
        )}
      </Card>

      <Card title={t('st.networks')}>
        <ul className="divide-y divide-[var(--border)] text-sm">
          {([
            ['net.arc', 'net.arcNote', 'active'],
            ['net.eth', 'net.ethNote', 'unavailable'],
          ] as const).map(([name, note, status]) => (
            <li key={name} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div><div className="font-medium">{t(name)}</div><div className="text-xs text-[var(--subtle)]">{t(note)}</div></div>
              <Badge tone={status === 'active' ? 'good' : 'neutral'}>{status === 'active' ? t('net.connected') : t('net.na')}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
