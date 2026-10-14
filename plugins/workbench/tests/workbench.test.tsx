import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Risk } from '../hooks/model.ts'
import {
  BRANCH_OFF_PROMPT,
  buildScene,
  encodePs,
  mainAction,
  parseNetstat,
  parseStatus,
  projectOf,
  readCommand,
  resolvePath,
  statusLine,
  toCard,
} from '../hooks/model.ts'
import type { Bench, DeckCard } from '../types'

const T0 = Date.parse('2026-10-13T10:00:00Z')
const REPO = 'C:\\code\\notes\\notes-app'
const WIKI = 'C:\\code\\wiki'

const NETSTAT = [
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1476',
  '  TCP    0.0.0.0:7680           0.0.0.0:0              LISTENING       36568',
  '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242',
  '  TCP    127.0.0.1:6274         0.0.0.0:0              LISTENING       5151',
  '  TCP    127.0.0.1:51315        0.0.0.0:0              LISTENING       21896',
  '  TCP    [::1]:5173             [::]:0                 LISTENING       4242',
  '  TCP    127.0.0.1:5173         127.0.0.1:61000        ESTABLISHED     4242',
].join('\r\n')

const TASKLIST = [
  '"svchost.exe","36568","Services","0","9,000 K"',
  '"node.exe","4242","Console","1","80,000 K"',
  '"node.exe","5151","Console","1","60,000 K"',
  '"Code.exe","21896","Console","1","90,000 K"',
].join('\r\n')

const COMMAND_LINES =
  `4242\t"C:\\Program Files\\nodejs\\node.exe" "${REPO}\\node_modules\\vite\\bin\\vite.js"\r\n` +
  '5151\t"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\.claude\\plugins\\cache\\inspector\\server.js\r\n'

type World = {
  branch: string
  ahead: number
  changed: number
  argv: string[][]
  status: (string | undefined)[]
  asked: string[]
  answer: string
  prompts: string[]
  shells: string[]
  /** The card the deck band would show, as last published. */
  card: DeckCard | null
}

const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On): { clock: ReturnType<typeof mock.clock>; w: World } {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const w: World = { branch: 'feat/android-twa', ahead: 2, changed: 3, argv: [], status: [], asked: [], answer: 'Go ahead', prompts: [], shells: [], card: null }
  on('state.set', ($, e, next) => {
    if (e.plugin === 'workbench' && e.key === 'card') w.card = e.value as DeckCard | null
    return next(e)
  })
  on('process.run', ($, e) => {
    const a = e.argv
    w.argv.push([...a])
    if (a[0] === 'git') {
      const dir = a[2] ?? ''
      const inRepo = dir.toLowerCase().startsWith(REPO.toLowerCase()) || dir.toLowerCase().startsWith(WIKI.toLowerCase())
      const top = dir.toLowerCase().startsWith(WIKI.toLowerCase()) ? 'C:/code/wiki' : REPO.replace(/\\/g, '/')
      const sub = a.includes('rev-parse') ? (a.includes('--show-toplevel') ? 'top' : 'head') : a.find(x => ['status', 'remote', 'rev-list', 'push'].includes(x))
      if (sub === 'top') return ok(inRepo ? `${top}\n` : '', inRepo ? 0 : 128)
      if (sub === 'head') return ok(`${w.branch}\n`)
      if (sub === 'status') {
        const files = Array.from({ length: w.changed }, (_, i) => `1 .M N... 100644 100644 100644 abc abc src/f${i}.ts`)
        return ok([`# branch.oid abc`, `# branch.head ${w.branch}`, `# branch.upstream origin/${w.branch}`, `# branch.ab +${w.ahead} -0`, ...files].join('\n'))
      }
      if (sub === 'remote') return ok('origin\n')
      if (sub === 'push') {
        w.ahead = 0
        return ok('')
      }
      return ok('0\n')
    }
    if (a[0] === 'netstat') return ok(NETSTAT)
    if (a[0] === 'tasklist') return ok(TASKLIST)
    if (a[0] === 'powershell') return ok(COMMAND_LINES)
    return ok('')
  })
  on('session.cwd', () => ({ value: REPO }))
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', ($, e) => {
    const input = e as unknown as { tool: string; command?: string; questions?: { question: string }[] }
    if (input.tool === 'AskUserQuestion') {
      const q = input.questions?.[0]?.question ?? ''
      w.asked.push(q)
      return { result: { questions: input.questions, answers: { [q]: w.answer } }, text: w.answer } as never
    }
    if (input.command) w.shells.push(input.command)
    return { result: {}, text: 'ok' } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return { clock, w }
}

