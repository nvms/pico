// A real Claude Code turn through pico's controller, for checking the
// engine against the installed `claude` after either one changes. It uses
// the subscription (haiku, a few cents of quota), so it is not part of the
// test suite. Run: node scripts/claude-code-smoke.js [model]

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createController } from '../src/controller.js'
import { createContextTracker } from '../src/context.js'
import { claudeCodeModels, claudeCodeStatus } from '../src/claude-code/models.js'

const status = await claudeCodeStatus()
if (!status.connected) {
  console.error('claude is not signed in to claude.ai; run claude auth login')
  process.exit(1)
}

const root = await mkdtemp(join(tmpdir(), 'pico-claude-smoke-'))
process.env.PICO_HOME = join(root, 'home')
await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\n')

const models = claudeCodeModels()
const model = models.find((m) => m.name === `claude-code/${process.argv[2] ?? 'haiku'}`) ?? models.at(-1)
const boot = {
  cwd: root, root, initialModel: model, models, providers: ['claude-code'], autoCompact: false, env: {},
  startupContext: { files: [], stopDir: root },
  tracker: createContextTracker({ stopDir: root, loaded: new Set() }),
  memory: { list: async () => [] }, skills: { list: () => [] },
  mcp: { list: () => [], tools: () => [], terminateAll() {} },
  shells: { killAll() {}, list: () => [] }, git: { refresh() {} },
  setMcpNotify() {}, setShellsNotify() {}, setWakeupsNotify() {}, setGitNotify() {}, setWakeupsFire() {}, setShellsExit() {},
}
function controller() {
  const ctl = createController({ boot, peerDirectory: join(root, 'peers') })
  ctl.on('flash', (text) => console.log(`flash: ${text}`))
  ctl.on('question', (question) => {
    console.log(`question: ${JSON.stringify(question.questions)}`)
    ctl.answerQuestion(question.questions.map(() => 'green'))
  })
  return ctl
}
let ctl = controller()

const turn = (text, { interruptAfter } = {}) => new Promise((resolve) => {
  if (interruptAfter) setTimeout(() => ctl.interrupt(), interruptAfter)
  let started = false
  const off = ctl.on('change', () => {
    if (ctl.state.busy) started = true
    else if (started && !ctl.isWorking()) { off(); resolve() }
  })
  ctl.send(text)
})

await turn('In notes.txt replace beta with BETA using your Edit tool. Then run `wc -l notes.txt` with Bash. Then ask me my favourite colour with the ask_user tool, as one text question. Finish with one short sentence that includes the colour.')
await turn('What word did you replace, in one word?')
await turn('Run `for i in 1 2 3 4 5 6 7 8 9 10; do echo $i; sleep 1; done` with Bash.', { interruptAfter: 6000 })

// a restart: the session is reopened by a new controller, and Claude Code
// resumes the conversation it saved instead of starting over
const file = ctl.state.session.file
await ctl.shutdown()
ctl = controller()
await ctl.resume({ file, header: { root, cwd: root } })
await turn('What colour did I say, in one word?')

console.log('\n--- transcript')
for (const item of ctl.state.derived.transcript) {
  if (item.kind === 'tool') console.log(`tool ${item.name} ${item.status}${item.diff ? ` +${item.diff.additions}/-${item.diff.deletions}` : ''}${item.revert ? ' (revertible)' : ''}: ${String(item.fullOutput ?? item.resultText ?? '').slice(0, 80).replace(/\n/g, ' | ')}`)
  else console.log(`${item.kind}: ${String(item.text ?? '').slice(0, 160)}`)
}
const engine = ctl.state.events.filter((event) => event.type === 'engine_state').map((event) => event.data.state)
console.log('\n--- engine states', engine.map((s) => s.claudeSessionId))
console.log('usage', JSON.stringify(ctl.state.derived.usage), 'last prompt', ctl.state.derived.lastPromptTokens)
console.log('notes.txt', JSON.stringify(await readFile(join(root, 'notes.txt'), 'utf8')))
await ctl.shutdown()
await rm(root, { recursive: true, force: true })
