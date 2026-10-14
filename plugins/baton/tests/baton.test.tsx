import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import type { DeckCard } from '../types'

const T0 = Date.parse('2026-10-13T10:00:00Z')
const MIN = 60_000

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'Draft the launch blog post', toolUses: [] },
  { role: 'assistant', text: 'Drafted it.', toolUses: [{ tool: 'Write', input: { file_path: 'C:/code/blog/drafts/launch.md' } }] } as unknown as SessionMessage,
  { role: 'user', text: 'Looks good, it is final', toolUses: [] },
  { role: 'assistant', text: 'Saved to the drafts folder.', toolUses: [] },
]

function world(on: On, tokens = 180_000) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = {
    tokens,
    compacts: [] as (string | undefined)[],
    prompts: [] as string[],
    asks: 0,
    reply: '{"break": true, "confidence": 0.9}',
    agents: [] as { status: string }[],
    /** The card the deck band would show, as last published. */
    card: null as DeckCard | null,
  }
  on('state.set', ($, e, next) => {
    if (e.plugin === 'baton' && e.key === 'card') w.card = e.value as DeckCard | null
    return next(e)
  })
  on('session.usage', () => ({ value: { startedAt: T0, context: { tokens: w.tokens, window: 1_000_000 }, rateLimits: [] } }))
  on('session.messages', () => ({ value: MESSAGES as never }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: w.agents as never }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  on('model.complete', () => {
    w.asks += 1
    return { value: { isAnswered: true, text: w.reply, usage: { input_tokens: 900, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('session.compact', ($, e) => {
    w.compacts.push(e.instructions)
    const before = w.tokens
    w.tokens = 14_000
    return { messages: [{ role: 'user', text: 'handoff', toolUses: [] }] as never, tokensBefore: before, tokensAfter: 14_000 }
  })
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return { clock, w }
}

async function start($: Engine, w: { tokens: number }) {
  await $.session.start({ cwd: 'C:/code/blog', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { tokens: w.tokens, window: 1_000_000 }, rateLimits: [], changed: ['context'] })
}

async function turn($: Engine, id: string, answer: string, tools: object[] = []) {
  await $.turn.start({ text: 'go', turnId: id })
  const tool = $.tool as unknown as { call: (t: object) => Promise<unknown> }
  for (const t of tools) await tool.call(t)
  await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: id, reason: 'answer' })
}

/** A press on the deck band: it runs the card's command the way the deck does. */
const deckRun = (args: string) =>
  ({ command: 'baton', args, origin: { kind: 'plugin', name: 'deck' }, presentation: {} }) as unknown as Parameters<Engine['command']['run']>[0]

test('a wrap-up arms a handoff that fires while you are away', async ($, on) => {
  const { clock, w } = world(on)
  await start($, w)
  await turn($, 't1', 'Saved the session notes.', [{ tool: 'Skill', skill: 'wrapup' }])

  expect(w.card?.text).toContain('Handing off in 8m')
  expect(w.card?.buttons.map(b => b.args)).toEqual(['now', 'later'])

  await clock.advance(7 * MIN)
  expect(w.compacts).toHaveLength(0)
  await clock.advance(2 * MIN)
  expect(w.compacts).toHaveLength(1)
  expect(w.compacts[0]).toContain('HANDOFF')
  expect(w.compacts[0]).toContain('wrapped up')

  expect(w.card?.text).toBe('Handed off 180K → 14K. Right moment?')
  expect(await $.command.run(deckRun('good'))).toEqual({})
  expect(w.card?.text ?? '').not.toContain('Handed off 180K')
})

test('a question from Claude holds the context, even after a wrap-up', async ($, on) => {
  const { clock, w } = world(on)
  await start($, w)
  await turn($, 't1', 'Saved everything. Want me to also draft the follow-up email?', [{ tool: 'Skill', skill: 'wrapup' }])
  await clock.advance(60 * MIN)
  expect(w.compacts).toHaveLength(0)
  expect(w.card?.text).toContain('held mid-task')
})

test('a running subagent or an open todo holds the context', async ($, on) => {
  const { clock, w } = world(on)
  await start($, w)
  w.agents = [{ status: 'running' }]
  await turn($, 't1', 'Pushed.', [{ tool: 'Bash', command: 'git push origin main' }])
  await clock.advance(60 * MIN)
  expect(w.compacts).toHaveLength(0)
})

test('a new prompt after a finished task hands off first, then sends it', async ($, on) => {
  const { clock, w } = world(on)
  await start($, w)
  await turn($, 't1', 'Pushed to main.', [{ tool: 'Bash', command: 'git push origin main' }])
  const held = await $.prompt.submit({ text: 'Now tidy my downloads folder', wait: false, origin: { kind: 'composer' } } as never)
  expect(held.drop).toContain('natural break')
  await clock.advance(1000)
  expect(w.compacts).toHaveLength(1)
  expect(w.compacts[0]).toContain('Now tidy my downloads folder')
  expect(w.prompts).toContain('Now tidy my downloads folder')
})

test('follow-ups, screenshots and wrap-up requests are never held', async ($, on) => {
  const { w } = world(on)
  await start($, w)
  await turn($, 't1', 'Pushed to main.', [{ tool: 'Bash', command: 'git push origin main' }])
  const a = await $.prompt.submit({ text: 'yes do it', wait: false, origin: { kind: 'composer' } } as never)
  const b = await $.prompt.submit({ text: 'Check this screenshot', attachments: [{ type: 'image' }], wait: false, origin: { kind: 'composer' } } as never)
  const c = await $.prompt.submit({ text: 'wrap this up', wait: false, origin: { kind: 'composer' } } as never)
  expect([a.drop, b.drop, c.drop]).toEqual([undefined, undefined, undefined])
  expect(w.asks).toBe(0)
  expect(w.compacts).toHaveLength(0)
})

test('the judge saying no lets the prompt through untouched', async ($, on) => {
  const { w } = world(on)
  await start($, w)
  w.reply = '{"break": false, "confidence": 0.8}'
  await turn($, 't1', 'Pushed to main.', [{ tool: 'Bash', command: 'git push origin main' }])
  const r = await $.prompt.submit({ text: 'Now change the pricing table in section 4', wait: false, origin: { kind: 'composer' } } as never)
  expect(r.drop).toBeUndefined()
  expect(w.asks).toBe(1)
  expect(w.compacts).toHaveLength(0)
})

test('a small context is left alone', async ($, on) => {
  const { clock, w } = world(on, 30_000)
  await start($, w)
  await turn($, 't1', 'Done.', [{ tool: 'Skill', skill: 'wrapup' }])
  await clock.advance(60 * MIN)
  expect(w.compacts).toHaveLength(0)
  expect(w.card).toBeNull()
})

test('an hour away with a big context: the card says the cache went cold', async ($, on) => {
  const { clock, w } = world(on)
  await start($, w)
  await turn($, 't1', 'Here is the draft of section 3.')
  await clock.advance(30 * MIN)
  expect(w.card?.text ?? '').not.toContain('cold')
  await clock.advance(31 * MIN)
  expect(w.card?.text).toBe('Cache went cold while you were away. Your next message re-reads all 180K at full cost.')
  expect(w.card?.tone).toBe('gold')

  await $.command.run(deckRun('later'))
  expect(w.card?.text).toContain('re-read on every request')
  expect(w.compacts).toHaveLength(0)
})
