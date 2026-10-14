/** One git repository as the last look found it. */
export type Bench = {
  /** The repository's top folder, Windows style. */
  repo: string
  /** Its folder name, for the status line. */
  name: string
  /** The checked-out branch, or `(detached)`. */
  branch: string
  /** On main or master. */
  isDefault: boolean
  /** Changed, staged and untracked files. */
  changed: number
  /** Files with unresolved merge conflicts. */
  conflicts: number
  /** The upstream branch (`origin/main`), or '' when the branch has none. */
  upstream: string
  ahead: number
  behind: number
  /** The repository has at least one remote. */
  hasRemote: boolean
  /** Commits on no remote: ahead of the upstream, or with no remote at all, every commit. */
  unpushed: number
}

/** A dev server: a process of a dev runtime listening on a dev port. */
export type Server = {
  pid: number
  /** The program, without `.exe` (`node`, `python`). */
  name: string
  ports: number[]
  /** The project folder its command line names, or ''. */
  project: string
}

export type WbMode = 'on' | 'quiet'
export type WbBusy = '' | 'push' | 'stop'

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
    workbench: {
      bench: Bench | null
      /** The band's message and buttons, for the deck. */
      card: DeckCard | null
      servers: Server[]
      busy: WbBusy
      mode: WbMode
    }
  }
}
