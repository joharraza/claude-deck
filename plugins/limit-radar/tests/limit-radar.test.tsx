import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On, SessionUsage } from 'claude-code'

import type { DeckCard } from '../types'

const T0 = Date.parse('2026-10-13T10:00:00Z')
const HOUR = 3_600_000
const RESET = T0 + 2 * HOUR
const RESUME = 'The usage limit has reset. Please continue from where you left off.'

const SPAWN = {
  tool_use_id: 'tu-1',
  prompt: 'Critique the landing page',
  description: 'Craft critic',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
} as unknown as AgentSpawnInput

function usageAt(pct: number): SessionUsage {
  return {
    startedAt: T0,
    context: { window: 200_000, tokens: 80_000, percent: 40 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: pct, resetsAt: new Date(RESET).toISOString() },
      { kind: 'seven_day', percentUsed: 31, resetsAt: new Date(T0 + 96 * HOUR).toISOString() },
    ],
  }
}

/** The engine beneath the mod: answers every call it makes and records what it shows. */
function world(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const seen = {
    usage: usageAt(40),
    prompts: [] as string[],
    toasts: [] as string[],
    status: [] as (string | undefined)[],
    /** The card the deck band would show, as last published. */
    card: null as DeckCard | null,
  }
  on('state.set', ($, e, next) => {
    if (e.plugin === 'limit-radar' && e.key === 'card') seen.card = e.value as DeckCard | null
    return next(e)
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.usage', () => ({ value: seen.usage }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  // The engine's own band beneath the mod: empty here.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  return { clock, seen }
}


/** A press on the deck band: it runs the card's command the way the deck does. */
const deckRun = (args: string) =>
  ({ command: 'radar', args, origin: { kind: 'plugin', name: 'deck' }, presentation: {} }) as unknown as Parameters<Engine['command']['run']>[0]

const DEAD_TURN = { reason: 'error', answer: '', durationMs: 5, isAborted: false, turnId: 't-1' } as const

test('a turn that dies on the limit continues on its own after the reset', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  expect(seen.status.at(-1)).toBeUndefined()

  seen.usage = usageAt(100)
  await $.turn.complete(DEAD_TURN)
  expect(seen.toasts.at(-1)).toContain('continues on its own in 2h')
  expect(seen.status.at(-1)).toBeUndefined()

  const card = seen.card
  expect(card?.text).toContain('Claude continues on its own in 2h')
  expect(card?.buttons.map(b => b.args)).toContain('auto off')
  expect(card?.isCritical).toBe(true)
  expect(card?.rank).toBe(3)

  await clock.advance(HOUR)
  expect(seen.prompts).toEqual([])

  seen.usage = usageAt(0)
  await clock.advance(HOUR + 2 * 60_000)
  expect(seen.prompts).toEqual([RESUME])

  // The resumed turn answers: the pause is over.
  await $.turn.complete({ ...DEAD_TURN, reason: 'answer', turnId: 't-2' })
  await clock.advance(HOUR)
  expect(seen.prompts).toEqual([RESUME])
})

test('with auto-continue off, the band offers Continue now after the reset', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.command.run({
    command: 'radar',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: {},
  } as unknown as Parameters<typeof $.command.run>[0])

  seen.usage = usageAt(100)
  await $.turn.complete(DEAD_TURN)
  await clock.advance(2 * HOUR + 2 * 60_000)
  expect(seen.prompts).toEqual([])

  expect(seen.card?.text).toContain('has reset')
  expect(await $.command.run(deckRun('now'))).toEqual({})
  await clock.advance(500)
  expect(seen.prompts).toEqual([RESUME])
})

test('near the limit, subagents are held until the person allows them', async ($, on) => {
  const { seen } = world(on)
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })

  seen.usage = usageAt(92)
  await $.session.measure({
    context: seen.usage.context,
    rateLimits: seen.usage.rateLimits,
    changed: ['rateLimits'],
  })
  expect(seen.toasts.at(-1)).toContain('92% of your 5-hour window used')

  const held = await $.agent.spawn(SPAWN)
  expect(held.deny).toContain('92%')

  expect(seen.card?.text).toContain('Subagents on hold at 92%')
  await $.command.run(deckRun('allow'))
  const let_through = await $.agent.spawn(SPAWN)
  expect(let_through.deny).toBeUndefined()
  expect(let_through.agentId).toBe('agent-1')
})

test('a prompt the person types cancels the scheduled resume', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  seen.usage = usageAt(100)
  await $.turn.complete(DEAD_TURN)

  await $.prompt.submit({ text: 'continue', origin: { kind: 'composer' }, wait: false })
  seen.prompts.length = 0
  await clock.advance(3 * HOUR)
  expect(seen.prompts).toEqual([])
})

test('calm limits leave the card empty; a watch card shows, and /radar hides it', async ($, on) => {
  const { seen } = world(on)
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  expect(seen.card).toBeNull()

  seen.usage = usageAt(80)
  await $.session.measure({ context: seen.usage.context, rateLimits: seen.usage.rateLimits, changed: ['rateLimits'] })
  const card = seen.card
  expect(card?.tone).toBe('watch')
  expect(card?.isCritical).toBe(false)

  await $.command.run({ command: 'radar', args: '', origin: { kind: 'composer' }, presentation: {} } as unknown as Parameters<typeof $.command.run>[0])
  expect(seen.card).toBeNull()
  expect(seen.status.at(-1)).toBeUndefined()
})
