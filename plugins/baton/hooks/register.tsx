import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BatonState, BatonPrefs, Signal, Veto } from '../types'
import type { Action } from './model.ts'
import {
  DEFAULT_SETTINGS,
  EMPTY,
  JUDGE_SYSTEM,
  LABEL,
  MEDIUM,
  MINUTE,
  WEIGHT,
  buildScene,
  digest,
  handoff,
  isAwaitingAnswer,
  isContinuation,
  kTok,
  learn,
  planIdle,
  promptSignal,
  score,
  span,
  toCard,
  toolSignal,
  todosOpen,
  verdict,
} from './model.ts'

const TICK_MS = 20_000
const DEFER_MS = 120
const JUDGE_TIMEOUT_MS = 12_000
const PERSON = new Set(['composer', 'bridge', 'sdk'])
const MENTION = /(^|\s)@\S/

const cardA = atom({ plugin: 'baton', key: 'card' } as const, null)
const modeA = atom({ plugin: 'baton', key: 'mode' } as const, 'light')
const stateA = atom({ plugin: 'baton', key: 'state' } as const, EMPTY)
const settingsA = atom({ plugin: 'baton', key: 'prefs' } as const, DEFAULT_SETTINGS)
const hiddenA = atom({ plugin: 'baton', key: 'isHidden' } as const, false)
const minuteA = atom({ plugin: 'baton', key: 'minute' } as const, 0)

// Module variables start over on a reload; session.start fills them again.
let transcript: string | undefined
let isTurnRunning = false
let canHold = true
let ticker: { cancel: () => void } | undefined

// ---------- helpers that take $ (top level, same file) ----------

/** Publishes the card the deck band shows, from the state as it stands. */
async function publish($: EngineInterface): Promise<void> {
  const st = await read($, stateA)
  const scene = buildScene(st, await read($, settingsA), await $.clock.now(), !isTurnRunning)
  const card = toCard(scene, st, await read($, hiddenA))
  if (JSON.stringify(card) !== JSON.stringify(await read($, cardA))) await update($, cardA, () => card)
  const mode = scene?.mode ?? 'light'
  if (mode !== (await read($, modeA))) await update($, modeA, () => mode)
}

async function patch($: EngineInterface, fn: (s: BatonState) => BatonState): Promise<void> {
  await update($, stateA, fn)
  await publish($)
}

async function saveSettings($: EngineInterface, next: BatonPrefs): Promise<void> {
  await update($, settingsA, () => next)
  await publish($)
  try {
    await $.store.set('settings', next)
  } catch {
    // Holds for this session.
  }
}

async function note($: EngineInterface, text: string): Promise<void> {
  const now = await $.clock.now()
  await patch($, s => ({ ...s, lastNote: text, lastNoteAt: now }))
}

async function addSignal($: EngineInterface, kind: Signal['kind']): Promise<void> {
  const now = await $.clock.now()
  await patch($, s => {
    const isNew = !s.signals.some(x => x.kind === kind)
    return {
      ...s,
      signals: [...s.signals.filter(x => x.kind !== kind), { kind, weight: WEIGHT[kind], at: now }],
      // A finished task clears a pause note: the work it paused is done now.
      vetoes: kind === 'wrap-up' || kind === 'shipped' ? s.vetoes.filter(v => v !== 'paused-work') : s.vetoes,
      marks: isNew ? [...s.marks, { kind: 'gate' as const, pos: s.removed + s.tokens, label: LABEL[kind] }].slice(-24) : s.marks,
    }
  })
}

async function setVeto($: EngineInterface, veto: Veto, isOn: boolean): Promise<void> {
  await patch($, s => ({ ...s, vetoes: isOn ? [...new Set([...s.vetoes, veto])] : s.vetoes.filter(v => v !== veto) }))
}

/** Asks Haiku whether this is a natural break; null when it could not say. */
async function judge($: EngineInterface, next?: string): Promise<{ isBreak: boolean; confidence: number } | null> {
  const d = digest(await $.session.messages(), next)
  if (d === null) return null
  const r = await $.model.complete({
    model: 'haiku',
    system: JUDGE_SYSTEM,
    prompt: d,
    maxTokens: 80,
    effort: 'low',
    timeoutMs: JUDGE_TIMEOUT_MS,
  })
  return r.isAnswered ? verdict(r.text) : null
}

