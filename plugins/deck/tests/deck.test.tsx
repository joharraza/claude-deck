import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { deckSvg, wrap2 } from '../hooks/art.ts'
import type { Card, Inputs } from '../hooks/model.ts'
import { buildDeck, pick } from '../hooks/model.ts'

const T0 = Date.parse('2026-10-14T10:00:00Z')
const HOUR = 3_600_000

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 130,
  scroll: { offset: 0, bodyRows: 7 },
  view: {},
} as unknown as RenderPropsOf['AbovePrompt']

const HANDOFF: Card = {
  id: 'baton:ready:0:1',
  rank: 1,
  tone: 'gold',
  text: 'Good moment to hand off (committed). The next task starts from a short summary, not 216K.',
  command: 'baton',
  buttons: [
    { args: 'now', label: 'Hand off now', isPrimary: true },
    { args: 'later', label: 'Not now' },
  ],
  isCritical: false,
  isQuietWhileWorking: true,
}

const PUSH: Card = {
  id: 'bench:repo|main|main-dirty,unpushed',
  rank: 2,
  tone: 'watch',
  text: 'On main with 3 uncommitted changes in notes-app.',
  command: 'bench',
  buttons: [{ args: 'branch', label: 'Branch off', isPrimary: true }, { args: 'push', label: 'Push main' }],
  isCritical: false,
  isQuietWhileWorking: true,
}

const BENCH = { repo: 'C:\\code\\notes-app', name: 'notes-app', branch: 'main', isDefault: true, changed: 3, conflicts: 0, upstream: 'origin/main', ahead: 2, behind: 0, hasRemote: true, unpushed: 2 }

function inputs(over: Partial<Inputs> = {}): Inputs {
  return {
    five: { pct: 61, resetsAt: T0 + 100 * 60_000 },
    seven: { pct: 31, resetsAt: T0 + 80 * HOUR },
    ctxPct: 22,
    tokens: 216_000,
    window: 1_000_000,
    minTokens: 100_000,
    batonMode: 'growing',
    bench: null,
    ports: [],
    busy: '',
    cards: [],
    snoozed: '',
    isWorking: false,
    now: T0,
    ...over,
  }
}

