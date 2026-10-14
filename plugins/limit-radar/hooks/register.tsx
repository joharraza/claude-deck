import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Meter, Pause } from '../types'
import type { Action } from './model.ts'
import {
  GUARD_AT,
  HOUR,
  MINUTE,
  buildScene,
  isSpent,
  planPause,
  settle,
  span,
  toCard,
  toMeter,
} from './model.ts'

const GRACE_MS = 90_000 // wait this long past the reported reset
const RETRY_MS = 30 * MINUTE // retry cadence when the reset time is unknown
const MAX_TRIES = 12
const TICK_MS = 20_000
const WARN_TOAST_AT = 85
const DEFER_MS = 120

const RESUME_TEXT =
  'The usage limit has reset. Please continue from where you left off.'

const cardA = atom({ plugin: 'limit-radar', key: 'card' } as const, null)
const meterA = atom({ plugin: 'limit-radar', key: 'meter' } as const, null)
const pauseA = atom({ plugin: 'limit-radar', key: 'pause' } as const, null)
const autoA = atom({ plugin: 'limit-radar', key: 'isAuto' } as const, true)
const hiddenA = atom({ plugin: 'limit-radar', key: 'isHidden' } as const, false)
const allowA = atom({ plugin: 'limit-radar', key: 'agentsAllowedUntil' } as const, 0)
const heldA = atom({ plugin: 'limit-radar', key: 'heldAt' } as const, 0)
const resumedA = atom({ plugin: 'limit-radar', key: 'resumedAt' } as const, 0)
const minuteA = atom({ plugin: 'limit-radar', key: 'minute' } as const, 0)

// Module variables start over on a reload; session.start fills them again.
let pauseKey = 'pause'
let lastArmAt = 0
let warnedFor: number | null = null
let ticker: { cancel: () => void } | undefined

// ---------- helpers that take $ (top level, same file) ----------

/**
 * Publishes the card the deck band shows. Called after every change and on
 * each tick, so countdowns stay current; any status line an earlier version
 * left under the prompt is cleared.
 */
async function paint($: EngineInterface): Promise<void> {
  $.ui.status(undefined)
  const meter = await read($, meterA)
  const scene = buildScene({
    meter,
    pause: await read($, pauseA),
    isAuto: await read($, autoA),
    allowedUntil: await read($, allowA),
    heldAt: await read($, heldA),
    resumedAt: await read($, resumedA),
    now: await $.clock.now(),
  })
  const card = toCard(scene, await read($, hiddenA), meter?.five?.resetsAt ?? null)
  if (JSON.stringify(card) !== JSON.stringify(await read($, cardA))) await update($, cardA, () => card)
}

async function setPause($: EngineInterface, p: Pause | null): Promise<void> {
  await update($, pauseA, () => p)
  try {
    if (p) await $.store.set(pauseKey, p)
    else await $.store.delete(pauseKey)
  } catch {
    // The pause still holds for this session.
  }
}

async function measure($: EngineInterface): Promise<Meter> {
  const u = await $.session.usage()
  const m = settle(toMeter(u.rateLimits, u.context), await $.clock.now())
  await update($, meterA, () => m)
  return m
}

async function notify($: EngineInterface, text: string): Promise<void> {
  try {
    await $.ui.notify(text, { title: 'Limit Radar' })
  } catch {
    // No channel: the toast and the band carry it.
  }
}

/** A turn died on the usage limit: work out when it resets and count down. */
async function arm($: EngineInterface, m: Meter): Promise<void> {
  const now = await $.clock.now()
  const p = planPause(m, await read($, pauseA), now, GRACE_MS, RETRY_MS)
  await setPause($, p)
  if (now - lastArmAt > 30_000) {
    const wait = span(p.resumeAt - now)
    $.ui.toast(
      (await read($, autoA))
        ? `Usage limit reached · Claude continues on its own in ${wait}`
        : `Usage limit reached · resets in ${wait}`,
      { timeoutMs: 8000 },
    )
  }
  lastArmAt = now
  await paint($)
}

