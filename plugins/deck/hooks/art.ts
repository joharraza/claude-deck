// The deck's desktop drawing: one SVG, deck in, markup out.
// Left: three liquid tubes (5-hour and 7-day limits, context against its
// window with Baton's line) with a light running through the liquid, and under
// them the one message. Right: a corner that acts out the repository (a commit
// rising to the cloud, a branch reaching off main, a knot, a spinner), or,
// with no repository in view, Limit Radar's scope (a dark disc, a fading beam,
// a blip per reading) beside Baton's glass tank of context. The frame also
// spans the room the buttons are laid over, so they sit inside it.
import type { Deck, Slot, Tube } from './model.ts'
import { TONE, clamp01, cool, heat } from './model.ts'

export const H = 116
const MIN_W = 460
const SLOT_W = 128

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI Variable','Segoe UI',Inter,sans-serif"

const BASE_CSS = `
.t{fill:#1c1c21}.s{fill:#5b5b64}.m{fill:#8a8a93}.k{fill:#e7e6ec}.kt{stroke:#e2e1e7}.nt{stroke:#5b5b64}.mn{stroke:#a1a1aa}.mf{fill:#a1a1aa}.dk{display:none}
@media (prefers-color-scheme: dark){.t{fill:#f2f2f5}.s{fill:#b0b0ba}.m{fill:#7b7b85}.k{fill:#2a2a31}.kt{stroke:#34343c}.nt{stroke:#b0b0ba}.mn{stroke:#52525b}.mf{fill:#52525b}.lt{display:none}.dk{display:inline}}
@keyframes dkSpin{to{transform:rotate(360deg)}}
@keyframes dkWave{to{transform:translateX(-56px)}}
@keyframes dkBubble{0%{transform:translateY(0);opacity:0}20%{opacity:.7}100%{transform:translateY(-26px);opacity:0}}
@keyframes dkPulse{50%{opacity:.35}}
@keyframes dkRise{0%{transform:translate(0,0);opacity:0}15%{opacity:1}80%{opacity:1}100%{transform:translate(20px,-11px);opacity:0}}
@keyframes dkBlip{0%{opacity:1;transform:scale(1.9)}18%{opacity:.85;transform:scale(1)}100%{opacity:.28;transform:scale(1)}}
@keyframes dkRing{0%{transform:scale(.6);opacity:.9}100%{transform:scale(2.2);opacity:0}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}
`

const GLOW =
  `<filter id="dkGlow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`

