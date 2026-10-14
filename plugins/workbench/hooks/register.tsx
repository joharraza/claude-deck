import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bench, Server, WbBusy, WbMode } from '../types'
import {
  BRANCH_OFF_PROMPT,
  DEFAULT_BRANCH,
  buildScene,
  commandLineScript,
  encodePs,
  isDevProgram,
  isOwnProcess,
  mainAction,
  parseCommandLines,
  parseNetstat,
  parseStatus,
  parseTasklist,
  projectOf,
  readCommand,
  serverLabel,
  toCard,
} from './model.ts'

const POLL_MS = 60_000
const SETTLE_MS = 1200
// Git reads without taking the index lock, so they never collide with Claude's own git commands.
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
const SHELLS = new Set(['Bash', 'PowerShell'])
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const benchA = atom({ plugin: 'workbench', key: 'bench' } as const, null)
const serversA = atom({ plugin: 'workbench', key: 'servers' } as const, [])
const cardA = atom({ plugin: 'workbench', key: 'card' } as const, null)
const busyA = atom({ plugin: 'workbench', key: 'busy' } as const, '')
const modeA = atom({ plugin: 'workbench', key: 'mode' } as const, 'on')

// Module variables start over on a reload; session.start fills them again.
/** The repository Claude last worked in; the session's folder until then. */
let focus = ''
/** Folder → its repository's top folder, '' when it is in none. */
const tops = new Map<string, string>()
/** Process id → command line, so each server is looked up once. */
const commandLines = new Map<number, string>()
let poller: { cancel: () => void } | undefined
let settle: { cancel: () => void } | undefined
let refreshing: Promise<void> | null = null
let isAgain = false
let isInteractive = true
let isGuardOn = true
/** Repositories where commits and pushes on main go ahead without asking. */
let allowed: string[] = []

type Ran = { code: number; out: string; err: string }

const nameOf = (repo: string) => repo.split('\\').filter(Boolean).at(-1) ?? repo
const oneLine = (s: string, max: number) => {
  const l = s.replace(/\s+/g, ' ').trim()
  return l.length > max ? `${l.slice(0, max - 1)}…` : l
}

// ---------- helpers that take $ (top level, same file) ----------

async function sh($: EngineInterface, argv: string[], timeoutMs = 20_000): Promise<Ran> {
  try {
    const r = await $.process.run(argv, { env: GIT_ENV, timeoutMs })
    return { code: r.exitCode, out: r.stdout, err: r.stderr }
  } catch (err) {
    return { code: -1, out: '', err: String(err) }
  }
}

