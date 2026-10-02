import { applyPatches } from './daemon-patch.js'

export async function createRemoteController(connection, { id, options = {}, localBoot = {} } = {}) {
  const initial = await connection.request(id ? 'attach' : 'create', id, id ? [] : [options])
  id = initial.id
  const state = {}
  const boot = { refs: {}, ...localBoot }
  const listeners = new Map()
  const sequences = new Map([[id, initial.sequence]])
  let recovering = false
  let current
  let previewId = null
  let previewQueue = Promise.resolve()
  const displayedId = () => previewId || id
  const emit = (type, value) => { for (const fn of listeners.get(type) || []) fn(value) }
  const call = (target, method, ...args) => {
    const result = connection.request('call', id, [target, method, ...args]).then(reply => {
      if (reply.snapshot) apply(reply.snapshot)
      emit('change', state)
      return reply.result
    })
    result.catch(error => emit('flash', error.message))
    return result
  }
  function apply(snapshot) {
    current = snapshot
    for (const key of Object.keys(state)) if (!(key in snapshot.state)) delete state[key]
    const session = state.session
    Object.assign(state, snapshot.state)
    if (session && session.id === state.session?.id) { Object.assign(session, state.session); state.session = session }
    Object.assign(boot, snapshot.boot)
    for (const key of ['researchModel', 'shellModel', 'deliberationModel', 'participantAModel', 'participantBModel']) {
      if (key in snapshot.boot) boot[key] = snapshot.boot[key]
    }
  }
  apply(initial.snapshot)
  for (const [target, methods] of Object.entries({
    shells: ['kill', 'dismiss', 'output'], wakeups: ['cancel'], git: ['refresh', 'setEnabled'],
    mcp: ['connectAll', 'add', 'update', 'remove', 'toggle', 'reconnect'], memory: ['list', 'setDisabled', 'forget'],
  })) {
    boot[target] = {}
    for (const method of methods) boot[target][method] = (...args) => call(target, method, ...args)
  }
  for (const [target, methods] of Object.entries(current.services)) {
    boot[target] ||= {}
    for (const method of Object.keys(methods)) boot[target][method] = () => current.services[target]?.[method]
  }
  if (boot.shells) boot.shells.output = id => current.services.shells?.outputs?.[id]
  boot.refreshModels = () => call('boot', 'refreshModels')
  const controller = {
    state, boot, id,
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type)?.delete(fn) },
    agents: { list: () => current.agents, get: id => current.agents.find(a => String(a.id) === String(id)) || null },
    async shutdown() { await previewQueue; if (previewId) await connection.request('detach', previewId); await connection.request('detach', id); unsubscribe() },
    configure: settings => connection.request('configure', id, [settings]),
    interrupt: () => connection.request('interrupt', id),
    demote: () => connection.request('demote', id),
    listOwnedSessions: () => connection.request('list'),
    async selectOwnedSession(nextId) {
      await previewQueue
      if (nextId === id) { await clearPreview(); return }
      const previous = id
      const previousPreview = previewId
      const next = previousPreview === nextId ? null : await connection.request('attach', nextId)
      previewId = null
      if (previousPreview && previousPreview !== nextId) await connection.request('detach', previousPreview)
      id = nextId
      controller.id = id
      if (next) { sequences.set(next.id, next.sequence); apply(next.snapshot) }
      await connection.request('detach', previous)
      emit('project', boot)
      emit('session', state.session)
      emit('change', state)
    },
  }
  for (const method of current.methods) if (!(method in controller)) controller[method] = (...args) => call('controller', method, ...args)
  for (const method of Object.keys(current.cached)) controller[method] = () => current.cached[method]
  for (const method of ['newSession', 'resume', 'switchProject', 'switchToWorktree', 'fork']) controller[method] = async value => {
    const next = await connection.request('switch', id, [method, value])
    id = next.id
    controller.id = id
    sequences.set(next.id, next.sequence)
    apply(next.snapshot)
    if (method === 'newSession' && typeof value === 'string' && value.trim() && state.derived?.title !== value.trim()) {
      const renamed = await call('controller', 'rename', value.trim())
      if (renamed === false || state.derived?.title !== value.trim()) throw new Error(`could not create session named "${value.trim()}"`)
    }
    emit('project', boot)
    emit('session', state.session)
    emit('change', state)
  }
  controller.previewSteer = changes => call('controller', 'previewSteer', changes)
  controller.loadHistory = async limit => {
    const target = displayedId()
    const reply = await connection.request('history', target, [Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER])
    if (displayedId() !== target) return
    sequences.set(target, reply.sequence)
    apply(reply.snapshot)
    emit('change', state)
  }
  function show(snapshot) {
    apply(snapshot)
    emit('project', boot)
    emit('session', state.session)
    emit('derived', state.derived)
    emit('change', state)
  }
  async function clearPreview() {
    if (!previewId) return
    const previous = previewId
    const original = await connection.request('attach', id)
    previewId = null
    sequences.set(id, original.sequence)
    show(original.snapshot)
    await connection.request('detach', previous)
  }
  function preview(nextId) {
    const task = previewQueue.then(async () => {
      if (!nextId || nextId === id) return clearPreview()
      if (nextId === previewId) return
      const next = await connection.request('attach', nextId)
      const previous = previewId
      previewId = nextId
      sequences.set(nextId, next.sequence)
      show(next.snapshot)
      if (previous) await connection.request('detach', previous)
    })
    previewQueue = task.catch(() => {})
    return task
  }
  boot.workspace = {
    preview,
    cancelPreview: () => preview(null),
    list: async () => (await connection.request('list')).filter(row => row.name),
    currentId: () => id,
    subscribe: fn => connection.on(message => { if (message.type === 'workspace') fn() }),
    select: nextId => controller.selectOwnedSession(nextId),
    interrupt: nextId => connection.request('interrupt', nextId),
    demote: nextId => connection.request('demote', nextId),
  }
  const unsubscribe = connection.on(message => {
    if (message.type === 'disconnect') { state.busy = false; state.streaming = null; emit('flash', 'daemon disconnected; work was not restarted'); emit('change', state); return }
    if (message.type !== 'update' || message.id !== displayedId()) return
    if (message.patches) {
      if (recovering) return
      if (sequences.get(message.id) !== message.baseSequence) {
        recovering = true
        const recoveringId = displayedId()
        connection.request('snapshot', recoveringId).then(reply => {
          if (displayedId() !== recoveringId) return
          sequences.set(recoveringId, reply.sequence)
          apply(reply.snapshot)
          emit('change', state)
        }).catch(error => emit('flash', error.message)).finally(() => { recovering = false })
        return
      }
      apply(applyPatches(current, message.patches))
      sequences.set(message.id, message.sequence)
      emit('derived', state.derived)
    } else {
      apply(message.snapshot)
      emit('derived', state.derived)
    }
    for (const event of message.events) {
      if (previewId && ['input', 'question', 'resumed', 'flash'].includes(event.type)) continue
      emit(event.type, event.type === 'project' ? boot : event.payload)
    }
    emit('change', state)
  })
  return controller
}
