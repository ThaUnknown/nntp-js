const CR = 13
const LF = 10
const DOT = 46
const CRLF = Buffer.from([CR, LF])
const CRLF_DOT = Buffer.from([CR, LF, DOT])

export class ConnectionClosedError extends Error {
  constructor () {
    super('The connection closed before the end of the response')
    this.name = 'ConnectionClosedError'
  }
}

/**
 * Reads NNTP responses from a byte stream.
 * Only 1 read can run at a time.
 */
export class ResponseReader {
  iterator: AsyncIterator<Uint8Array>
  /** Received bytes that a read did not use yet. */
  buffer: Buffer = Buffer.alloc(0)

  constructor (source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  async _receive () {
    const { value, done } = await this.iterator.next()
    if (done) throw new ConnectionClosedError()
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }

  /** Reads 1 line. The result does not include the CRLF. */
  async readLine () {
    let searchStart = 0
    for (;;) {
      const index = this.buffer.indexOf(CRLF, searchStart)
      if (index !== -1) {
        const line = this.buffer.subarray(0, index)
        this.buffer = this.buffer.subarray(index + 2)
        return line
      }
      // A CR at the end can be the start of a CRLF that the next chunk completes.
      searchStart = Math.max(0, this.buffer.length - 1)
      await this._receive()
    }
  }

  /**
   * Reads the data block of a multi-line response, up to the "." line.
   * The result does not include the CRLF of the last line, and has the RFC 3977 dot-stuffing removed.
   */
  async readMultiline () {
    const parts: Buffer[] = []
    let length = 0
    const keep = (part: Buffer) => {
      if (!part.length) return
      parts.push(part)
      length += part.length
    }
    const result = () => {
      // The CRLF of the last line is part of the terminator, not of the data.
      const data = Buffer.concat(parts, length)
      return data.subarray(0, Math.max(0, data.length - 2))
    }

    // The data block starts at the start of a line.
    // Act as if a CRLF comes before the data, so that 1 search finds all of the lines that start with a dot.
    let atLineStart = true
    for (;;) {
      if (atLineStart) {
        if (this.buffer.length < 3) {
          await this._receive()
          continue
        }
        if (this.buffer[0] === DOT) {
          if (this.buffer[1] === CR && this.buffer[2] === LF) {
            this.buffer = this.buffer.subarray(3)
            return result()
          }
          if (this.buffer[1] === DOT) this.buffer = this.buffer.subarray(1)
        }
        atLineStart = false
      }

      const index = this.buffer.indexOf(CRLF_DOT)
      if (index === -1) {
        // Keep all of the chunk, and do not join it to the next chunk, because that copies the next chunk.
        // A CRLF at the end, or a CR at the end and an LF at the start of the next chunk, starts a new line.
        const last = this.buffer.length - 1
        const endsWithCRLF = last >= 1 && this.buffer[last - 1] === CR && this.buffer[last] === LF
        const endsWithCR = this.buffer[last] === CR
        keep(this.buffer)
        this.buffer = Buffer.alloc(0)
        do await this._receive(); while (!this.buffer.length)
        if (endsWithCRLF) {
          atLineStart = true
        } else if (endsWithCR && this.buffer[0] === LF) {
          keep(this.buffer.subarray(0, 1))
          this.buffer = this.buffer.subarray(1)
          atLineStart = true
        }
        continue
      }

      keep(this.buffer.subarray(0, index + 2))
      this.buffer = this.buffer.subarray(index + 2)
      atLineStart = true
    }
  }
}
