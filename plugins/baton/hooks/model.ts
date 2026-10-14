// Baton's pure model: what counts as the end of a task, what vetoes a
// handoff, the judge's question, the handoff instructions, and the scene
// with the card the deck band shows. No `$` here; register.tsx feeds it and
// acts on what it says.
import type { SessionMessage } from 'claude-code'

import type { BatonState, BatonPrefs, DeckCard, Mark, Signal, Veto } from '../types'

export const MINUTE = 60_000
export const STRONG = 0.6
export const MEDIUM = 0.3
export const STRONG_IDLE_MS = 8 * MINUTE
/** Medium cases wait until just before the 1-hour prompt cache goes cold. */
export const MEDIUM_IDLE_MS = 45 * MINUTE
export const RATE_SHOWN_MS = 30 * MINUTE
/** The prompt cache lives an hour: past that, the next request re-reads the whole context at full price. */
export const COLD_MS = 60 * MINUTE

export const DEFAULT_SETTINGS: BatonPrefs = { mode: 'auto', minTokens: 100_000, bar: 0.75 }

export const EMPTY: BatonState = {
  tokens: 0,
  window: 0,
  signals: [],
  vetoes: [],
  marks: [],
  armed: null,
  phase: 'idle',
  unrated: null,
  removed: 0,
  savedTokens: 0,
  handoffs: 0,
  lastNote: '',
  lastNoteAt: 0,
  lastTurnAt: 0,
  coldSkippedAt: 0,
}

// ---------- signals ----------

export const WEIGHT: Record<Signal['kind'], number> = {
  'wrap-up': 0.65,
  shipped: 0.45,
  published: 0.35,
  committed: 0.3,
  delivered: 0.3,
  'todos-done': 0.3,
  'you-said-done': 0.3,
}

export const LABEL: Record<Signal['kind'], string> = {
  'wrap-up': 'wrapped up',
  shipped: 'shipped',
  published: 'published',
  committed: 'committed',
  delivered: 'file sent',
  'todos-done': 'todos done',
  'you-said-done': 'you said done',
}

export const VETO_LABEL: Record<Veto, string> = {
  'todos-open': 'a todo is in progress',
  'agents-running': 'a subagent is running',
  'paused-work': 'work was paused, not finished',
  'awaiting-answer': 'Claude asked you something',
}

