import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

import { XMLParser } from 'fast-xml-parser'
import { parseHTML } from 'linkedom'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix)

export function publicWebUrl(raw: string): URL {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('仅支持公开 HTTP(S) 资料链接')
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost')) throw new Error('不接受本地地址')
  if (url.hostname.includes(':') || (isIP(url.hostname) && blocked.check(url.hostname))) throw new Error('不接受保留地址')
  return url
}

/** 固定解析后的公开 IP;重定向逐次检查,并限制页面体积和总读取时间。 */
export async function fetchPublicPage(raw: string, redirects = 0): Promise<{ url: string; body: string; contentType: string }> {
  const url = publicWebUrl(raw)
  const addresses = await lookup(url.hostname, { family: 4, all: true })
  if (!addresses.length || addresses.some(item => blocked.check(item.address))) throw new Error('资料地址未解析到公开网络')
  const response = await new Promise<{ status: number; location?: string; body: string; contentType: string }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: { 'User-Agent': 'PR-Agent/0.1 (race information)', Accept: 'text/html,application/xml,text/xml,text/plain' },
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4),
    }, res => {
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 1_500_000) request.destroy(new Error('赛事资料页面过大'))
        else chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', () => resolve({
        status: res.statusCode ?? 0, location: res.headers.location,
        body: Buffer.concat(chunks).toString('utf8'), contentType: String(res.headers['content-type'] ?? ''),
      }))
    })
    const timer = setTimeout(() => request.destroy(new Error('赛事资料请求超时')), 10_000)
    request.on('close', () => clearTimeout(timer))
    request.on('error', reject)
    request.end()
  })
  if (response.status >= 300 && response.status < 400 && response.location && redirects < 3) return fetchPublicPage(new URL(response.location, url).href, redirects + 1)
  if (response.status !== 200) throw new Error(`赛事资料 HTTP ${response.status}`)
  return { url: url.href, body: response.body, contentType: response.contentType }
}

export interface RaceWebDocument {
  url: string
  title: string
  text: string
  fetchedAt: string
  authority: 'official' | 'unverified'
}

function officialHost(host: string) {
  const trusted = (process.env.PR_RACE_OFFICIAL_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return host.endsWith('.gov.cn') || trusted.some(value => host === value || host.endsWith(`.${value}`))
}

export async function readRaceWebDocument(url: string): Promise<RaceWebDocument> {
  const page = await fetchPublicPage(url)
  if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(page.contentType)) throw new Error('资料不是可解析的网页正文')
  const { document } = parseHTML(page.body)
  const title = document.querySelector('title')?.textContent ?? ''
  document.querySelectorAll('script,style,noscript,nav,footer,header,iframe').forEach(node => node.remove())
  const text = (document.querySelector('article') ?? document.querySelector('main') ?? document.body).textContent?.replace(/\s+/g, ' ').trim() ?? ''
  if (text.length < 60) throw new Error('网页正文不足，可能需要登录或仅有图片')
  return { url: page.url, title, text: text.slice(0, 22000), fetchedAt: new Date().toISOString(), authority: officialHost(new URL(page.url).hostname) ? 'official' : 'unverified' }
}

export async function searchRaceWeb(query: string): Promise<string[]> {
  if (process.env.TAVILY_API_KEY) {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST', signal: AbortSignal.timeout(12_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: 6, search_depth: 'basic', include_answer: false }),
    })
    if (!response.ok) throw new Error(`赛事搜索 HTTP ${response.status}`)
    const result = await response.json() as { results?: Array<{ url?: string }> }
    return (result.results ?? []).flatMap(item => typeof item.url === 'string' ? [item.url] : [])
  }
  const url = new URL('https://www.bing.com/search')
  url.searchParams.set('format', 'rss')
  url.searchParams.set('q', query)
  // 搜索引擎域名是固定的；不要把其 CDN 的证书域名绑定到解析出的 IP，
  // 否则代理返回的共享地址会触发 TLS SAN 错误。搜索结果中的赛事链接仍会经过
  // fetchPublicPage 的公开地址校验。
  const response = await fetch(url.href, { signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/rss+xml,text/xml' } })
  if (!response.ok) throw new Error(`赛事搜索 HTTP ${response.status}`)
  const parsed = new XMLParser({ processEntities: false }).parse(await response.text())
  const entries = parsed?.rss?.channel?.item
  if (!entries) throw new Error('赛事搜索没有返回可解析的结果')
  const items = Array.isArray(entries) ? entries : [entries]
  return items.flatMap((item: { link?: unknown }) => typeof item.link === 'string' ? [item.link] : []).slice(0, 6)
}
