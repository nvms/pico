import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { deserialize } from 'node:v8'
import { wire } from '../src/daemon-wire.js'

test('slow terminals receive latest snapshots without losing events or disconnecting', () => {
  const socket = new EventEmitter()
  socket.destroyed = false
  socket.writableNeedDrain = true
  socket.writableLength = 70 * 1024 * 1024
  const frames = []
  socket.write = frame => { frames.push(deserialize(frame.subarray(4))); return true }
  socket.destroy = () => { socket.destroyed = true }
  const send = wire(socket, () => {})
  for (let i = 0; i < 100; i++) send({ type: 'update', id: 'one', snapshot: { sequence: i }, events: [{ type: 'flash', payload: i }] })
  send({ type: 'workspace' })
  assert.equal(frames.length, 0)
  assert.equal(socket.destroyed, false)
  socket.writableNeedDrain = false
  socket.emit('drain')
  assert.equal(frames.length, 2)
  assert.equal(frames[0].snapshot.sequence, 99)
  assert.equal(frames[0].events.length, 100)
  assert.equal(frames[1].type, 'workspace')
  assert.equal(socket.destroyed, false)
})
