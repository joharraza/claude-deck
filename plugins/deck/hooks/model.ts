// The deck's pure model: what Limit Radar, Baton and Workbench hold, in; the
// band's gauges, its corner and its one message, out. No `$` here, so the
// desktop drawing (art.ts) and the terminal strip (strip.tsx) share it.

export const MINUTE = 60_000

export const TONE = {
  ok: '#4ade80',
  watch: '#fbbf24',
  hot: '#f87171',
  gold: '#fbbf24',
  info: '#22d3ee',
  ctx: '#a78bfa',
  calm: '#94a3b8',
} as const

/** Baton's colors, one per thing it can be doing: the tank shows them. */
export const BATON_TONE: Record<string, string> = {
  light: '#22d3ee',
  growing: '#60a5fa',
  ready: '#2dd4bf',
  armed: '#fbbf24',
  cold: '#fbbf24',
  holding: '#94a3b8',
  judging: '#22d3ee',
  compacting: '#a78bfa',
  handed: '#34d399',
}

/** Baton is working on the context, or about to: the tank bubbles. */
const BATON_BUSY = new Set(['growing', 'armed', 'judging', 'compacting'])

export type Window = { pct: number; resetsAt: number | null }

/** A mod's card, as each of the three declares it in its contract. */
export type Card = {
  id: string
  rank: number
  tone: 'ok' | 'watch' | 'hot' | 'gold' | 'info'
  text: string
  command: string
  buttons: readonly { args: string; label: string; isPrimary?: boolean }[]
  isCritical: boolean
  isQuietWhileWorking?: boolean
}

export type BenchIn = {
  name: string
  branch: string
  isDefault: boolean
  changed: number
  conflicts: number
  unpushed: number
  hasRemote: boolean
  behind: number
}

export type Inputs = {
  five: Window | null
  seven: Window | null
  /** Context as a percent of the window, from Limit Radar; a fallback for tokens. */
  ctxPct: number | null
  tokens: number
  /** The model's context window in tokens; 0 when not known yet. */
  window: number
  /** Where Baton starts looking for a break. */
  minTokens: number
  /** What Baton is doing ('light', 'armed', …); '' when not known. */
  batonMode: string
  bench: BenchIn | null
  ports: readonly number[]
  busy: '' | 'push' | 'stop'
  /** Cards in tie-break order: limits first, then git, then the handoff. */
  cards: readonly (Card | null | undefined)[]
  snoozed: string
  isWorking: boolean
  now: number
}

export type Tube = {
  key: 'five' | 'seven' | 'ctx'
  label: string
  /** 0..1 */
  fill: number
  tone: string
  value: string
  note: string
  /** Where the handoff threshold sits on the tube, 0..1. */
  notch: number | null
  /** The tube pulses: a limit past 90%, or the context while a hand-off counts down (in gold). */
  isHot: boolean
  /** How far through its window the clock is, 0..1; null where there is no window. */
  mark: number | null
  /** The gradient along the whole tube. */
  paint: 'heat' | 'ctx'
}

export type Motion = 'calm' | 'rise' | 'fork' | 'knot' | 'lone' | 'busy'

export type Slot =
  | { kind: 'git'; name: string; branch: string; detail: string; tone: string; motion: Motion }
  | {
      kind: 'radar'
      /** 0..1 each: the 5-hour and 7-day windows and the context against its window. */
      five: number
      seven: number
      ctx: number
      fiveTone: string
      /** Baton's color for what it is doing now. */
      ctxTone: string
      /** Baton's line on the tank, 0..1. */
      notch: number
      /** Baton is working on the context: the tank bubbles. */
      isBusy: boolean
      /** Baton wants a hand-off: the tank's ring pulses. */
      isCalling: boolean
      /** The radar's center: the 5-hour figure. */
      center: string
      tokensLabel: string
      label: string
      detail: string
    }

export type Message = { tone: string; text: string; card: Card | null }

export type Deck = { tubes: Tube[]; slot: Slot; message: Message; alt: string }

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

