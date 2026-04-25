import { WizardoApiError } from "./errors.js"
import type {
  CreateDeployInput,
  CreateDeployResult,
  DeployFileSource,
  DeployOptions,
  DeployStatus,
  FinalizeDeployInput,
  FinalizeDeployResult,
  WhoamiResult,
  WizardoClientOptions,
} from "./types.js"

const DEFAULT_BASE_URL = "https://api.wizardo.dev"
const MAX_UPLOAD_RETRIES = 3
const RETRY_BASE_MS = 300

export class WizardoClient {
  private readonly token: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: WizardoClientOptions) {
    if (!opts.token) throw new Error("WizardoClient: token is required")
    this.token = opts.token
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  whoami(): Promise<WhoamiResult> {
    return this.json<WhoamiResult>("GET", "/v1/whoami")
  }

  createDeploy(input: CreateDeployInput): Promise<CreateDeployResult> {
    return this.json<CreateDeployResult>("POST", "/v1/deploys", input)
  }

  async uploadFile(deployId: string, file: DeployFileSource): Promise<void> {
    const url =
      `${this.baseUrl}/v1/deploys/${enc(deployId)}/upload` +
      `?path=${enc(file.path)}`

    let lastErr: unknown
    for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": file.contentType,
            "content-length": String(file.size),
          },
          body: file.body as BodyInit,
          ...({ duplex: "half" } as { duplex: "half" }),
        })
        if (res.ok) return
        const err = await toApiError(res)
        if (!isRetryable(res.status) || attempt === MAX_UPLOAD_RETRIES) throw err
        lastErr = err
      } catch (err) {
        if (err instanceof WizardoApiError && !isRetryable(err.status)) throw err
        lastErr = err
        if (attempt === MAX_UPLOAD_RETRIES) throw err
      }
      await sleep(RETRY_BASE_MS * 2 ** attempt)
    }
    throw lastErr
  }

  finalizeDeploy(input: FinalizeDeployInput): Promise<FinalizeDeployResult> {
    const { deployId, ...body } = input
    return this.json<FinalizeDeployResult>(
      "POST",
      `/v1/deploys/${enc(deployId)}/finalize`,
      body
    )
  }

  getDeploy(deployId: string): Promise<DeployStatus> {
    return this.json<DeployStatus>("GET", `/v1/deploys/${enc(deployId)}`)
  }

  /**
   * High-level deploy: create → parallel upload → finalize.
   *
   * ```ts
   * const result = await client.deploy({
   *   remoteName: '@myorg/dashboard',
   *   envName: 'production',
   *   dir: './dist',
   * })
   * ```
   */
  async deploy(opts: DeployOptions): Promise<FinalizeDeployResult> {
    const concurrency = Math.max(1, opts.concurrency ?? 8)
    const notify = opts.onProgress ?? (() => {})

    const sources = await collectSources(opts)
    if (sources.length === 0) throw new Error("deploy(): no files to upload")

    const created = await this.createDeploy({
      remoteName: opts.remoteName,
      envName: opts.envName,
      gitSha: opts.gitSha,
      gitBranch: opts.gitBranch,
      gitMessage: opts.gitMessage,
      ciProvider: opts.ciProvider,
    })
    notify({ kind: "create", deployId: created.deployId, buildId: created.buildId })

    let uploadedBytes = 0
    const totalBytes = sources.reduce((s, f) => s + f.size, 0)

    const queue = [...sources]
    const worker = async () => {
      for (;;) {
        const file = queue.shift()
        if (!file) return
        await this.uploadFile(created.deployId, file)
        uploadedBytes += file.size
        notify({
          kind: "upload",
          path: file.path,
          bytes: file.size,
          uploaded: uploadedBytes,
          total: totalBytes,
        })
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, sources.length) }, worker)
    )

    notify({ kind: "finalize", deployId: created.deployId })
    const result = await this.finalizeDeploy({
      deployId: created.deployId,
      envName: opts.envName,
      entryFile: opts.entryFile,
      files: sources.map((f) => ({ path: f.path, size: f.size, contentType: f.contentType })),
    })
    notify({ kind: "done", result })
    return result
  }

  private async json<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    }
    if (body !== undefined) headers["content-type"] = "application/json"
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw await toApiError(res)
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }
}

async function collectSources(opts: DeployOptions): Promise<DeployFileSource[]> {
  if (opts.files) {
    const out: DeployFileSource[] = []
    for await (const f of opts.files as AsyncIterable<DeployFileSource>) out.push(f)
    return out
  }
  if (opts.dir) return walkDir(opts.dir)
  throw new Error("deploy(): pass `dir` (Node) or `files` (any environment)")
}

async function walkDir(root: string): Promise<DeployFileSource[]> {
  const { readdir, stat, readFile } = await import("node:fs/promises")
  const { join, resolve } = await import("node:path")
  const out: DeployFileSource[] = []
  async function walk(abs: string, rel: string) {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(childAbs, childRel)
      else if (entry.isFile()) {
        const { size } = await stat(childAbs)
        const body = await readFile(childAbs)
        out.push({ path: childRel, contentType: guessContentType(entry.name), body, size })
      }
    }
  }
  await walk(resolve(root), "")
  return out
}

const CT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
}

function guessContentType(name: string): string {
  const i = name.lastIndexOf(".")
  return i < 0 ? "application/octet-stream" : (CT[name.slice(i).toLowerCase()] ?? "application/octet-stream")
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

async function toApiError(res: Response): Promise<WizardoApiError> {
  let code = "unknown", message = res.statusText
  try {
    const body = await res.json() as { error?: { code?: string; message?: string } }
    if (body.error?.code) code = body.error.code
    if (body.error?.message) message = body.error.message
  } catch { /* non-JSON body */ }
  return new WizardoApiError(res.status, code, message, res.headers.get("x-request-id") ?? undefined)
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
function enc(s: string) { return encodeURIComponent(s) }
