import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { test } from 'node:test'

import { ConnectionClosedError, NNTP, NNTPProtocolError, NNTPTemporaryError } from '../src/index.ts'

const WELCOME = '200 welcome\r\n'
const CAPABILITIES = '101 capabilities\r\nVERSION 2\r\nREADER\r\n.\r\n'

const tick = () => new Promise(resolve => setImmediate(resolve))

function text (data: Uint8Array) {
  return Buffer.from(data).toString('latin1')
}

// A fake server socket that records the client commands. The test decides when each server chunk arrives.
function fakeServer () {
  const commands: string[] = []
  const socket = new Duplex({
    read () {},
    write (chunk: Buffer, _encoding, callback) {
      commands.push(chunk.toString('latin1'))
      callback()
    }
  })
  // The wait lets the client read the chunk, so that the next chunk does not join it.
  const send = async (data: string) => {
    socket.push(Buffer.from(data, 'latin1'))
    await tick()
  }
  const close = async () => {
    socket.push(null)
    await tick()
  }
  return { socket, commands, send, close }
}

async function connect () {
  const server = fakeServer()
  const nntp = new NNTP('fake')
  const connected = nntp.connect(false, undefined, server.socket as never)
  await server.send(WELCOME)
  await server.send(CAPABILITIES)
  await connected
  server.commands.length = 0
  return { nntp, ...server }
}

// The next reconnect of the client uses the fake server that this function gives.
function nextServer (nntp: NNTP) {
  const server = fakeServer()
  nntp._createSocket = () => server.socket as never
  return server
}

test('body sends the 2nd command before the 1st reply arrives, and gives each call its own reply', async () => {
  const { nntp, commands, send } = await connect()
  const first = nntp.body('<a>')
  const second = nntp.body('<b>')
  await tick()
  assert.deepEqual(commands, ['BODY <a>\r\n', 'BODY <b>\r\n'])

  await send('222 1 <a> body\r\nfirst\r\n.\r\n')
  await send('222 2 <b> body\r\nsecond\r\n.\r\n')
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.messageId, '<a>')
  assert.equal(text(a.data), 'first')
  assert.equal(b.messageId, '<b>')
  assert.equal(text(b.data), 'second')
})

test('body gives the correct reply to the 2nd call if the article of the 1st call does not exist', async () => {
  const { nntp, send } = await connect()
  const first = nntp.body('<a>')
  const second = nntp.body('<b>')
  const missing = assert.rejects(first, NNTPTemporaryError)

  await send('430 no such article\r\n222 2 <b> body\r\nsecond\r\n.\r\n')
  await missing
  const b = await second
  assert.equal(b.messageId, '<b>')
  assert.equal(text(b.data), 'second')
  assert.equal(nntp.connected, true)
})

test('body rejects all calls in flight if the connection closes, and the next call reconnects', async () => {
  const { nntp, send, close } = await connect()
  const first = assert.rejects(nntp.body('<a>'), ConnectionClosedError)
  const second = assert.rejects(nntp.body('<b>'), ConnectionClosedError)
  await send('222 1 <a> body\r\npartial da')
  await close()
  await first
  await second

  const server = nextServer(nntp)
  const third = nntp.body('<c>')
  await server.send(WELCOME)
  await server.send(CAPABILITIES)
  await server.send('222 3 <c> body\r\nthird\r\n.\r\n')
  assert.equal(text((await third).data), 'third')
  assert.deepEqual(server.commands, ['CAPABILITIES\r\n', 'BODY <c>\r\n'])
})

// A command that the client sends during the handshake gets a reply that the handshake reads.
test('body does not send a command during the reconnect that an earlier call started', async () => {
  const { nntp, close } = await connect()
  const lost = assert.rejects(nntp.body('<a>'), ConnectionClosedError)
  await close()
  await lost

  const server = nextServer(nntp)
  const third = nntp.body('<c>')
  const fourth = nntp.body('<d>')
  await server.send(WELCOME)
  // The connection is open from this point, but the handshake is not complete.
  const fifth = nntp.body('<e>')
  await tick()
  assert.deepEqual(server.commands, ['CAPABILITIES\r\n'])

  await server.send(CAPABILITIES)
  await server.send('222 3 <c> body\r\nthird\r\n.\r\n')
  await server.send('222 4 <d> body\r\nfourth\r\n.\r\n')
  await server.send('222 5 <e> body\r\nfifth\r\n.\r\n')
  assert.equal(text((await third).data), 'third')
  assert.equal(text((await fourth).data), 'fourth')
  assert.equal(text((await fifth).data), 'fifth')
  assert.deepEqual(server.commands, ['CAPABILITIES\r\n', 'BODY <c>\r\n', 'BODY <d>\r\n', 'BODY <e>\r\n'])

  // After the reconnect, the client pipelines again.
  server.commands.length = 0
  const sixth = nntp.body('<f>')
  const seventh = nntp.body('<g>')
  await tick()
  assert.deepEqual(server.commands, ['BODY <f>\r\n', 'BODY <g>\r\n'])
  await server.send('222 6 <f> body\r\nsixth\r\n.\r\n222 7 <g> body\r\nseventh\r\n.\r\n')
  assert.equal(text((await sixth).data), 'sixth')
  assert.equal(text((await seventh).data), 'seventh')
})