/** Wrap-up skills (`wrapup`, `notes-wrapup`, `wrap-up`): when one finishes, the work is saved and done. */
const WRAP_SKILLS = /^([a-z0-9-]+-)?wrap-?up$/i
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--\S+))*\s+`
const SHIPPED = new RegExp(String.raw`${GIT}(push|merge)\b|\bgh\s+pr\s+(create|merge)\b`)
const COMMITTED = new RegExp(String.raw`${GIT}commit\b`)

export type ToolSeen = { tool: string; input: Record<string, unknown>; isOk: boolean }

/** A tool call's boundary signal, if it is one. */
export function toolSignal(t: ToolSeen): Signal['kind'] | null {
  if (!t.isOk) return null
  if (t.tool === 'Skill' && typeof t.input.skill === 'string' && WRAP_SKILLS.test(t.input.skill.replace(/^.*:/, ''))) return 'wrap-up'
  if ((t.tool === 'Bash' || t.tool === 'PowerShell') && typeof t.input.command === 'string') {
    if (SHIPPED.test(t.input.command)) return 'shipped'
    if (COMMITTED.test(t.input.command)) return 'committed'
  }
  if (t.tool === 'Artifact' && (t.input.action === undefined || t.input.action === 'publish') && t.input.asset !== true) return 'published'
  if (t.tool === 'SendUserFile') return 'delivered'
  if (t.tool === 'TodoWrite' && Array.isArray(t.input.todos)) {
    const todos = t.input.todos as { status?: string }[]
    if (todos.length > 0 && todos.every(x => x.status === 'completed')) return 'todos-done'
  }
  return null
}

export function todosOpen(input: Record<string, unknown>): boolean | null {
  if (!Array.isArray(input.todos)) return null
  return (input.todos as { status?: string }[]).some(x => x.status === 'in_progress' || x.status === 'pending')
}

const DONE_SAID = /\b(that'?s it|that is it|enough for today|all good|looks good|perfect|it'?s final|is final|approved?|excellent|great,? thanks|thank you|done for (now|today)|we'?re done|all done|works now|it works)\b/i
const WRAP_SAID = /\b(wrap (this|it|both|everything)( up)?|wrap up|save this|remember this)\b/i
const PAUSE_SAID = /\b(pause|on hold|blocked|waiting (for|on)|half[- ]done|in progress|mid[- ]?task|don'?t (wrap|compact)|keep (this|it) open|come back to (this|it))\b/i

/** What a prompt the person typed says about the task boundary. */
export function promptSignal(text: string): { signal: Signal['kind'] | null; isPause: boolean } {
  const t = text.trim()
  const isPause = PAUSE_SAID.test(t)
  if (WRAP_SAID.test(t)) return { signal: 'wrap-up', isPause }
  if (t.length <= 160 && DONE_SAID.test(t) && !isPause) return { signal: 'you-said-done', isPause }
  return { signal: null, isPause }
}

/** Claude ended its turn on a question: the next prompt will lean on this context. */
export function isAwaitingAnswer(answer: string): boolean {
  const tail = answer.trim().slice(-400)
  if (tail.endsWith('?')) return true
  return /\b(want me to|shall i|should i|do you want|which (one|option)|confirm\??|let me know (if|which|when))\b[^.]*\??\s*$/i.test(tail)
}

/** A prompt that leans on what was just said, so it is never a fresh start. */
export function isContinuation(text: string): boolean {
  return /^\s*(yes|yeah|yep|ok(ay)?|sure|go( ahead)?|do (it|that|this|both)|continue|and |also|but |then |same|again|try again|fix (it|this|that)|this |that |it |the (error|issue|above)|above|why )/i.test(text)
}

export function score(signals: readonly Signal[]): number {
  if (signals.length === 0) return 0
  const kinds = new Set(signals.map(s => s.kind))
  const top = Math.max(...[...kinds].map(k => WEIGHT[k]))
  return Math.min(1, top + 0.1 * (kinds.size - 1))
}

/** Whether and when to hand off while the person is away. */
export function planIdle(
  st: BatonState,
  set: BatonPrefs,
  now: number,
): { fireAt: number; armedAt: number; needsJudge: boolean } | null {
  if (set.mode !== 'auto' || st.vetoes.length > 0 || st.tokens < set.minTokens) return null
  const s = score(st.signals)
  if (s >= STRONG) return { fireAt: now + STRONG_IDLE_MS, armedAt: now, needsJudge: false }
  if (s >= MEDIUM) return { fireAt: now + MEDIUM_IDLE_MS, armedAt: now, needsJudge: true }
  return null
}

/** Ratings teach the bar: a mid-task handoff raises it, a good one eases it. */
export function learn(bar: number, isGood: boolean): number {
  return Math.round(Math.min(0.95, Math.max(0.6, bar + (isGood ? -0.02 : 0.05))) * 100) / 100
}

// ---------- the judge ----------

export const JUDGE_SYSTEM = `You decide whether a work session with an AI assistant has reached the end of a task.
You see what the current stretch of work has been about, the person's recent prompts, the files touched, the start of the assistant's last answer and, when there is one, the person's NEW prompt.
Say "break": true only when the previous task is finished and everything still needed could be carried by a short handoff note (what was done, decisions and reasons, open items, file paths and links).
Say false when the new prompt (or the next step) depends on exact recent details: an error being debugged, a draft being revised line by line, an answer to a question the assistant asked, work that was paused rather than finished.
Reply with one JSON object only: {"break": true|false, "confidence": 0.0-1.0}`

const TAG = /<(system-reminder|ide_[a-z_]+|pasted_content[^>]*|artifact-view-context[^>]*)>[\s\S]*?<\/[a-z_-]+>/g
const SUMMARY = /^This session is being continued from a previous conversation/
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** A short digest of the current stretch of work, for the judge. */
export function digest(messages: readonly SessionMessage[], next?: string): string | null {
  const prompts: string[] = []
  let files: string[] = []
  let lastAnswer = ''
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const t of m.toolUses) {
        const p = t.input.file_path ?? t.input.notebook_path ?? t.input.path
        if (EDITS.has(t.tool) && typeof p === 'string') files.push(p.split(/[\\/]/).at(-1) ?? p)
      }
      if (m.text.trim() !== '') lastAnswer = m.text.trim()
      continue
    }
    if (m.toolResults?.length) continue
    const text = m.text.replace(TAG, '').trim()
    if (text === '' || text.startsWith('<')) continue
    if (SUMMARY.test(text)) {
      prompts.length = 0
      files = []
      continue
    }
    prompts.push(text)
  }
  if (prompts.length === 0) return null
  const first = prompts[0] ?? ''
  const recent = prompts.slice(-3)
  const uniq = [...new Set(files)].slice(-12)
  return [
    `Stretch started with: ${JSON.stringify(clip(first, 400))}`,
    `Recent prompts: ${recent.map(p => JSON.stringify(clip(p, 300))).join(' | ')}`,
    `Files edited: ${uniq.length > 0 ? uniq.join(', ') : 'none'}`,
    `Assistant's last answer begins: ${JSON.stringify(clip(lastAnswer, 500))}`,
    next === undefined ? 'No new prompt yet: the person stepped away.' : `NEW prompt: ${JSON.stringify(clip(next, 600))}`,
  ].join('\n')
}