/** Compacts with the handoff instructions; says what happened. */
async function handOff($: EngineInterface, why: string, isAuto: boolean, next?: string): Promise<string> {
  const before = (await read($, stateA)).tokens
  await patch($, s => ({ ...s, phase: 'compacting', armed: null }))
  const instructions = handoff(why, next, transcript)
  let after: number | undefined
  try {
    const r = await $.session.compact({ instructions })
    if (r.skip !== undefined) {
      await patch($, s => ({ ...s, phase: 'idle' }))
      return `Baton: compaction skipped (${r.skip}).`
    }
    after = r.tokensAfter
  } catch (err) {
    // A host that compacts only as a command (an SDK session) runs /compact itself.
    if (!/headless|command|sdk|not available/i.test(String(err))) {
      await patch($, s => ({ ...s, phase: 'idle' }))
      return `Baton: could not compact (${String(err)}).`
    }
    await $.command.run({ command: 'compact', args: instructions })
  }
  if (after === undefined) after = (await $.session.usage()).context.tokens ?? before
  const now = await $.clock.now()
  const was = before
  const left = Math.min(after, was)
  await patch($, s => ({
    ...s,
    phase: 'idle',
    tokens: left,
    signals: [],
    vetoes: [],
    armed: null,
    removed: s.removed + (was - left),
    handoffs: s.handoffs + 1,
    marks: [...s.marks, { kind: 'handoff' as const, pos: s.removed + was, label: `${kTok(was)}→${kTok(left)}`, before: was, after: left }].slice(-24),
    unrated: isAuto ? { at: now, before: was, after: left, why } : null,
    lastNote: `Handed off ${kTok(was)} → ${kTok(left)}`,
    lastNoteAt: now,
  }))
  return `Baton: ${why} → handed off ${kTok(was)} → ${kTok(left)}. Each request now skips ${kTok(was - left)}.`
}

/** The judge found a break at a prompt: compact first, then send the prompt it held. */
async function handOffThenSend($: EngineInterface, text: string, why: string): Promise<void> {
  try {
    $.ui.log(await handOff($, why, true, text))
  } catch (err) {
    $.ui.log(`Baton: could not compact (${String(err)})`)
  } finally {
    try {
      await $.prompt.submit({ text, asUser: true })
    } catch {
      // The prompt must never be lost: put it back in the composer.
      await $.prompt.fill({ text, mode: 'replace' }).catch(() => undefined)
      $.ui.toast('Baton could not resend your prompt; it is back in the box.', { timeoutMs: 10000 })
    }
  }
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const minute = Math.floor(now / MINUTE)
  if ((await read($, minuteA)) !== minute) await update($, minuteA, () => minute)
  await publish($)

  const st = await read($, stateA)
  const set = await read($, settingsA)
  if (!st.armed || isTurnRunning || st.phase !== 'idle' || now < st.armed.fireAt) return
  if (set.mode !== 'auto' || st.vetoes.length > 0 || st.tokens < set.minTokens) {
    await patch($, s => ({ ...s, armed: null }))
    return
  }
  const why = st.signals.map(x => LABEL[x.kind]).join(' + ') || 'idle'
  if (st.armed.needsJudge) {
    await patch($, s => ({ ...s, phase: 'judging' }))
    const v = await judge($).catch(() => null)
    await patch($, s => ({ ...s, phase: 'idle' }))
    if (!v?.isBreak || v.confidence < set.bar) {
      await patch($, s => ({ ...s, armed: null }))
      await note($, 'Haiku saw unfinished work · holding the context')
      return
    }
  }
  const said = await handOff($, `${why}, then you stepped away`, true)
  $.ui.log(said)
  $.ui.toast(said.replace(/^Baton: /, 'Baton · '), { timeoutMs: 8000 })
}

