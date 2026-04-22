// Default decoded value for LIST OVERVIEW.FMT if not supported
export const DEFAULT_OVERVIEW_FMT = [
  'subject',
  'from',
  'date',
  'message-id',
  'references',
  ':bytes',
  ':lines'
]

// Alternative names allowed in LIST OVERVIEW.FMT response
export const OVERVIEW_FMT_ALTERNATIVES: Record<string, string> = {
  bytes: ':bytes',
  lines: ':lines'
}

export const NEW_LINE = new Uint8Array([13, 10]) // CRLF
export const LONGRESP_END = new Uint8Array([13, 10, 46, 13, 10]) // CRLF.CRLF
export const HEADERS_END = new Uint8Array([13, 10, 13, 10]) // CRLFCRLF