export function kTok(n: number): string {
  if (n >= 1_000_000) return `${n >= 10_000_000 ? Math.round(n / 1_000_000) : Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(Math.round(n))
}

export const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)

function mix(a: string, b: string, t: number): string {
  const rgb = (h: string) => {
    const n = parseInt(h.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
  }
  const [ar, ag, ab] = rgb(a)
  const [br, bg, bb] = rgb(b)
  const k = clamp01(t)
  const c = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, '0')
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`
}

/** Usage heat: the band's green, warming to amber past 60% and to red at the top. */
export function heat(f: number): string {
  const k = clamp01(f)
  if (k < 0.6) return TONE.ok
  if (k < 0.8) return mix(TONE.ok, TONE.watch, (k - 0.6) / 0.2)
  return mix(TONE.watch, TONE.hot, (k - 0.8) / 0.2)
}

/** Context tint, as Limit Radar paints it: cyan through violet to magenta. */
export function cool(f: number): string {
  const k = clamp01(f)
  return k < 0.6 ? mix('#22d3ee', '#a78bfa', k / 0.6) : mix('#a78bfa', '#f472b6', (k - 0.6) / 0.4)
}

/** Usage tone, on Limit Radar's lines: watch from 75%, hot from 90%. */
export const usageTone = (pct: number): string => (pct >= 90 ? TONE.hot : pct >= 75 ? TONE.watch : TONE.ok)

// ---------- the deck ----------

export const FIVE_HOURS = 5 * 60 * MINUTE
export const SEVEN_DAYS = 7 * 24 * 60 * MINUTE

function limitTube(key: 'five' | 'seven', label: string, w: Window | null, now: number): Tube {
  const base = { key, label, notch: null, paint: 'heat' as const }
  if (w === null) return { ...base, fill: 0, tone: TONE.calm, value: '—', note: 'no reading yet', isHot: false, mark: null }
  const note = w.resetsAt !== null ? `resets ${span(w.resetsAt - now)}` : w.pct === 0 ? 'new window' : ''
  const length = key === 'five' ? FIVE_HOURS : SEVEN_DAYS
  const mark = w.resetsAt !== null ? clamp01(1 - (w.resetsAt - now) / length) : null
  return { ...base, fill: clamp01(w.pct / 100), tone: usageTone(w.pct), value: `${w.pct}%`, note, isHot: w.pct >= 90, mark }
}

function ctxTube(i: Inputs): Tube {
  if (i.tokens > 0) {
    // Against the model's own window; Baton's line is a notch on it.
    const window = i.window > 0 ? i.window : Math.max(i.tokens, i.minTokens * 2)
    return {
      key: 'ctx',
      label: 'ctx',
      fill: clamp01(i.tokens / window),
      // The context tint, as Limit Radar drew it: cyan, violet, then magenta as it fills.
      tone: cool(i.tokens / window),
      value: kTok(i.tokens),
      note: `of ${kTok(window)} · hand-off at ${kTok(i.minTokens)}`,
      notch: clamp01(i.minTokens / window),
      // Gold pulse while Baton counts down to a hand-off, in step with the tank.
      isHot: i.batonMode === 'armed',
      mark: null,
      paint: 'ctx',
    }
  }
  if (i.ctxPct !== null) {
    return { key: 'ctx', label: 'ctx', fill: clamp01(i.ctxPct / 100), tone: TONE.ctx, value: `${i.ctxPct}%`, note: 'of window', notch: null, isHot: false, mark: null, paint: 'ctx' }
  }
  return { key: 'ctx', label: 'ctx', fill: 0, tone: TONE.calm, value: '—', note: 'no reading yet', notch: null, isHot: false, mark: null, paint: 'ctx' }
}

