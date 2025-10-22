import net from 'node:net'
import tls from 'node:tls'
import { EventEmitter } from 'events'
import { formatDate, parseDateString, parseHeaders, parseOverview, parseOverviewFmt } from './helpers.ts'
import { NNTPDataError, NNTPPermanentError, NNTPProtocolError, NNTPReplyError, NNTPTemporaryError } from './exceptions.ts'
import { LONGRESP_END, DEFAULT_OVERVIEW_FMT, NEW_LINE, HEADERS_END } from './constants.ts'

async function * findByteSequence (sourceIterator: AsyncIterable<Uint8Array>, targetSequence: Uint8Array) {
  // not great but good enough
  const buffer = []
  let targetLength = targetSequence.length
  let matchIndex = 0

  for await (const chunk of sourceIterator) {
    for (const byte of chunk) {
      buffer.push(byte)
      if (byte === targetSequence[matchIndex]) {
        matchIndex++
        if (matchIndex === targetLength) {
          // Sequence found, yield all data up to but not including the sequence
          if (buffer.length > 0) {
            targetSequence = yield new Uint8Array(buffer.slice(0, -targetLength)) || targetSequence
          }
          buffer.length = 0 // Clear the buffer
          matchIndex = 0
          targetLength = targetSequence.length
        }
      } else {
        matchIndex = (byte === targetSequence[0]) ? 1 : 0
      }
    }
  }

  if (buffer.length > 0) yield new Uint8Array(buffer)
}

const decoder = new TextDecoder('ascii')
function decode (data: Uint8Array) {
  return decoder.decode(data)
}

export class NNTP extends EventEmitter {
  host
  port
  sock?: net.Socket
  welcome?: string
  caps?: Record<string, string[]>
  readermodeAfterauth?: boolean
  tlsOn = false
  authenticated = false
  nntpVersion?: number
  nntpImplementation?: string
  _cachedoverviewfmt?: string[]
  byteReader?: AsyncGenerator<Uint8Array, void, Uint8Array>
  connected = false

  constructor (host: string, port = 119, readermode = false, timeout?: number) {
    super()
    this.host = host
    this.port = port
  }

  async connect (readermode = false, timeout: number | undefined = undefined, socket?: net.Socket) {
    try {
      this.sock = socket || this._createSocket(timeout)
      this.byteReader = findByteSequence(this.sock, NEW_LINE) // initialize with new line since first requet is always a welcome single line
      this.welcome = decode(await this._getresp())
      this.caps = undefined
      this.connected = true
      await this.getcapabilities()
      this.readermodeAfterauth = false
      if (readermode && !this.caps!?.READER) {
        await this._setreadermode()
        if (!this.readermodeAfterauth) {
          this.caps = undefined
          await this.getcapabilities()
        }
      }
    } catch (error) {
      this.sock?.end()
      throw error
    }
  }

  connectTLS (readermode = false, timeout?: number, context?: tls.SecureContext) {
    return this.connect(readermode, 0, new tls.TLSSocket(this._createSocket(timeout), { secureContext: context }))
  }

  _createSocket (timeout?: number) {
    if (timeout != null && timeout === 0) {
      throw new Error('Non-blocking socket (timeout=0) is not supported')
    }
    return net.createConnection({ host: this.host, port: this.port, timeout })
  }

  async _getresp (delimiter = NEW_LINE) {
    const resp = await this._getline(delimiter)
    if (resp[0] === 52 || resp[0] === 53) { // 4xx, 5xx
      throw new NNTPTemporaryError(decode(resp))
    }
    if (resp[0] !== 49 && resp[0] !== 50 && resp[0] !== 51) { // 1xx, 2xx, 3xx
      throw new NNTPProtocolError(decode(resp))
    }
    return resp
  }

  async _getline (delimiter = NEW_LINE) {
    const { value } = await this.byteReader!.next(delimiter)
    if (value === undefined) throw new Error('End of stream')

    return value
  }

  _putline (line: string) {
    if (!this.connected) throw new Error('Not connected')
    this.sock!.write(line + '\r\n')
  }

  _shortcmd (line: string) {
    this._putline(line)
    return this._getresp()
  }

  _longcmd (line: string) {
    this._putline(line)
    return this._getlongresp()
  }

  async _getlongresp () {
    return { resp: decode(await this._getresp()), data: await this._getline(LONGRESP_END) }
  }

  getwelcome (): string {
    return this.welcome as string
  }

  async getcapabilities () {
    if (this.caps === undefined) {
      this.nntpVersion = 1
      this.nntpImplementation = undefined
      try {
        const { caps } = await this.capabilities()
        this.caps = caps
        if (caps.VERSION) {
          this.nntpVersion = Math.max(...caps.VERSION.map(Number))
        }
        if (caps.IMPLEMENTATION) {
          this.nntpImplementation = caps.IMPLEMENTATION.join(' ')
        }
      } catch (error) {
        this.caps = {}
      }
    }
    return this.caps
  }

