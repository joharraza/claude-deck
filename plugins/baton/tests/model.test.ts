import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_SETTINGS,
  EMPTY,
  buildScene,
  handoff,
  isAwaitingAnswer,
  isContinuation,
  learn,
  promptSignal,
  score,
  toCard,
  toolSignal,
  verdict,
} from '../hooks/model.ts'

const NOW = Date.parse('2026-10-13T10:00:00Z')

test('your own wrap-up skills and shipped work count as task ends', async () => {
  expect(toolSignal({ tool: 'Skill', input: { skill: 'wrapup' }, isOk: true })).toBe('wrap-up')
  expect(toolSignal({ tool: 'Skill', input: { skill: 'notes-wrapup' }, isOk: true })).toBe('wrap-up')
  expect(toolSignal({ tool: 'Bash', input: { command: 'cd x && git -C repo push origin main' }, isOk: true })).toBe('shipped')
  expect(toolSignal({ tool: 'PowerShell', input: { command: 'git commit -m "x"' }, isOk: true })).toBe('committed')
  expect(toolSignal({ tool: 'Artifact', input: { file_path: 'a.html' }, isOk: true })).toBe('published')
  expect(toolSignal({ tool: 'Bash', input: { command: 'git push' }, isOk: false })).toBeNull()
  expect(toolSignal({ tool: 'Bash', input: { command: 'git status' }, isOk: true })).toBeNull()
})

test('what you type is read for done, wrap-up and pause', async () => {
  expect(promptSignal('Looks good, it is final').signal).toBe('you-said-done')
  expect(promptSignal('wrap up both and compact').signal).toBe('wrap-up')
  expect(promptSignal('Keep the migration on hold, push the rest').isPause).toBe(true)
  expect(promptSignal('Rewrite section 4 with the new pricing and the risk register').signal).toBeNull()
})

test('questions and follow-ups lean on the context', async () => {
  expect(isAwaitingAnswer('Saved. Want me to draft the email too?')).toBe(true)
  expect(isAwaitingAnswer('Saved to the drafts folder.')).toBe(false)
  expect(isContinuation('yes do it')).toBe(true)
  expect(isContinuation('Try again')).toBe(true)
  expect(isContinuation('Organise my downloads folder')).toBe(false)
})

test('signals add up, ratings move the bar, verdicts parse', async () => {
  const at = NOW
  expect(score([{ kind: 'wrap-up', weight: 0.65, at }, { kind: 'shipped', weight: 0.45, at }])).toBeGreaterThan(0.7)
  expect(learn(0.75, false)).toBe(0.8)
  expect(learn(0.75, true)).toBe(0.73)
  expect(verdict('```json\n{"break": true, "confidence": 0.82}\n```')).toEqual({ isBreak: true, confidence: 0.82 })
  expect(verdict('no idea')).toBeNull()
})

test('the handoff keeps open work and points at the full transcript', async () => {
  const h = handoff('wrapped up', 'Organise downloads', 'C:/x/session.jsonl')
  expect(h).toContain('Open items')
  expect(h).toContain('paused')
  expect(h).toContain('Organise downloads')
  expect(h).toContain('C:/x/session.jsonl')
})

test('the card says the break in one sentence, and nothing while the context is light', async () => {
  const st = {
    ...EMPTY,
    tokens: 182_000,
    window: 1_000_000,
    signals: [{ kind: 'shipped' as const, weight: 0.45, at: NOW }],
  }
  const card = toCard(buildScene(st, DEFAULT_SETTINGS, NOW), st, false)
  expect(card?.text).toBe('Good moment to hand off (shipped). The next task starts from a short summary, not 182K.')
  expect(card?.buttons.map(b => b.args)).toEqual(['now', 'later'])
  expect(card?.isQuietWhileWorking).toBe(true)
  expect(toCard(buildScene(st, DEFAULT_SETTINGS, NOW), st, true)).toBeNull()

  const light = { ...EMPTY, tokens: 60_000, window: 1_000_000 }
  expect(toCard(buildScene(light, DEFAULT_SETTINGS, NOW), light, false)).toBeNull()
})