async function start($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.session.start({ cwd: REPO, surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
}

async function bash($: Engine, command: string): Promise<{ deny?: string; text?: string }> {
  const tool = $.tool as unknown as { call: (t: object) => Promise<{ deny?: string; text?: string }> }
  return tool.call({ tool: 'Bash', command })
}

/** A press on the deck band: it runs the card's command the way the deck does. */
const deckRun = (args: string) =>
  ({ command: 'bench', args, origin: { kind: 'plugin', name: 'deck' }, presentation: {} }) as unknown as Parameters<Engine['command']['run']>[0]

test('unpushed commits: the card names them, and Push clears it', async ($, on) => {
  const { clock, w } = world(on)
  await start($, clock)
  expect(w.status.at(-1)).toBeUndefined()
  expect(w.card?.text).toBe('2 commits not on GitHub in notes-app.')
  expect(w.card?.buttons.map(b => b.args)).toEqual(['push', 'stop'])
  expect(w.card?.isQuietWhileWorking).toBe(true)

  expect(await $.command.run(deckRun('push'))).toEqual({})
  expect(w.argv.some(a => a.join(' ') === `git -C ${REPO} push`)).toBe(true)
  expect(w.card).toBeNull()
})

test('on main with changes: Branch off asks Claude, and a commit on main asks first', async ($, on) => {
  const { clock, w } = world(on)
  w.branch = 'main'
  w.ahead = 0
  await start($, clock)
  expect(w.card?.text).toBe('On main with 3 uncommitted changes in notes-app.')
  await $.command.run(deckRun('branch'))
  await clock.advance(500)
  expect(w.prompts).toEqual([BRANCH_OFF_PROMPT])

  w.answer = 'Stop'
  const stopped = await bash($, 'cd /c/code/notes/notes-app && git add -A && git commit -m "Fix nav"')
  expect(stopped.deny).toContain('The user stopped Claude before it could commit on main in notes-app')
  expect(w.shells).toEqual([])
  expect(w.asked).toEqual(['Claude is about to commit on main in notes-app. Go ahead?'])

  w.answer = 'New branch first'
  expect((await bash($, `git -C "${REPO}" commit -m x`)).deny).toContain('git switch -c')

  w.answer = 'Go ahead'
  expect((await bash($, `git -C "${REPO}" commit -m x`)).deny).toBeUndefined()
  expect(w.shells).toHaveLength(1)

  const asked = w.asked.length

  w.answer = 'Always in this repo'
  await bash($, `git -C "${REPO}" push`)
  await bash($, `git -C "${REPO}" push`)
  expect(w.asked).toHaveLength(asked + 1)
  expect(w.shells).toHaveLength(3)
})

test('Stop servers stops the dev servers it lists, not Claude, plugin or editor processes', async ($, on) => {
  const { clock, w } = world(on)
  await start($, clock)
  await $.command.run(deckRun('stop'))
  expect(w.argv.find(a => a[0] === 'taskkill')).toEqual(['taskkill', '/T', '/F', '/PID', '4242'])
})

test('a new risk gives the card a new id; quiet mode keeps warnings out of the band', async ($, on) => {
  const { clock, w } = world(on)
  await start($, clock)
  const first = w.card?.id
  w.branch = 'main'
  await clock.advance(61_000)
  expect(w.card?.id).not.toBe(first)
  expect(w.card?.text).toContain('On main')

  await $.command.run({ command: 'bench', args: 'quiet', origin: { kind: 'composer' }, presentation: {} } as never)
  expect(w.card).toBeNull()
})

test('reading git, netstat, command lines and commands', () => {
  expect(parseStatus('# branch.head main\n# branch.upstream origin/main\n# branch.ab +13 -2\n1 .M x\n? new.ts\nu UU y')).toEqual({
    branch: 'main',
    upstream: 'origin/main',
    ahead: 13,
    behind: 2,
    changed: 3,
    conflicts: 1,
  })
  expect([...parseNetstat(NETSTAT)]).toEqual([
    [36568, [7680]],
    [4242, [5173]],
    [5151, [6274]],
  ])
  expect(projectOf(`"C:\\Program Files\\nodejs\\node.exe" "${REPO}\\node_modules\\next\\dist\\bin\\next" dev`)).toBe('notes-app')
  expect(projectOf('python -m http.server 8000')).toBe('')
  expect(projectOf('node C:/code/notes/notes-site/server.js')).toBe('notes-site')

  expect(resolvePath('C:\\x', '/c/code/notes')).toBe('C:\\code\\notes')
  expect(resolvePath('C:\\code\\notes', '../wiki')).toBe('C:\\code\\wiki')
  const r = readCommand('cd "C:/code/notes/notes-app" && git -c a=b status; git -C ../notes-site push -u origin main', 'C:\\tmp')
  expect(r.calls.map(c => `${c.dir} ${c.verb}`)).toEqual([`${REPO} status`, 'C:\\code\\notes\\notes-site push'])

  const call = (s: string) => readCommand(s, REPO).calls[0]!
  expect(mainAction(call('git commit -m x'), 'main')).toBe('commit')
  expect(mainAction(call('git commit -m x'), 'feat/x')).toBeNull()
  expect(mainAction(call('git push'), 'feat/x')).toBeNull()
  expect(mainAction(call('git push origin main'), 'feat/x')).toBe('push')
  expect(mainAction(call('git push origin HEAD:master'), 'feat/x')).toBe('push')
  expect(mainAction(call('git push -u origin feat/x'), 'main')).toBeNull()
  expect(mainAction(call('git push --dry-run'), 'main')).toBeNull()
  expect(encodePs('ab')).toBe('YQBiAA==')
})

test('every risk becomes a card, and the status text reads right', () => {
  const b: Bench = {
    repo: REPO,
    name: 'notes-app',
    branch: 'main',
    isDefault: true,
    changed: 2,
    conflicts: 1,
    upstream: '',
    ahead: 0,
    behind: 1,
    hasRemote: false,
    unpushed: 5,
  }
  expect(statusLine(b, [])).toBe('notes-app ⎇ main · 1 conflicted · 2 changed · 5 commits, no remote · ↓1 behind')
  expect(statusLine(null, [])).toBeUndefined()
  const o = { snoozed: '', busy: '' as const, mode: 'on' as const, isWorking: false }
  const cases: [Partial<Bench>, Risk | 'busy'][] = [
    [{}, 'conflict'],
    [{ conflicts: 0 }, 'main-dirty'],
    [{ conflicts: 0, changed: 0, hasRemote: true, upstream: 'origin/main' }, 'unpushed'],
    [{ conflicts: 0, changed: 0 }, 'no-remote'],
  ]
  for (const [patch, risk] of cases) {
    const sc = buildScene({ ...b, ...patch }, [], o)
    expect(sc?.risk).toBe(risk)
    const card = toCard(sc, 'notes-app')
    expect(card?.tone).toBe(risk === 'conflict' ? 'hot' : 'watch')
    expect(card?.text.endsWith(' in notes-app.')).toBe(true)
  }
  const busy = buildScene(b, [], { ...o, busy: 'push' })
  expect(toCard(busy, 'notes-app')).toEqual({ id: 'bench:busy', rank: 2, tone: 'info', text: 'Pushing main to GitHub…', command: 'bench', buttons: [], isCritical: true })
  expect(buildScene({ ...b, conflicts: 0, changed: 0, unpushed: 0 }, [], o)).toBeNull()
})
