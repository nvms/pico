import { dirname } from 'node:path'
import { serveDaemon, daemonPaths } from 'picocode-core/daemon-transport.js'
import { createDaemonSession } from './daemon-session.js'

const socket = process.argv[process.argv.indexOf('--socket') + 1]
const paths = process.argv.includes('--socket') ? { socket, directory: dirname(socket) } : daemonPaths()
const daemon = await serveDaemon({ paths, createSession: createDaemonSession, onClose: () => process.exit(0) })
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => daemon.close().catch(() => process.exit(1)))
process.on('uncaughtException', () => daemon.close().finally(() => process.exit(1)))
process.on('unhandledRejection', () => daemon.close().finally(() => process.exit(1)))