  async capabilities () {
    const caps: Record<string, string[]> = {}
    const { resp, data } = await this._longcmd('CAPABILITIES')
    for (const line of decode(data).split('\r\n')) {
      const [name, ...tokens] = line.split(' ')
      caps[name] = tokens
    }
    return { resp, caps }
  }

  newgroups (date: Date) {
    if (!(date instanceof Date)) {
      throw new TypeError('the date parameter must be a Date object')
    }

    return this._longcmd(`NEWGROUPS ${formatDate(date, 'yyyyMMdd')} ${formatDate(date, 'HHmmss')}`)
  }

  newnews (group: string, date: Date) {
    if (!(date instanceof Date)) {
      throw new TypeError('the date parameter must be a Date object')
    }

    return this._longcmd(`NEWNEWS ${group} ${formatDate(date, 'yyyyMMdd')} ${formatDate(date, 'HHmmss')}`)
  }

  list (groupPattern?: string | number) {
    return this._longcmd(groupPattern ? `LIST ACTIVE ${groupPattern}` : 'LIST')
  }

  async description (group: string) {
    return await this._getdescriptions(group, false) as string
  }

  async descriptions (groupPattern: string) {
    return await this._getdescriptions(groupPattern, true) as [string, Record<string, string>]
  }

  async group (name: string) {
    const resp = decode(await this._shortcmd(`GROUP ${name}`))
    if (!resp.startsWith('211')) {
      throw new NNTPReplyError(resp)
    }
    const [count, first, last, group] = resp.split(' ')
    return { resp, count, first, last, group }
  }

  help () {
    return this._longcmd('HELP')
  }

  stat (messageSpec?: string) {
    if (messageSpec) {
      return this._statcmd(`STAT ${messageSpec}`)
    } else {
      return this._statcmd('STAT')
    }
  }

  next () {
    return this._statcmd('NEXT')
  }

  last () {
    return this._statcmd('LAST')
  }

  /** get article head  */
  async head (messageSpec?: string | number) {
    const { resp, data } = await this._artcmd(messageSpec ? `HEAD ${messageSpec}` : 'HEAD')
    return { resp, headers: parseHeaders(decode(data).split('\r\n')) }
  }

  /** get article body  */
  async body (messageSpec?: string | number) {
    return await this._artcmd(messageSpec ? `BODY ${messageSpec}` : 'BODY')
  }

  /** get article head and body  */
  async article (messageSpec?: string | number) {
    this._putline(messageSpec ? `ARTICLE ${messageSpec}` : 'ARTICLE')
    const resp = decode(await this._getresp())
    const headers = parseHeaders(decode(await this._getline(HEADERS_END)).split('\r\n'))
    const data = await this._getline(LONGRESP_END) as Uint8Array<ArrayBuffer>

    return { resp, res: new Response(data, { headers }) }
  }

  slave () {
    return this._shortcmd('SLAVE')
  }

  async xhdr (hdr: string, str: any) {
    const { resp, data } = await this._longcmd(`XHDR ${hdr} ${str}`)
    return {
      resp,
      hdr: decode(data).split('\r\n').map(line => {
        const match = /^([0-9]+) ?(.*)\n?/.exec(line)
        return match ? match[1] : line
      })
    }
  }

  async xover (start: string | number, end: string | number) {
    const { resp, data } = await this._longcmd(`XOVER ${start}-${end}`)
    return { resp, overviews: parseOverview(decode(data).split('\r\n'), await this._getoverviewfmt()) }
  }

  async over (messageSpec: [string | number, string | number] | number | string) {
    let cmd = this.caps?.OVER ? 'OVER' : 'XOVER'
    if (Array.isArray(messageSpec)) {
      const [start, end] = messageSpec
      cmd += ` ${start}-${end || ''}`
    } else if (messageSpec != null) {
      cmd += ` ${messageSpec}`
    }
    const { resp, data } = await this._longcmd(cmd)
    const fmt = await this._getoverviewfmt()
    return { resp, overview: parseOverview(decode(data).split('\r\n'), fmt) }
  }

  async date () {
    const resp = decode(await this._shortcmd('DATE'))
    if (!resp.startsWith('111')) {
      throw new NNTPReplyError(resp)
    }
    const elem = resp.split(' ')
    if (elem.length !== 2) {
      throw new NNTPDataError(resp)
    }
    const date = elem[1]
    if (date.length !== 14) {
      throw new NNTPDataError(resp)
    }
    return { resp, date: parseDateString(date) }
  }

  post (data: Iterable<Buffer>) {
    return this._post('POST', data)
  }

  ihave (messageId: any, data: Iterable<Buffer>) {
    return this._post(`IHAVE ${messageId}`, data)
  }

