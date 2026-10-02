import { randomUUID } from 'node:crypto'
import { plain } from './daemon-wire.js'
import { forkSession, loadSession } from './session.js'

const events = ['change', 'derived', 'flash', 'input', 'question', 'turn', 'session', 'resumed', 'mcp', 'shells', 'git', 'project', 'image']
const queries = ['activity', 'shellRows', 'costSummary', 'speedApplies', 'effortApplies']
const busy = ctl => ctl.isWorking?.() || ctl.state.busy || ctl.state.compacting || ctl.agents?.list().some(a => ['running', 'queued'].includes(a.status))
const named = ctl => !!ctl.state.derived?.title?.trim()

export function snapshot(ctl) {
  const boot = ctl.boot
  const services = {}
  for (const [service, methods] of Object.entries({ shells: ['list', 'running'], wakeups: ['list', 'pending'], git: ['status'], mcp: ['list'], commands: ['list'], skills: ['list'] })) {
    services[service] = {}
    for (const method of methods) if (typeof boot[service]?.[method] === 'function') services[service][method] = plain(boot[service][method]())
  }
  services.shells ||= {}
  services.shells.outputs = {}
  for (const shell of services.shells.list || []) {
    try { services.shells.outputs[shell.id] = plain(boot.shells.output(shell.id, { tail: 2000 })) } catch {}
  }
  const cached = {}
  for (const method of queries) if (typeof ctl[method] === 'function') cached[method] = plain(ctl[method]())
  return { state: plain(ctl.state), boot: plain(Object.fromEntries(Object.entries(boot).filter(([key]) => !['refs', 'shells', 'wakeups', 'git', 'mcp', 'memory', 'commands', 'skills', 'tracker'].includes(key)))), services, cached, agents: plain(ctl.agents?.list() || []), methods: Object.keys(ctl).filter(k => typeof ctl[k] === 'function' && !['on', 'shutdown'].includes(k)) }
}

