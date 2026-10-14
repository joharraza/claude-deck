// Workbench's pure model: reading git, netstat, tasklist and command-line
// output, reading the shell commands Claude runs, the status line and the
// band's scene. No `$` here.
import type { Bench, DeckCard, Server, WbBusy, WbMode } from '../types'

export const DEFAULT_BRANCH = /^(main|master)$/

export const AMBER = '#f59e0b'
export const RED = '#f87171'
export const CYAN = '#22d3ee'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ---------- git ----------

export type Status = Pick<Bench, 'branch' | 'upstream' | 'ahead' | 'behind' | 'changed' | 'conflicts'>

/** `git status --porcelain=v2 --branch`. */
export function parseStatus(out: string): Status {
  const s: Status = { branch: '', upstream: '', ahead: 0, behind: 0, changed: 0, conflicts: 0 }
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) s.branch = line.slice(14).trim()
    else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      if (m) {
        s.ahead = Number(m[1])
        s.behind = Number(m[2])
      }
    } else if (line.startsWith('u ')) {
      s.conflicts += 1
      s.changed += 1
    } else if (/^[12?] /.test(line)) s.changed += 1
  }
  return s
}

// ---------- dev servers ----------

const DEV_PROGRAM = /^(node|bun|deno|python|pythonw|py|php|ruby|java|dotnet|uvicorn|hugo|esbuild|caddy|workerd)\.exe$/i
// Processes of a dev runtime that are not the person's servers: Claude's own, editors', plugins'.
const NOT_DEV = /\\AppData\\Roaming\\Claude\\|\\AppData\\Local\\AnthropicClaude\\|\\\.claude\\|\\Microsoft VS Code\\|\\\.vscode\\|\\JetBrains\\/i
const INSTALL = /\\(Program Files( \(x86\))?|nodejs|AppData\\Local\\Programs|AppData\\Roaming\\npm|\.bun|\.deno|scoop|WindowsApps)\\/i

export function isDevPort(port: number): boolean {
  return (port >= 3000 && port <= 9999) || port === 1234 || port === 1313
}

export function isDevProgram(exe: string): boolean {
  return DEV_PROGRAM.test(exe)
}

/** `netstat -ano`: the dev ports each process listens on. */
export function parseNetstat(out: string): Map<number, number[]> {
  const m = new Map<number, number[]>()
  for (const line of out.split(/\r?\n/)) {
    const r = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (!r) continue
    const port = Number(r[2])
    const pid = Number(r[3])
    if (!isDevPort(port) || pid <= 4) continue
    const ports = m.get(pid) ?? []
    if (!ports.includes(port)) ports.push(port)
    m.set(pid, ports.sort((a, b) => a - b))
  }
  return m
}

/** `tasklist /fo csv /nh`: each process's program. */
export function parseTasklist(out: string): Map<number, string> {
  const m = new Map<number, string>()
  for (const line of out.split(/\r?\n/)) {
    const r = line.match(/^"([^"]+)","(\d+)"/)
    if (r) m.set(Number(r[2]), r[1]!)
  }
  return m
}

/** Lines of `<pid>\t<command line>`, as the CIM query prints them. */
export function parseCommandLines(out: string): Map<number, string> {
  const m = new Map<number, string>()
  for (const line of out.split(/\r?\n/)) {
    const r = line.match(/^(\d+)\t(.*)$/)
    if (r) m.set(Number(r[1]), r[2]!.trim())
  }
  return m
}

export function isOwnProcess(cmd: string): boolean {
  return NOT_DEV.test(cmd)
}

/** The project folder a server's command line names: the folder holding its node_modules, or its script's folder. */
export function projectOf(cmd: string): string {
  for (const raw of segments(cmd).flat()) {
    const p = raw.replace(/^--?[\w-]+=/, '').replace(/\//g, '\\')
    if (!/^[A-Za-z]:\\/.test(p) || INSTALL.test(p)) continue
    const at = p.toLowerCase().indexOf('\\node_modules\\')
    const dir = at >= 0 ? p.slice(0, at) : /\.[a-z0-9]+$/i.test(p) ? p.slice(0, p.lastIndexOf('\\')) : p
    const name = dir.split('\\').filter(Boolean).at(-1) ?? ''
    if (name && !/^[A-Za-z]:$/.test(name)) return name
  }
  return ''
}

export function serverLabel(s: Server): string {
  return `${s.project || s.name} ${s.ports.map(p => `:${p}`).join(' ')}`
}

// ---------- the commands Claude runs ----------

/** A shell command split into simple commands, each a list of words; quotes kept together, not escapes. */
export function segments(command: string): string[][] {
  const segs: string[][] = []
  let cur: string[] = []
  let tok = ''
  let hasTok = false
  let quote = ''
  const endTok = () => {
    if (hasTok) cur.push(tok)
    tok = ''
    hasTok = false
  }
  const endSeg = () => {
    endTok()
    if (cur.length > 0) segs.push(cur)
    cur = []
  }
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = ''
      else tok += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      hasTok = true
    } else if ('&|;()\n\r'.includes(ch)) endSeg()
    else if (ch === ' ' || ch === '\t') endTok()
    else {
      tok += ch
      hasTok = true
    }
  }
  endSeg()
  return segs
}

