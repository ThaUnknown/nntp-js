import { NNTP } from '../src/index.ts'

const s = new NNTP('news.gmane.io', 119)

await s.connect()

// await s.connectTLS()

const caps = await s.getcapabilities()
if ('STARTTLS' in caps) {
  await s.starttls()
}
console.log({ caps })

const { count, first, last, group } = await s.group('gmane.comp.python.general')
console.log('Group', group, 'has', count, 'articles, range', first, 'to', last)

function cut (s: string, lim: number): string {
  if (s.length > lim) {
    return s.slice(0, lim - 4) + '...'
  }
  return s
}

const firstArticle = (Number(last) | 0) - 10 + 1
const { overviews } = await s.xover(firstArticle, last)

for (const [artnum, over] of overviews) {
  const author = over.from.split('<', 1)[0]
  const subject = over.subject
  const lines = parseInt(over[':lines'])
  console.log(`${artnum.toString().padStart(7)} ${cut(author, 20).padEnd(20)} ${cut(subject, 42).padEnd(42)} (${lines})`)
}

s.quit()