async function resume($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, resumedA, () => now)
  await $.prompt.submit({ text: RESUME_TEXT, asUser: true })
  $.ui.toast('Limit reset · Claude picked up where it stopped', { timeoutMs: 8000 })
  await notify($, 'Your usage limit reset. Claude has continued the task.')
}

async function setAuto($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, autoA, () => isOn)
  try {
    await $.store.set('isAuto', isOn)
  } catch {
    // Holds for this session.
  }
}

async function setHidden($: EngineInterface, isHidden: boolean): Promise<void> {
  await update($, hiddenA, () => isHidden)
  try {
    await $.store.set('isHidden', isHidden)
  } catch {
    // Holds for this session.
  }
  await paint($)
}

async function loadSaved($: EngineInterface): Promise<void> {
  try {
    const isAuto = (await $.store.get('isAuto')) !== false
    const isHidden = (await $.store.get('isHidden')) === true
    await update($, autoA, () => isAuto)
    await update($, hiddenA, () => isHidden)
    // A pause survives a restart of this same session, never a new one.
    const saved = (await $.store.get(pauseKey)) as Pause | undefined
    if (saved && (await $.clock.now()) - saved.since < 24 * HOUR) await update($, pauseA, () => saved)
    else if (saved) await $.store.delete(pauseKey)
  } catch {
    // Defaults stand.
  }
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const minute = Math.floor(now / MINUTE)
  if ((await read($, minuteA)) !== minute) {
    await update($, minuteA, () => minute)
    // Once a minute: a window whose reset has passed while idle starts over.
    const m = await read($, meterA)
    if (m && settle(m, now) !== m) await update($, meterA, () => settle(m, now))
  }

  const p = await read($, pauseA)
  if (p && !p.isDue && now >= p.resumeAt) {
    if (!(await read($, autoA))) {
      await setPause($, { ...p, isDue: true })
      $.ui.toast('Your usage limit has reset', { timeoutMs: 8000 })
      await notify($, 'Your usage limit has reset. Ready to continue.')
    } else if (p.tries >= MAX_TRIES) {
      await setPause($, null)
      $.ui.toast('Limit Radar stopped retrying. Type "continue" when ready.', { timeoutMs: 10000 })
    } else {
      // Keep a fallback armed in case this attempt hits the limit too;
      // a turn that answers clears it.
      await setPause($, { ...p, resumeAt: now + RETRY_MS, isKnown: false, tries: p.tries + 1 })
      await resume($)
    }
  }
  await paint($)
}

async function press($: EngineInterface, key: Action): Promise<void> {
  const now = await $.clock.now()
  if (key === 'now' || key === 'dismiss') await setPause($, null)
  if (key === 'now') await resume($)
  if (key === 'auto-on') await setAuto($, true)
  if (key === 'auto-off') await setAuto($, false)
  if (key === 'allow') {
    const m = await read($, meterA)
    const until = m?.five?.resetsAt ?? now + 5 * HOUR
    await update($, allowA, () => until)
  }
  await paint($)
}