/** The three mods' values as the deck reads them; the test changes them between draws. */
function world(on: On) {
  mock.clock(on, { now: T0 })
  mock.store(on)
  const w = {
    values: {
      'limit-radar.meter': { five: { pct: 61, resetsAt: T0 + 100 * 60_000 }, seven: { pct: 31, resetsAt: T0 + 80 * HOUR }, ctx: 22 },
      'baton.state': { tokens: 216_000, window: 1_000_000 },
      'baton.prefs': { mode: 'auto', minTokens: 100_000, bar: 0.75 },
    } as Record<string, unknown>,
    runs: [] as string[],
  }
  on('state.get', ($, e, next) => {
    const k = `${e.plugin}.${e.key}`
    if (e.plugin !== 'deck') return { value: { value: w.values[k] as never, version: 1 } }
    return next(e)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', ($, e) => {
    w.runs.push(`/${e.command} ${e.args}`)
    return {}
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return w
}

test('the gauges, the corner and the calm line', () => {
  const d = buildDeck(inputs())!
  expect(d.tubes.map(t => `${t.label} ${t.value} ${t.note}`)).toEqual(['5h 61% resets 1h 40m', '7d 31% resets 3d 8h', 'ctx 216K of 1M · hand-off at 100K'])
  // Measured against the 1M window, with Baton's line at 10%; tinted by fill, never a hard switch.
  expect(d.tubes[2]?.isHot).toBe(false)
  expect(d.tubes[2]?.fill).toBe(0.216)
  expect(d.tubes[2]?.notch).toBe(0.1)
  // 1h 40m left of 5 hours: the clock is two thirds through the window.
  expect(Math.round((d.tubes[0]?.mark ?? 0) * 100)).toBe(67)
  expect(d.slot.kind).toBe('radar')
  // The tank wears Baton's color for what it is doing, and bubbles while it works.
  expect(d.slot.kind === 'radar' && [d.slot.ctxTone, d.slot.isBusy, d.slot.isCalling]).toEqual(['#60a5fa', true, false])
  const armed = buildDeck(inputs({ batonMode: 'armed' }))!.slot
  expect(armed.kind === 'radar' && [armed.ctxTone, armed.isCalling]).toEqual(['#fbbf24', true])
  // While a hand-off counts down, the context bar pulses gold with the tank; never otherwise.
  const counting = buildDeck(inputs({ batonMode: 'armed' }))!
  expect(counting.tubes[2]?.isHot).toBe(true)
  expect(deckSvg(counting, 860).source).toContain('stroke="#fbbf24" stroke-width="1.4" filter="url(#dkGlow)"')
  expect(buildDeck(inputs({ batonMode: 'cold' }))!.tubes[2]?.isHot).toBe(false)
  expect(d.message.card).toBeNull()
  expect(d.message.text).toBe('All clear. 216K in context; Baton hands off at the next break.')

  const git = buildDeck(inputs({ bench: BENCH, ports: [5173] }))!
  expect(git.slot).toEqual({ kind: 'git', name: 'notes-app', branch: 'main', detail: '3 changed · ↑2 · :5173', tone: '#fbbf24', motion: 'fork' })
  expect(buildDeck(inputs({ five: null, seven: null, ctxPct: null, tokens: 0 }))).toBeNull()
})

test('one card at a time: the most urgent, never a dismissed one, none of the quiet ones while Claude works', () => {
  expect(pick({ cards: [null, PUSH, HANDOFF], snoozed: '', isWorking: false })?.id).toBe(PUSH.id)
  expect(pick({ cards: [null, PUSH, HANDOFF], snoozed: PUSH.id, isWorking: false })?.id).toBe(HANDOFF.id)
  expect(pick({ cards: [PUSH, HANDOFF], snoozed: '', isWorking: true })).toBeNull()
  const critical = { ...PUSH, id: 'bench:busy', isCritical: true, isQuietWhileWorking: false }
  expect(pick({ cards: [critical], snoozed: 'bench:busy', isWorking: true })?.id).toBe('bench:busy')
})

test('the drawing is one clean SVG whose message never runs past two lines', () => {
  for (const over of [{}, { bench: BENCH, ports: [5173] }, { cards: [PUSH] }, { tokens: 0 }]) {
    const pic = deckSvg(buildDeck(inputs(over))!, 860)
    expect(pic.source.startsWith('<svg')).toBe(true)
    expect(pic.source).not.toContain('NaN')
    expect(pic.source).not.toContain('undefined')
    expect(pic.height).toBe(116)
  }
  expect(deckSvg(buildDeck(inputs())!, 200).width).toBe(460)
  const lines = wrap2('Cache went cold while you were away. Your next message re-reads all 216K at full cost, so hand off first.', 12.5, 300)
  expect(lines).toHaveLength(2)
  expect(lines[1]?.endsWith('…')).toBe(true)
})

test('the band draws on both surfaces and its buttons run the mod commands', async ($, on) => {
  const w = world(on)
  w.values['baton.card'] = HANDOFF
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'deck', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ key: 'deck-baton-now' } as never)).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'deck', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(String((await ui.find({ type: 'Svg' }))?.props['alt'])).toContain('Good moment to hand off')
  await ui.press({ key: 'deck-baton-now' } as never)
  expect(w.runs).toEqual(['/baton now'])

  // Once the mod drops its card, the calm line stands in.
  w.values['baton.card'] = null
  const after = await $.ui.mount({ plugin: 'deck', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(String((await after.find({ type: 'Svg' }))?.props['alt'])).toContain('All clear')
  expect(await after.find({ key: 'deck-baton-now' } as never)).toBeUndefined()
})

test('quiet cards wait while Claude works, and /deck hides the band', async ($, on) => {
  const w = world(on)
  w.values['workbench.bench'] = BENCH
  w.values['workbench.card'] = PUSH
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })

  const busy = await $.ui.mount({ plugin: 'deck', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, isWorking: true } })
  expect(await busy.find({ key: 'deck-bench-branch' } as never)).toBeUndefined()
  expect(String((await busy.find({ type: 'Svg' }))?.props['alt'])).toContain('notes-app on main')
  await busy.unmount()

  await $.command.run({ command: 'deck', args: 'hide', origin: { kind: 'composer' }, presentation: {} } as never)
  const hidden = await $.ui.mount({ plugin: 'deck', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await hidden.find({ type: 'Svg' })).toBeUndefined()
})
