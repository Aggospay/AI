/**
 * Renders every dashboard tab in every language against a running worker, in a simulated DOM, and fails on
 * runtime exceptions or obviously broken output (undefined, NaN, [object Object], missing translations).
 *   bun run agent:ui-check            (worker must be running; AGENT_ADMIN_TOKEN comes from .env)
 * It cannot judge layout. Look at the preview for that.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const TOKEN = process.env.AGENT_ADMIN_TOKEN ?? ''
const WORKER = 'http://localhost:8787'
const realFetch = globalThis.fetch.bind(globalThis)

GlobalRegistrator.register({ url: 'http://localhost:5173/' })
// The simulated browser has no Vite proxy: send /api calls straight to the worker.
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const target = url.startsWith('/api') ? WORKER + url : url.startsWith('http://localhost:5173/api') ? WORKER + url.slice('http://localhost:5173'.length) : url
  if (!target.startsWith(WORKER)) return Promise.reject(new Error('blocked non-worker request: ' + target))
  return realFetch(target, { ...init, signal: AbortSignal.timeout(8000) })
})

const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { WagmiProvider } = await import('wagmi')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { ConnectKitProvider } = await import('connectkit')
const { config } = await import('../src/config')
const { default: App } = await import('../src/App')
const { en } = await import('../src/i18n/en')
const { ar } = await import('../src/i18n/ar')
const { es } = await import('../src/i18n/es')
const { hi } = await import('../src/i18n/hi')
const { id } = await import('../src/i18n/id')
const { ru } = await import('../src/i18n/ru')
const { zh } = await import('../src/i18n/zh')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const catalogs = { en, zh, id, hi, es, ar, ru } as const
const TABS = ['overview', 'opportunities', 'launches', 'positions', 'orders', 'approvals', 'activity', 'controls', 'settings', 'fund']
const BAD = [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /useI18n must/, /Cannot read prop/]

const errors: string[] = []
const origError = console.error
console.error = (...a: unknown[]) => {
  const msg = a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')
  // React dev warnings about act() or unknown DOM props are noise here; real exceptions are not.
  if (/not wrapped in act|Warning: |ReactDOMTestUtils/.test(msg)) return
  errors.push(msg.slice(0, 300))
}
window.addEventListener('error', (e) => errors.push('uncaught: ' + e.message))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
let runs = 0

for (const lang of Object.keys(catalogs) as Array<keyof typeof catalogs>) {
  for (const tab of TABS) {
    errors.length = 0
    window.localStorage.setItem('agent.lang', lang)
    window.sessionStorage.setItem('agent.adminToken', TOKEN)
    window.history.replaceState(null, '', `/?tab=${tab}`)
    document.body.innerHTML = '<div id="root"></div>'
    const el = document.getElementById('root') as HTMLElement
    const root = createRoot(el)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    act(() => {
      root.render(
        createElement(
          WagmiProvider,
          { config },
          createElement(QueryClientProvider, { client: qc }, createElement(ConnectKitProvider, null, createElement(App))),
        ),
      )
    })
    await act(async () => {
      await sleep(1400)
    })
    const text = el.textContent ?? ''
    const problems: string[] = [...errors]
    if (text.length < 120) problems.push(`page looks empty (${text.length} chars, expected at least 120)`)
    for (const re of BAD) if (re.test(text)) problems.push(`output contains ${re}`)
    const tabLabel = catalogs[lang][`tab.${tab === 'positions' ? 'portfolio' : tab}` as keyof typeof en]
    if (!text.includes(tabLabel)) problems.push(`missing translated tab label "${tabLabel}"`)
    if (document.documentElement.lang !== lang) problems.push(`html lang is ${document.documentElement.lang}`)
    if ((lang === 'ar') !== (document.documentElement.dir === 'rtl')) problems.push(`html dir is ${document.documentElement.dir}`)
    runs++
    if (problems.length > 0) {
      failures++
      console.log(`FAIL ${lang}/${tab}: ${problems.slice(0, 4).join(' | ')}`)
    }
    act(() => {
      root.unmount()
    })
    qc.clear()
  }
}
console.error = origError
console.log(failures === 0 ? `ALL OK (${runs} renders: ${Object.keys(catalogs).length} languages x ${TABS.length} tabs)` : `${failures} of ${runs} renders failed`)
await GlobalRegistrator.unregister()
process.exit(failures === 0 ? 0 : 1)
