import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { deckSvg } from './art.ts'
import type { Card, Inputs } from './model.ts'
import { MINUTE, buildDeck } from './model.ts'

// Desktop: the room the buttons take at the band's right edge, in CSS pixels.
const ACTIONS_W = 150

const snoozedA = atom({ plugin: 'deck', key: 'snoozed' } as const, '')
const hiddenA = atom({ plugin: 'deck', key: 'isHidden' } as const, false)
const minuteA = atom({ plugin: 'deck', key: 'minute' } as const, 0)

// Module variables start over on a reload; session.start fills them again.
let ticker: { cancel: () => void } | undefined
/** What happened since this load, for /deck debug: starts, redraw requests, draws and failures. */
const trace: string[] = []
let loadedAt = 0

function note(text: string): void {
  trace.push(`+${((Date.now() - loadedAt) / 1000).toFixed(1)}s ${text}`)
  if (trace.length > 40) trace.shift()
}

// ---------- helpers that take $ (top level, same file) ----------

/** Everything the band draws from, read while drawing so any change redraws it. */
async function gather($: EngineInterface, isWorking: boolean): Promise<Inputs> {
  // The three mods' values: the deck reads them, never writes them.
  const meter = (await $.state.get({ plugin: 'limit-radar', key: 'meter' } as const)).value ?? null
  const baton = (await $.state.get({ plugin: 'baton', key: 'state' } as const)).value
  const prefs = (await $.state.get({ plugin: 'baton', key: 'prefs' } as const)).value
  const servers = (await $.state.get({ plugin: 'workbench', key: 'servers' } as const)).value ?? []
  return {
    five: meter?.five ?? null,
    seven: meter?.seven ?? null,
    ctxPct: meter?.ctx ?? null,
    tokens: baton?.tokens ?? 0,
    window: baton?.window ?? 0,
    minTokens: prefs?.minTokens ?? 100_000,
    batonMode: (await $.state.get({ plugin: 'baton', key: 'mode' } as const)).value ?? '',
    bench: (await $.state.get({ plugin: 'workbench', key: 'bench' } as const)).value ?? null,
    ports: [...new Set(servers.flatMap(s => s.ports))],
    busy: (await $.state.get({ plugin: 'workbench', key: 'busy' } as const)).value ?? '',
    // Tie-break order: limits, then git, then the handoff.
    cards: [
      (await $.state.get({ plugin: 'limit-radar', key: 'card' } as const)).value,
      (await $.state.get({ plugin: 'workbench', key: 'card' } as const)).value,
      (await $.state.get({ plugin: 'baton', key: 'card' } as const)).value,
    ],
    snoozed: await read($, snoozedA),
    isWorking,
    now: await $.clock.now(),
  }
}

/** A button runs its mod's own command, so the mod does what it always did. */
async function run($: EngineInterface, card: Card, args: string): Promise<void> {
  try {
    await $.command.run({ command: card.command, args })
  } catch (err) {
    $.ui.toast(`Could not run /${card.command} ${args}: ${String(err).slice(0, 140)}`, { timeoutMs: 8000 })
  }
}

async function setHidden($: EngineInterface, isHidden: boolean): Promise<void> {
  await update($, hiddenA, () => isHidden)
  await $.store.set('isHidden', isHidden).catch(() => undefined)
}

async function tick($: EngineInterface): Promise<void> {
  const minute = Math.floor((await $.clock.now()) / MINUTE)
  if ((await read($, minuteA)) !== minute) await update($, minuteA, () => minute)
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'deck',
      description: 'Deck: show or hide the band with the limits, the context and git',
      argumentHint: 'hide | show | debug',
      immediate: true,
    })
    try {
      if ((await $.store.get('isHidden')) === true) await update($, hiddenA, () => true)
    } catch {
      // Shown by default.
    }
    ticker?.cancel()
    ticker = $.clock.every(20_000, () => void tick($).catch(() => undefined))
    await tick($)
    // A reload brings a fresh module, but the band on screen is the old one's
    // until something it read changes: draw again now, and once more after the
    // other mods have published from their own reload.
    loadedAt = Date.now()
    note(`session.start (${e.surface})`)
    $.ui.invalidate('ui.render')
    for (const ms of [1500, 5000]) {
      $.clock.after(ms, () => {
        note(`redraw asked (${ms} ms)`)
        $.ui.invalidate('ui.render')
      })
    }
    return started
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'debug') return { text: ['Deck since its last load:', ...trace].join('\n') }
    const isHidden = arg === 'hide' ? true : arg === 'show' ? false : !(await read($, hiddenA))
    await setHidden($, isHidden)
    return { text: isHidden ? 'Deck band hidden. /deck show brings it back.' : 'Deck band shown above the prompt.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.props.hasSurvey || (await read($, hiddenA))) return drawn
    await read($, minuteA) // redraws each minute for the reset countdowns

    let deck: ReturnType<typeof buildDeck>
    try {
      deck = buildDeck(await gather($, e.props.isWorking))
    } catch (err) {
      // A mod beside it may be mid-reload: try again shortly rather than stay blank.
      note(`draw failed: ${String(err).slice(0, 160)}`)
      $.clock.after(1000, () => $.ui.invalidate('ui.render'))
      return drawn
    }
    note(`drew (${e.surface}${deck === null ? ', nothing measured yet' : ''}; maxRows ${e.props.maxRows}, window ${e.props.scroll.bodyRows} from ${e.props.scroll.offset}${drawn ? ', another band above' : ''})`)
    if (deck === null) return drawn
    const card = deck.message.card
    const buttons = card?.buttons ?? []
    const cols = Math.max(30, e.props.bodyColumns || 80)

    if (e.surface === 'terminal') {
      const { Box, Button, Client } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {drawn}
          <Box key="deck" flexDirection="row">
            <Client key="deck-strip" module="./strip.tsx" width={cols - 3} height={2} props={deck} />
          </Box>
          {card && buttons.length > 0 && (
            <Box key="deck-actions" flexDirection="row" gap={1} paddingLeft={4}>
              {buttons.map(b => (
                <Button key={`deck-${card.command}-${b.args}`} label={b.label} variant={b.isPrimary ? 'primary' : undefined} onPress={() => void run($, card, b.args)} />
              ))}
            </Box>
          )}
        </Box>
      )
    }

    // Desktop: one drawing whose frame spans the buttons' room too; the buttons
    // are laid back over that room, so they sit inside the band. The main one
    // is filled, the rest outlined.
    const { Box, Button, Svg } = $.ui.resolve(e)
    const actionsW = card && buttons.length > 0 ? ACTIONS_W : 0
    const pic = deckSvg(deck, (cols - 3) * 8 - 8, actionsW)
    return (
      <Box flexDirection="column">
        {drawn}
        <Box key="deck" flexDirection="row" alignItems="center">
          <Svg source={pic.source} alt={pic.alt} width={pic.width} height={pic.height} />
          {card && actionsW > 0 && (
            <Box
              key="deck-actions"
              flexDirection="column"
              alignItems="center"
              justifyContent="center"
              gap={1}
              width={actionsW}
              height={pic.height}
              marginLeft={-actionsW}
              paddingX={2}
            >
              {buttons.map(b => (
                <Button
                  key={`deck-${card.command}-${b.args}`}
                  label={b.label}
                  variant={b.isPrimary ? 'primary' : 'secondary'}
                  onPress={() => void run($, card, b.args)}
                />
              ))}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
