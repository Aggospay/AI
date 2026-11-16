/**
 * Persistent task scheduler. Task metadata (next run, last status) lives in SQLite so health
 * checks and the dashboard can see it, and a restart resumes on schedule. Tasks never overlap
 * themselves, errors are captured per task and never kill the process.
 */
import type { Db } from './db'
import { logger } from './log'
import { errMessage, nowMs } from './util'

const log = logger('scheduler')

interface Task {
  name: string
  intervalMs: number
  fn: () => Promise<void>
  running: boolean
  pendingTrigger: boolean
}

export class Scheduler {
  private tasks = new Map<string, Task>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private db: Db) {}

  register(name: string, intervalMs: number, fn: () => Promise<void>): void {
    this.tasks.set(name, { name, intervalMs, fn, running: false, pendingTrigger: false })
    this.db
      .query(
        `INSERT INTO tasks (name, next_run, interval_ms) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET interval_ms = excluded.interval_ms`,
      )
      .run(name, nowMs(), intervalMs)
  }

  /** Run a task as soon as possible (coalesced if it is already running). */
  trigger(name: string): void {
    const t = this.tasks.get(name)
    if (!t) return
    if (t.running) t.pendingTrigger = true
    else void this.execute(t)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const now = nowMs()
      for (const t of this.tasks.values()) {
        if (t.running) continue
        const row = this.db.query('SELECT next_run FROM tasks WHERE name = ?').get(t.name) as { next_run: number } | null
        if (!row || row.next_run <= now) void this.execute(t)
      }
    }, 250)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async execute(t: Task): Promise<void> {
    if (t.running) return
    t.running = true
    const started = nowMs()
    let status = 'ok'
    let error: string | null = null
    try {
      await t.fn()
    } catch (e) {
      status = 'error'
      error = errMessage(e)
      log.warn(`task ${t.name} failed`, { error })
    } finally {
      t.running = false
      this.db
        .query(
          `UPDATE tasks SET last_run = ?, last_status = ?, last_error = ?, runs = runs + 1, next_run = ? WHERE name = ?`,
        )
        .run(started, status, error, nowMs() + t.intervalMs, t.name)
      if (t.pendingTrigger) {
        t.pendingTrigger = false
        void this.execute(t)
      }
    }
  }

  status(): Array<{ name: string; lastRun: number | null; lastStatus: string | null; lastError: string | null; intervalMs: number; runs: number }> {
    return (
      this.db.query('SELECT name, last_run, last_status, last_error, interval_ms, runs FROM tasks ORDER BY name').all() as Array<{
        name: string; last_run: number | null; last_status: string | null; last_error: string | null; interval_ms: number; runs: number
      }>
    ).map((r) => ({
      name: r.name, lastRun: r.last_run, lastStatus: r.last_status, lastError: r.last_error,
      intervalMs: r.interval_ms, runs: r.runs,
    }))
  }
}
