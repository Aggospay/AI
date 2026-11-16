/** Small UI primitives shared across the dashboard. Arc Dark tokens live in index.css. */
import clsx from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { useI18n } from '@/i18n'

export function Card({ title, aside, children, className }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-2xl border border-[var(--border)] bg-[var(--surface)] backdrop-blur-md', className)}>
      {(title || aside) && (
        <header className="flex items-center justify-between gap-3 px-5 pt-4">
          {title && <h2 className="label">{title}</h2>}
          {aside}
        </header>
      )}
      <div className="p-5 pt-3">{children}</div>
    </section>
  )
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={clsx('display num mt-1 truncate text-2xl font-semibold', tone)}>{value}</div>
      {sub && <div className="num mt-0.5 truncate text-xs text-[var(--subtle)]">{sub}</div>}
    </div>
  )
}

type Tone = 'neutral' | 'good' | 'bad' | 'warn' | 'accent'
const TONES: Record<Tone, string> = {
  neutral: 'bg-[var(--surface-strong)] text-[var(--muted)]',
  good: 'bg-[rgba(141,216,159,0.14)] text-[var(--success)]',
  bad: 'bg-[rgba(232,109,122,0.14)] text-[var(--danger)]',
  warn: 'bg-[rgba(232,196,109,0.14)] text-[var(--warn)]',
  accent: 'bg-[rgba(172,198,233,0.16)] text-[var(--accent)]',
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={clsx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', TONES[tone])}>{children}</span>
}

export function Btn({
  variant = 'ghost', busy, className, children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger'; busy?: boolean }) {
  const { t } = useI18n()
  const styles = {
    primary: 'bg-[var(--accent)] text-[#0d1b2f] hover:bg-[var(--accent-hover)]',
    ghost: 'border border-[var(--border)] bg-transparent text-[var(--ink-2)] hover:bg-[var(--surface-strong)]',
    danger: 'bg-[var(--danger)] text-[#1a0a0d] hover:opacity-90',
  }[variant]
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={clsx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50',
        styles,
        className,
      )}
    >
      {busy ? t('common.working') : children}
    </button>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50',
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--surface-muted)]',
      )}
    >
      <span className={clsx('absolute start-0.5 top-0.5 h-5 w-5 rounded-full bg-[#0d1b2f] transition-transform', checked && 'translate-x-5 rtl:-translate-x-5')} style={checked ? undefined : { background: '#cbd5e1' }} />
    </button>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--subtle)]">{children}</div>
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="text-start">
            {head.map((h) => (
              <th key={h} className="label px-2 pb-2 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">{children}</tbody>
      </table>
    </div>
  )
}

export const Td = ({ children, className }: { children: ReactNode; className?: string }) => (
  <td className={clsx('num px-2 py-2.5 align-middle', className)}>{children}</td>
)

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-[var(--ink-2)]">{label}</span>
      {hint && <span className="ms-2 text-xs text-[var(--subtle)]">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  )
}

export const inputCls =
  'num min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)]'
