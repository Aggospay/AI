/** Structured logger that redacts configured secrets. Never log raw environment values. */

const SECRET_ENV_NAMES = [
  'CIRCLE_API_KEY',
  'CIRCLE_ENTITY_SECRET',
  'ENTITY_SECRET',
  'AGENT_ADMIN_TOKEN',
  'RPC_PROXY_TOKEN',
]

function secretValues(): string[] {
  return SECRET_ENV_NAMES.map((n) => process.env[n]).filter((v): v is string => !!v && v.length >= 8)
}

export function redact(text: string): string {
  let out = text
  for (const secret of secretValues()) out = out.split(secret).join('[redacted]')
  // Provider URLs may embed tokens in the query string.
  out = out.replace(/([?&](?:_rpc_token|token|key|apikey)=)[^&\s"']+/gi, '$1[redacted]')
  out = out.replace(/\b(?:TEST|LIVE)_API_KEY:[\w:-]+/g, '[redacted]')
  return out
}

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function threshold(): number {
  const raw = (process.env.AGENT_LOG_LEVEL ?? 'info') as Level
  return ORDER[raw] ?? ORDER.info
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (ORDER[level] < threshold()) return
  const base = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
  let line = base
  if (extra !== undefined) {
    try {
      line += ' ' + JSON.stringify(extra, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
    } catch {
      line += ' [unserializable]'
    }
  }
  const out = redact(line)
  if (level === 'error') console.error(out)
  else if (level === 'warn') console.warn(out)
  else console.log(out)
}

export function logger(scope: string) {
  return {
    debug: (m: string, x?: unknown) => write('debug', scope, m, x),
    info: (m: string, x?: unknown) => write('info', scope, m, x),
    warn: (m: string, x?: unknown) => write('warn', scope, m, x),
    error: (m: string, x?: unknown) => write('error', scope, m, x),
  }
}

export type Logger = ReturnType<typeof logger>
