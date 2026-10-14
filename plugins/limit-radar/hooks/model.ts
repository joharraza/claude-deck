// Limit Radar's pure model: readings in, a Scene out, and the Scene as the
// card the deck band shows. No `$` here.
import type { SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { DeckCard, Meter, Pause, Window } from '../types'

export const WARN_AT = 75
export const HOT_AT = 90
export const GUARD_AT = 90

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const FIVE_HOURS = 5 * HOUR
export const SEVEN_DAYS = 7 * 24 * HOUR
export const RESUMED_SHOWN_MS = 90_000
export const HELD_SHOWN_MS = 10 * MINUTE

export const TONE = {
  clear: '#4ade80',
  watch: '#fbbf24',
  hot: '#f87171',
  paused: '#818cf8',
  due: '#34d399',
  held: '#fb923c',
  resumed: '#34d399',
} as const

export type Mode = keyof typeof TONE

export type Lane = {
  key: 'five' | 'seven' | 'ctx'
  label: string
  pct: number
  /** Short note after the value: the reset countdown. */
  note: string
  /** How far through its window the clock is, 0..1; null where none. */
  mark: number | null
}

export type Action = 'now' | 'dismiss' | 'auto-on' | 'auto-off' | 'allow'

export type Scene = {
  mode: Mode
  tone: string
  chip: string
  headline: string
  sub: string
  lanes: Lane[]
  center: { big: string; small: string }
  /** Smooth countdown while paused: what is left and the whole wait. */
  countdown: { leftMs: number; totalMs: number } | null
  buttons: { key: Action; label: string; isPrimary?: boolean }[]
  /** Critical scenes show even when the band is hidden, and have no ✕. */
  isCritical: boolean
}

// ---------- readings ----------

export function toWindow(limit: SessionRateLimit | undefined): Window | null {
  if (!limit) return null
  const at = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN

  return {
    pct: Math.round(limit.percentUsed),
    resetsAt: Number.isFinite(at) ? at : null,
  }
}

export function toMeter(
  limits: readonly SessionRateLimit[],
  context: SessionContextUsage,
): Meter {
  return {
    five: toWindow(limits.find(l => l.kind === 'five_hour')),
    seven: toWindow(limits.find(l => l.kind === 'seven_day')),
    ctx: context.percent ?? null,
  }
}

/**
 * A reading only moves when a request comes back, so an idle session keeps the
 * last one. A window whose reset time has passed has started over: it reads as
 * empty until the next request reports the new window.
 */
export function settle(m: Meter, now: number): Meter {
  const fresh = (w: Window | null): Window | null => (w && w.resetsAt !== null && w.resetsAt <= now ? { pct: 0, resetsAt: null } : w)
  const five = fresh(m.five)
  const seven = fresh(m.seven)
  return five === m.five && seven === m.seven ? m : { ...m, five, seven }
}

export function hasReading(m: Meter | null): m is Meter {
  return m !== null && (m.five !== null || m.seven !== null || m.ctx !== null)
}

export function isSpent(m: Meter): boolean {
  return [m.five, m.seven].some(w => w !== null && w.pct >= 100)
}

/** When to resume after the limit was hit, from the windows that ran out. */
export function planPause(
  m: Meter,
  prev: Pause | null,
  now: number,
  graceMs: number,
  retryMs: number,
): Pause {
  const windows = [m.five, m.seven].filter((w): w is Window => w !== null)
  const spent = windows.filter(w => w.pct >= 100)
  const near = spent.length > 0 ? spent : windows.filter(w => w.pct >= 95)
  const resets = near
    .map(w => w.resetsAt)
    .filter((t): t is number => t !== null && t > now)
  const resetsAt = resets.length > 0 ? Math.max(...resets) : null

  return {
    resumeAt: resetsAt !== null ? resetsAt + graceMs : now + retryMs,
    isKnown: resetsAt !== null,
    since: prev?.since ?? now,
    tries: prev?.tries ?? 0,
    isDue: false,
  }
}

// ---------- formatting ----------

export function span(ms: number): string {
  if (ms <= 30_000) return 'moments'
  const mins = Math.ceil(ms / MINUTE)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`

  return `${m}m`
}

/** h:mm for the radar's center. */
export function clock(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / MINUTE))

  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}

export const clamp01 = (v: number): number =>
  Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)

  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  const k = clamp01(t)
  const c = (x: number, y: number) =>
    Math.round(x + (y - x) * k).toString(16).padStart(2, '0')

  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`
}

/** Usage heat: green, through lime and amber, to red. */
export function heat(f: number): string {
  const k = clamp01(f)
  if (k < 0.5) return mix('#4ade80', '#a3e635', k / 0.5)
  if (k < 0.75) return mix('#a3e635', '#fbbf24', (k - 0.5) / 0.25)

  return mix('#fbbf24', '#f87171', (k - 0.75) / 0.25)
}

/** Context tint: cyan through violet to magenta. */
export function cool(f: number): string {
  const k = clamp01(f)

  return k < 0.6 ? mix('#22d3ee', '#a78bfa', k / 0.6) : mix('#a78bfa', '#f472b6', (k - 0.6) / 0.4)
}

// ---------- pace ----------

export type Pace = {
  /** How far through the window the clock is, 0..1. */
  timeFrac: number | null
  /** Where usage lands at reset if the pace holds. */
  projected: number | null
  /** Time until the limit at this pace, when that comes before the reset. */
  etaMs: number | null
}

export function pace(w: Window | null, lengthMs: number, now: number): Pace {
  if (!w || w.resetsAt === null) return { timeFrac: null, projected: null, etaMs: null }
  const left = Math.max(0, w.resetsAt - now)
  const elapsed = Math.max(0, lengthMs - left)
  const timeFrac = clamp01(elapsed / lengthMs)
  if (elapsed < 10 * MINUTE || w.pct < 3 || w.pct >= 100) {
    return { timeFrac, projected: null, etaMs: null }
  }
  const rate = w.pct / elapsed
  const projected = Math.round(w.pct + rate * left)
  const eta = (100 - w.pct) / rate

  return { timeFrac, projected: Math.min(999, projected), etaMs: eta < left ? eta : null }
}

// ---------- the scene ----------

export type Snapshot = {
  meter: Meter | null
  pause: Pause | null
  isAuto: boolean
  allowedUntil: number
  heldAt: number
  resumedAt: number
  now: number
}

export function buildScene(s: Snapshot): Scene | null {
  const { meter: m, pause: p, isAuto, now } = s
  const five = m?.five ?? null
  const fivePace = pace(five, FIVE_HOURS, now)
  const sevenPace = pace(m?.seven ?? null, SEVEN_DAYS, now)

  const lanes: Lane[] = []
  if (five) {
    lanes.push({
      key: 'five',
      label: '5-HOUR',
      pct: five.pct,
      note: five.resetsAt ? `↻ ${span(five.resetsAt - now)}` : '',
      mark: fivePace.timeFrac,
    })
  }
  if (m?.seven) {
    lanes.push({
      key: 'seven',
      label: '7-DAY',
      pct: m.seven.pct,
      note: m.seven.resetsAt ? `↻ ${span(m.seven.resetsAt - now)}` : '',
      mark: sevenPace.timeFrac,
    })
  }
  if (m?.ctx !== null && m?.ctx !== undefined) {
    lanes.push({ key: 'ctx', label: 'CONTEXT', pct: m.ctx, note: 'of window', mark: null })
  }

  const autoNote = `auto-continue ${isAuto ? 'on' : 'off'}`
  const resetNote = five?.resetsAt ? `Resets in ${span(five.resetsAt - now)}` : 'Reset time not reported'
  const usage = five
    ? { big: `${five.pct}%`, small: '5-HOUR' }
    : m?.ctx !== null && m?.ctx !== undefined
      ? { big: `${m.ctx}%`, small: 'CONTEXT' }
      : { big: '—', small: 'NO READING' }

  const scene = (
    mode: Mode,
    chip: string,
    headline: string,
    sub: string,
    extra: Partial<Scene> = {},
  ): Scene => ({
    mode,
    tone: TONE[mode],
    chip,
    headline,
    sub,
    lanes,
    center: usage,
    countdown: null,
    buttons: [],
    isCritical: false,
    ...extra,
  })

  if (p && p.isDue) {
    return scene('due', 'RESET', 'Your usage limit has reset', 'Claude stopped mid-task. Pick it up where it left off.', {
      center: { big: '0:00', small: 'READY' },
      buttons: [
        { key: 'now', label: 'Continue now', isPrimary: true },
        { key: 'dismiss', label: 'Dismiss' },
      ],
      isCritical: true,
    })
  }
  if (p) {
    const left = Math.max(0, p.resumeAt - now)
    const unknown = p.isKnown ? '' : ' · reset time unknown, checking every 30 min'

    return scene(
      'paused',
      'PAUSED',
      isAuto ? `Claude continues on its own in ${span(left)}` : `Limit resets in ${span(left)}`,
      `Limit hit ${span(now - p.since)} ago · ${autoNote}${unknown}`,
      {
        center: { big: clock(left), small: 'TO RESET' },
        countdown: { leftMs: left, totalMs: Math.max(left, p.resumeAt - p.since) },
        buttons: isAuto
          ? [
              ...(p.isKnown ? [] : [{ key: 'now' as const, label: 'Try now' }]),
              { key: 'auto-off', label: 'Cancel auto-continue' },
            ]
          : [{ key: 'auto-on', label: 'Auto-continue at reset', isPrimary: true }],
        isCritical: true,
      },
    )
  }
  if (s.resumedAt > 0 && now - s.resumedAt < RESUMED_SHOWN_MS) {
    return scene('resumed', 'BACK', 'Back at work', 'The limit reset and Claude picked up where it stopped')
  }
  if (!hasReading(m)) return null

  const isHeld =
    five !== null &&
    s.heldAt > 0 &&
    now - s.heldAt < HELD_SHOWN_MS &&
    now >= s.allowedUntil &&
    five.pct >= GUARD_AT
  if (isHeld && five) {
    return scene('held', 'HELD', `Subagents on hold at ${five.pct}%`, `Holding them keeps a half-done agent from losing its work · ${resetNote.toLowerCase()}`, {
      buttons: [{ key: 'allow', label: 'Allow agents', isPrimary: true }],
      isCritical: true,
    })
  }
  if (!five) return scene('clear', 'CLEAR', `Context ${m.ctx ?? 0}% full`, 'No rate-limit reading on this plan')

  if (five.pct >= HOT_AT) {
    const head = fivePace.etaMs !== null ? `Limit in ~${span(fivePace.etaMs)} at this pace` : `${five.pct}% of the 5-hour window used`
    return scene('hot', 'HOT', head, `${resetNote} · subagents hold at ${GUARD_AT}% · ${autoNote}`)
  }
  if (fivePace.etaMs !== null) {
    return scene('watch', 'WATCH', `At this pace the limit hits in ${span(fivePace.etaMs)}`, `${resetNote} · ${autoNote}`)
  }
  if (five.pct >= WARN_AT) {
    return scene('watch', 'WATCH', `${five.pct}% of the 5-hour window used`, `${resetNote} · ${autoNote}`)
  }
  if (fivePace.projected !== null && fivePace.projected >= 85) {
    return scene('watch', 'WATCH', `On pace for ${fivePace.projected}% by reset`, `${resetNote} · ${autoNote}`)
  }
  const head = fivePace.projected !== null ? `On pace for ${fivePace.projected}% by reset` : `${100 - five.pct}% of your 5-hour window left`

  return scene('clear', 'CLEAR', head, `${resetNote} · ${autoNote}`)
}

// ---------- the deck's card ----------

const CARD: Record<Mode, { rank: number; tone: DeckCard['tone'] }> = {
  clear: { rank: -1, tone: 'ok' },
  watch: { rank: 1, tone: 'watch' },
  hot: { rank: 2, tone: 'hot' },
  paused: { rank: 3, tone: 'info' },
  due: { rank: 3, tone: 'ok' },
  held: { rank: 2, tone: 'watch' },
  resumed: { rank: 1, tone: 'ok' },
}

const ARGS: Record<Action, string> = { now: 'now', dismiss: 'dismiss', 'auto-on': 'auto on', 'auto-off': 'auto off', allow: 'allow' }

const sentence = (s: string) => (s === '' ? '' : `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}${/[.?!…]$/.test(s) ? '' : '.'}`)

/**
 * What the deck says for this scene: nothing while the limits are calm (the
 * gauges say it), one sentence and the scene's buttons otherwise. `window`
 * keys the card to the 5-hour window, so a ✕ lasts until the next one.
 */
export function toCard(sc: Scene | null, isHidden: boolean, window: number | null): DeckCard | null {
  if (sc === null || sc.mode === 'clear') return null
  if (isHidden && !sc.isCritical) return null
  const { rank, tone } = CARD[sc.mode]
  const first = sc.sub.split(' · ')[0] ?? ''
  return {
    id: `radar:${sc.mode}:${window ?? 0}`,
    rank,
    tone,
    text: `${sentence(sc.headline)} ${sentence(first)}`.trim(),
    command: 'radar',
    buttons: sc.buttons.map(b => ({ args: ARGS[b.key], label: b.label, ...(b.isPrimary ? { isPrimary: true } : {}) })),
    isCritical: sc.isCritical,
  }
}
