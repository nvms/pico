import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { compactTranscriptRuns } from '../src/ui/transcript-window.js'

const result = await build({
  entryPoints: [new URL('../src/ui/transcript.jsx', import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  jsxFactory: 'h',
  banner: { js: `function h(type, props, ...children) {
    props = { ...props, children: children.flat(Infinity).filter(child => child != null && child !== false) }
    return typeof type === 'function' ? type(props) : { type, props }
  }` },
  plugins: [{
    name: 'renderer-stubs',
    setup(build) {
      build.onResolve({ filter: /^@trendr\/core$/ }, () => ({ path: 'renderer', namespace: 'stub' }))
      build.onResolve({ filter: /^\.\/highlight\.js$/ }, () => ({ path: 'highlight', namespace: 'stub' }))
      build.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: path === 'highlight'
        ? `export const highlight = value => value; export const langForPath = () => 'text'`
        : `export const ease = () => {}; export const linear = () => {};
           export const createSignal = value => [() => value, next => { value = next }];
           export const useHitTest = () => () => false;
           export const useMouse = () => {}; export const useInput = () => {};
           export const ScrollBox = props => h('scroll-box', props);
           export function useAnimated(value) { const get = () => value; get.set = get.snap = next => { value = next }; return get }
           export const Markdown = props => h('markdown', props);
           export const Spinner = props => h('spinner', props);
           export const Diff = props => h('diff', props);
           export const HorizontalScrollBox = props => h('horizontal-scroll', props);` }))
    },
  }],
})
const { DeliberationExchange, Message } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...(tree.props?.children || []).flatMap(child => nodes(child, predicate))]
}

const tools = Array.from({ length: 8 }, (_, i) => ({
  kind: 'tool', callId: `call-${i}`, name: 'bash', description: `Command ${i}`,
  title: `echo ${i}`, fullOutput: `output-${i}\n`, status: 'done', exitCode: 0, durationMs: 100,
}))
const turn = { kind: 'deliberation-turn', role: 'participant-a', round: 1, parallelGroup: 'research', tools, active: true }
const toolGroups = tree => nodes(tree, node => node.type === 'box' && node.props.style?.paddingX === 2 && node.props.children[0]?.type === 'text' && node.props.children[0]?.props.children[0] === ' ')

for (const wide of [false, true]) {
  for (const state of [
    { active: true, text: null },
    { active: true, text: 'Streaming response' },
    { active: false, text: null },
    { active: false, text: 'Finished response' },
  ]) {
    test(`compact deliberation reuses main tool rendering: wide=${wide}, ${JSON.stringify(state)}`, () => {
      const item = { ...turn, ...state }
      const expected = Message({ item: compactTranscriptRuns(tools, state.active && !state.text)[0], verbose: false })
      const rendered = DeliberationExchange({ turns: [item], compactToolHistory: true, wide, verbose: false })
      assert.deepEqual(toolGroups(rendered), [expected])
    })
  }
}

for (const compactToolHistory of [false, true]) {
  test(`expanded deliberation preserves individual tool cards: compact=${compactToolHistory}`, () => {
    const rendered = DeliberationExchange({ turns: [turn], compactToolHistory, wide: true, verbose: true })
    const expected = tools.map(item => Message({ item, verbose: true }))
    assert.deepEqual(toolGroups(rendered), expected)
  })
}

test('paired participants have outer margins and an empty center column', () => {
  const right = { ...turn, role: 'participant-b' }
  const rendered = DeliberationExchange({ turns: [turn, right], wide: true })
  const row = rendered.props.children[0]
  assert.equal(row.props.style.paddingX, 2)
  assert.equal(row.props.children.length, 3)
  assert.equal(row.props.children[1].props.style.width, 1)
  assert.equal(row.props.children[1].props.style.height, undefined)
  assert.equal(row.props.children[1].props.style.bg, undefined)
  assert.equal(row.props.style.alignItems ?? 'stretch', 'stretch')
  const borders = nodes(row, node => node.props.style?.width === 1 && node.props.style?.flexShrink === 0)
  assert.equal(borders.length, 1)
  assert.equal(nodes(row.props.children[0], node => node.props.style?.width === 1).length, 0)
})

test('stacked participants and synthesis retain their margins and borders', () => {
  for (const wide of [false, true]) {
    const rendered = DeliberationExchange({ turns: [{ ...turn, role: 'synthesis', tools: [] }], wide })
    assert.equal(rendered.props.children[0].props.style.paddingX, 2)
    assert.equal(nodes(rendered, node => node.props.style?.width === 1).length, 1)
  }
  const rendered = DeliberationExchange({ turns: [turn, { ...turn, role: 'participant-b' }], wide: false })
  assert.deepEqual(rendered.props.children.map(node => node.props.style.paddingX), [2, 2])
  assert.equal(nodes(rendered, node => node.props.style?.width === 1).length, 2)
})

test('participants have equal bounded heights and independent scroll controls', () => {
  const rendered = DeliberationExchange({
    turns: [{ ...turn, text: 'Short' }, { ...turn, role: 'participant-b', text: 'Long\n'.repeat(100) }],
    wide: true, viewportHeight: 30, focused: true,
  })
  const panes = nodes(rendered, node => node.type === 'scroll-box')
  assert.equal(panes.length, 2)
  assert.notEqual(panes[0].props.onScroll, panes[1].props.onScroll)
  assert.deepEqual(panes.map(pane => pane.props.focused), [true, false])
  assert.deepEqual(nodes(rendered, node => node.props.style?.height === 29).map(node => node.props.style.height), [29, 29])
  for (const pane of panes) assert.equal(nodes(pane, node => node.type === 'text' && String(node.props.children[0]).startsWith('Participant')).length, 0)
})
