// Wire types — in sync with apps/api route shapes.

export type WizardoClientOptions = {
  /** Bearer token (Clerk M2M JWT). Required. */
  token: string
  /** Override the API base URL. Default: https://api.wizardo.dev */
  baseUrl?: string
  /** Pluggable fetch implementation (Node 18+ has global fetch built-in). */
  fetch?: typeof globalThis.fetch
}

export type CreateDeployInput = {
  remoteName: string
  envName: string
  gitSha?: string
  gitBranch?: string
  gitMessage?: string
  ciProvider?: string
}

export type CreateDeployResult = {
  deployId: string
  buildId: string
  r2Prefix: string
}

export type DeployFile = {
  path: string
  size: number
  contentType: string
}

export type FinalizeDeployInput = {
  deployId: string
  envName: string
  entryFile?: string
  files?: DeployFile[]
}

export type FinalizeDeployResult = {
  deployId: string
  buildId: string
  releaseId: string
  envId: string
  envName: string
}

export type DeployStatus = {
  deployId: string
  buildId: string
  status: "pending" | "running" | "uploading" | "succeeded" | "failed" | "canceled"
  remoteName: string
  projectId: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  commitSha: string | null
  error: string | null
}

export type WhoamiResult = {
  tokenId: string
  orgId: string
  projectId: string
  scope: string[]
}

// ---- High-level deploy() types ----

export type DeployFileSource = {
  path: string
  contentType: string
  body: ReadableStream | ArrayBuffer | Uint8Array | Blob
  size: number
}

export type DeployOptions = {
  remoteName: string
  envName: string
  /**
   * Explicit file list — use this in browsers or when you've already
   * walked the filesystem yourself. In Node, pass `dir` instead.
   */
  files?: AsyncIterable<DeployFileSource> | Iterable<DeployFileSource>
  /**
   * Local directory to upload (Node only). The SDK walks it recursively
   * and infers Content-Types.
   */
  dir?: string
  entryFile?: string
  gitSha?: string
  gitBranch?: string
  gitMessage?: string
  ciProvider?: string
  /** Max simultaneous uploads. Default: 8 */
  concurrency?: number
  onProgress?: (event: DeployProgress) => void
}

export type DeployProgress =
  | { kind: "create"; deployId: string; buildId: string }
  | { kind: "upload"; path: string; bytes: number; uploaded: number; total: number }
  | { kind: "finalize"; deployId: string }
  | { kind: "done"; result: FinalizeDeployResult }
