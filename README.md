# pico

A coding agent that runs in your terminal. Rendering is [@trendr/core](https://github.com/nvms/trendr), model access is [@prsm/ai](https://github.com/prsmjs/ai).

<p align="center">
  <img src=".github/assets/quick-task.gif" alt="pico demo">
</p>

<p align="center">
  <img src=".github/assets/panels.gif" alt="pico demo">
</p>

## Install

```
npm i -g picocode
```

Requires node 24 or newer and ripgrep. Set at least one provider key in your environment: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `XAI_API_KEY`. Alternatively, use `/connect` in pico to sign in with your ChatGPT subscription and access Codex models. Models are offered based on the credentials available.

## Use

Run `pico` in a project directory. Type `/` to browse commands, or run `/help` for the full reference.

Sessions are stored under `~/.pico` as jsonl event logs. AGENTS.md files are read automatically from the working directory up to the git root, and lazily from subdirectories as the agent touches them. User-defined prompt templates live in `~/.pico/commands` and `.pico/commands`, skills in `~/.pico/skills` and `.pico/skills`.
