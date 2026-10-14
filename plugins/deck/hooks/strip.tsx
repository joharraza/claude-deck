// The deck's terminal band: a Client surface module animating at 10 fps.
// Row one: the three tubes as bars with a light running through the fill.
// Row two: the corner (the repository, or a turning radar glyph with no
// repository) and the one message. No `$` here: the hooks module sends the
// deck as plain props.
import type { ClientModule, RenderElement } from 'claude-code'

import type { Deck, Tube } from './model.ts'

type StripState = { t: number }
type Run = { text: string; color?: string; bg?: string; bold?: boolean; dim?: boolean }

const TRACK = '#3f3f46'
const SWEEP = ['◜', '◝', '◞', '◟']
const GIT: Record<string, string[]> = {
  calm: ['●─●'],
  rise: ['●─● ', '●─●•', '●─● ˙'],
  fork: ['●─╮ ', '●─╮·'],
  knot: ['╲✕╱', '╲ ╱'],
  lone: ['● ✕', '●  '],
  busy: ['◐', '◓', '◑', '◒'],
}

function bar(tube: Tube, cells: number, t: number): Run[] {
  const full = Math.round(tube.fill * cells)
  const notch = tube.notch === null ? -1 : Math.min(cells - 1, Math.floor(tube.notch * cells))
  const shine = full > 2 ? Math.floor((t / 2) % (full + 6)) : -1
  const runs: Run[] = []
  for (let i = 0; i < cells; i++) {
    if (i === notch && i >= full) runs.push({ text: '┃', color: '#e4e4e7' })
    else if (i < full) runs.push({ text: '━', color: i === shine ? '#ffffff' : tube.tone, bold: i === shine })
    else runs.push({ text: '─', color: TRACK })
  }
  return runs
}

const Strip: ClientModule<Deck, StripState> = (props, surface) => {
  if (surface.state === undefined) {
    surface.setState({ t: 0 })
    surface.every(100, () => surface.setState({ t: (surface.state?.t ?? 0) + 1 }))
  }
  const t = surface.state?.t ?? 0
  const { Box, Text } = surface.elements
  const width = surface.columns || 80
  const d = props

  const cells = Math.max(6, Math.min(20, Math.floor((width - 3 * 26) / 3)))
  const top: Run[] = [{ text: ' ' }]
  for (const tube of d.tubes) {
    top.push({ text: `${tube.label} `, dim: true })
    top.push(...bar(tube, cells, t))
    const isBlink = tube.isHot && Math.floor(t / 8) % 2 === 1
    // The context number blinks gold while a hand-off counts down.
    const color = tube.isHot && tube.key === 'ctx' && isBlink ? '#fbbf24' : tube.tone
    top.push({ text: ` ${tube.value}`, color, bold: !isBlink })
    if (tube.note) top.push({ text: ` ${tube.note}`, dim: true })
    top.push({ text: '   ' })
  }

  const s = d.slot
  const bottom: Run[] = [{ text: ' ' }]
  if (s.kind === 'git') {
    const frames = GIT[s.motion] ?? ['●─●']
    bottom.push({ text: `${frames[Math.floor(t / 4) % frames.length] ?? ''} `, color: s.tone, bold: true })
    bottom.push({ text: s.name, bold: true })
    bottom.push({ text: ` ⎇ ${s.branch} · ${s.detail}`, dim: true })
  } else {
    bottom.push({ text: `${SWEEP[Math.floor(t / 3) % SWEEP.length] ?? '◜'} `, color: s.fiveTone, bold: true })
    bottom.push({ text: `${s.label} · ${s.detail}`, dim: true })
  }
  bottom.push({ text: '   │  ', color: TRACK })
  const isBlink = d.message.card !== null && Math.floor(t / 10) % 2 === 1
  bottom.push({ text: '● ', color: d.message.tone, bold: true, dim: isBlink })
  bottom.push(d.message.card ? { text: d.message.text, bold: true } : { text: d.message.text, dim: true })

  const line = (runs: Run[], key: string): RenderElement => {
    const merged: Run[] = []
    for (const r of runs) {
      const last = merged[merged.length - 1]
      if (last && last.color === r.color && last.bg === r.bg && last.bold === r.bold && last.dim === r.dim) last.text += r.text
      else merged.push({ ...r })
    }
    return (
      <Text key={key} wrap="truncate-end">
        {merged.map((r, i) => (
          <Text key={String(i)} color={r.color} backgroundColor={r.bg} bold={r.bold} dimColor={r.dim}>
            {r.text}
          </Text>
        ))}
      </Text>
    )
  }

  return (
    <Box flexDirection="column">
      {line(top, 'a')}
      {line(bottom, 'b')}
    </Box>
  )
}

export default Strip
