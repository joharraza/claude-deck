/** A task-boundary signal: what happened, and how strongly it says "this task is done". */
export type Signal = {
  kind: 'wrap-up' | 'shipped' | 'committed' | 'published' | 'delivered' | 'todos-done' | 'you-said-done'
  weight: number
  at: number
}

/** A reason not to compact now: compacting would cost the current task its details. */
export type Veto = 'todos-open' | 'agents-running' | 'paused-work' | 'awaiting-answer'

/**
 * A mark on the relay track: a boundary seen or a handoff made. `pos` is the
 * session's distance: tokens handed off so far plus the context at the time.
 */
export type Mark = {
  kind: 'gate' | 'handoff'
  pos: number
  label: string
  /** Handoffs: the context before and after. */
  before?: number
  after?: number
}

/** An automatic handoff the person has not rated yet. */
export type Unrated = { at: number; before: number; after: number; why: string }

export type BatonState = {
  /** Context now, its window, and the size at the last handoff (the track's start). */
  tokens: number
  window: number
  /** Signals since the last handoff. */
  signals: Signal[]
  vetoes: Veto[]
  marks: Mark[]
  /** A timed handoff while the person is away: when it fires, and how strong the case. */
  armed: { fireAt: number; armedAt: number; needsJudge: boolean } | null
  /** What the band says about work in flight right now. */
  phase: 'idle' | 'judging' | 'compacting'
  unrated: Unrated | null
  /** Tokens the handoffs removed from the context, summed over this session. */
  removed: number
  /** Re-reading avoided: removed tokens times the model requests made since. */
  savedTokens: number
  handoffs: number
  lastNote: string
  lastNoteAt: number
  /** When the last main turn ended: an hour on, the prompt cache is cold. */
  lastTurnAt: number
  /** When the person passed on the cold-cache handoff. */
  coldSkippedAt: number
}

export type BatonPrefs = {
  mode: 'auto' | 'ask' | 'off'
  minTokens: number
  /** The judge's confidence bar; ratings move it. */
  bar: number
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

/** What Baton is doing, as its band once showed it: the deck colors the tank by it. */
export type BatonMode = 'light' | 'growing' | 'ready' | 'armed' | 'holding' | 'judging' | 'compacting' | 'handed' | 'cold'

declare module 'claude-code' {
  interface PluginState {
    baton: {
      state: BatonState
      /** The band's message and buttons, for the deck. */
      card: DeckCard | null
      prefs: BatonPrefs
      isHidden: boolean
      /** What Baton is doing now. */
      mode: BatonMode
      minute: number
    }
  }
}
