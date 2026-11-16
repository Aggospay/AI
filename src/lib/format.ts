import { Amount } from '@/onchain-money'
import { USDC_DECIMALS } from '@/onchain-facts'

/** USDC base units (string or bigint) to a display string with fixed decimals. */
export function usdc(raw: string | bigint | number | null | undefined, digits = 3): string {
  if (raw === null || raw === undefined || raw === '') return '-'
  try {
    return Amount.fromRaw(BigInt(raw), USDC_DECIMALS).toFixed(digits)
  } catch {
    return '-'
  }
}

export function signedUsdc(raw: string | bigint | null | undefined, digits = 3): string {
  if (raw === null || raw === undefined) return '-'
  const v = BigInt(raw)
  return `${v > 0n ? '+' : ''}${usdc(v, digits)}`
}

export function pnlClass(raw: string | bigint | null | undefined): string {
  if (raw === null || raw === undefined) return 'text-[var(--subtle)]'
  const v = BigInt(raw)
  return v > 0n ? 'text-[var(--success)]' : v < 0n ? 'text-[var(--danger)]' : 'text-[var(--muted)]'
}

export function short(addr: string | null | undefined): string {
  if (!addr) return '-'
  return addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr
}

let intlTag = 'en'

/** Set by the i18n provider. Latin digits are forced so money and times stay consistent across languages. */
export function setFormatLocale(tag: string): void {
  intlTag = `${tag}-u-nu-latn`
}

const rtf = (): Intl.RelativeTimeFormat => new Intl.RelativeTimeFormat(intlTag, { numeric: 'always', style: 'short' })
const unit = (u: 'second' | 'minute' | 'hour' | 'day'): Intl.NumberFormat => new Intl.NumberFormat(intlTag, { style: 'unit', unit: u, unitDisplay: 'narrow' })

/** Localized "5 minutes ago" style text for a past millisecond timestamp. */
export function ago(ms: number | null | undefined): string {
  if (!ms) return '-'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return rtf().format(-s, 'second')
  if (s < 3600) return rtf().format(-Math.round(s / 60), 'minute')
  if (s < 86_400) return rtf().format(-Math.round(s / 3600), 'hour')
  return rtf().format(-Math.round(s / 86_400), 'day')
}

/** Localized compact duration until a unix-seconds timestamp. */
export function until(sec: number): string {
  const s = sec - Math.floor(Date.now() / 1000)
  if (s <= 0) return unit('second').format(0)
  if (s < 90) return unit('second').format(s)
  if (s < 5400) return unit('minute').format(Math.round(s / 60))
  if (s < 172_800) return unit('hour').format(Math.round(s / 3600))
  return unit('day').format(Math.round(s / 86_400))
}

export function bpsPct(bps: number | string | null | undefined): string {
  if (bps === null || bps === undefined) return '-'
  return `${(Number(bps) / 100).toFixed(1)}%`
}

/** Whole minutes remaining until a millisecond timestamp (never negative). */
export function minutesLeft(ms: number): number {
  return Math.max(0, Math.round((ms - Date.now()) / 60_000))
}
