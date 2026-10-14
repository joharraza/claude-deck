import { expect, test } from 'claude-code/testing'

import { FIVE_HOURS, HOUR, buildScene, pace, settle, toCard } from '../hooks/model.ts'

const NOW = Date.parse('2026-10-13T10:00:00Z')

test('pace warns when usage outruns the clock', async () => {
  // 2 hours into the window (3 hours left) and 60% used: 100% comes in 1h 20m.
  const p = pace({ pct: 60, resetsAt: NOW + 3 * HOUR }, FIVE_HOURS, NOW)
  expect(Math.abs((p.timeFrac ?? 0) - 0.4) < 1e-9).toBe(true)
  expect(Math.round((p.etaMs ?? 0) / 60_000)).toBe(80)
  // 4 hours in, 40% used: lands at 50% by reset, no warning.
  const q = pace({ pct: 40, resetsAt: NOW + HOUR }, FIVE_HOURS, NOW)
  expect(q.projected).toBe(50)
  expect(q.etaMs).toBeNull()
})

test('the scene reads as calm, watch and hot', async () => {
  const at = (pct: number, left: number) =>
    buildScene({
      meter: { five: { pct, resetsAt: NOW + left }, seven: { pct: 20, resetsAt: NOW + 50 * HOUR }, ctx: 30 },
      pause: null, isAuto: true, allowedUntil: 0, heldAt: 0, resumedAt: 0, now: NOW,
    })
  expect(at(40, HOUR)?.chip).toBe('CLEAR')
  expect(at(40, HOUR)?.headline).toBe('On pace for 50% by reset')
  expect(at(60, 3 * HOUR)?.chip).toBe('WATCH')
  expect(at(60, 3 * HOUR)?.headline).toContain('At this pace the limit hits in 1h 20m')
  expect(at(93, 2 * HOUR)?.chip).toBe('HOT')
})

test('the card is one sentence with the buttons of the scene, and empty when calm', async () => {
  const at = (pct: number, left: number) =>
    buildScene({
      meter: { five: { pct, resetsAt: NOW + left }, seven: { pct: 20, resetsAt: NOW + 50 * HOUR }, ctx: 30 },
      pause: null, isAuto: true, allowedUntil: 0, heldAt: 0, resumedAt: 0, now: NOW,
    })
  expect(toCard(at(40, HOUR), false, NOW + HOUR)).toBeNull()
  const hot = toCard(at(93, 2 * HOUR), false, NOW + 2 * HOUR)
  expect(hot?.tone).toBe('hot')
  expect(hot?.text).toBe('Limit in ~14m at this pace. Resets in 2h.')
  expect(hot?.id).toBe(`radar:hot:${NOW + 2 * HOUR}`)
  expect(toCard(at(93, 2 * HOUR), true, null)).toBeNull()

  const paused = buildScene({
    meter: { five: { pct: 100, resetsAt: NOW + HOUR }, seven: null, ctx: 30 },
    pause: { resumeAt: NOW + HOUR, isKnown: true, since: NOW, tries: 0, isDue: false },
    isAuto: false, allowedUntil: 0, heldAt: 0, resumedAt: 0, now: NOW,
  })
  const card = toCard(paused, true, null)
  expect(card?.isCritical).toBe(true)
  expect(card?.buttons).toEqual([{ args: 'auto on', label: 'Auto-continue at reset', isPrimary: true }])
})

test('a window whose reset has passed reads as started over', async () => {
  const now = Date.parse('2026-10-14T09:00:00Z')
  const m = { five: { pct: 94, resetsAt: now - 3_600_000 }, seven: { pct: 12, resetsAt: now + 86_400_000 }, ctx: 22 }
  const s = settle(m, now)
  expect(s.five).toEqual({ pct: 0, resetsAt: null })
  expect(s.seven).toBe(m.seven)
  expect(settle(s, now)).toBe(s)
})
