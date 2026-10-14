/** One rate-limit window as last measured. */
export type Window = { pct: number; resetsAt: number | null }

/** The latest reading: the 5-hour and 7-day windows and the context fill. */
export type Meter = {
  five: Window | null
  seven: Window | null
  ctx: number | null
}

/** A turn that died on the usage limit, waiting for the window to reset. */
export type Pause = {
  /** When to send the resume prompt, ms since epoch. */
  resumeAt: number
  /** False when the reset time was guessed rather than reported. */
  isKnown: boolean
  /** When the limit was hit, ms since epoch: the start of the countdown. */
  since: number
  /** How many times the resume has been tried for this pause. */
  tries: number
  /** The reset has passed while auto-continue was off: waiting on the person. */
  isDue: boolean
}

/**
 * What the deck band shows for this mod: one sentence and its buttons. The
 * deck draws the band; each button runs `/<command> <args>` back here.
 */
export type DeckCard = {
  /** Stable while the situation lasts: the deck's âœ• hides it until it changes. */
  id: string
  /** How urgent: 0 a note, 1 a suggestion, 2 a risk, 3 critical. */
  rank: number
  tone: 'ok' | 'watch' | 'hot' | 'gold' | 'info'
  text: string
  command: string
  buttons: { args: string; label: string; isPrimary?: boolean }[]
  /** Shown with no âœ•. */
  isCritical: boolean
  /** Kept out of view while Claude is working. */
  isQuietWhileWorking?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'limit-radar': {
      /** The band's message and buttons, for the deck. */
      card: DeckCard | null
      meter: Meter | null
      pause: Pause | null
      isAuto: boolean
      /** The band is hidden by its ✕ (critical states still show). */
      isHidden: boolean
      /** Subagents may run until this time even above the guard line. */
      agentsAllowedUntil: number
      /** Last time a subagent spawn was held, so the band can say so. */
      heldAt: number
      /** Set right after an auto-resume, for a short confirmation. */
      resumedAt: number
      /** Minute tick that redraws the countdown. */
      minute: number
    }
  }
}
