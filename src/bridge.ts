import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { patchPlaywrightBundle } from "../scripts/patch-playwright.mjs"
import { startProxy, type ProxyOptions, type StartedProxy } from "./proxy"

export type BridgeMode = "windows-owner" | "wsl-client"
export type BridgeState = "stopped" | "starting" | "ready" | "degraded" | "failed" | "stopping"
export type OwnerLifecycleAction = "start" | "stop" | "restart"

export type BridgeConfig = {
  configDir: string
  playwrightHost: string
  playwrightPort: number
  proxyHost: string
  proxyPort: number
  endpoint: URL
  proxyEndpoint: URL
  browserExecutable: string
  profileDirName: string
  extensionTokenFile: string
  proxyTokenFile: string
  ownerFile: string
  startupTimeoutMs: number
  startupPollMs: number
  shutdownTimeoutMs: number
}

export type BridgeStatus = {
  mode: BridgeMode
  state: BridgeState
  endpoint: URL
  proxyEndpoint?: URL
  proxyRunning: boolean
  pid?: number
  patchApplied: boolean
  extensionConnected: boolean
  reason?: string
}

export type SpawnedChild = {
  pid: number
  onExit(listener: (code: number | null) => void): void
}

export type BridgeDependencies = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  fileExists(path: string): boolean
  readText(path: string): string
  writeText(path: string, value: string): void
  resolve(name: string): string
  isPortOpen(host: string, port: number): Promise<boolean>
  spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): SpawnedChild
  gracefulKillTree?(pid: number): Promise<void>
  waitForExit?(pid: number, timeoutMs: number): Promise<boolean>
  killTree(pid: number): Promise<void>
  isProcessRunning?(pid: number): boolean
  sleep(ms: number): Promise<void>
  probeMcp(endpoint: URL, bearerToken?: string): Promise<{ mcp: boolean; extension: boolean }>
  now(): Date
  startProxy?(options: ProxyOptions): StartedProxy
  /** Request the Windows owner to perform a lifecycle operation from WSL. */
  requestOwnerLifecycle?(action: OwnerLifecycleAction): Promise<void>
}

type OwnerRecord = {
  ownerPid: number
  mcpPid: number
  startedAt: string
}

const DEFAULT_BROWSER_EXECUTABLE =
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function loopbackHost(value: string | undefined): string {
  if (value === "localhost" || value === "::1" || value === "[::1]") return value
  const octets = value?.split(".").map(Number)
  if (
    octets?.length === 4 &&
    octets[0] === 127 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  ) {
    return value!
  }
  return "127.0.0.1"
}

function configPath(configDir: string, value: string): string {
  return resolve(configDir, value)
}

function endpoint(host: string, port: number): URL {
  return new URL(`http://${host}:${port}/mcp`)
}

function playwrightArguments(config: BridgeConfig, mcpCli: string): string[] {
  return [
    mcpCli,
    "--extension",
    "--browser=chrome",
    `--executable-path=${config.browserExecutable}`,
    `--profile-dir-name=${config.profileDirName}`,
    `--host=${config.playwrightHost}`,
    `--port=${config.endpoint.port}`,
    "--shared-browser-context",
    "--codegen=none",
    "--image-responses=omit",
    "--console-level=warning",
    "--no-webmcp",
    "--idle-timeout=0",
  ]
}

function hasBackgroundTabPatch(source: string): boolean {
  const methodStart = source.indexOf("async createTarget(url3)")
  if (methodStart < 0) return false
  const method = source.slice(methodStart, methodStart + 2_000)
  return method.includes('"chrome.tabs.create"') && method.includes("active: false")
}

function wslGateway(dependencies: BridgeDependencies): string | undefined {
  try {
    for (const line of dependencies.readText("/proc/net/route").split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/)
      if (fields[1] !== "00000000") continue

      const gateway = fields[2]
      if (gateway === undefined || !/^[0-9a-fA-F]{8}$/.test(gateway)) continue

      const value = Number.parseInt(gateway, 16)
      const octets = [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24]
      if (octets.every((octet) => octet === 0)) continue
      return octets.join(".")
    }
  } catch {
    // Fall back to resolv.conf when the route table is unavailable.
  }

  try {
    return dependencies
      .readText("/etc/resolv.conf")
      .match(/^nameserver\s+(\S+)/m)?.[1]
  } catch {
    return undefined
  }
}