export function verdict(text: string): { isBreak: boolean; confidence: number } | null {
  const m = text.match(/\{[\s\S]*?\}/)
  if (!m) return null
  try {
    const v = JSON.parse(m[0]) as { break?: unknown; confidence?: unknown }
    if (typeof v.break !== 'boolean') return null
    const c = typeof v.confidence === 'number' ? Math.max(0, Math.min(1, v.confidence)) : 0
    return { isBreak: v.break, confidence: c }
  } catch {
    return null
  }
}

// ---------- the handoff ----------

export function handoff(why: string, next?: string, transcript?: string): string {
  return [
    `This compaction runs at a task boundary (${why}). Write the summary as a HANDOFF for whatever comes next, not as a history of this conversation.`,
    ...(next === undefined ? [] : [`The next task starts with this prompt; keep what it needs: ${JSON.stringify(next.slice(0, 600))}`]),
    'Keep, in this order and in plain words:',
    '1. What was just finished, in two or three sentences, with the files, links, artifact URLs, commit hashes and branches it produced.',
    '2. Open items and follow-ups the user asked for or agreed to, in the user\'s own words where possible.',
    '3. Work that is paused or waiting: what it is, why it stopped, and what must happen before it resumes. Never present paused work as the next step.',
    '4. Decisions and preferences that still apply, each with its reason, including corrections the user gave about style, wording or approach.',
    '5. Exact file paths, folder buckets, URLs and names of people involved, so nothing has to be searched for again.',
    'Leave out anything already in CLAUDE.md or the memory files, raw tool output, and dead ends that no longer matter.',
    ...(transcript === undefined ? [] : [`End the summary with this line: "Full pre-handoff transcript: ${transcript}. If a detail you need is missing, search that file before asking the user."`]),
  ].join('\n')
}

// ---------- formatting ----------

export function kTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(Math.round(n))
}

