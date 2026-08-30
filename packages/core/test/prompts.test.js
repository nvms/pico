import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listPrompts, removePrompt, savePrompt } from '../src/prompts.js'

test('prompts use storage distinct from commands', async () => {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  await mkdir(join(process.env.PICO_HOME, 'commands'), { recursive: true })
  await writeFile(join(process.env.PICO_HOME, 'commands', 'commit.md'), 'commit command')

  await savePrompt({ name: 'Review Changes', description: 'Review work', body: 'Review this carefully.' })
  assert.deepEqual(await listPrompts(), [{ name: 'review-changes', description: 'Review work', body: 'Review this carefully.' }])
  await removePrompt('review-changes')
  assert.deepEqual(await listPrompts(), [])
  await access(join(process.env.PICO_HOME, 'commands', 'commit.md'))
  delete process.env.PICO_HOME
})
