import { DEFAULT_OVERVIEW_FMT, OVERVIEW_FMT_ALTERNATIVES } from './constants.ts'
import { NNTPDataError } from './exceptions.ts'

export function parseHeaders (lines: string[]) {
  const headers = new Headers()
  for (const entry of lines) {
    const firstColon = entry.indexOf(': ')
    if (firstColon === -1) continue
    headers.set(entry.slice(0, firstColon), entry.slice(firstColon + 2))
  }
  return headers
}

export function formatDate (inputDate: Date, format: string) {
  if (!inputDate) return ''

  const padZero = (value: number) => (value < 10 ? `0${value}` : `${value}`)
  const parts: Record<string, () => string> = {
    yyyy: () => padZero(inputDate.getFullYear()),
    MM: () => padZero(inputDate.getMonth() + 1),
    dd: () => padZero(inputDate.getDate()),
    HH: () => padZero(inputDate.getHours()),
    hh: () => padZero(inputDate.getHours() > 12 ? inputDate.getHours() - 12 : inputDate.getHours()),
    mm: () => padZero(inputDate.getMinutes()),
    ss: () => padZero(inputDate.getSeconds())
  }

  return format.replace(/yyyy|MM|dd|HH|hh|mm|ss/g, (match) => parts[match]!())
}

export function parseDateString (dateStr: string) {
  const slice = (start: number, end?: number) => parseInt(dateStr.slice(start, end))

  // yyyymmddhhmmss
  return new Date(slice(0, 4), slice(4, 6) - 1, slice(6, 8), slice(-6, -4), slice(-4, -2), slice(-2))
}

export function parseOverviewFmt (lines: string[]): string[] {
  const fmt = lines.map((line) => {
    const name = (line[0] === ':' ? line.split(':', 2)[1] : line.split(':', 1)[0])?.toLowerCase()

    return OVERVIEW_FMT_ALTERNATIVES[name!] ?? name!
  })

  if (fmt.length < DEFAULT_OVERVIEW_FMT.length) throw new NNTPDataError('LIST OVERVIEW.FMT response too short')
  if (!fmt.slice(0, DEFAULT_OVERVIEW_FMT.length).every((v, i) => v === DEFAULT_OVERVIEW_FMT[i])) throw new NNTPDataError('LIST OVERVIEW.FMT redefines default fields')

  return fmt
}

export function parseOverview (lines: string[], fmt: string[]): Array<[number, Record<string, any>]> {
  const nDefaults = DEFAULT_OVERVIEW_FMT.length
  const overview: Array<[number, Record<string, any>]> = []
  for (const line of lines) {
    const fields: Record<string, any> = {}
    const [articleNumberStr, ...tokens] = line.split('\t')
    const articleNumber = parseInt(articleNumberStr!, 10)
    for (let i = 0; i < tokens.length; i++) {
      if (i >= fmt.length) {
        continue
      }
      const fieldName = fmt[i]!
      const isMetadata = fieldName.startsWith(':')
      if (i >= nDefaults && !isMetadata) {
        const h = fieldName + ': '
        if (tokens[i] && tokens[i]!.toLowerCase().slice(0, h.length) !== h) {
          throw new NNTPDataError("OVER/XOVER response doesn't include names of additional headers")
        }
        if (tokens[i]) tokens[i] = tokens[i]!.slice(h.length)
      }
      fields[fmt[i]!] = tokens[i]
    }
    overview.push([articleNumber, fields])
  }
  return overview
}
