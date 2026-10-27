// sim-data dalı (paraleltrading reposu): core koşu sonuçlarını runs/<id>.json olarak yazar, Claude rutini yorumunu
// yorum/<id>.json olarak koyar. Yazmak için SIM_GITHUB_TOKEN (yalnız bu repoya Contents: read and write izinli
// fine-grained token; Railway değişkeni). Okuma token'sız da çalışır (repo açık). Dalın ucu token varsa REST API'den,
// yoksa git'in akıllı HTTP ucundan (API kotası harcamaz); liste ve dosyalar contents API'sinden.

const trim = (s: string) => s.replace(/\/+$/, '')

export const gh = {
  repo: process.env.SIM_REPO || 'ariagdere/paraleltrading',
  branch: process.env.SIM_BRANCH || 'sim-data',
  token: process.env.SIM_GITHUB_TOKEN ?? '',
  gitUrl: trim(process.env.GITHUB_URL || 'https://github.com'),
  apiUrl: trim(process.env.GITHUB_API_URL || 'https://api.github.com'),
}

const headers = (accept = 'application/vnd.github+json', auth = true) => ({
  'User-Agent': 'paraleltrading-core',
  Accept: accept,
  'X-GitHub-Api-Version': '2022-11-28',
  ...(auth && gh.token ? { Authorization: `Bearer ${gh.token}` } : {}),
})

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call(method: string, url: string, body?: unknown, accept?: string, auth = true): Promise<string> {
  const res = await fetch(url, {
    method,
    headers: { ...headers(accept, auth), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    // token yalnız gönderildiyse suçlanır; hangi istek düştüğü de yazılır
    const quota = res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0' ? ' (GitHub API kotası doldu)' : ''
    const token = auth && gh.token && (res.status === 401 || (res.status === 403 && !quota)) ? ' (SIM_GITHUB_TOKEN geçersiz ya da bu repoya izni yok)' : ''
    throw new GitHubError(res.status, `GitHub HTTP ${res.status}${quota}${token}, ${method} ${new URL(url).pathname}: ${text.slice(0, 200)}`)
  }
  return text
}

const path = (p: string) => p.split('/').map(encodeURIComponent).join('/')

// Dalın ucu (commit sha). Token varsa REST API'den (kimlikli, dakikada bir okumaya kota yeter); yoksa git'in akıllı HTTP
// ucundan, Authorization'sız (repo açık; git ucu API'nin Bearer token'ını kabul etmeyebilir).
export async function branchHead(): Promise<string> {
  if (gh.token) {
    let ref: { object?: { sha?: unknown } }
    try {
      ref = JSON.parse(await call('GET', `${gh.apiUrl}/repos/${gh.repo}/git/ref/heads/${path(gh.branch)}`))
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) throw new Error(`${gh.repo} reposunda ${gh.branch} dalı bulunamadı`)
      throw err
    }
    const sha = ref?.object?.sha
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub dal ucu beklenen biçimde değil')
    return sha
  }
  const text = await call('GET', `${gh.gitUrl}/${gh.repo}.git/info/refs?service=git-upload-pack`, undefined, '*/*', false)
  const m = text.match(new RegExp(`([0-9a-f]{40}) refs/heads/${gh.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`))
  if (!m) throw new Error(`${gh.repo} reposunda ${gh.branch} dalı bulunamadı`)
  return m[1]!
}

// Klasördeki dosyalar (klasör yoksa boş).
export async function listDir(dir: string, ref: string): Promise<Array<{ name: string; path: string; sha: string }>> {
  try {
    const list = JSON.parse(await call('GET', `${gh.apiUrl}/repos/${gh.repo}/contents/${path(dir)}?ref=${encodeURIComponent(ref)}`))
    if (!Array.isArray(list)) throw new Error('GitHub klasör listesi beklenen biçimde değil')
    return list
      .filter((f) => f?.type === 'file')
      .map((f) => ({ name: String(f.name), path: String(f.path), sha: String(f.sha) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return []
    throw err
  }
}

export async function readFile(p: string, ref: string): Promise<string> {
  const f = JSON.parse(await call('GET', `${gh.apiUrl}/repos/${gh.repo}/contents/${path(p)}?ref=${encodeURIComponent(ref)}`))
  if (f?.encoding !== 'base64' || typeof f?.content !== 'string') throw new Error(`${p} okunamadı (dosya çok büyük ya da beklenen biçimde değil)`)
  return Buffer.from(f.content, 'base64').toString('utf8')
}

// Dosyayı dala yazar (varsa üzerine); commit sha'sını döner.
export async function putFile(p: string, text: string, message: string): Promise<string> {
  if (!gh.token) throw new Error('SIM_GITHUB_TOKEN tanımlı değil; sonuç sim-data dalına yazılamadı')
  let sha: string | undefined
  try {
    const cur = JSON.parse(await call('GET', `${gh.apiUrl}/repos/${gh.repo}/contents/${path(p)}?ref=${encodeURIComponent(gh.branch)}`))
    if (typeof cur?.sha === 'string') sha = cur.sha
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 404)) throw err
  }
  const res = JSON.parse(
    await call('PUT', `${gh.apiUrl}/repos/${gh.repo}/contents/${path(p)}`, {
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch: gh.branch,
      ...(sha ? { sha } : {}),
    }),
  )
  const commit = res?.commit?.sha
  if (typeof commit !== 'string') throw new Error('GitHub yazımı commit döndürmedi')
  return commit
}
