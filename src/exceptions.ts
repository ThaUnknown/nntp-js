export class NNTPError extends Error {
  response: string

  constructor (...args: string[]) {
    super(...args)
    this.name = 'NNTPError'
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    this.response = args[0] || 'No response given'
  }
}

export class NNTPReplyError extends NNTPError {
  constructor (...args: string[]) {
    super(...args)
    this.name = 'NNTPReplyError'
  }
}

export class NNTPTemporaryError extends NNTPError {
  constructor (...args: string[]) {
    super(...args)
    this.name = 'NNTPTemporaryError'
  }
}

export class NNTPPermanentError extends NNTPError {
  constructor (...args: string[]) {
    super(...args)
    this.name = 'NNTPPermanentError'
  }
}

export class NNTPProtocolError extends NNTPError {
  constructor (...args: string[]) {
    super(...args)
    this.name = 'NNTPProtocolError'
  }
}

export class NNTPDataError extends NNTPError {
  constructor (...args: string[]) {
    super(...args)
    this.name = 'NNTPDataError'
  }
}