const XML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: string) => s.replace(/[&<>"']/g, c => XML[c] ?? c)
const f1 = (n: number) => n.toFixed(1)

type TextOpts = { cls?: string; fill?: string; size?: number; weight?: number; anchor?: string }

function text(x: number, y: number, s: string, o: TextOpts = {}): string {
  const paint = o.fill ? `fill="${o.fill}"` : `class="${o.cls ?? 't'}"`
  return (
    `<text ${paint} x="${f1(x)}" y="${f1(y)}" font-family="${FONT}" font-size="${o.size ?? 12}" font-weight="${o.weight ?? 500}"` +
    (o.anchor ? ` text-anchor="${o.anchor}"` : '') +
    ` font-variant-numeric="tabular-nums">${esc(s)}</text>`
  )
}

function deepen(hex: string, k = 0.38): string {
  const n = parseInt(hex.slice(1), 16)
  const c = (x: number) => Math.round(x * (1 - k)).toString(16).padStart(2, '0')
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`
}

/** Colored text readable on both themes: deeper on light, as is on dark. */
function tinted(x: number, y: number, s: string, color: string, o: TextOpts = {}): string {
  return `<g class="lt">${text(x, y, s, { ...o, fill: deepen(color) })}</g><g class="dk">${text(x, y, s, { ...o, fill: color })}</g>`
}

export function textWidth(s: string, size: number): number {
  let w = 0
  for (const ch of s) w += (/[\s.,:;'|!il1()·]/.test(ch) ? 0.3 : /[A-Z@%MWmw]/.test(ch) ? 0.7 : 0.56) * size
  return w
}

export function fit(s: string, size: number, maxW: number): string {
  if (maxW <= 0) return ''
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size) > maxW) break
    out += ch
  }
  return out.length > 0 ? `${out.trimEnd()}…` : ''
}

/** At most two lines: words fill the first, the rest fits the second with an ellipsis. */
export function wrap2(s: string, size: number, maxW: number): string[] {
  const words = s.split(/\s+/).filter(Boolean)
  let first = ''
  let i = 0
  for (; i < words.length; i++) {
    const next = first ? `${first} ${words[i]}` : (words[i] ?? '')
    if (textWidth(next, size) > maxW) break
    first = next
  }
  if (first === '') return [fit(s, size, maxW)]
  const rest = words.slice(i).join(' ')
  return rest ? [first, fit(rest, size, maxW)] : [first]
}

// ---------- the tubes ----------

/** The colors along a tube: usage heat, or the context tint (cyan, violet, magenta). */
function stops(t: Tube): string {
  const paint = t.paint === 'heat' ? heat : cool
  const at = t.paint === 'heat' ? [0, 0.6, 0.8, 1] : [0, 0.3, 0.6, 1]
  return at.map(o => `<stop offset="${o}" stop-color="${paint(o)}"/>`).join('')
}

/**
 * One tube, as Limit Radar drew its meters: a gradient along the whole tube
 * shown as far as the fill, a glow, a light running through the liquid, and
 * the clock's place in the window (amber when usage runs ahead of it).
 * The light's run depends on the fill, so its keyframes go into `css`.
 */
function tube(t: Tube, i: number, x: number, cy: number, w: number, valueX: number, css: string[]): string {
  const y = cy - 4
  const h = 8
  const fillW = Math.max(0, w * t.fill)
  const id = `dkT${i}`
  const out: string[] = []
  out.push(text(16, cy + 4, t.label, { cls: 'm', size: 11, weight: 650 }))
  out.push(
    `<linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="${f1(x)}" y1="0" x2="${f1(x + w)}" y2="0">${stops(t)}</linearGradient>`,
  )
  out.push(`<rect class="k" x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${h}" rx="4"/>`)
  if (fillW > 0.5) {
    const fw = Math.max(h, fillW)
    out.push(`<clipPath id="${id}"><rect x="${f1(x)}" y="${f1(y)}" width="${f1(fw)}" height="${h}" rx="4"/></clipPath>`)
    out.push(`<rect x="${f1(x)}" y="${f1(y)}" width="${f1(fw)}" height="${h}" rx="4" fill="url(#${id}g)" filter="url(#dkGlow)"/>`)
    if (fw > 24) {
      out.push(
        `<g clip-path="url(#${id})"><rect x="${f1(x - 22)}" y="${f1(y)}" width="18" height="${h}" rx="4" fill="#ffffff" fill-opacity=".35" ` +
          `style="animation:dkShine${i} 2.6s cubic-bezier(.45,0,.2,1) ${f1(i * 0.6)}s infinite"/></g>`,
      )
      css.push(`@keyframes dkShine${i}{from{transform:translateX(0)}to{transform:translateX(${f1(fw + 4)}px)}}`)
    }
  }
  if (t.isHot) {
    // A limit pulses in its own color; the context pulses gold, with the tank, while a hand-off counts down.
    const ring = t.paint === 'ctx' ? TONE.gold : t.tone
    const glow = t.paint === 'ctx' ? ' filter="url(#dkGlow)"' : ''
    out.push(`<rect x="${f1(x - 1.5)}" y="${f1(y - 1.5)}" width="${f1(w + 3)}" height="${h + 3}" rx="5.5" fill="none" stroke="${ring}" stroke-width="1.4"${glow} style="animation:dkPulse 1.6s ease-in-out infinite"/>`)
  }
  if (t.notch !== null) {
    const nx = x + w * t.notch
    out.push(`<path class="nt" d="M${f1(nx)} ${f1(y - 3)}V${f1(y + h + 3)}" stroke-width="1.2" stroke-dasharray="2 2"/>`)
  }
  if (t.mark !== null) {
    // The clock's place in the window: usage past it is running hot.
    const mx = x + w * t.mark
    const isAhead = t.fill > t.mark + 0.04
    const paint = isAhead ? `fill="${TONE.watch}"` : 'class="m"'
    out.push(
      `<path d="M${f1(mx - 3)} ${f1(y - 6.5)}h6l-3 3.5z" ${paint}/>` +
        `<path d="M${f1(mx)} ${f1(y - 2.5)}V${f1(y + h + 2.5)}" stroke="${isAhead ? TONE.watch : '#8a8a93'}" stroke-width="1.2"/>`,
    )
  }
  out.push(tinted(valueX, cy + 4.3, t.value, t.tone === TONE.calm ? '#8a8a93' : t.tone, { size: 12.5, weight: 700 }))
  // Bold digits run wider than the estimate: give the note room.
  if (t.note) out.push(text(valueX + textWidth(t.value, 12.5) * 1.15 + 9, cy + 4, t.note, { cls: 's', size: 11 }))
  return out.join('')
}

// ---------- the corner ----------

function cloud(x: number, y: number, tone: string, extra = ''): string {
  return (
    `<path d="M${x - 8} ${y + 4}H${x + 8}A4 4 0 0 0 ${x + 8} ${y - 4}A5.5 5.5 0 0 0 ${x - 1} ${y - 5.5}A5 5 0 0 0 ${x - 8} ${y + 4}Z" ` +
    `fill="${tone}" fill-opacity=".14" stroke="${tone}" stroke-width="1.4" stroke-linejoin="round" ${extra}/>`
  )
}

function gitCorner(s: Extract<Slot, { kind: 'git' }>, x0: number): string {
  const t = s.tone
  const out: string[] = []
  const mainY = 56
  const brY = 36
  out.push(`<path class="mn" d="M${x0 + 8} ${mainY}H${x0 + 74}" stroke-width="2" stroke-linecap="round"/>`)
  out.push(`<circle class="mf" cx="${x0 + 20}" cy="${mainY}" r="3.6"/><circle class="mf" cx="${x0 + 40}" cy="${mainY}" r="3.6"/>`)
  const branch = `M${x0 + 40} ${mainY}C${x0 + 52} ${mainY} ${x0 + 50} ${brY} ${x0 + 64} ${brY}H${x0 + 80}`
  if (s.motion === 'fork') {
    out.push(`<path d="${branch}" fill="none" stroke="${t}" stroke-width="2" stroke-dasharray="3 2.5" stroke-linecap="round" style="animation:dkPulse 2.2s ease-in-out infinite"/>`)
    out.push(`<circle cx="${x0 + 84}" cy="${brY}" r="4" fill="none" stroke="${t}" stroke-width="1.6" stroke-dasharray="2 1.6" style="animation:dkPulse 1.4s ease-in-out infinite"/>`)
    out.push(`<circle cx="${x0 + 64}" cy="${mainY}" r="4.2" fill="${t}" filter="url(#dkGlow)"/>`)
  } else {
    out.push(`<path d="${branch}" fill="none" stroke="${t}" stroke-width="2" stroke-linecap="round" filter="url(#dkGlow)"/>`)
    out.push(`<circle cx="${x0 + 64}" cy="${brY}" r="3.6" fill="${t}" filter="url(#dkGlow)"/><circle cx="${x0 + 80}" cy="${brY}" r="4.4" fill="${t}" filter="url(#dkGlow)"/>`)
  }
  const cx = x0 + 106
  const cy = 20
  if (s.motion === 'lone') {
    out.push(`<g style="animation:dkPulse 2s ease-in-out infinite">${cloud(cx, cy, t, 'stroke-dasharray="2 1.6"')}<path d="M${cx - 9} ${cy + 8}L${cx + 9} ${cy - 8}" stroke="${t}" stroke-width="1.6" stroke-linecap="round"/></g>`)
  } else {
    out.push(`<g filter="url(#dkGlow)">${cloud(cx, cy, t)}</g>`)
  }
  if (s.motion === 'rise') {
    out.push(`<circle cx="${x0 + 82}" cy="${brY - 2}" r="2.6" fill="${t}" filter="url(#dkGlow)" style="animation:dkRise 1.8s ease-in infinite"/>`)
  }
  if (s.motion === 'knot') {
    out.push(`<g transform="translate(${x0 + 80} ${brY})"><circle r="5" fill="${t}" fill-opacity=".3" style="transform-box:fill-box;transform-origin:center;animation:dkRing 1.4s ease-out infinite"/></g>`)
    out.push(`<path d="M${x0 + 77.6} ${brY - 2.4}L${x0 + 82.4} ${brY + 2.4}M${x0 + 82.4} ${brY - 2.4}L${x0 + 77.6} ${brY + 2.4}" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>`)
  }
  if (s.motion === 'busy') {
    out.push(`<g transform="translate(${cx} ${cy})"><g style="animation:dkSpin 1.1s linear infinite"><path d="M0 -13A13 13 0 0 1 13 0" fill="none" stroke="${t}" stroke-width="2.2" stroke-linecap="round"/></g></g>`)
  }
  if (s.motion === 'calm') {
    out.push(`<path d="M${cx - 3.5} ${cy}l2.4 2.4l4.6 -4.8" fill="none" stroke="${t}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)
  }
  const head = fit(s.name, 12, SLOT_W - 8)
  const headW = textWidth(head, 12)
  out.push(text(x0 + 4, 92, head, { cls: 't', size: 12, weight: 700 }))
  out.push(text(x0 + 4 + headW + 6, 92, fit(`⎇ ${s.branch}`, 11, SLOT_W - 14 - headW), { cls: 's', size: 11 }))
  out.push(tinted(x0 + 4, 107, fit(s.detail, 11, SLOT_W - 8), s.motion === 'calm' ? '#8a8a93' : t, { size: 11, weight: 600 }))
  return out.join('')
}

/** Limit Radar's scope: a dark disc, a beam fading behind its edge, a blip per reading. */
function scope(s: Extract<Slot, { kind: 'radar' }>, cx: number, cy: number, r: number): string {
  const tone = s.fiveTone
  const period = s.five >= 0.9 ? 2.2 : s.five >= 0.75 ? 3.2 : 4.5
  const out: string[] = []
  out.push(
    `<radialGradient id="dkDisc" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#131b30"/><stop offset=".75" stop-color="#0a0f1d"/><stop offset="1" stop-color="#05070d"/></radialGradient>` +
      `<clipPath id="dkScope"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>`,
  )
  // Bezel: the 5-hour usage.
  const ringR = r + 4
  const C = 2 * Math.PI * ringR
  out.push(`<circle class="kt" cx="${cx}" cy="${cy}" r="${ringR}" fill="none" stroke-width="3.4"/>`)
  out.push(
    `<circle cx="${cx}" cy="${cy}" r="${ringR}" fill="none" stroke="${heat(s.five)}" stroke-width="3.4" stroke-linecap="round" ` +
      `stroke-dasharray="${f1(Math.max(0.01, s.five) * C)} ${f1(C)}" transform="rotate(-90 ${cx} ${cy})" filter="url(#dkGlow)"/>`,
  )
  // The disc, its rings and crosshair.
  out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#dkDisc)"/>`)
  for (const k of [0.34, 0.67, 1]) {
    out.push(`<circle cx="${cx}" cy="${cy}" r="${f1(r * k)}" fill="none" stroke="${tone}" stroke-opacity="${k === 1 ? 0.35 : 0.16}" stroke-width="${k === 1 ? 1 : 0.7}"/>`)
  }
  out.push(`<path d="M${cx - r} ${cy}H${cx + r}M${cx} ${cy - r}V${cy + r}" stroke="${tone}" stroke-opacity=".1" stroke-width=".7"/>`)
  // The beam: thin slices fading behind a bright leading edge.
  const slices: string[] = []
  const N = 12
  const spread = 52
  for (let i = 0; i < N; i++) {
    const a0 = (-(i + 1) * spread * Math.PI) / (N * 180)
    const a1 = (-i * spread * Math.PI) / (N * 180)
    const op = (0.42 * (1 - i / N) ** 1.8).toFixed(3)
    slices.push(
      `<path d="M${cx} ${cy}L${f1(cx + r * Math.cos(a1))} ${f1(cy + r * Math.sin(a1))}A${r} ${r} 0 0 0 ${f1(cx + r * Math.cos(a0))} ${f1(cy + r * Math.sin(a0))}Z" fill="${tone}" fill-opacity="${op}"/>`,
    )
  }
  out.push(
    `<g clip-path="url(#dkScope)"><g style="transform-box:view-box;transform-origin:${cx}px ${cy}px;animation:dkSpin ${period}s linear infinite">` +
      slices.join('') +
      `<line x1="${cx}" y1="${cy}" x2="${cx + r}" y2="${cy}" stroke="${tone}" stroke-width="1.3" stroke-opacity=".95" filter="url(#dkGlow)"/></g></g>`,
  )
  // Blips: one per reading, farther out the fuller it is, flaring as the beam passes.
  const blips: [number, number, string][] = [
    [300, s.five, heat(s.five)],
    [60, s.seven, heat(s.seven)],
    [175, s.ctx, cool(s.ctx)],
  ]
  for (const [ang, k, color] of blips) {
    const rr = r * (0.22 + 0.68 * clamp01(k))
    const bx = cx + rr * Math.cos((ang * Math.PI) / 180)
    const by = cy + rr * Math.sin((ang * Math.PI) / 180)
    const delay = ((ang / 360) * period).toFixed(2)
    out.push(
      `<g style="transform-box:fill-box;transform-origin:center;opacity:.28;animation:dkBlip ${period}s linear ${delay}s infinite">` +
        `<circle cx="${f1(bx)}" cy="${f1(by)}" r="4" fill="${color}" fill-opacity=".25"/>` +
        `<circle cx="${f1(bx)}" cy="${f1(by)}" r="1.9" fill="${color}" filter="url(#dkGlow)"/></g>`,
    )
  }
  // The 5-hour figure on a dark plate so it reads over the beam.
  out.push(`<circle cx="${cx}" cy="${cy}" r="${f1(r * 0.42)}" fill="#070a14" fill-opacity=".82"/>`)
  out.push(text(cx, cy + 4, s.center, { fill: '#f5f7ff', size: s.center.length > 3 ? 9.5 : 11, weight: 750, anchor: 'middle' }))
  return out.join('')
}

/** Baton's glass tank, in Baton's color for what it is doing: two moving surfaces, its line, bubbles while it works. */
function tank(s: Extract<Slot, { kind: 'radar' }>, cx: number, cy: number, r: number): string {
  const tone = s.ctxTone
  const out: string[] = []
  out.push(
    `<clipPath id="dkTank"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>` +
      `<linearGradient id="dkLiquid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone}" stop-opacity=".95"/><stop offset="1" stop-color="${tone}" stop-opacity=".45"/></linearGradient>` +
      `<radialGradient id="dkGlass" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#1a2236"/><stop offset="1" stop-color="#070a12"/></radialGradient>`,
  )
  const ringR = r + 4
  out.push(`<circle class="kt" cx="${cx}" cy="${cy}" r="${ringR}" fill="none" stroke-width="3.4"/>`)
  out.push(
    `<circle cx="${cx}" cy="${cy}" r="${ringR}" fill="none" stroke="${tone}" stroke-opacity="${s.isCalling ? 0.8 : 0.3}" stroke-width="${s.isCalling ? 1.8 : 1.2}"` +
      (s.isCalling ? ` filter="url(#dkGlow)" style="animation:dkPulse 1.8s ease-in-out infinite"` : '') +
      `/>`,
  )
  out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#dkGlass)"/>`)
  const level = cy + r - 2 * r * Math.max(0.03, s.ctx)
  const wave = (y: number, amp: number) => {
    let d = `M${cx - r - 60} ${f1(y)}`
    for (let x = cx - r - 60; x < cx + r + 60; x += 28) d += `q14 ${f1(-amp)} 28 0`
    return `${d}V${cy + r + 2}H${cx - r - 60}Z`
  }
  out.push(
    `<g clip-path="url(#dkTank)">` +
      `<path d="${wave(level + 2, 2.6)}" fill="${tone}" fill-opacity=".28" style="animation:dkWave 5.5s linear infinite"/>` +
      `<path d="${wave(level, 2.1)}" fill="url(#dkLiquid)" style="animation:dkWave 3.4s linear infinite reverse"/>`,
  )
  if (s.isBusy && s.ctx > 0.05) {
    for (const [dx, delay, rr] of [[-9, 0, 1.4], [4, 1.1, 1.1], [10, 2.2, 1], [-2, 3.0, 1.2]] as const) {
      out.push(`<circle cx="${cx + dx}" cy="${cy + r - 5}" r="${rr}" fill="#ffffff" fill-opacity=".6" style="animation:dkBubble 3.6s ease-in ${delay}s infinite"/>`)
    }
  }
  const ty = cy + r - 2 * r * clamp01(s.notch)
  out.push(`<line x1="${cx - r}" y1="${f1(ty)}" x2="${cx + r}" y2="${f1(ty)}" stroke="#ffffff" stroke-opacity=".45" stroke-width="1" stroke-dasharray="3 3"/></g>`)
  out.push(`<path d="M${f1(cx - r * 0.62)} ${f1(cy - r * 0.42)}a${f1(r * 0.75)} ${f1(r * 0.75)} 0 0 1 ${f1(r * 0.5)} ${f1(-r * 0.36)}" stroke="#ffffff" stroke-opacity=".22" stroke-width="2.4" fill="none" stroke-linecap="round"/>`)
  out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${tone}" stroke-opacity=".45" stroke-width="1"/>`)
  out.push(`<rect x="${cx - 17}" y="${cy - 8}" width="34" height="15" rx="6" fill="#05070d" fill-opacity=".55"/>`)
  out.push(text(cx, cy + 3.6, s.tokensLabel, { fill: '#f5f7ff', size: 10.5, weight: 750, anchor: 'middle' }))
  return out.join('')
}

function radarCorner(s: Extract<Slot, { kind: 'radar' }>, x0: number): string {
  const out: string[] = []
  // Same size, same height: the scope and the tank read as a pair.
  out.push(scope(s, x0 + 31, 38, 23))
  out.push(tank(s, x0 + 95, 38, 23))
  out.push(text(x0 + 4, 92, s.label, { cls: 'm', size: 11, weight: 650 }))
  out.push(text(x0 + 4, 107, fit(s.detail, 11, SLOT_W - 8), { cls: 's', size: 11 }))
  return out.join('')
}

// ---------- the band ----------

/**
 * `width` is the whole frame; the rightmost `reserve` pixels are left empty
 * for the buttons the host lays over them, so they sit inside the frame.
 */
export function deckSvg(d: Deck, width: number, reserve = 0): { source: string; width: number; height: number; alt: string } {
  const W = Math.max(MIN_W + reserve, Math.round(width))
  const slotX = W - reserve - SLOT_W - 8
  const tubeX = 44
  const tubeW = Math.max(90, Math.min(340, slotX - 12 - tubeX - 175))
  const valueX = tubeX + tubeW + 12
  const tone = d.message.tone
  const parts: string[] = []
  const css: string[] = []

  parts.push(`<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12" fill="${tone}" fill-opacity=".05" stroke="${tone}" stroke-opacity=".3"/>`)
  d.tubes.forEach((t, i) => parts.push(tube(t, i, tubeX, 20 + i * 21, tubeW, valueX, css)))

  const hasCard = d.message.card !== null
  parts.push(`<circle cx="20" cy="88" r="3.6" fill="${tone}"${hasCard ? ' style="animation:dkPulse 1.6s ease-in-out infinite"' : ''}/>`)
  const lines = wrap2(d.message.text, 12.5, slotX - 12 - 30)
  lines.forEach((l, i) => parts.push(text(30, 92 + i * 15, l, { cls: hasCard ? 't' : 's', size: 12.5, weight: hasCard ? 600 : 500 })))

  parts.push(`<path class="kt" d="M${slotX - 6} 12V104" stroke-width="1"/>`)
  parts.push(d.slot.kind === 'git' ? gitCorner(d.slot, slotX) : radarCorner(d.slot, slotX))

  if (reserve > 0) parts.push(`<path class="kt" d="M${W - reserve} 14V102" stroke-width="1"/>`)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${BASE_CSS}${css.join('')}</style><defs>${GLOW}</defs>${parts.join('')}</svg>`
  return { source, width: W, height: H, alt: d.alt }
}
