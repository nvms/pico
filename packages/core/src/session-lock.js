import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'

const lockOptions = {
  realpath: false,
  retries: { retries: 100, minTimeout: 10, maxTimeout: 100 },
}

async function withLock(target, lockfilePath, task) {
  const release = await lockfile.lock(target, { ...lockOptions, lockfilePath })
  try {
    return await task()
  } finally {
    await release()
  }
}

export async function withSessionLock(file, task) {
  await mkdir(dirname(file), { recursive: true })
  return withLock(file, `${file}.lock`, task)
}

export async function withIndexLock(dir, task) {
  await mkdir(dir, { recursive: true })
  return withLock(dir, join(dir, '.index.lock'), task)
}
