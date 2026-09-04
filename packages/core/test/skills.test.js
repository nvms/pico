import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillIndex } from '../src/skills.js'

test('host skills join the index and load by name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pico-skills-'))
  const host = [{ name: 'new-schedule', description: 'host', source: 'builtin', body: 'host body' }]
  const index = await createSkillIndex(root, { host })
  assert.ok(index.list().some((s) => s.name === 'new-schedule'))
  assert.equal(await index.load('new-schedule'), 'host body')
  assert.ok(await index.load('new-skill'))
})