function gitSlot(b: BenchIn, ports: readonly number[], busy: Inputs['busy']): Slot {
  const parts: string[] = []
  if (b.conflicts > 0) parts.push(`${b.conflicts} conflicted`)
  parts.push(b.changed > 0 ? `${b.changed} changed` : 'clean')
  if (b.unpushed > 0) parts.push(b.hasRemote ? `↑${b.unpushed}` : 'no remote')
  if (b.behind > 0) parts.push(`↓${b.behind}`)
  if (ports.length > 0) parts.push(ports.map(p => `:${p}`).join(' '))
  const motion: Motion = busy
    ? 'busy'
    : b.conflicts > 0
      ? 'knot'
      : b.isDefault && b.changed > 0
        ? 'fork'
        : b.unpushed > 0
          ? b.hasRemote
            ? 'rise'
            : 'lone'
          : 'calm'
  const tone = motion === 'busy' ? TONE.info : motion === 'knot' ? TONE.hot : motion === 'calm' ? TONE.ok : TONE.watch
  return { kind: 'git', name: b.name, branch: b.branch, detail: parts.join(' · '), tone, motion }
}

function radarSlot(i: Inputs, ctx: Tube): Slot {
  const pct = i.five?.pct ?? 0
  const detail = i.ports.length > 0 ? i.ports.map(p => `:${p}`).join(' ') : i.tokens >= i.minTokens ? 'session long' : 'session light'
  return {
    kind: 'radar',
    five: clamp01(pct / 100),
    seven: clamp01((i.seven?.pct ?? 0) / 100),
    ctx: ctx.fill,
    fiveTone: usageTone(pct),
    ctxTone: BATON_TONE[i.batonMode] ?? TONE.ctx,
    notch: ctx.notch ?? 0.5,
    isBusy: BATON_BUSY.has(i.batonMode),
    isCalling: ['ready', 'armed', 'cold'].includes(i.batonMode),
    center: i.five ? `${pct}%` : '—',
    tokensLabel: ctx.value,
    label: 'no repo',
    detail,
  }
}

/** The one card on show: the most urgent; on a tie, the first in `cards`. */
export function pick(i: Pick<Inputs, 'cards' | 'snoozed' | 'isWorking'>): Card | null {
  let best: Card | null = null
  for (const c of i.cards) {
    if (!c) continue
    if (c.isQuietWhileWorking && i.isWorking) continue
    if (!c.isCritical && c.id === i.snoozed) continue
    if (best === null || c.rank > best.rank) best = c
  }
  return best
}

function calmText(i: Inputs): string {
  if (i.isWorking) return i.tokens > 0 ? `Working · ${kTok(i.tokens)} in context.` : 'Working.'
  if (i.tokens <= 0) return 'All clear.'
  return i.tokens < i.minTokens
    ? `All clear. ${kTok(i.tokens)} in context, plenty of room.`
    : `All clear. ${kTok(i.tokens)} in context; Baton hands off at the next break.`
}

/** The band, or null while nothing has been measured yet. */
export function buildDeck(i: Inputs): Deck | null {
  const hasAny = i.five !== null || i.seven !== null || i.ctxPct !== null || i.tokens > 0 || i.bench !== null
  if (!hasAny) return null
  const ctx = ctxTube(i)
  const tubes = [limitTube('five', '5h', i.five, i.now), limitTube('seven', '7d', i.seven, i.now), ctx]
  const slot = i.bench ? gitSlot(i.bench, i.ports, i.busy) : radarSlot(i, ctx)
  const card = pick(i)
  const message: Message = card ? { tone: TONE[card.tone], text: card.text, card } : { tone: TONE.calm, text: calmText(i), card: null }

  const gauges = tubes.map(t => `${t.label} ${t.value}${t.note ? ` (${t.note})` : ''}`).join(', ')
  const corner = slot.kind === 'git' ? `${slot.name} on ${slot.branch}: ${slot.detail}` : `no repository, ${slot.detail}`
  const actions = card && card.buttons.length > 0 ? ` Actions: ${card.buttons.map(b => b.label).join(', ')}.` : ''
  return { tubes, slot, message, alt: `${gauges}. ${corner}. ${message.text}${actions}` }
}