/** A path as a shell wrote it (`/c/x`, `C:/x`, relative), made absolute and Windows style; '' when it cannot tell. */
export function resolvePath(base: string, p: string): string {
  if (!p || /^[$~%]/.test(p)) return ''
  let s = p
  const drive = s.match(/^\/([a-zA-Z])(\/|$)/)
  if (drive) s = `${drive[1]!.toUpperCase()}:\\${s.slice(3)}`
  s = s.replace(/\//g, '\\')
  const isAbsolute = /^[a-zA-Z]:\\/.test(s)
  if (!isAbsolute && !/^[a-zA-Z]:\\/.test(base)) return ''
  const full = isAbsolute ? s : `${base.replace(/\\+$/, '')}\\${s}`
  const out: string[] = []
  for (const part of full.split('\\')) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(part)
  }
  return out.length === 1 ? `${out[0]}\\` : out.join('\\')
}

export type GitCall = { dir: string; verb: string; args: string[] }

const CD = /^(cd|chdir|pushd|set-location|sl)$/i

/** The folders a command moves into and the git commands it runs, each with the folder it runs in. */
export function readCommand(command: string, cwd: string): { calls: GitCall[]; dirs: string[] } {
  let dir = cwd
  const calls: GitCall[] = []
  const dirs: string[] = []
  for (const [head, ...rest] of segments(command)) {
    if (!head) continue
    if (CD.test(head)) {
      const arg = rest.find(t => !t.startsWith('-') && t.toLowerCase() !== '/d')
      const d = arg ? resolvePath(dir, arg) : ''
      if (d) {
        dir = d
        dirs.push(d)
      }
      continue
    }
    if (!/^git(\.exe)?$/i.test(head)) continue
    let at = dir
    let i = 0
    while (i < rest.length && rest[i]!.startsWith('-')) {
      const t = rest[i]!
      if (t === '-C' && rest[i + 1] !== undefined) {
        at = resolvePath(at, rest[i + 1]!) || at
        i += 2
      } else if (t === '-c' || t === '--git-dir' || t === '--work-tree') i += 2
      else i += 1
    }
    const verb = rest[i]
    if (!verb) continue
    if (at !== dir) dirs.push(at)
    calls.push({ dir: at, verb, args: rest.slice(i + 1) })
  }
  return { calls, dirs }
}

/** Whether a git command commits on, or pushes to, main or master. */
export function mainAction(call: GitCall, branch: string): 'commit' | 'push' | null {
  const isMain = DEFAULT_BRANCH.test(branch)
  if (call.args.some(a => a === '--dry-run' || a === '-h' || a === '--help')) return null
  if (call.verb === 'commit') return isMain ? 'commit' : null
  if (call.verb !== 'push' || call.args.includes('-n')) return null
  const refspecs = call.args.filter(a => !a.startsWith('-')).slice(1)
  if (refspecs.length === 0) return isMain ? 'push' : null
  const hitsMain = refspecs.some(r => {
    const ref = r.replace(/^\+/, '')
    return /(^|:)(refs\/heads\/)?(main|master)$/.test(ref) || (/^HEAD(:|$)/.test(ref) && isMain && !ref.includes(':'))
  })
  return hitsMain ? 'push' : null
}

// ---------- what shows ----------

