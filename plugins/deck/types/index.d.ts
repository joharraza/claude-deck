/** The id of a card the person dismissed with ✕. */
export type DeckSnooze = string

declare module 'claude-code' {
  interface PluginState {
    deck: {
      /** The card dismissed with ✕: it stays away until its id changes. */
      snoozed: DeckSnooze
      /** The whole band, hidden by /deck hide. */
      isHidden: boolean
      /** Minute tick that redraws the reset countdowns. */
      minute: number
    }
  }
}