function isWsl(dependencies: BridgeDependencies): boolean {
  return (
    dependencies.platform === "linux" &&
    Boolean(dependencies.env.WSL_DISTRO_NAME || dependencies.env.WSL_INTEROP)
  )
}

function resolveConfig(
  dependencies: BridgeDependencies,
  overrides: Partial<BridgeConfig>,
): BridgeConfig {
  const env = dependencies.env
  const configDir = overrides.configDir ?? env.OPENCODE_CONFIG_DIR ?? process.cwd()
  const wsl = isWsl(dependencies)
  const windowsHost =
    env.OPENCODE_PLAYWRIGHT_WINDOWS_HOST ?? (wsl ? wslGateway(dependencies) : undefined) ?? "127.0.0.1"
  const playwrightHost = loopbackHost(overrides.playwrightHost ?? env.OPENCODE_PLAYWRIGHT_HOST)
  const playwrightPort = overrides.playwrightPort ?? integer(env.OPENCODE_PLAYWRIGHT_PORT, 8931)
  const proxyHost = overrides.proxyHost ?? env.OPENCODE_PLAYWRIGHT_PROXY_HOST ?? "0.0.0.0"
  const proxyPort = overrides.proxyPort ?? integer(env.OPENCODE_PLAYWRIGHT_PROXY_PORT, 8932)

  return {
    configDir,
    playwrightHost,
    playwrightPort,
    proxyHost,
    proxyPort,
    endpoint: overrides.endpoint ?? endpoint(wsl ? windowsHost : playwrightHost, playwrightPort),
    proxyEndpoint: overrides.proxyEndpoint ?? endpoint(windowsHost, proxyPort),
    browserExecutable:
      overrides.browserExecutable ?? env.OPENCODE_PLAYWRIGHT_EXECUTABLE_PATH ?? DEFAULT_BROWSER_EXECUTABLE,
    profileDirName: overrides.profileDirName ?? env.OPENCODE_PLAYWRIGHT_PROFILE_DIR_NAME ?? "Default",
    extensionTokenFile:
      configPath(
        configDir,
        overrides.extensionTokenFile ??
          env.OPENCODE_PLAYWRIGHT_EXTENSION_TOKEN_FILE ??
          join(".secrets", "playwright-key"),
      ),
    proxyTokenFile:
      configPath(
        configDir,
        overrides.proxyTokenFile ??
          env.OPENCODE_PLAYWRIGHT_PROXY_TOKEN_FILE ??
          join(".secrets", "playwright-mcp-proxy-key"),
      ),
    ownerFile: overrides.ownerFile ?? join(configDir, "playwright-mcp-owner.json"),
    startupTimeoutMs:
      overrides.startupTimeoutMs ?? integer(env.OPENCODE_PLAYWRIGHT_STARTUP_TIMEOUT_MS, 15_000),
    startupPollMs:
      overrides.startupPollMs ?? integer(env.OPENCODE_PLAYWRIGHT_STARTUP_POLL_MS, 100),
    shutdownTimeoutMs:
      overrides.shutdownTimeoutMs ?? integer(env.OPENCODE_PLAYWRIGHT_SHUTDOWN_TIMEOUT_MS, 5_000),
  }
}

function cloneStatus(status: BridgeStatus): BridgeStatus {
  return {
    ...status,
    endpoint: new URL(status.endpoint.href),
    proxyEndpoint: status.proxyEndpoint ? new URL(status.proxyEndpoint.href) : undefined,
    proxyRunning: status.proxyRunning,
  }
}