export function span(ms: number): string {
  if (ms <= 30_000) return 'moments'
  const mins = Math.ceil(ms / MINUTE)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

// ---------- the scene ----------

export const TONE = {
  light: '#4ade80',
  growing: '#60a5fa',
  ready: '#2dd4bf',
  armed: '#fbbf24',
  holding: '#94a3b8',
  cold: '#fbbf24',
  judging: '#22d3ee',
  compacting: '#a78bfa',
  handed: '#34d399',
} as const

export type Mode = keyof typeof TONE
export type Action = 'now' | 'later' | 'good' | 'bad'

export type Scene = {
  mode: Mode
  tone: string
  chip: string
  headline: string
  sub: string
  /** Context against twice the threshold, and the threshold on that scale. */
  fill: number
  threshold: number
  tokensLabel: string
  /** The relay track since the session began. */
  track: { x: number; kind: Mark['kind']; label: string }[]
  /** Signals and vetoes in play now, as short chips. */
  chips: { text: string; isVeto: boolean }[]
  saved: string
  perRequest: string
  countdown: { leftMs: number; totalMs: number } | null
  buttons: { key: Action; label: string; isPrimary?: boolean }[]
  isCritical: boolean
}

/** `isIdle`: no turn is running, so a cold cache is worth saying. */
export function buildScene(st: BatonState, set: BatonPrefs, now: number, isIdle = true): Scene | null {
  const minTokens = set.minTokens
  const isQuiet = st.tokens < minTokens * 0.4 && st.handoffs === 0 && st.unrated === null
  if (isQuiet || st.tokens === 0) return null

  const s = score(st.signals)
  const top = Math.max(st.removed + st.tokens, ...st.marks.map(m => m.pos), 1)
  const track = st.marks.map(m => ({ x: Math.min(1, m.pos / (top * 1.04)), kind: m.kind, label: m.label }))
  const chips = [
    ...[...new Set(st.signals.map(x => x.kind))].map(k => ({ text: LABEL[k], isVeto: false })),
    ...st.vetoes.map(v => ({ text: VETO_LABEL[v], isVeto: true })),
  ]
  const lastHandoff = [...st.marks].reverse().find(m => m.kind === 'handoff')
  const perRequest = lastHandoff?.before !== undefined && lastHandoff.after !== undefined ? `−${kTok(lastHandoff.before - lastHandoff.after)}` : ''

  const scene = (mode: Mode, chip: string, headline: string, sub: string, extra: Partial<Scene> = {}): Scene => ({
    mode,
    tone: TONE[mode],
    chip,
    headline,
    sub,
    // The tank's scale: Baton's threshold sits halfway up, so the level reads
    // as "how close to a handoff", whatever the model's window.
    fill: Math.min(1, st.tokens / (minTokens * 2)),
    threshold: 0.5,
    tokensLabel: kTok(st.tokens),
    track,
    chips,
    saved: st.savedTokens > 0 ? kTok(st.savedTokens) : '0',
    perRequest,
    countdown: null,
    buttons: [],
    isCritical: false,
    ...extra,
  })

  if (st.phase === 'compacting') {
    return scene('compacting', 'HANDING OFF', 'Writing the handoff summary…', 'Open work, decisions and file paths go into the summary', { isCritical: true })
  }
  if (st.phase === 'judging') {
    return scene('judging', 'CHECKING', 'Is this a natural break?', 'A quick Haiku check before your prompt runs')
  }
  if (st.unrated && now - st.unrated.at < RATE_SHOWN_MS) {
    const u = st.unrated
    return scene('handed', 'HANDED OFF', `Handed off ${kTok(u.before)} → ${kTok(u.after)}`, `${u.why} · each request now skips ${kTok(u.before - u.after)}. Right moment?`, {
      buttons: [
        { key: 'good', label: '👍 Right moment', isPrimary: true },
        { key: 'bad', label: '👎 I was mid-task' },
      ],
      isCritical: true,
    })
  }
  if (st.armed) {
    const left = Math.max(0, st.armed.fireAt - now)
    return scene(
      'armed',
      'ARMED',
      `Handing off in ${span(left)} if you stay away`,
      st.armed.needsJudge ? 'A Haiku check confirms the task is finished first · a new prompt cancels' : 'A new prompt cancels this; Baton judges it then',
      {
        countdown: { leftMs: left, totalMs: Math.max(left, st.armed.fireAt - st.armed.armedAt) },
        buttons: [
          { key: 'now', label: 'Hand off now', isPrimary: true },
          { key: 'later', label: 'Not now' },
        ],
        isCritical: true,
      },
    )
  }
  const isCold =
    isIdle &&
    st.phase === 'idle' &&
    st.vetoes.length === 0 &&
    st.lastTurnAt > 0 &&
    now - st.lastTurnAt >= COLD_MS &&
    st.coldSkippedAt < st.lastTurnAt &&
    st.tokens >= minTokens * 0.5
  if (isCold) {
    return scene('cold', 'COLD', 'Cache went cold while you were away', `Your next message re-reads all ${kTok(st.tokens)} at full cost`, {
      buttons: [
        { key: 'now', label: 'Hand off now', isPrimary: true },
        { key: 'later', label: 'Not now' },
      ],
    })
  }
  if (st.tokens >= minTokens && st.vetoes.length > 0) {
    return scene('holding', 'HOLDING', `${kTok(st.tokens)} in context · holding it, mid-task`, `Baton waits: ${st.vetoes.map(v => VETO_LABEL[v]).join(', ')}`)
  }
  if (st.tokens >= minTokens && s >= MEDIUM) {
    return scene('ready', 'BREAK', 'Good moment to hand off', `${set.mode === 'ask' ? 'Ask mode' : 'Auto mode'} · the next task would start on a short summary`, {
      buttons: [
        { key: 'now', label: 'Hand off now', isPrimary: true },
        { key: 'later', label: 'Not now' },
      ],
    })
  }
  if (st.tokens >= minTokens) {
    return scene('growing', 'WATCHING', `${kTok(st.tokens)} re-read on every request`, 'Baton hands off at the next wrap-up, push or natural break')
  }
  const note = st.lastNote && now - st.lastNoteAt < 10 * MINUTE ? st.lastNote : `Baton steps in from ${kTok(minTokens)}`
  return scene('light', 'LIGHT', `Context light · ${kTok(st.tokens)}`, note)
}

// ---------- the deck's card ----------

const ARGS: Record<Action, string> = { now: 'now', later: 'later', good: 'good', bad: 'bad' }

/**
 * What the deck says for this scene: one plain sentence and its buttons;
 * nothing while the context is light (the ctx gauge says it).
 */
export function toCard(sc: Scene | null, st: BatonState, isHidden: boolean): DeckCard | null {
  if (sc === null || sc.mode === 'light') return null
  if (isHidden && !sc.isCritical) return null
  const signals = [...new Set(st.signals.map(x => LABEL[x.kind]))].join(' + ')
  const at = (rank: number, tone: DeckCard['tone'], text: string, quiet = false): DeckCard => ({
    id: `baton:${sc.mode}:${st.handoffs}:${st.lastTurnAt}`,
    rank,
    tone,
    text,
    command: 'baton',
    buttons: sc.buttons.map(b => ({
      args: ARGS[b.key],
      label: b.key === 'good' ? 'Right moment' : b.key === 'bad' ? 'I was mid-task' : b.label,
      ...(b.isPrimary ? { isPrimary: true } : {}),
    })),
    isCritical: sc.isCritical,
    ...(quiet ? { isQuietWhileWorking: true } : {}),
  })
  switch (sc.mode) {
    case 'compacting':
      return at(3, 'info', 'Writing the handoff summary. Open work, decisions and file paths go into it.')
    case 'judging':
      return at(1, 'info', 'Checking whether this is a natural break before your prompt runs.')
    case 'handed':
      return at(2, 'ok', `${sc.headline}. Right moment?`)
    case 'armed':
      return at(2, 'gold', `${sc.headline}. A new prompt cancels it.`)
    case 'cold':
      return at(1, 'gold', `${sc.headline}. ${sc.sub}.`, true)
    case 'ready':
      return at(1, 'gold', `Good moment to hand off${signals ? ` (${signals})` : ''}. The next task starts from a short summary, not ${sc.tokensLabel}.`, true)
    case 'holding':
      return at(0, 'info', `${sc.tokensLabel} in context, held mid-task: ${st.vetoes.map(v => VETO_LABEL[v]).join(', ')}.`, true)
    default:
      return at(0, 'info', `${sc.tokensLabel} re-read on every request. Baton hands off at the next natural break.`, true)
  }
}