/** The status line: `notes-app ⎇ feat/x · 3 changed · ↑2 unpushed · ● 2 servers :3000 :5173`. */
export function statusLine(b: Bench | null, servers: readonly Server[]): string | undefined {
  const parts: string[] = []
  if (b) {
    parts.push(`${b.name} ⎇ ${b.branch}`)
    if (b.conflicts > 0) parts.push(`${b.conflicts} conflicted`)
    parts.push(b.changed > 0 ? `${b.changed} changed` : 'clean')
    if (b.unpushed > 0) parts.push(b.hasRemote ? `↑${b.unpushed} unpushed` : `${plural(b.unpushed, 'commit')}, no remote`)
    if (b.behind > 0) parts.push(`↓${b.behind} behind`)
  }
  if (servers.length > 0) parts.push(`● ${plural(servers.length, 'server')} ${servers.flatMap(s => s.ports).map(p => `:${p}`).join(' ')}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export type Risk = 'conflict' | 'main-dirty' | 'unpushed' | 'no-remote'

export function risksOf(b: Bench | null): Risk[] {
  if (!b) return []
  const r: Risk[] = []
  if (b.conflicts > 0) r.push('conflict')
  if (b.isDefault && b.changed > 0) r.push('main-dirty')
  if (b.unpushed > 0) r.push(b.hasRemote ? 'unpushed' : 'no-remote')
  return r
}

export type Action = 'push' | 'branch' | 'stop' | 'snooze'
export type Button = { key: Action; label: string; isPrimary: boolean }

export type Scene = {
  risk: Risk | 'busy'
  tone: string
  chip: string
  hint: string
  title: string
  sub: string
  buttons: Button[]
  /** What ✕ dismisses: the band stays away until the repository, branch or risks change. */
  signature: string
}

export const BRANCH_OFF_PROMPT =
  'Move my uncommitted changes off main onto a new branch named for this work (git switch -c keeps them), then carry on there.'

export function buildScene(
  b: Bench | null,
  servers: readonly Server[],
  o: { snoozed: string; busy: WbBusy; mode: WbMode; isWorking: boolean },
): Scene | null {
  if (o.busy) {
    const isPush = o.busy === 'push'
    return {
      risk: 'busy',
      tone: CYAN,
      chip: isPush ? 'PUSHING' : 'STOPPING',
      hint: `Workbench${b ? ` · ${b.name}` : ''}`,
      title: isPush ? `Pushing ${b?.branch ?? 'the branch'} to GitHub…` : `Stopping ${plural(servers.length, 'dev server')}…`,
      sub: isPush ? `git push from ${b?.repo ?? 'the repository'}` : servers.map(serverLabel).join(' · '),
      buttons: [],
      signature: '',
    }
  }
  if (!b || o.mode === 'quiet' || o.isWorking) return null
  const risks = risksOf(b)
  const top = risks[0]
  if (top === undefined) return null
  const signature = `${b.repo}|${b.branch}|${risks.join(',')}`
  if (o.snoozed === signature) return null

  const heads: Record<Risk, { chip: string; title: string; phrase: string }> = {
    conflict: { chip: 'CONFLICT', title: `Merge conflict in ${plural(b.conflicts, 'file')}`, phrase: `${b.conflicts} conflicted` },
    'main-dirty': {
      chip: `ON ${b.branch.toUpperCase()}`,
      title: `On ${b.branch} with ${plural(b.changed, 'uncommitted change')}`,
      phrase: `${b.changed} uncommitted on ${b.branch}`,
    },
    unpushed: { chip: 'UNPUSHED', title: `${plural(b.unpushed, 'commit')} not on GitHub`, phrase: `↑${b.unpushed} not on GitHub` },
    'no-remote': { chip: 'NO REMOTE', title: `${plural(b.unpushed, 'commit')} only on this PC`, phrase: 'no remote set up' },
  }

  const sub = [`⎇ ${b.branch}`]
  for (const r of risks.slice(1)) sub.push(heads[r].phrase)
  if (top === 'no-remote') sub.push('no remote set up')
  if (!risks.includes('main-dirty') && b.changed > 0) sub.push(`${b.changed} changed`)
  if (b.behind > 0) sub.push(`↓${b.behind} behind`)
  if (servers.length > 0) sub.push(`servers ${servers.map(serverLabel).join(', ')}`)

  const buttons: Button[] = []
  for (const r of risks) {
    if (r === 'main-dirty') buttons.push({ key: 'branch', label: 'Branch off', isPrimary: false })
    if (r === 'unpushed') buttons.push({ key: 'push', label: b.isDefault ? `Push ${b.branch}` : 'Push branch', isPrimary: false })
  }
  if (servers.length > 0) buttons.push({ key: 'stop', label: 'Stop servers', isPrimary: false })
  const shown = buttons.slice(0, 2)
  if (shown[0] && shown[0].key !== 'stop') shown[0] = { ...shown[0], isPrimary: true }

  return {
    risk: top,
    tone: top === 'conflict' ? RED : AMBER,
    chip: heads[top].chip,
    hint: `Workbench · ${b.name}`,
    title: heads[top].title,
    sub: sub.join(' · '),
    buttons: shown,
    signature,
  }
}

/**
 * What the deck says for this scene: the risk in one sentence and its
 * buttons, kept out of view while Claude works; nothing when all is safe.
 */
export function toCard(sc: Scene | null, name: string): DeckCard | null {
  if (sc === null) return null
  if (sc.risk === 'busy') {
    return { id: 'bench:busy', rank: 2, tone: 'info', text: sc.title, command: 'bench', buttons: [], isCritical: true }
  }
  return {
    id: `bench:${sc.signature}`,
    rank: 2,
    tone: sc.risk === 'conflict' ? 'hot' : 'watch',
    text: `${sc.title} in ${name}.`,
    command: 'bench',
    buttons: sc.buttons.map(b => ({ args: b.key, label: b.label, ...(b.isPrimary ? { isPrimary: true } : {}) })),
    isCritical: false,
    isQuietWhileWorking: true,
  }
}

// ---------- PowerShell ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** A script for `powershell -EncodedCommand`: UTF-16LE, base64. */
export function encodePs(script: string): string {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i)
    bytes.push(c & 255, c >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!
    out += c === undefined ? '=' : B64[n & 63]!
  }
  return out
}

/** Prints `<pid>\t<command line>` for each process id given. */
export function commandLineScript(pids: readonly number[]): string {
  const filter = pids.map(p => `ProcessId=${Math.trunc(p)}`).join(' or ')
  return `$ProgressPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`
}