function readOwner(path: string): OwnerRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<OwnerRecord>
    if (
      typeof value.ownerPid === "number" &&
      typeof value.mcpPid === "number" &&
      typeof value.startedAt === "string"
    ) {
      return value as OwnerRecord
    }
  } catch {
    // A missing or malformed owner record proves no ownership.
  }
  return undefined
}

function ownerLockFailureReason(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined

  if (code === "EEXIST") return "Playwright owner lock is already held"
  if (code === "ENOENT") return "Playwright owner lock directory is unavailable"
  if (code === "EACCES" || code === "EPERM") return "Playwright owner lock access is denied"
  return "Playwright owner lock is unavailable"
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  )
}

export class PlaywrightBridge {
  private readonly config: BridgeConfig
  private current: BridgeStatus
  private childPid?: number
  private patchVerified = false
  private lifecycleGeneration = 0
  private ownerStartedAt?: string
  private proxy?: StartedProxy
  private childExitWaiter?: { pid: number; resolve: (exited: boolean) => void }

  constructor(
    private readonly dependencies: BridgeDependencies,
    config: Partial<BridgeConfig> = {},
  ) {
    this.config = resolveConfig(dependencies, config)
    this.current = this.makeStatus("stopped")
  }

  async start(): Promise<BridgeStatus> {
    const generation = ++this.lifecycleGeneration
    if (isWsl(this.dependencies)) return this.startWsl(generation)

    this.setStatus("starting")

    let portOpen: boolean
    try {
      portOpen = await this.dependencies.isPortOpen("127.0.0.1", Number(this.config.endpoint.port))
    } catch (error) {
      if (!this.isCurrent(generation)) return this.status()
      return this.setStatus("failed", "Playwright port check failed")
    }
    if (!this.isCurrent(generation)) return this.status()

    if (portOpen) {
      const owner = readOwner(this.config.ownerFile)
      if (
        this.childPid !== undefined &&
        this.ownerStartedAt !== undefined &&
        owner?.ownerPid === process.pid &&
        owner.mcpPid === this.childPid &&
        owner.startedAt === this.ownerStartedAt
      ) {
        return this.waitUntilReady(generation)
      }
      return this.setStatus("failed", "foreign-owned port is already listening")
    }

    this.patchVerified = false
    let resolvedMcpCli: string
    let extensionToken: string
    try {
      resolvedMcpCli = this.validateWindowsPrerequisites()
      const environmentToken = this.dependencies.env.OPENCODE_PLAYWRIGHT_EXTENSION_TOKEN
      if (environmentToken === undefined) {
        try {
          extensionToken = this.dependencies.readText(this.config.extensionTokenFile).trim()
        } catch {
          throw new Error("Playwright extension token file could not be read")
        }
      } else {
        extensionToken = environmentToken.trim()
      }
      if (extensionToken.length === 0) throw new Error("Playwright extension token is empty")
    } catch (error) {
      const safeReasons = [
        "Playwright MCP package could not be resolved",
        "Playwright MCP entrypoint is missing",
        "Playwright MCP entrypoint could not be checked",
        "Playwright core bundle could not be resolved",
        "Playwright core bundle is missing",
        "Playwright core bundle could not be checked",
        "Playwright core bundle could not be read",
        "Playwright core bundle could not be patched",
        "Playwright core bundle has an unsupported shape",
        "Playwright background-tab patch is missing",
        "Brave executable is missing",
        "Brave executable could not be checked",
        "Playwright extension token file is missing",
        "Playwright extension token file could not be checked",
        "Playwright extension token file could not be read",
        "Playwright proxy token file is missing",
        "Playwright proxy token file could not be checked",
        "Playwright extension token is empty",
      ]
      const reason = error instanceof Error && safeReasons.includes(error.message)
        ? error.message
        : "Playwright prerequisite check failed unexpectedly"
      return this.setStatus("failed", reason)
    }
    try {
      await this.acquireOwnerRecord()
    } catch (error) {
      return this.setStatus("failed", ownerLockFailureReason(error))
    }

    const args = playwrightArguments(this.config, resolvedMcpCli)

    try {
      const child = this.dependencies.spawn("node", args, {
        cwd: this.config.configDir,
        env: {
          ...this.dependencies.env,
          PLAYWRIGHT_MCP_EXTENSION_TOKEN: extensionToken,
        },
      })
      this.childPid = child.pid
      this.writeOwnerRecord(child.pid)
      child.onExit((code) => {
        if (this.childPid !== child.pid) return
        if (this.childExitWaiter?.pid === child.pid) {
          this.childExitWaiter.resolve(true)
          this.childExitWaiter = undefined
        }
        const wasStopping = this.current.state === "stopping"
        this.lifecycleGeneration++
        this.stopProxy()
        this.childPid = undefined
        this.removeOwnerRecord()
        if (wasStopping) {
          this.patchVerified = false
          this.setStatus("stopped")
        } else {
          this.setStatus("failed", `Playwright MCP child exited (code ${code ?? "unknown"})`)
        }
      })
    } catch (error) {
      return this.failStartup(generation, "Playwright MCP process could not start")
    }

    return this.waitUntilReady(generation)
  }