// A reply on the old socket must not be read from the new socket.
test('body reconnects only after the calls on the old socket end', async () => {
  const { nntp, send } = await connect()
  const first = nntp.body('<a>')
  const second = assert.rejects(nntp.body('<b>'), ConnectionClosedError)
  await tick()
  // A socket error marks the connection as closed before the reads fail. This line gives the same state.
  nntp.connected = false

  const server = fakeServer()
  let reconnected = false
  nntp._createSocket = () => {
    reconnected = true
    return server.socket as never
  }
  const third = nntp.body('<c>')
  await tick()
  assert.equal(reconnected, false)

  await send('222 1 <a> body\r\nfirst\r\n.\r\n')
  assert.equal(text((await first).data), 'first')
  await second
  await server.send(WELCOME)
  await server.send(CAPABILITIES)
  await server.send('222 3 <c> body\r\nthird\r\n.\r\n')
  assert.equal(text((await third).data), 'third')
})

test('body does not give data to the 2nd call if the 1st reply is not a valid status line', async () => {
  const { nntp, send } = await connect()
  const first = assert.rejects(nntp.body('<a>'), NNTPProtocolError)
  // The position in the byte stream is unknown after a bad reply, so the reply of the 2nd command cannot be trusted.
  const second = assert.rejects(nntp.body('<b>'), ConnectionClosedError)
  await send('garbage\r\n222 2 <b> body\r\nsecond\r\n.\r\n')
  await first
  await second
  assert.equal(nntp.connected, false)
})

test('body gives each call its own reply for each split point of 2 replies', async () => {
  const wire = '222 1 <a> body\r\n..dot line\r\nfirst\r\n.\r\n222 2 <b> body\r\nsecond\r\n.\r\n'
  const { nntp, send } = await connect()
  for (let split = 0; split <= wire.length; split++) {
    const first = nntp.body('<a>')
    const second = nntp.body('<b>')
    if (split > 0) await send(wire.slice(0, split))
    if (split < wire.length) await send(wire.slice(split))
    assert.equal(text((await first).data), '.dot line\r\nfirst', `split at ${split}`)
    assert.equal(text((await second).data), 'second', `split at ${split}`)
  }
})

test('body gives the exact data of 2 large articles for different chunk sizes', async () => {
  const article = (name: string) => {
    const lines = Array.from({ length: 20000 }, (_, i) => `${i % 100 === 0 ? '.' : ''}${name} line ${i} `.padEnd(64, 'x'))
    const wire = lines.map(line => line.startsWith('.') ? '.' + line : line).join('\r\n') + '\r\n.\r\n'
    return { original: lines.join('\r\n'), wire }
  }
  const a = article('a')
  const b = article('b')
  assert.ok(a.original.length > 1e6)
  const wire = `222 1 <a> body\r\n${a.wire}222 2 <b> body\r\n${b.wire}`

  const { nntp, send } = await connect()
  for (const chunkSize of [997, 65536, wire.length]) {
    const first = nntp.body('<a>')
    const second = nntp.body('<b>')
    for (let offset = 0; offset < wire.length; offset += chunkSize) await send(wire.slice(offset, offset + chunkSize))
    const dataA = text((await first).data)
    const dataB = text((await second).data)
    assert.equal(dataA.length, a.original.length, `chunk size ${chunkSize}`)
    assert.ok(dataA === a.original, `chunk size ${chunkSize}`)
    assert.equal(dataB.length, b.original.length, `chunk size ${chunkSize}`)
    assert.ok(dataB === b.original, `chunk size ${chunkSize}`)
  }
})
