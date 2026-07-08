import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLine, parseLines, makeEvent } from '../src/core/events.js'
import { parseCommand } from '../src/core/mcp.js'
import { parseFrontmatter, createSkillIndex } from '../src/core/skills.js'
import { discoverKeys } from '../src/core/keys.js'
import { availableModels, defaultModel, estimateCost, findModel } from '../src/core/models.js'
import { fuzzyScore } from '../src/ui/fuzzy.js'

test('parseLine tolerates garbage and blank lines', () => {
  assert.equal(parseLine(''), null)
  assert.equal(parseLine('{"broken'), null)
  assert.equal(parseLine('"just a string"'), null)
  assert.equal(parseLine('{"type":"user","data":{}}').type, 'user')
  const events = parseLines('{"type":"a","data":{}}\n\nnot json\n{"type":"b","data":{}}\n')
  assert.equal(events.length, 2)
})

test('events carry ids and timestamps', () => {
  const e = makeEvent('user', { text: 'hi' })
  assert.ok(e.id)
  assert.ok(e.at > 0)
})

test('parseCommand handles quotes and env prefixes', () => {
  assert.deepEqual(parseCommand('npx -y @modelcontextprotocol/server-filesystem /tmp'), {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: {},
  })
  assert.deepEqual(parseCommand('API_KEY=abc node server.js --dir "/my docs"'), {
    command: 'node',
    args: ['server.js', '--dir', '/my docs'],
    env: { API_KEY: 'abc' },
  })
  assert.throws(() => parseCommand('KEY=only'), /empty command/)
})

test('parseFrontmatter extracts meta and body', () => {
  const { meta, body } = parseFrontmatter('---\nname: deploy\ndescription: ship it\n---\ndo the thing\n')
  assert.equal(meta.name, 'deploy')
  assert.equal(meta.description, 'ship it')
  assert.equal(body.trim(), 'do the thing')
  assert.deepEqual(parseFrontmatter('no frontmatter').meta, {})
})

test('project skills override global skills', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pico-home-'))
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  process.env.PICO_HOME = home
  await mkdir(join(home, 'skills/deploy'), { recursive: true })
  await writeFile(join(home, 'skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: global deploy\n---\nglobal body')
  await mkdir(join(root, '.pico/skills/deploy'), { recursive: true })
  await writeFile(join(root, '.pico/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: project deploy\n---\nproject body')

  const index = await createSkillIndex(root)
  assert.equal(index.list().length, 1)
  assert.equal(index.list()[0].description, 'project deploy')
  assert.equal((await index.load('deploy')).trim(), 'project body')
  delete process.env.PICO_HOME
})

test('discoverKeys picks up provider env vars', () => {
  const keys = discoverKeys({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' })
  assert.deepEqual(keys, { google: 'g', openai: 'o' })
})

test('model catalog filters by provider and prices usage', () => {
  const models = availableModels(['google'])
  assert.ok(models.length >= 3)
  assert.ok(models.every((m) => m.provider === 'google'))
  assert.equal(defaultModel(['google']).name, 'google/gemini-2.5-pro')
  const cost = estimateCost(findModel('google/gemini-2.5-pro'), { promptTokens: 1e6, completionTokens: 1e6 })
  assert.equal(cost, 11.25)
})

test('fuzzyScore ranks contiguous and boundary matches higher', () => {
  assert.ok(fuzzyScore('sig', 'src/signal.js') > fuzzyScore('sig', 'src/sxixgx.js'))
  assert.ok(fuzzyScore('', 'anything') === 0)
  assert.equal(fuzzyScore('zzz', 'src/signal.js'), -1)
})
