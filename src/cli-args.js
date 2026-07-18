export const USAGE = `pico - a coding agent in your terminal

usage:
  pico                       interactive session in the current directory
  pico -p "prompt"           headless: run one agentic turn, print the answer
  cat log | pico -p "..."    stdin is appended to the prompt as context

headless flags:
  -p, --print <prompt>       the prompt to run
  --json                     print a single JSON result object to stdout
  --stream-json              stream session events to stdout as jsonl
  -m, --model <name>         model to use (fuzzy matched, or raw provider/model)
  --effort <level>           thinking effort: auto|low|medium|high|max
  --resume <session-id>      continue an existing session from this project
  --max-tool-calls <n>       stop the agent after n tool calls (default 50)
  -q, --quiet                no progress output on stderr

  --connect                  sign in with a ChatGPT plan (OAuth in your browser)
  update, --update           update pico to the latest release from npm
  -h, --help                 show this help
  -v, --version              show version`

export function parseArgs(argv) {
  const opts = { mode: 'interactive' }
  const takeValue = (name, i) => {
    if (i + 1 >= argv.length) throw new Error(`${name} requires a value`)
    return argv[i + 1]
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-p' || arg === '--print') {
      opts.mode = 'headless'
      opts.prompt = takeValue(arg, i)
      i++
    } else if (arg === '--json') opts.json = true
    else if (arg === '--stream-json') opts.streamJson = true
    else if (arg === '-m' || arg === '--model') {
      opts.model = takeValue(arg, i)
      i++
    } else if (arg === '--effort') {
      const level = takeValue(arg, i)
      if (!['auto', 'low', 'medium', 'high', 'max'].includes(level)) {
        throw new Error(`invalid effort "${level}": use auto|low|medium|high|max`)
      }
      opts.effort = level
      i++
    } else if (arg === '--resume') {
      opts.resume = takeValue(arg, i)
      i++
    } else if (arg === '--max-tool-calls') {
      const value = takeValue(arg, i)
      if (!/^\d+$/.test(value)) throw new Error('--max-tool-calls requires a positive integer')
      opts.maxToolCalls = Number(value)
      if (!Number.isSafeInteger(opts.maxToolCalls) || opts.maxToolCalls < 1) {
        throw new Error('--max-tool-calls requires a positive integer')
      }
      i++
    } else if (arg === '--connect') opts.mode = 'connect'
    else if (arg === 'update' || arg === '--update') opts.mode = 'update'
    else if (arg === '-q' || arg === '--quiet') opts.quiet = true
    else if (arg === '-h' || arg === '--help') opts.mode = 'help'
    else if (arg === '-v' || arg === '--version') opts.mode = 'version'
    else throw new Error(`unknown argument "${arg}"`)
  }

  if (opts.mode === 'headless' && !opts.prompt?.trim()) throw new Error('-p requires a non-empty prompt')
  return opts
}