async function statusReport($: EngineInterface): Promise<string> {
  const m = await measure($)
  const now = await $.clock.now()
  const p = await read($, pauseA)
  const line = (name: string, w: Meter['five']) =>
    w ? `${name}: ${w.pct}%${w.resetsAt ? ` · resets in ${span(w.resetsAt - now)}` : ''}` : `${name}: no reading yet`
  const lines = [
    line('5-hour window', m.five),
    line('7-day window', m.seven),
    `Context: ${m.ctx !== null ? `${m.ctx}%` : 'no reading yet'}`,
    `Auto-continue: ${(await read($, autoA)) ? 'on' : 'off'}`,
    `Subagent guard: holds new subagents at ${GUARD_AT}% of the 5-hour window`,
  ]
  if (p) lines.push(`Paused: resumes in ${span(p.resumeAt - now)}`)
  return lines.join('\n')
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    pauseKey = `pause:${await $.session.id()}`

    await $.command.register({
      name: 'radar',
      description: 'Limit Radar: show or hide its messages in the band; "auto on|off" for auto-continue; "status" for figures',
      argumentHint: 'auto on | auto off | status | now | allow',
      immediate: true,
    })
    await loadSaved($)
    try {
      await measure($)
    } catch {
      // No reading yet.
    }
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    await tick($)

    return started
  })

  on('session.measure', async ($, e, next) => {
    const m = settle(toMeter(e.rateLimits, e.context), await $.clock.now())
    await update($, meterA, () => m)
    const five = m.five
    if (five && five.pct >= WARN_TOAST_AT && five.pct < 100 && warnedFor !== five.resetsAt) {
      warnedFor = five.resetsAt
      const reset = five.resetsAt ? ` · resets in ${span(five.resetsAt - (await $.clock.now()))}` : ''
      $.ui.toast(`${five.pct}% of your 5-hour window used${reset}`, { timeoutMs: 6000 })
    }
    await paint($)
    return next(e)
  })

  // The engine's own stop-failure signal: the turn died on the usage limit.
  on('classic.StopFailure', async ($, e, next) => {
    const r = await next(e)
    if (e.error === 'rate_limit') await arm($, await measure($))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    const m = await measure($)
    if (e.reason === 'answer' && (await read($, pauseA)) !== null) await setPause($, null)
    else if (e.reason === 'error' && isSpent(m)) await arm($, m)
    await paint($)
    return r
  })

  // The person took over: their own prompt replaces the scheduled resume.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
    if (isPerson && (await read($, pauseA)) !== null) {
      await setPause($, null)
      await paint($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Near the limit, hold new subagents: one that hits the limit mid-run
  // loses its work.
  on('agent.spawn', async ($, e, next) => {
    const m = await read($, meterA)
    const now = await $.clock.now()
    const five = m?.five
    if (!five || five.pct < GUARD_AT || now < (await read($, allowA))) return next(e)

    await update($, heldA, () => now)
    await paint($)
    const reset = five.resetsAt ? ` (resets in ${span(five.resetsAt - now)})` : ''
    return {
      deny:
        `Limit Radar held this subagent: the 5-hour usage window is at ${five.pct}%${reset}. ` +
        'A subagent that hits the limit mid-run loses its work. Do this step in the main ' +
        'thread instead, or ask the user to press "Allow agents" above the prompt.',
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'radar' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    // The deck's buttons run these; they answer with a toast, not a transcript line.
    const isDeck = e.origin.kind === 'plugin'

    if (arg === 'now' || arg === 'dismiss' || arg === 'allow') {
      // The resume prompt cannot be sent from inside the command: send it once the command returns.
      if (arg === 'now') $.clock.after(DEFER_MS, () => void press($, 'now').catch(() => undefined))
      else await press($, arg)
      if (arg === 'allow') $.ui.toast('Subagents allowed until the 5-hour window resets', { timeoutMs: 5000 })
      return isDeck ? {} : { text: arg === 'allow' ? 'Subagents allowed until the 5-hour window resets.' : 'Done.' }
    }

    if (arg === 'auto on' || arg === 'auto off' || arg === 'on' || arg === 'off') {
      const isOn = arg.endsWith('on')
      await setAuto($, isOn)
      await paint($)
      if (isDeck) $.ui.toast(`Auto-continue is ${isOn ? 'on' : 'off'}`, { timeoutMs: 4000 })
      return isDeck ? {} : { text: `Auto-continue is ${isOn ? 'on' : 'off'}.` }
    }
    if (arg === 'status') return { text: await statusReport($) }

    const isHidden = !(await read($, hiddenA))
    await setHidden($, isHidden)
    return {
      text: isHidden
        ? 'Limit Radar messages hidden from the band. They still show when a limit pauses Claude. /radar brings them back.'
        : 'Limit Radar messages shown in the band.',
    }
  })
}