async function statusReport($: EngineInterface): Promise<string> {
  const st = await read($, stateA)
  const set = await read($, settingsA)
  const now = await $.clock.now()
  return [
    `Context: ${kTok(st.tokens)} of ${kTok(st.window)} · Baton acts from ${kTok(set.minTokens)}`,
    `Mode: ${set.mode} · judge bar ${set.bar.toFixed(2)} (Haiku)`,
    `Signals since the last handoff: ${st.signals.map(x => LABEL[x.kind]).join(', ') || 'none'} (score ${score(st.signals).toFixed(2)})`,
    `Holding for: ${st.vetoes.join(', ') || 'nothing'}`,
    st.armed ? `Armed: hands off in ${span(st.armed.fireAt - now)} unless you send a prompt` : 'Armed: no',
    `Handoffs this session: ${st.handoffs} · re-reading saved: ${kTok(st.savedTokens)} tokens`,
  ].join('\n')
}

async function press($: EngineInterface, key: Action): Promise<void> {
  if (key === 'now') {
    $.clock.after(DEFER_MS, () => void handOff($, 'you asked', false).then(t => $.ui.log(t)).catch(() => undefined))
  }
  if (key === 'later') {
    const now = await $.clock.now()
    await patch($, s => ({ ...s, armed: null, signals: [], coldSkippedAt: now }))
  }
  if (key === 'good' || key === 'bad') {
    const set = await read($, settingsA)
    await saveSettings($, { ...set, bar: learn(set.bar, key === 'good') })
    await patch($, s => ({ ...s, unrated: null }))
    $.ui.toast(key === 'good' ? 'Baton · noted, this was a good moment' : `Baton · noted; it now needs confidence ≥ ${learn(set.bar, false).toFixed(2)}`)
  }
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    canHold = e.isInteractive || e.surface === 'desktop'
    await $.command.register({
      name: 'baton',
      description: 'Baton: hand off now; or "auto|ask|off", "min 150k", "status", "hide", "show", "later", "good|bad"',
      argumentHint: 'auto | ask | off | min 150k | status | hide | show',
      immediate: true,
    })
    try {
      const saved = (await $.store.get('settings')) as Partial<BatonPrefs> | undefined
      const isHidden = (await $.store.get('isHidden')) === true
      await update($, settingsA, () => ({ ...DEFAULT_SETTINGS, ...(saved ?? {}) }))
      await update($, hiddenA, () => isHidden)
    } catch {
      // Defaults stand.
    }
    try {
      const u = await $.session.usage()
      await patch($, s => ({ ...s, tokens: u.context.tokens ?? s.tokens, window: u.context.window }))
    } catch {
      // No reading yet.
    }
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    return started
  })

  // The transcript's path goes into the handoff, so a lost detail can be found again.
  on('classic.Stop', async ($, e, next) => {
    transcript = e.transcript_path
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await patch($, s => ({ ...s, tokens: e.context.tokens ?? s.tokens, window: e.context.window }))
    return next(e)
  })

  // Every main-loop request re-reads the context: what the handoffs removed is saved again.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId === undefined) {
      await patch($, s => (s.removed > 0 ? { ...s, savedTokens: s.savedTokens + s.removed } : s))
    }
    return r
  })

  // The person's own /compact and the engine's autocompact count on the track too.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.skip === undefined && e.trigger !== 'precompute' && e.trigger !== 'plugin') {
      const before = r.tokensBefore ?? (await read($, stateA)).tokens
      const after = r.tokensAfter ?? before
      await patch($, s => ({
        ...s,
        tokens: after,
        signals: [],
        armed: null,
        removed: s.removed + Math.max(0, before - after),
        marks: [...s.marks, { kind: 'handoff' as const, pos: s.removed + before, label: e.trigger === 'auto' ? 'auto' : '/compact', before, after }].slice(-24),
      }))
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    await patch($, s => (s.armed ? { ...s, armed: null } : s))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran
    const isOk = ran.deny === undefined && ran.isError !== true
    const input = e as unknown as Record<string, unknown>
    const kind = toolSignal({ tool: String(e.tool), input, isOk })
    if (kind !== null) await addSignal($, kind)
    if (e.tool === 'TodoWrite' && isOk) {
      const open = todosOpen(input)
      if (open !== null) await setVeto($, 'todos-open', open)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    isTurnRunning = false
    const ended = await $.clock.now()
    await patch($, s => ({ ...s, lastTurnAt: ended }))
    await setVeto($, 'awaiting-answer', e.reason === 'answer' && isAwaitingAnswer(e.answer))
    try {
      const agents = await $.agent.list()
      await setVeto($, 'agents-running', agents.some(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting'))
    } catch {
      // No list: no veto.
    }
    const now = await $.clock.now()
    const st = await read($, stateA)
    const plan = planIdle(st, await read($, settingsA), now)
    await patch($, s => ({ ...s, armed: plan }))
    return r
  })

  // Prompt time: note what the prompt says; at a natural break, hand off first.
  on('prompt.submit', async ($, e, next) => {
    if (!PERSON.has(e.origin.kind) || e.text.trimStart().startsWith('/')) return next(e)
    await patch($, s => (s.armed ? { ...s, armed: null } : s))

    const said = promptSignal(e.text)
    if (said.isPause) await setVeto($, 'paused-work', true)
    if (said.signal !== null) await addSignal($, said.signal)
    // A wrap-up request needs the whole context: the boundary comes after it.
    if (said.signal === 'wrap-up') return next(e)

    const st = await read($, stateA)
    const set = await read($, settingsA)
    const isEligible =
      set.mode === 'auto' &&
      canHold &&
      !isTurnRunning &&
      e.turnId === undefined &&
      st.phase === 'idle' &&
      !(e.attachments?.length) &&
      !MENTION.test(e.text) &&
      st.tokens >= set.minTokens &&
      st.vetoes.length === 0 &&
      !isContinuation(e.text) &&
      (score(st.signals) >= MEDIUM || st.tokens >= set.minTokens * 1.5)
    if (!isEligible) return next(e)

    await patch($, s => ({ ...s, phase: 'judging' }))
    let v: { isBreak: boolean; confidence: number } | null = null
    try {
      v = await judge($, e.text)
    } finally {
      await patch($, s => ({ ...s, phase: 'idle' }))
    }
    if (!v?.isBreak || v.confidence < set.bar) return next(e)

    const why = `natural break (Haiku ${v.confidence.toFixed(2)})`
    $.clock.after(DEFER_MS, () => void handOffThenSend($, e.text, why))
    return { drop: `Baton: a natural break (Haiku ${v.confidence.toFixed(2)} ≥ ${set.bar.toFixed(2)}). Handing off first, then sending your prompt.` }
  }).catch(($, e, next) => next(e)) // a failed judge never holds a prompt back

  on('command.run', { command: 'baton' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    const set = await read($, settingsA)
    // The deck's buttons run these; they answer with a toast or a log line, not a transcript row.
    const isDeck = e.origin.kind === 'plugin'

    if (arg === 'auto' || arg === 'ask' || arg === 'off') {
      await saveSettings($, { ...set, mode: arg })
      return { text: `Baton mode: ${arg}.` }
    }
    const min = arg.match(/^min (\d+(?:\.\d+)?)\s*(k|m)?$/)
    if (min) {
      const n = Number(min[1]) * (min[2] === 'm' ? 1_000_000 : min[2] === 'k' ? 1000 : 1)
      await saveSettings($, { ...set, minTokens: Math.max(20_000, Math.round(n)) })
      return { text: `Baton acts from ${kTok(Math.max(20_000, Math.round(n)))} of context.` }
    }
    if (arg === 'status') return { text: await statusReport($) }
    if (arg === 'hide' || arg === 'show') {
      await update($, hiddenA, () => arg === 'hide')
      await $.store.set('isHidden', arg === 'hide').catch(() => undefined)
      await publish($)
      return { text: arg === 'hide' ? 'Baton messages hidden from the band. /baton show brings them back.' : 'Baton messages shown in the band.' }
    }
    if (arg === 'later') {
      await press($, 'later')
      return isDeck ? {} : { text: 'Baton: not now. It waits for the next break.' }
    }
    if (arg === 'good' || arg === 'bad') {
      await press($, arg)
      return isDeck ? {} : { text: 'Baton: rating saved.' }
    }
    // The host refuses a compaction under the command's own turn: run it once the command returns.
    $.clock.after(DEFER_MS, () => void handOff($, 'you asked', false).then(t => $.ui.log(t)).catch(() => undefined))
    return isDeck ? {} : { text: 'Baton: handing off with a handoff summary…' }
  })
}
