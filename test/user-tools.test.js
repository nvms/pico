import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanUserTools } from '../src/core/user-tools.js'

async function fixture() {
  process.env.PICO_HOME = await mkdtemp(join(tmpdir(), 'pico-home-'))
  const root = await mkdtemp(join(tmpdir(), 'pico-proj-'))
  await mkdir(join(process.env.PICO_HOME, 'tools'), { recursive: true })
  await mkdir(join(root, '.pico/tools'), { recursive: true })
  return root
}

test('loads object and factory tools, project wins collisions', async () => {
  const root = await fixture()
  await writeFile(
    join(process.env.PICO_HOME, 'tools/greet.js'),
    "export default { name: 'greet', description: 'global greet', schema: {}, execute: () => 'hi from global' }",
  )
  await writeFile(
    join(root, '.pico/tools/greet.js'),
    "export default ({ root }) => ({ name: 'greet', description: 'project greet', schema: {}, execute: () => root })",
  )
  await writeFile(
    join(root, '.pico/tools/shout.js'),
    "export default { name: 'shout', description: 'loud', schema: { text: { type: 'string' } }, execute: ({ text }) => text.toUpperCase() }",
  )

  const { tools, errors } = await scanUserTools({ cwd: root, root })
  assert.equal(errors.length, 0)
  assert.deepEqual(tools.map((t) => t.name).sort(), ['greet', 'shout'])
  const greet = tools.find((t) => t.name === 'greet')
  assert.equal(greet.description, 'project greet')
  assert.equal(await greet.execute({}), root)
  assert.equal(await tools.find((t) => t.name === 'shout').execute({ text: 'hey' }), 'HEY')
  delete process.env.PICO_HOME
})

test('reports broken tools as errors without failing the scan', async () => {
  const root = await fixture()
  await writeFile(join(root, '.pico/tools/broken.js'), 'export default { name: 42 }')
  await writeFile(join(root, '.pico/tools/syntax.js'), 'this is not javascript ((')
  await writeFile(
    join(root, '.pico/tools/fine.js'),
    "export default { name: 'fine', description: 'ok', schema: {}, execute: () => 1 }",
  )
  const { tools, errors } = await scanUserTools({ cwd: root, root })
  assert.equal(tools.length, 1)
  assert.equal(errors.length, 2)
  delete process.env.PICO_HOME
})

test('edits are picked up via mtime cache busting', async () => {
  const root = await fixture()
  const file = join(root, '.pico/tools/version.js')
  await writeFile(file, "export default { name: 'version', description: 'v', schema: {}, execute: () => 1 }")
  const first = await scanUserTools({ cwd: root, root })
  assert.equal(await first.tools[0].execute({}), 1)

  await writeFile(file, "export default { name: 'version', description: 'v', schema: {}, execute: () => 2 }")
  const later = new Date(Date.now() + 5000)
  await utimes(file, later, later)
  const second = await scanUserTools({ cwd: root, root })
  assert.equal(await second.tools[0].execute({}), 2)
  delete process.env.PICO_HOME
})
