/** Smoke test for a running worker: bun run agent:smoke (needs AGENT_ADMIN_TOKEN in .env). Never changes mode, approval mode or the pause switch. */
const f = (u: string, init: RequestInit = {}) => fetch(u, { ...init, signal: AbortSignal.timeout(10_000) })
const base = 'http://localhost:8787'
const tok = process.env.AGENT_ADMIN_TOKEN ?? ''
const h = { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' }
let bad = 0
const check = (name: string, ok: boolean, extra = '') => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, extra) }
const gets = ['/healthz','/api/state','/api/settings','/api/portfolio','/api/opportunities','/api/collections','/api/launches','/api/listings','/api/offers','/api/intents','/api/intents?status=failed','/api/activity?limit=5','/api/failed','/api/gas','/api/stubs','/api/wallets']
for (const p of gets) {
  const r = await f(base + p, { headers: h })
  const t = await r.text()
  check('GET ' + p, r.status === 200 || r.status === 404, `${r.status} ${t.length}b${r.status === 404 ? ' (route absent)' : ''}`)
  if (r.status === 200 && p !== '/healthz') { try { JSON.parse(t) } catch { check('json ' + p, false) } }
}
check('no token -> 401', (await f(base + '/api/state')).status === 401)
check('wrong token -> 401', (await f(base + '/api/state', { headers: { Authorization: 'Bearer nope' } })).status === 401)
check('healthz open, no secrets', !(await (await f(base + '/healthz')).text()).includes(tok))
check('traversal blocked', [401, 403, 404].includes((await f(base + '/..%2f..%2f.env', { headers: h })).status))
const post = (p: string, b: unknown, raw = false) => f(base + '/api' + p, { method: p === '/settings' ? 'PATCH' : 'POST', headers: h, body: raw ? (b as string) : JSON.stringify(b) })
check('bad json -> 4xx', (await post('/control/pause', '{oops', true)).status >= 400)
check('mode needs confirm phrase', (await post('/control/mode', { mode: 'testnet-live' })).status >= 400)
check('mode wrong phrase', (await post('/control/mode', { mode: 'testnet-live', confirm: 'yes' })).status >= 400)
check('invalid settings rejected', (await post('/settings', { risk: { minCollectionScore: 999 } })).status >= 400)
check('settings bigint garbage rejected', (await post('/settings', { risk: { maxPurchasePrice: 'abc' } })).status >= 400)
check('unknown strategy rejected', (await post('/control/strategy', { name: 'rm -rf', enabled: true })).status >= 400)
check('approve unknown intent', (await post('/intents/does-not-exist/approve', {})).status >= 400)
check('mint unknown collection', (await post('/mint', { collection: '0x0000000000000000000000000000000000000001', quantity: 1 })).status >= 400)
check('mint bad quantity', (await post('/mint', { collection: '0x7eac9854c7fc6cc192ddf060c878046e4dcd72bd', quantity: 9999 })).status >= 400)
const st = await (await f(base + '/api/state', { headers: h })).json() as { mode: string; approvalMode: string; paused: boolean }
check('defaults safe', st.mode === 'paper' && st.approvalMode === 'manual' && !st.paused, JSON.stringify({ m: st.mode, a: st.approvalMode, p: st.paused }))
const sse = await f(base + '/api/stream', { headers: h })
check('SSE opens', sse.status === 200 && (sse.headers.get('content-type') ?? '').includes('event-stream'))
await sse.body?.cancel()
console.log(bad === 0 ? 'ALL OK' : `${bad} FAILED`)