  async stop(): Promise<void> {
    if (isWsl(this.dependencies)) {
      if (this.dependencies.requestOwnerLifecycle !== undefined) {
        await this.dependencies.requestOwnerLifecycle("stop")
      }
      this.setStatus("stopped")
      return
    }
    ++this.lifecycleGeneration
    const pid = this.childPid
    this.setStatus("stopping")

    let failure: unknown
    try {
      this.stopProxy()
    } catch {
      failure = new Error("Playwright proxy shutdown failed")
    }
    try {
      if (pid !== undefined) await this.terminateOwnedChild(pid)
    } catch (error) {
      if (failure === undefined) failure = error
    }

    if (pid === undefined || this.childPid !== pid) {
      if (this.childPid === pid) this.childPid = undefined
      this.removeOwnerRecord()
      this.patchVerified = false
      this.setStatus("stopped")
    }
    if (failure !== undefined) throw failure
  }

  async restart(): Promise<BridgeStatus> {
    const generation = ++this.lifecycleGeneration
    if (isWsl(this.dependencies)) return this.startWsl(generation, "restart")

    // A failed/stopped bridge normally has no owned child left to stop.  Start
    // directly in that case so restart remains a recovery operation.  When a
    // child is still tracked, retain the strict stop-then-start ownership
    // boundary, but do not let a stop failure remove the start fallback.
    if (this.childPid === undefined) return this.start()

    try {
      await this.stop()
    } catch {
      return this.start()
    }
    return this.start()
  }

  status(): BridgeStatus {
    return cloneStatus(this.current)
  }

  private async startWsl(
    generation: number,
    action: OwnerLifecycleAction = "start",
  ): Promise<BridgeStatus> {
    this.setStatus("starting")

    if (this.dependencies.requestOwnerLifecycle !== undefined) {
      try {
        await this.dependencies.requestOwnerLifecycle(action)
      } catch {
        if (!this.isCurrent(generation)) return this.status()
        return this.setStatus("failed", "Windows Playwright owner request failed")
      }
    }

    let bearerToken: string
    try {
      bearerToken = this.dependencies.readText(this.config.proxyTokenFile).trim()
      if (bearerToken.length === 0) throw new Error("Playwright proxy token is empty")
    } catch {
      return this.setStatus("failed", "Windows Playwright proxy probe failed")
    }

    const result = await this.probeBeforeDeadline(
      this.config.proxyEndpoint,
      this.config.startupTimeoutMs,
      bearerToken,
    )
    if (!this.isCurrent(generation)) return this.status()
    if (result.kind === "probe" && result.value.mcp && result.value.extension) {
      return this.setStatus("ready", undefined, true)
    }
    if (result.kind === "error") {
      return this.setStatus("failed", "Windows Playwright proxy probe failed")
    }
    return this.setStatus("failed", "Windows Playwright proxy is not ready")
  }

