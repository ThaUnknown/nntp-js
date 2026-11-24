import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { test } from 'node:test'

import { ConnectionClosedError, NNTP, ResponseReader } from '../src/index.ts'

// Each next() of the iterator gives exactly 1 chunk, so that the tests control where the network splits the data.
async function * chunks (parts: string[]) {
  for (const part of parts) yield Buffer.from(part, 'latin1')
}

function text (data: Uint8Array) {
  return Buffer.from(data).toString('latin1')
}

// The server sends the dot-stuffed form. The client must give the original lines.
const WIRE_BODY = '..first line starts with a dot\r\nmiddle\r\n..\r\n...two dots\r\nlast\r\n.\r\n'
const ORIGINAL_BODY = '.first line starts with a dot\r\nmiddle\r\n.\r\n..two dots\r\nlast'

test('readMultiline removes the dot-stuffing and the terminator', async () => {
  const reader = new ResponseReader(chunks([WIRE_BODY]))
  assert.equal(text(await reader.readMultiline()), ORIGINAL_BODY)
})

test('readMultiline gives the same result for each split point of the data', async () => {
  for (let split = 1; split < WIRE_BODY.length; split++) {
    const reader = new ResponseReader(chunks([WIRE_BODY.slice(0, split), WIRE_BODY.slice(split)]))
    assert.equal(text(await reader.readMultiline()), ORIGINAL_BODY, `split at ${split}`)
  }
})

test('readMultiline gives the same result when each byte is a separate chunk', async () => {
  const reader = new ResponseReader(chunks([...WIRE_BODY]))
  assert.equal(text(await reader.readMultiline()), ORIGINAL_BODY)
})

test('readMultiline finds the terminator after an empty chunk between the CR and the LF', async () => {
  const reader = new ResponseReader(chunks(['line\r', '', '\n.\r\n']))
  assert.equal(text(await reader.readMultiline()), 'line')
})

test('readMultiline reads an empty data block and does not read the next response', async () => {
  const reader = new ResponseReader(chunks(['.\r\n222 next\r\n']))
  assert.equal(text(await reader.readMultiline()), '')
  assert.equal(text(await reader.readLine()), '222 next')
})

test('readMultiline keeps a data line that is empty', async () => {
  const reader = new ResponseReader(chunks(['\r\nafter empty line\r\n.\r\n']))
  assert.equal(text(await reader.readMultiline()), '\r\nafter empty line')
})

test('readLine finds a CRLF that is split across 2 chunks', async () => {
  const reader = new ResponseReader(chunks(['200 hel', 'lo\r', '\n201 second\r\n']))
  assert.equal(text(await reader.readLine()), '200 hello')
  assert.equal(text(await reader.readLine()), '201 second')
})

test('readMultiline throws if the connection closes before the terminator', async () => {
  const reader = new ResponseReader(chunks(['partial da']))
  await assert.rejects(reader.readMultiline(), ConnectionClosedError)
})

test('readLine throws if the connection closes before the CRLF', async () => {
  const reader = new ResponseReader(chunks(['200 no end']))
  await assert.rejects(reader.readLine(), ConnectionClosedError)
})

// A fake server socket. Client writes are ignored. Each server chunk arrives in a separate macrotask.
function fakeServer (parts: string[], end = false) {
  const socket = new Duplex({
    read () {},
    write (_chunk, _encoding, callback) { callback() }
  })
  const all = ['200 welcome\r\n', '101 capabilities\r\nVERSION 2\r\nREADER\r\n.\r\n', ...parts]
  ;(async () => {
    for (const part of all) {
      socket.push(Buffer.from(part, 'latin1'))
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    if (end) socket.push(null)
  })()
  return socket
}

async function connect (parts: string[], end = false) {
  const nntp = new NNTP('fake')
  await nntp.connect(false, undefined, fakeServer(parts, end) as never)
  return nntp
}

test('body after an empty body gets its own response', async () => {
  const nntp = await connect(['222 1 <a> body\r\n.\r\n', '222 2 <b> body\r\nsecond\r\n.\r\n'])
  const first = await nntp.body('<a>')
  assert.equal(first.messageId, '<a>')
  assert.equal(text(first.data), '')
  const second = await nntp.body('<b>')
  assert.equal(second.messageId, '<b>')
  assert.equal(text(second.data), 'second')
})

test('body gives the original lines of a dot-stuffed article', async () => {
  const nntp = await connect(['222 1 <a> body\r\n', WIRE_BODY])
  assert.equal(text((await nntp.body('<a>')).data), ORIGINAL_BODY)
})

test('body throws and marks the connection as closed if the response stops before its end', async () => {
  const nntp = await connect(['222 1 <a> body\r\npartial da'], true)
  await assert.rejects(nntp.body('<a>'), ConnectionClosedError)
  assert.equal(nntp.connected, false)
})

test('article separates the headers from the body', async () => {
  const nntp = await connect(['220 1 <a> article\r\nSubject: test\r\nFrom: someone\r\n\r\nbody line\r\n..dot line\r\n.\r\n'])
  const { res } = await nntp.article('<a>')
  assert.equal(res.headers.get('subject'), 'test')
  assert.equal(res.headers.get('from'), 'someone')
  assert.equal(await res.text(), 'body line\r\n.dot line')
})
