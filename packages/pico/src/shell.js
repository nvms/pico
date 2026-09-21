import { basename } from 'node:path'
import { runTurn } from 'picocode-core/agent.js'
import { readConfig } from 'picocode-core/config.js'
import { loadModelRuntime, selectModel } from './model-runtime.js'

const SYSTEM = ({ platform, shell, cwd }) => `Generate exactly one shell command that satisfies the user's request. The output must be a valid shell command without Markdown formatting. If multiple steps are required, try to combine them together using &&.

Environment:
- operating system: ${platform}
- shell: ${shell}
- current directory: ${cwd}

Output only the command as one line. Do not use Markdown formatting such as \`\`\`. Do not explain the command. Do not execute the command.`

export function commandFromResponse(text) {
  const command = text.trim()
  if (!command) throw new Error('the model returned an empty command')
  if (command.includes('\0') || /[\r\n]/.test(command)) throw new Error('the model returned more than one line')
  if (command.includes('```')) throw new Error('the model returned Markdown instead of a command')
  return command
}

export async function runShell(opts, dependencies = {}) {
  const stderr = dependencies.stderr || process.stderr
  const stdout = dependencies.stdout || process.stdout
  try {
    const config = await (dependencies.readConfig || readConfig)()
    const runtime = await (dependencies.loadModelRuntime || loadModelRuntime)()
    if (runtime.providers.length === 0) throw new Error('no credentials found (set a provider key or run pico --connect)')

    const configuredModel = config.models?.shell
    const model = selectModel({
      models: runtime.models,
      providers: runtime.providers,
      requested: opts.model,
      configured: configuredModel || config.defaultModel,
    })
    const requestedName = opts.model || configuredModel
    if (!model || model.available === false) {
      throw new Error(`no usable model${requestedName ? ` matching "${requestedName}"` : ''}`)
    }

    const auth = model.provider === 'codex' ? runtime.codexCredentials : null
    if (model.provider === 'codex' && !auth) throw new Error('codex models need a ChatGPT sign-in (run pico --connect)')

    const result = await (dependencies.runTurn || runTurn)({
      history: [{ role: 'user', content: opts.prompt }],
      tools: [],
      recorder: null,
      modelName: model.name,
      effort: opts.effort ?? (model.effort ? 'low' : null),
      auth,
      system: SYSTEM({
        platform: process.platform === 'darwin' ? 'macOS' : process.platform,
        shell: basename(process.env.SHELL || 'zsh'),
        cwd: process.cwd(),
      }),
    })
    if (result.error) throw new Error(result.error)
    if (result.interrupted) throw new Error('command generation was interrupted')
    const text = result.messages
      .filter((message) => message.role === 'assistant' && typeof message.content === 'string')
      .at(-1)?.content || ''
    stdout.write(commandFromResponse(text) + '\n')
    return 0
  } catch (error) {
    stderr.write(`pico: ${error.message}\n`)
    return 1
  }
}