  async quit () {
    try {
      return await this._shortcmd('QUIT')
    } finally {
      this._close()
    }
  }

  async login (user: string | null = null, password: string | null = null) {
    if (this.authenticated) {
      throw new Error('Already logged in.')
    }
    if (!user) {
      throw new Error('`user` must be specified')
    }

    const resp = decode(await this._shortcmd(`authinfo user ${user}`))
    if (resp.startsWith('381')) {
      if (!password) {
        throw new NNTPReplyError(resp)
      } else {
        const resp = decode(await this._shortcmd(`authinfo pass ${password}`))
        if (!resp.startsWith('281')) {
          throw new NNTPPermanentError(resp)
        }
      }
    }
    this.caps = undefined
    await this.getcapabilities()
    if (this.readermodeAfterauth && !this.caps!?.READER) {
      await this._setreadermode()
      this.caps = undefined
      await this.getcapabilities()
    }
  }

  async _setreadermode () {
    try {
      this.welcome = decode(await this._shortcmd('mode reader'))
    } catch (error) {
      if ((error as Error).message.startsWith('480')) {
        this.readermodeAfterauth = true
      } else {
        throw error
      }
    }
  }

  _close () {
    this.sock!.end()
  }

  _statparse (resp: string) {
    if (!resp.startsWith('22')) {
      throw new NNTPReplyError(resp)
    }
    const words = resp.split(' ')
    const artNum = parseInt(words[1])
    const messageId = words[2]
    return { resp, artNum, messageId }
  }

  async _statcmd (line: string) {
    return this._statparse(decode(await this._shortcmd(line)))
  }

  async _artcmd (line: string) {
    const { resp, data } = await this._longcmd(line)
    const { artNum, messageId } = this._statparse(resp)
    return { resp, artNum, messageId, data }
  }

  async _getoverviewfmt () {
    if (this._cachedoverviewfmt) return this._cachedoverviewfmt

    let fmt = []
    try {
      const { data } = await this._longcmd('LIST OVERVIEW.FMT')
      fmt = decode(data).split('\r\n')
    } catch (error) {
      fmt = DEFAULT_OVERVIEW_FMT
    }
    this._cachedoverviewfmt = parseOverviewFmt(fmt)
    return this._cachedoverviewfmt
  }

  async _getdescriptions (groupPattern: string, returnAll: boolean): Promise<string | [string, Record<string, string>]> {
    const linePat = /^(?<group>[^ \t]+)[ \t]+(.*)$/
    const { resp, data } = await this._longcmd(`LIST NEWSGROUPS ${groupPattern}`)
    const lines = decode(data).split('\r\n')
    if (!resp.startsWith('215')) {
      const { resp, data } = await this._longcmd(`XGTITLE ${groupPattern}`)
      if (returnAll) {
        const groups: Record<string, string> = {}
        for (const rawLine of decode(data).split('\r\n')) {
          const match = linePat.exec(rawLine.trim())
          if (match) {
            const [, name, desc] = match
            groups[name] = desc
          }
        }
        return [resp, groups]
      } else {
        return ''
      }
    } else {
      if (returnAll) {
        const groups: Record<string, string> = {}
        for (const rawLine of lines) {
          const match = linePat.exec(rawLine.trim())
          if (match) {
            const [, name, desc] = match
            groups[name] = desc
          }
        }
        return [resp, groups]
      } else {
        const match = linePat.exec(lines[0].trim())
        if (match) {
          const [, , desc] = match
          return desc
        }
        return ''
      }
    }
  }

  async _post (command: string, data: Iterable<Buffer>) {
    const resp = decode(await this._shortcmd(command))
    if (!resp.startsWith('3')) {
      throw new NNTPReplyError(resp)
    }
    for (const line of data) {
      let lineStr = line.toString()
      if (!lineStr.endsWith('\r\n')) lineStr += '\r\n'
      if (lineStr.startsWith('.')) lineStr = '.' + lineStr
      this.sock!.write(lineStr)
    }
    this.sock!.write('.\r\n')
    return await this._getresp()
  }

  async starttls (secureContext?: tls.SecureContext) {
    if (this.tlsOn) {
      throw new Error('TLS is already enabled.')
    }
    if (this.authenticated) {
      throw new Error('TLS cannot be started after authentication.')
    }
    const resp = decode(await this._shortcmd('STARTTLS'))
    if (resp.startsWith('382')) {
      this.connected = false
      await new Promise<void>(resolve => {
        this.sock = tls.connect(5000, this.host, { socket: this.sock, secureContext }, resolve)
        this.byteReader = findByteSequence(this.sock, NEW_LINE)
      })
      this.connected = true
      this.tlsOn = true
      this.caps = undefined
      await this.getcapabilities()
    } else {
      throw new Error('TLS failed to start.')
    }
  }
}