  private validateWindowsPrerequisites(): string {
    let packagePath: string
    try {
      packagePath = this.dependencies.resolve("@playwright/mcp/package.json")
    } catch {
      throw new Error("Playwright MCP package could not be resolved")
    }
    const resolvedMcpCli = join(dirname(packagePath), "cli.js")
    let cliExists: boolean
    try {
      cliExists = this.dependencies.fileExists(resolvedMcpCli)
    } catch {
      throw new Error("Playwright MCP entrypoint could not be checked")
    }
    if (!cliExists) {
      throw new Error("Playwright MCP entrypoint is missing")
    }

    let coreBundle: string
    try {
      coreBundle = this.dependencies.resolve("playwright-core/lib/coreBundle")
    } catch {
      throw new Error("Playwright core bundle could not be resolved")
    }
    let coreBundleExists: boolean
    try {
      coreBundleExists = this.dependencies.fileExists(coreBundle)
    } catch {
      throw new Error("Playwright core bundle could not be checked")
    }
    if (!coreBundleExists) {
      throw new Error("Playwright core bundle is missing")
    }
    let coreBundleText: string
    try {
      coreBundleText = this.dependencies.readText(coreBundle)
    } catch {
      throw new Error("Playwright core bundle could not be read")
    }
    let patchedBundleText: string
    if (hasBackgroundTabPatch(coreBundleText)) {
      patchedBundleText = coreBundleText
    } else {
      try {
        patchedBundleText = patchPlaywrightBundle(coreBundleText)
      } catch {
        throw new Error("Playwright core bundle has an unsupported shape")
      }
      if (patchedBundleText !== coreBundleText) {
        try {
          this.dependencies.writeText(coreBundle, patchedBundleText)
        } catch {
          throw new Error("Playwright core bundle could not be patched")
        }
      }
    }
    if (!hasBackgroundTabPatch(patchedBundleText)) {
      throw new Error("Playwright background-tab patch is missing")
    }
    this.patchVerified = true

    let browserExists: boolean
    try {
      browserExists = this.dependencies.fileExists(this.config.browserExecutable)
    } catch {
      throw new Error("Brave executable could not be checked")
    }
    if (!browserExists) {
      throw new Error("Brave executable is missing")
    }
    if (this.dependencies.env.OPENCODE_PLAYWRIGHT_EXTENSION_TOKEN === undefined) {
      let extensionTokenExists: boolean
      try {
        extensionTokenExists = this.dependencies.fileExists(this.config.extensionTokenFile)
      } catch {
        throw new Error("Playwright extension token file could not be checked")
      }
      if (!extensionTokenExists) throw new Error("Playwright extension token file is missing")
    }
    let proxyTokenExists: boolean
    try {
      proxyTokenExists = this.dependencies.fileExists(this.config.proxyTokenFile)
    } catch {
      throw new Error("Playwright proxy token file could not be checked")
    }
    if (!proxyTokenExists) {
      throw new Error("Playwright proxy token file is missing")
    }

    return resolvedMcpCli
  }

