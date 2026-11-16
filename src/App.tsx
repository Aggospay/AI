import { useCallback, useEffect, useState } from 'react'
import { Activity, Bot, CircleDollarSign, Gauge, ListChecks, Rocket, Settings2, ShieldCheck, Telescope, Wallet } from 'lucide-react'
import { Approvals, ActivityLog } from '@/components/Operations'
import { Controls } from '@/components/Controls'
import { Fund, NotImplemented } from '@/components/Fund'
import { Gate } from '@/components/Gate'
import { Header } from '@/components/Header'
import { Launches, Opportunities } from '@/components/Market'
import { Overview } from '@/components/Overview'
import { Orders, Positions } from '@/components/Portfolio'
import { SettingsPanel } from '@/components/SettingsPanel'
import { Card } from '@/components/ui'
import { api, ApiError, clearToken, getToken, setToken, useAgentStream, type AgentState, type IntentView, type Portfolio } from '@/lib/api'
import { useApi } from '@/lib/hooks'
import { I18nProvider, useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/en'

const TABS = [
  { id: 'overview', label: 'tab.overview', icon: Gauge },
  { id: 'opportunities', label: 'tab.opportunities', icon: Telescope },
  { id: 'launches', label: 'tab.launches', icon: Rocket },
  { id: 'positions', label: 'tab.portfolio', icon: CircleDollarSign },
  { id: 'orders', label: 'tab.orders', icon: ListChecks },
  { id: 'approvals', label: 'tab.approvals', icon: ShieldCheck },
  { id: 'activity', label: 'tab.activity', icon: Activity },
  { id: 'controls', label: 'tab.controls', icon: Bot },
  { id: 'settings', label: 'tab.settings', icon: Settings2 },
  { id: 'fund', label: 'tab.fund', icon: Wallet },
] as const satisfies ReadonlyArray<{ id: string; label: MessageKey; icon: unknown }>
type TabId = (typeof TABS)[number]['id']

function initialTab(): TabId {
  const t = new URLSearchParams(window.location.search).get('tab')
  return (TABS.find((x) => x.id === t)?.id ?? 'overview')
}

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<TabId>(initialTab)
  const state = useApi<AgentState>('state', '/state', 3000)
  const portfolio = useApi<Portfolio>('portfolio', '/portfolio', 5000)
  const pending = useApi<IntentView[]>('intents', '/intents?status=proposed', 3000)
  useAgentStream(true)

  const go = useCallback((t: TabId) => {
    setTab(t)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', t)
    window.history.replaceState(null, '', url)
  }, [])

  useEffect(() => {
    if (state.error?.status === 401) onSignOut()
  }, [state.error, onSignOut])

  if (state.isLoading) return <div className="grid min-h-dvh place-items-center text-[var(--subtle)]">{t('app.connecting')}</div>
  if (!state.data) {
    return (
      <main className="mx-auto max-w-md px-5 py-16">
        <Card title={t('app.unreachable.title')}>
          <p className="text-sm text-[var(--ink-2)]">{t('app.unreachable.body')}</p>
          <p dir="ltr" className="mono mt-2 text-sm text-[var(--accent)]">bun run agent:start</p>
          <p className="mt-2 text-xs text-[var(--subtle)]">{state.error?.message}</p>
        </Card>
      </main>
    )
  }
  const s = state.data
  const waiting = pending.data?.length ?? 0

  return (
    <div className="min-h-dvh">
      <Header state={s} onSignOut={onSignOut} />
      <nav aria-label={t('nav.sections')} className="border-b border-[var(--border)]">
        <ul className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-3 md:px-5">
          {TABS.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => go(id)}
                aria-current={tab === id ? 'page' : undefined}
                className={`relative flex min-h-11 items-center gap-2 whitespace-nowrap px-3 text-sm font-medium transition ${tab === id ? 'text-[var(--ink)]' : 'text-[var(--subtle)] hover:text-[var(--ink-2)]'}`}
              >
                <Icon size={15} aria-hidden />
                {t(label)}
                {id === 'approvals' && waiting > 0 && <span className="num rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-bold text-[#0d1b2f]">{waiting}</span>}
                {tab === id && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[var(--accent)]" />}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="mx-auto max-w-[1400px] px-4 py-5 md:px-6">
        {tab === 'overview' && <Overview state={s} portfolio={portfolio.data} />}
        {tab === 'opportunities' && <Opportunities />}
        {tab === 'launches' && <Launches />}
        {tab === 'positions' && <Positions portfolio={portfolio.data} />}
        {tab === 'orders' && <Orders />}
        {tab === 'approvals' && <Approvals state={s} />}
        {tab === 'activity' && <ActivityLog state={s} />}
        {tab === 'controls' && <Controls state={s} />}
        {tab === 'settings' && <SettingsPanel />}
        {tab === 'fund' && (
          <div className="space-y-5">
            <Fund state={s} />
            <NotImplemented />
          </div>
        )}
      </main>
    </div>
  )
}

function Root() {
  const { t, lang } = useI18n()
  const [token, setLocal] = useState(getToken())
  const [error, setError] = useState<string | undefined>()

  const submit = async (value: string) => {
    setToken(value)
    try {
      await api('/state')
      setLocal(value)
      setError(undefined)
    } catch (e) {
      clearToken()
      setError(e instanceof ApiError && e.status === 401 ? t('gate.rejected') : e instanceof Error ? t('gate.unreachable', { msg: e.message }) : t('gate.unreachable2'))
    }
  }
  const signOut = useCallback(() => {
    clearToken()
    setLocal('')
  }, [])

  // Remounting on language change refreshes every relative-time label that is computed outside React state.
  if (!token) return <Gate key={lang} onSubmit={(v) => void submit(v)} error={error} />
  return <Dashboard key={lang} onSignOut={signOut} />
}

export default function App() {
  return (
    <I18nProvider>
      <Root />
    </I18nProvider>
  )
}