export function createDaemonRuntime({ createSession, onEmpty = () => {}, batchMs = 16 }) {
  const sessions = new Map()
  const clients = new Set()
  let queue = Promise.resolve()
  let closed = false
  const serial = task => {
    const result = queue.then(task)
    queue = result.catch(() => {})
    return result
  }
  async function createRecord(client, options) {
    const created = await createSession(options)
    const ctl = created.controller || created
    const record = { id: randomUUID(), ctl, dispose: created.dispose, views: new Set([client]), events: [], timer: null, unsub: [] }
    sessions.set(record.id, record)
    for (const type of events) record.unsub.push(ctl.on(type, payload => publish(record, type, payload)))
    return record
  }
  function publish(record, type, payload) {
    if (type !== 'change') record.events.push({ type, payload: plain(type === 'project' ? null : payload) })
    if (!record.timer) record.timer = setTimeout(() => {
      record.timer = null
      const update = { type: 'update', id: record.id, snapshot: snapshot(record.ctl), events: record.events.splice(0) }
      for (const client of record.views) client.send(update)
      for (const client of clients) client.send({ type: 'workspace' })
    }, batchMs)
  }
  async function dispose(record) {
    if (!sessions.delete(record.id)) return
    clearTimeout(record.timer)
    record.unsub.forEach(fn => fn())
    await record.ctl.shutdown()
    await record.dispose?.()
    if (!sessions.size) onEmpty()
  }
  async function detach(client, id) {
    const record = sessions.get(id)
    if (!record) return
    record.views.delete(client)
    if (!record.views.size && !named(record.ctl)) await dispose(record)
  }
  return {
    disconnect(client) { clients.delete(client); return serial(async () => { for (const record of [...sessions.values()]) await detach(client, record.id) }) },
    dispatch(client, request) {
      if (client) clients.add(client)
      if (request.op === 'interrupt') {
        const record = sessions.get(request.id)
        if (!record) return Promise.reject(new Error('session is no longer running'))
        record.ctl.interrupt()
        publish(record, 'change')
        return Promise.resolve()
      }
      return serial(async () => {
      if (closed) throw new Error('daemon is shutting down')
      const { op, id, args = [] } = request
      if (op === 'list') return [...sessions.values()].map(r => {
        const ctl = r.ctl
        const tool = [...(ctl.state.overlay || [])].reverse().find(item => item.kind === 'tool')
        const message = [...(ctl.state.events || [])].reverse().find(event => event.type === 'message' && event.data.message.role === 'assistant')
        const content = message?.data.message.content
        return { id: r.id, sessionId: ctl.state.session?.id, name: ctl.state.derived?.title || null, title: ctl.state.derived?.title || '', cwd: ctl.boot.cwd, root: ctl.boot.root, color: ctl.state.derived?.color, status: busy(ctl) ? 'busy' : 'idle', busy: !!busy(ctl), activity: tool?.description || tool?.title || (busy(ctl) ? ctl.state.turnPhase || 'working' : null), lastMessageAt: message?.at || null, lastMessage: typeof content === 'string' ? content : content?.filter(part => part.type === 'text').map(part => part.text).join('\n') || '', views: r.views.size }
      })
      if (op === 'create') {
        const record = await createRecord(client, args[0] || {})
        return { id: record.id, snapshot: snapshot(record.ctl) }
      }
      const record = sessions.get(id)
      if (!record) throw new Error('session is no longer running')
      if (op === 'attach') { record.views.add(client); return { id, snapshot: snapshot(record.ctl) } }
      if (op === 'switch') {
        const [method, value] = args
        if (!record.views.has(client)) throw new Error('attach to the session first')
        let meta = ['resume', 'switchProject'].includes(method) ? value : null
        if (meta) {
          const existing = [...sessions.values()].find(r => r.ctl.state.session?.id === meta.header.id)
          if (existing) {
            existing.views.add(client)
            if (existing !== record) await detach(client, id)
            return { id: existing.id, snapshot: snapshot(existing.ctl) }
          }
          const saved = await loadSession(meta.file)
          meta = { ...meta, header: saved.header }
        }
        if (method === 'fork') {
          if (busy(record.ctl)) throw new Error('finish or interrupt the current turn first')
          const forked = await forkSession({ source: record.ctl.state.session, cwd: record.ctl.boot.cwd, root: record.ctl.boot.root, events: record.ctl.state.events })
          meta = { file: forked.session.file, header: forked.session.header }
        }
        if (!['newSession', 'resume', 'switchProject', 'switchToWorktree', 'fork'].includes(method)) throw new Error('unsupported session switch')
        const next = await createRecord(client, { cwd: meta?.header.cwd || meta?.header.root || value?.root || record.ctl.boot.cwd, version: record.ctl.boot.version, theme: record.ctl.boot.theme, detectedTheme: record.ctl.boot.detectedTheme, themePref: record.ctl.boot.themePref })
        try {
          if (meta) {
            await next.ctl.resume(meta)
            if (next.ctl.state.session?.id !== meta.header.id) throw new Error('session could not be resumed')
          }
          if (method === 'newSession' && typeof value === 'string' && value.trim()) {
            const name = value.trim()
            const renamed = await next.ctl.rename(name)
            if (renamed === false || next.ctl.state.derived?.title !== name) throw new Error(`could not create session named "${name}"`)
          }
          await detach(client, id)
          return { id: next.id, snapshot: snapshot(next.ctl) }
        } catch (error) { await dispose(next); throw error }
      }
      if (op === 'detach') { await detach(client, id); return }
      if (!record.views.has(client) && !['demote', 'interrupt'].includes(op)) throw new Error('attach to the session first')
      if (op === 'interrupt') { record.ctl.interrupt(); publish(record, 'change'); return }
      if (op === 'demote') {
        if (busy(record.ctl)) throw new Error('interrupt the session before clearing its name')
        const renamed = await record.ctl.rename('')
        if (renamed === false || named(record.ctl)) throw new Error('session name could not be cleared')
        if (!record.views.size) await dispose(record)
        else publish(record, 'change')
        return
      }
      if (op === 'call') {
        const [target, method, ...values] = args
        const allowedServices = { shells: ['kill', 'dismiss', 'output'], wakeups: ['cancel'], git: ['refresh', 'setEnabled'], mcp: ['connectAll', 'add', 'update', 'remove', 'toggle', 'reconnect'], memory: ['list', 'setDisabled', 'forget'], boot: ['refreshModels'] }
        if (target !== 'controller' && !allowedServices[target]?.includes(method)) throw new Error('unsupported service action')
        const object = target === 'controller' ? record.ctl : target === 'boot' ? record.ctl.boot : record.ctl.boot[target]
        if (!object || typeof object[method] !== 'function' || method.startsWith('_') || ['shutdown', 'on', 'constructor', '__proto__'].includes(method)) throw new Error('unsupported daemon action')
        if (target === 'controller' && ['newSession', 'resume', 'switchProject', 'switchToWorktree', 'fork'].includes(method)) throw new Error('session switches require a separate owner')
        if (target === 'controller' && method === 'rename' && !String(values[0] || '').trim() && busy(record.ctl)) throw new Error('interrupt the session before clearing its name')
        if (target === 'controller' && method === 'compact') {
          Promise.resolve(object[method](...values)).catch(error => publish(record, 'flash', error.message))
          publish(record, 'change')
          return { result: undefined, snapshot: snapshot(record.ctl) }
        }
        const result = await object[method](...values)
        publish(record, 'change')
        return { result, snapshot: snapshot(record.ctl) }
      }
      if (op === 'configure') {
        const allowed = ['researchModel', 'shellModel', 'deliberationModel', 'participantAModel', 'participantBModel', 'researchAgentLimit', 'clouds', 'compactToolHistory', 'gitFooter', 'wideSidebar']
        for (const [key, value] of Object.entries(args[0])) { if (!allowed.includes(key)) throw new Error('unsupported session setting'); record.ctl.boot[key] = value }
        publish(record, 'change')
        return
      }
      throw new Error('unsupported daemon operation')
    }) },
    close() { return serial(async () => { closed = true; for (const record of [...sessions.values()]) await dispose(record) }) },
  }
}
