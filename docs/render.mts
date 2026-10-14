// Renders the README's pictures with the deck's own drawing code:
//   node --experimental-strip-types docs/render.mts
// Each picture is the SVG the band draws in the desktop app. Buttons are the
// app's own controls laid over the band, so they are sketched in here.
import { writeFileSync } from 'node:fs'
import { buildDeck } from '../plugins/deck/hooks/model.ts'
import { deckSvg } from '../plugins/deck/hooks/art.ts'

const NOW = Date.parse('2026-10-14T10:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const W = 900
const ACTIONS = 150

const base = {
  five: { pct: 47, resetsAt: NOW + 131 * MIN },
  seven: { pct: 19, resetsAt: NOW + 134 * HOUR },
  ctxPct: 39,
  tokens: 393_000,
  window: 1_000_000,
  minTokens: 100_000,
  batonMode: 'growing',
  bench: null,
  ports: [] as number[],
  busy: '' as const,
  cards: [] as unknown[],
  snoozed: '',
  isWorking: false,
  now: NOW,
}

const repo = { name: 'notes-app', branch: 'main', isDefault: true, changed: 3, conflicts: 0, unpushed: 2, hasRemote: true, behind: 0 }

function card(source: string, tone: string, rank: number, text: string, buttons: [string, string?]) {
  return {
    id: `${source}:x`, rank, tone, text, command: source, isCritical: false,
    buttons: buttons.filter(Boolean).map((label, i) => ({ args: String(i), label: label!, ...(i === 0 ? { isPrimary: true } : {}) })),
  }
}

function buttons(svg: string, labels: string[]): string {
  if (labels.length === 0) return svg
  const x = W - ACTIONS / 2
  const top = 58 - (labels.length * 30 - 8) / 2
  const parts = labels.map((label, i) => {
    const y = top + i * 30
    const isPrimary = i === 0
    return (
      `<rect class="${isPrimary ? 'bp' : 'bo'}" x="${x - 58}" y="${y}" width="116" height="24" rx="7"/>` +
      `<text class="${isPrimary ? 'bpt' : 'bot'}" x="${x}" y="${y + 16}" text-anchor="middle" font-family="Segoe UI,Inter,sans-serif" font-size="12.5" font-weight="600">${label}</text>`
    )
  })
  const css =
    '<style>.bp{fill:#1c1c21}.bpt{fill:#ffffff}.bo{fill:none;stroke:#b0b0ba}.bot{fill:#1c1c21}' +
    '@media (prefers-color-scheme: dark){.bp{fill:#f2f2f5}.bpt{fill:#1c1c21}.bo{stroke:#5b5b64}.bot{fill:#e4e4e7}}</style>'
  return svg.replace(/<\/svg>$/, `${css}${parts.join('')}</svg>`)
}

const shots: [string, object, string[]][] = [
  ['countdown', { batonMode: 'armed', cards: [null, null, card('baton', 'gold', 2, 'Handing off in 36m if you stay away. A new prompt cancels it.', ['Hand off now', 'Not now'])] }, ['Hand off now', 'Not now']],
  ['calm', { tokens: 42_000, batonMode: 'light', ctxPct: 4 }, []],
  ['cold-cache', { five: { pct: 3, resetsAt: NOW + 291 * MIN }, batonMode: 'cold', cards: [null, null, card('baton', 'gold', 1, 'Cache went cold while you were away. Your next message re-reads all 393K at full cost.', ['Hand off now', 'Not now'])] }, ['Hand off now', 'Not now']],
  ['git-main', { tokens: 88_000, batonMode: 'light', bench: repo, ports: [5173], cards: [null, card('bench', 'watch', 2, 'On main with 3 uncommitted changes in notes-app.', ['Branch off', 'Push main']), null] }, ['Branch off', 'Push main']],
  ['git-unpushed', { tokens: 120_000, bench: { ...repo, branch: 'feat/search', isDefault: false, changed: 0 }, cards: [null, card('bench', 'watch', 2, '2 commits not on GitHub in notes-app.', ['Push branch']), null] }, ['Push branch']],
  ['near-limit', { five: { pct: 92, resetsAt: NOW + 38 * MIN }, seven: { pct: 71, resetsAt: NOW + 30 * HOUR }, tokens: 140_000, cards: [card('radar', 'hot', 2, 'Limit in ~14m at this pace. Resets in 38m.', []), null, null] }, []],
]

for (const [name, over, labels] of shots) {
  const deck = buildDeck({ ...base, ...over } as never)!
  const pic = deckSvg(deck, W, labels.length > 0 ? ACTIONS : 0)
  writeFileSync(new URL(`./${name}.svg`, import.meta.url), buttons(pic.source, labels))
  console.log(name)
}