  private async acquireOwnerRecord(): Promise<void> {
    let descriptor: number | undefined
    const startedAt = this.dependencies.now().toISOString()
    try {
      descriptor = openSync(this.config.ownerFile, "wx")
      writeFileSync(
        descriptor,
        JSON.stringify({
          ownerPid: process.pid,
          mcpPid: 0,
          startedAt,
        } satisfies OwnerRecord),
        "utf8",
      )
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
          descriptor = undefined
          rmSync(this.config.ownerFile, { force: true })
        } catch {
          // The caller receives the acquisition failure below.
        }
      }
      if (isFileExistsError(error)) {
        const owner = readOwner(this.config.ownerFile)
        if (owner !== undefined && await this.isStaleOwner(owner)) {
          try {
            rmSync(this.config.ownerFile, { force: true })
          } catch {
            // A concurrent owner may have replaced the stale record.
          }
          return this.acquireOwnerRecord()
        }
      }
      throw error
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
    this.ownerStartedAt = startedAt
  }

  private async isStaleOwner(owner: OwnerRecord): Promise<boolean> {
    const isRunning = (pid: number): boolean => {
      if (pid <= 0) return false
      if (this.dependencies.isProcessRunning !== undefined) {
        return this.dependencies.isProcessRunning(pid)
      }
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return code === "EPERM"
      }
    }

    if (isRunning(owner.ownerPid) || isRunning(owner.mcpPid)) return false

    const [playwrightPortOpen, proxyPortOpen] = await Promise.all([
      this.dependencies.isPortOpen("127.0.0.1", this.config.playwrightPort),
      this.dependencies.isPortOpen("127.0.0.1", this.config.proxyPort),
    ])
    return !playwrightPortOpen && !proxyPortOpen
  }

  private writeOwnerRecord(mcpPid: number): void {
    writeFileSync(
      this.config.ownerFile,
      JSON.stringify({
        ownerPid: process.pid,
        mcpPid,
        startedAt: this.ownerStartedAt!,
      } satisfies OwnerRecord),
      "utf8",
    )
  }

  private async waitUntilReady(generation: number): Promise<BridgeStatus> {
    const startedAt = this.dependencies.now().getTime()
    const maxAttempts = Math.max(1, Math.ceil(this.config.startupTimeoutMs / this.config.startupPollMs))

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!this.isCurrent(generation)) return this.status()
      const elapsedByClock = Math.max(0, this.dependencies.now().getTime() - startedAt)
      const elapsedByAttempts = attempt * this.config.startupPollMs
      const remaining = this.config.startupTimeoutMs - Math.max(elapsedByClock, elapsedByAttempts)
      if (remaining <= 0) break

      const result = await this.probeBeforeDeadline(this.config.endpoint, remaining)
      if (!this.isCurrent(generation)) return this.status()
      if (result.kind === "probe" && result.value.mcp) {
        try {
          this.ensureProxyStarted()
        } catch (error) {
          const reason = error instanceof Error && error.message === "No WSL NAT client subnets could be detected"
            ? error.message
            : "Playwright proxy could not start"
          return this.failStartup(generation, reason)
        }
        if (result.value.extension) return this.setStatus("ready", undefined, true)
        return this.setStatus("degraded", "Brave extension is not connected", false)
      }
      if (result.kind === "timeout") break

      if (this.dependencies.now().getTime() - startedAt >= this.config.startupTimeoutMs) break
      await this.dependencies.sleep(this.config.startupPollMs)
      if (!this.isCurrent(generation)) return this.status()
    }

    return this.failStartup(generation, "Playwright MCP startup timed out")
  }

  private async failStartup(generation: number, reason: string): Promise<BridgeStatus> {
    if (!this.isCurrent(generation)) return this.status()
    this.stopProxy()
    const pid = this.childPid
    if (pid !== undefined) {
      try {
        await this.dependencies.killTree(pid)
      } catch {
        if (!this.isCurrent(generation)) return this.status()
        return this.setStatus("failed", reason)
      }
      if (!this.isCurrent(generation)) return this.status()
      if (this.childPid === pid) this.childPid = undefined
    }
    this.removeOwnerRecord()
    return this.setStatus("failed", reason)
  }

  private probeBeforeDeadline(
    endpoint: URL,
    timeoutMs: number,
    bearerToken?: string,
  ): Promise<
    | { kind: "probe"; value: { mcp: boolean; extension: boolean } }
    | { kind: "error" }
    | { kind: "timeout" }
  > {
    return new Promise((resolve) => {
      let settled = false
      const finish = (
        result:
          | { kind: "probe"; value: { mcp: boolean; extension: boolean } }
          | { kind: "error" }
          | { kind: "timeout" },
      ) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs)

      const probe =
        bearerToken === undefined
          ? this.dependencies.probeMcp(endpoint)
          : this.dependencies.probeMcp(endpoint, bearerToken)
      probe.then(
        (value) => finish({ kind: "probe", value }),
        () => finish({ kind: "error" }),
      )
    })
  }

  private removeOwnerRecord(): void {
    const startedAt = this.ownerStartedAt
    if (startedAt === undefined) return
    const owner = readOwner(this.config.ownerFile)
    if (owner?.ownerPid === process.pid && owner.startedAt === startedAt) {
      try {
        rmSync(this.config.ownerFile, { force: true })
      } catch {
        return
      }
    }
    this.ownerStartedAt = undefined
  }

  private ensureProxyStarted(): void {
    if (this.proxy !== undefined) return
    const bearerToken = this.dependencies.readText(this.config.proxyTokenFile).trim()
    if (bearerToken.length === 0) throw new Error("Playwright proxy token is empty")

    const launchProxy = this.dependencies.startProxy ?? startProxy
    this.proxy = launchProxy({
      hostname: this.config.proxyHost,
      port: Number(this.config.proxyEndpoint.port),
      targetOrigin: new URL(this.config.endpoint.href),
      bearerToken,
    })
  }

  private stopProxy(): void {
    const proxy = this.proxy
    if (proxy === undefined) return
    try {
      proxy.stop(true)
    } finally {
      if (this.proxy === proxy) this.proxy = undefined
    }
  }

  private async terminateOwnedChild(pid: number): Promise<void> {
    if (this.childPid !== pid) return

    const gracefulKillTree = this.dependencies.gracefulKillTree
    if (gracefulKillTree === undefined) {
      await this.dependencies.killTree(pid)
      if (this.childPid === pid) this.childPid = undefined
      this.removeOwnerRecord()
      this.patchVerified = false
      return
    }

    let gracefulFailure: unknown
    try {
      await gracefulKillTree(pid)
    } catch {
      gracefulFailure = new Error("Playwright graceful shutdown failed")
    }

    let waitFailure: unknown
    if (this.childPid === pid && gracefulFailure === undefined) {
      try {
        if (await this.waitForChildExit(pid, this.config.shutdownTimeoutMs)) {
          this.childPid = undefined
        }
      } catch {
        waitFailure = new Error("Playwright shutdown wait failed")
      }
    }

    let forceFailure: unknown
    if (this.childPid === pid) {
      try {
        await this.dependencies.killTree(pid)
      } catch {
        forceFailure = new Error("Playwright forced shutdown failed")
      }
    }

    if (this.childPid === pid && forceFailure === undefined) this.childPid = undefined
    if (this.childPid !== pid) {
      this.removeOwnerRecord()
      this.patchVerified = false
    }
    if (forceFailure !== undefined) throw forceFailure
    if (gracefulFailure !== undefined) throw gracefulFailure
    if (waitFailure !== undefined) throw waitFailure
  }

  private async waitForChildExit(pid: number, timeoutMs: number): Promise<boolean> {
    if (this.childPid !== pid) return true

    let resolveObserved!: (exited: boolean) => void
    const observed = new Promise<boolean>((resolve) => {
      resolveObserved = resolve
    })
    this.childExitWaiter = { pid, resolve: resolveObserved }
    const deadline = this.dependencies.waitForExit
      ? this.dependencies.waitForExit(pid, timeoutMs)
      : new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
    try {
      return await Promise.race([observed, deadline])
    } finally {
      if (this.childExitWaiter?.pid === pid) this.childExitWaiter = undefined
    }
  }

  private isCurrent(generation: number): boolean {
    return this.lifecycleGeneration === generation
  }

  private makeStatus(
    state: BridgeState,
    reason?: string,
    extensionConnected = false,
  ): BridgeStatus {
    return {
      mode: isWsl(this.dependencies) ? "wsl-client" : "windows-owner",
      state,
      endpoint: new URL(this.config.endpoint.href),
      proxyEndpoint: new URL(this.config.proxyEndpoint.href),
      proxyRunning: this.proxy !== undefined || (isWsl(this.dependencies) && state === "ready"),
      pid: this.childPid,
      patchApplied: this.patchVerified,
      extensionConnected,
      reason,
    }
  }

  private setStatus(
    state: BridgeState,
    reason?: string,
    extensionConnected = false,
  ): BridgeStatus {
    this.current = this.makeStatus(state, reason, extensionConnected)
    return this.status()
  }

}