async function cwdOf($: EngineInterface): Promise<string> {
  try {
    return (await $.session.cwd()).replace(/\//g, '\\')
  } catch {
    return ''
  }
}

async function toplevel($: EngineInterface, dir: string): Promise<string> {
  const key = dir.toLowerCase()
  const known = tops.get(key)
  if (known !== undefined) return known
  const r = await sh($, ['git', '-C', dir, 'rev-parse', '--show-toplevel'], 10_000)
  const top = r.code === 0 ? r.out.trim().replace(/\//g, '\\') : ''
  tops.set(key, top)
  return top
}

/** Follows Claude into a repository: the bench shows the last one it worked in. */
async function follow($: EngineInterface, dir: string): Promise<void> {
  if (!dir) return
  const top = await toplevel($, dir)
  if (top) focus = top
}

async function readBench($: EngineInterface, repo: string): Promise<Bench | null> {
  const s = await sh($, ['git', '--no-optional-locks', '-C', repo, 'status', '--porcelain=v2', '--branch'])
  if (s.code !== 0) return null
  const st = parseStatus(s.out)
  let hasRemote = st.upstream !== ''
  let unpushed = st.ahead
  if (!hasRemote) {
    hasRemote = (await sh($, ['git', '-C', repo, 'remote'])).out.trim() !== ''
    const c = await sh($, ['git', '-C', repo, 'rev-list', '--count', 'HEAD', ...(hasRemote ? ['--not', '--remotes'] : [])])
    unpushed = c.code === 0 ? Number(c.out.trim()) || 0 : 0
  }
  return { ...st, repo, name: nameOf(repo), isDefault: DEFAULT_BRANCH.test(st.branch), hasRemote, unpushed }
}

async function readServers($: EngineInterface): Promise<Server[]> {
  const listening = parseNetstat((await sh($, ['netstat', '-ano'])).out)
  if (listening.size === 0) return []
  const programs = parseTasklist((await sh($, ['tasklist', '/fo', 'csv', '/nh'])).out)
  const pids = [...listening.keys()].filter(pid => isDevProgram(programs.get(pid) ?? ''))
  const unknown = pids.filter(pid => !commandLines.has(pid))
  if (unknown.length > 0) {
    const r = await sh($, ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(commandLineScript(unknown))], 20_000)
    const found = parseCommandLines(r.out)
    for (const pid of unknown) commandLines.set(pid, found.get(pid) ?? '')
  }
  for (const pid of [...commandLines.keys()]) if (!listening.has(pid)) commandLines.delete(pid)
  return pids
    .filter(pid => !isOwnProcess(commandLines.get(pid) ?? ''))
    .map(pid => ({
      pid,
      name: (programs.get(pid) ?? '').replace(/\.exe$/i, ''),
      ports: listening.get(pid) ?? [],
      project: projectOf(commandLines.get(pid) ?? ''),
    }))
}

/** Publishes the card the deck band shows, from the bench as it stands. */
async function publish($: EngineInterface): Promise<void> {
  const bench = await read($, benchA)
  const scene = buildScene(bench, await read($, serversA), {
    snoozed: '',
    busy: await read($, busyA),
    mode: await read($, modeA),
    isWorking: false,
  })
  const card = toCard(scene, bench?.name ?? '')
  if (JSON.stringify(card) !== JSON.stringify(await read($, cardA))) await update($, cardA, () => card)
}

async function refreshOnce($: EngineInterface): Promise<void> {
  const dir = focus || (await cwdOf($))
  const repo = dir ? await toplevel($, dir) : ''
  const [bench, servers] = await Promise.all([repo ? readBench($, repo) : Promise.resolve(null), readServers($)])
  if (JSON.stringify(bench) !== JSON.stringify(await read($, benchA))) await update($, benchA, () => bench)
  if (JSON.stringify(servers) !== JSON.stringify(await read($, serversA))) await update($, serversA, () => servers)
  await publish($)
}

/** One look at a time; a call during a look asks for one more after it. */
async function refresh($: EngineInterface): Promise<void> {
  if (refreshing) {
    isAgain = true
    return refreshing
  }
  const run = (async () => {
    do {
      isAgain = false
      await refreshOnce($)
    } while (isAgain)
  })().finally(() => {
    refreshing = null
  })
  refreshing = run
  return run
}

/** Looks again once things settle after a tool call. */
function soon($: EngineInterface, ms = SETTLE_MS): void {
  settle?.cancel()
  settle = $.clock.after(ms, () => void refresh($).catch(() => undefined))
}

/**
 * Asks before a command commits on, or pushes to, main. Returns the reason to refuse it, or null to let it run.
 * The person can wave a repository through for good ("Always in this repo"), say one whose own tools commit on main by design.
 */
async function guard($: EngineInterface, command: string): Promise<string | null> {
  if (!isGuardOn) return null
  const { calls } = readCommand(command, await cwdOf($))
  for (const call of calls) {
    if (call.verb !== 'commit' && call.verb !== 'push') continue
    const repo = await toplevel($, call.dir)
    if (!repo || allowed.includes(repo.toLowerCase())) continue
    const branch = (await sh($, ['git', '-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()
    const action = mainAction(call, branch)
    if (action === null) continue
    const name = nameOf(repo)
    const what = action === 'commit' ? `commit on ${branch}` : `push to ${branch === '' || !DEFAULT_BRANCH.test(branch) ? 'main' : branch}`
    let answer: string
    try {
      answer = await $.ui.ask(`Claude is about to ${what} in ${name}. Go ahead?`, {
        header: 'Main branch',
        options: ['Go ahead', 'Always in this repo', 'New branch first', 'Stop'],
      })
    } catch {
      if (!isInteractive) return null
      return `The user closed the Workbench check before Claude could ${what} in ${name}. Do not run it again; ask them how to go on.`
    }
    if (answer === 'Go ahead') continue
    if (answer === 'Always in this repo') {
      allowed = [...allowed, repo.toLowerCase()]
      await $.store.set('allowed', allowed).catch(() => undefined)
      continue
    }
    if (answer === 'New branch first') {
      return `The user wants this work on its own branch, not ${branch || 'main'}. Create a branch named for the work (git switch -c <name> keeps uncommitted changes), then ${action} there.`
    }
    if (answer === 'Stop') return `The user stopped Claude before it could ${what} in ${name}. Do not try again; ask them what they want.`
    return `The user answered the main-branch check with: "${answer}". Do that instead of running this command.`
  }
  return null
}

async function push($: EngineInterface): Promise<void> {
  const b = await read($, benchA)
  if (!b || (await read($, busyA)) !== '') return
  await update($, busyA, () => 'push' as WbBusy)
  await publish($)
  let argv = ['git', '-C', b.repo, 'push']
  if (!b.upstream) {
    const remote = (await sh($, ['git', '-C', b.repo, 'remote'])).out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    argv = [...argv, '-u', remote.includes('origin') ? 'origin' : (remote[0] ?? 'origin'), b.branch]
  }
  const r = await sh($, argv, 180_000)
  await update($, busyA, () => '' as WbBusy)
  $.ui.toast(r.code === 0 ? `Pushed ${b.branch} from ${b.name}.` : `Push failed: ${oneLine(r.err || r.out, 160)}`, { timeoutMs: r.code === 0 ? 5000 : 12_000 })
  await refresh($)
}

async function stopServers($: EngineInterface): Promise<string> {
  const servers = await read($, serversA)
  if (servers.length === 0 || (await read($, busyA)) !== '') return 'No dev servers running.'
  await update($, busyA, () => 'stop' as WbBusy)
  await publish($)
  const r = await sh($, ['taskkill', '/T', '/F', ...servers.flatMap(s => ['/PID', String(s.pid)])], 30_000)
  await update($, busyA, () => '' as WbBusy)
  const text =
    r.code === 0
      ? `Stopped ${servers.length === 1 ? 'the dev server' : `${servers.length} dev servers`}: ${servers.map(serverLabel).join(', ')}.`
      : `Could not stop every server: ${oneLine(r.err || r.out, 160)}`
  $.ui.toast(text, { timeoutMs: 6000 })
  await refresh($)
  return text
}

async function branchOff($: EngineInterface): Promise<void> {
  try {
    await $.prompt.submit({ text: BRANCH_OFF_PROMPT, asUser: true })
  } catch {
    await $.prompt.fill({ text: BRANCH_OFF_PROMPT, mode: 'replace' }).catch(() => undefined)
  }
}

async function setMode($: EngineInterface, mode: WbMode): Promise<void> {
  await update($, modeA, () => mode)
  await $.store.set('mode', mode).catch(() => undefined)
  await publish($)
}

async function statusText($: EngineInterface): Promise<string> {
  await refresh($)
  const b = await read($, benchA)
  const servers = await read($, serversA)
  const lines = [`Workbench: band ${await read($, modeA)} · main-branch check ${isGuardOn ? 'on' : 'off'}`]
  if (b) {
    lines.push(`${b.repo}: ${b.branch}${b.upstream ? ` (tracks ${b.upstream})` : b.hasRemote ? ' (no upstream)' : ' (no remote)'}`)
    lines.push(`  ${b.changed} changed, ${b.conflicts} conflicted, ${b.unpushed} not pushed, ${b.behind} behind`)
  } else {
    lines.push('No git repository in view yet: it follows the repository Claude works in.')
  }
  lines.push(servers.length > 0 ? `Dev servers: ${servers.map(s => `${serverLabel(s)} (${s.name}, pid ${s.pid})`).join(', ')}` : 'No dev servers running.')
  lines.push(`Commits and pushes on main go ahead without asking in: ${allowed.map(nameOf).join(', ')}`)
  return lines.join('\n')
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isInteractive = e.isInteractive || e.surface === 'desktop'
    // The deck band carries the bench now: clear the status line earlier versions set.
    $.ui.status(undefined)
    await $.command.register({
      name: 'bench',
      description: 'Workbench: status; "push" the branch; "branch" off main; "stop" dev servers; "quiet" (no warnings in the band) or "on"; "guard on|off" for the main-branch check',
      argumentHint: 'push | branch | stop | quiet | on | guard on|off',
      immediate: true,
    })
    try {
      const mode = await $.store.get('mode')
      if (mode === 'on' || mode === 'quiet') await update($, modeA, () => mode)
      const guardOn = await $.store.get('guard')
      if (typeof guardOn === 'boolean') isGuardOn = guardOn
      const stored = await $.store.get('allowed')
      if (Array.isArray(stored)) allowed = [...new Set(stored.map(String))]
    } catch {
      // Defaults: band on, check on.
    }
    soon($, 1500)
    poller?.cancel()
    poller = $.clock.every(POLL_MS, () => void refresh($).catch(() => undefined))
    return started
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (SHELLS.has(tool) && typeof input.command === 'string') {
      const command = input.command
      if (/\bgit\b[^|;&]*\b(init|clone)\b/.test(command)) tops.clear()
      const deny = await guard($, command)
      if (deny !== null) return { deny }
      const ran = await next(e)
      const { dirs } = readCommand(command, await cwdOf($))
      if (dirs.length > 0) await follow($, dirs[dirs.length - 1]!)
      soon($)
      return ran
    }
    const ran = await next(e)
    if (WRITERS.has(tool)) {
      const path = String(input.file_path ?? input.notebook_path ?? '').replace(/\//g, '\\')
      if (path.includes('\\')) await follow($, path.slice(0, path.lastIndexOf('\\')))
      soon($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) soon($, 300)
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'bench' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    // The deck's buttons run these; they answer with a toast, not a transcript line.
    const isDeck = e.origin.kind === 'plugin'
    if (arg === 'push') {
      const b = await read($, benchA)
      if (!b) return { text: 'Workbench: no repository in view.' }
      await push($)
      return isDeck ? {} : { text: `Workbench: pushing ${b.branch} from ${b.name}; a toast says how it went.` }
    }
    if (arg === 'branch') {
      // Claude does the branching: its prompt goes once the command returns.
      $.clock.after(120, () => void branchOff($).catch(() => undefined))
      return isDeck ? {} : { text: 'Workbench: asking Claude to move the changes onto a new branch.' }
    }
    if (arg === 'stop') {
      await refresh($)
      const text = await stopServers($)
      return isDeck ? {} : { text: `Workbench: ${text}` }
    }
    if (arg === 'quiet' || arg === 'on') {
      await setMode($, arg)
      return { text: arg === 'quiet' ? 'Workbench: no warnings in the band; the git corner still shows the repository.' : 'Workbench: the band warns when something is at risk.' }
    }
    if (arg === 'guard on' || arg === 'guard off') {
      isGuardOn = arg === 'guard on'
      await $.store.set('guard', isGuardOn).catch(() => undefined)
      return { text: `Workbench: main-branch check ${isGuardOn ? 'on' : 'off'}.` }
    }
    if (arg === 'guard reset') {
      allowed = []
      await $.store.set('allowed', allowed).catch(() => undefined)
      return { text: 'Workbench: the check asks again in every repository.' }
    }
    return { text: await statusText($) }
  })
}
