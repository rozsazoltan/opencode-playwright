import { Plugin } from "@opencode/plugin"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import {
  PlaywrightBridge,
  type BridgeConfig,
  type BridgeDependencies,
  type BridgeStatus,
  type OwnerLifecycleAction,
} from "./bridge"

const unsafeTools = [
  "playwright_browser_tabs",
  "playwright_browser_run_code_unsafe",
] as const

let sharedBridge: PlaywrightBridge | undefined
let sharedProxyToken: string | undefined
const inFlightStarts = new WeakMap<PlaywrightBridge, Promise<BridgeStatus>>()
const bridgeReferences = new WeakMap<PlaywrightBridge, { count: number }>()
const loggedStartupFailures = new WeakMap<PlaywrightBridge, string>()
const loggedSetupErrors = new WeakSet<object>()

type PluginContext = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]
type PluginOptions = Readonly<Record<string, unknown>>

type OwnerLifecycleRequester = (action: OwnerLifecycleAction) => Promise<void>
type DiagnosticLogger = (message: string) => void

export function diagnosticLogPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return join(env.XDG_DATA_HOME || join(homeDirectory, ".local", "share"), "opencode", "log", "opencode-playwright-bridge.log")
}

export function createDiagnosticLogger(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): DiagnosticLogger {
  const path = diagnosticLogPath(env, homeDirectory)
  return (message) => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `[${new Date().toISOString()}] ${redacted(message)}\n`, "utf8")
    } catch {
      // Diagnostics must never prevent plugin startup.
    }
  }
}

function diagnosticError(error: unknown): string {
  return error instanceof Error ? "unexpected error" : "unknown error"
}

function requestWindowsOwnerLifecycle(
  action: OwnerLifecycleAction,
  env: NodeJS.ProcessEnv,
  configDir: string,
): void {
  const serviceUrl = env.OPENCODE_PLAYWRIGHT_WINDOWS_SERVICE_URL ?? "http://127.0.0.1:49374"
  let password = env.OPENCODE_SERVER_PASSWORD
  if (password === undefined) {
    try {
      const service = JSON.parse(readFileSync(join(configDir, "service.json"), "utf8")) as { password?: unknown }
      if (typeof service.password === "string") password = service.password
    } catch {
      // The service may be configured without authentication.
    }
  }
  const escapedPassword = (password ?? "").replace(/'/g, "''")
  const script = [
    `$base = '${serviceUrl.replace(/'/g, "''")}'`,
    `$password = '${escapedPassword}'`,
    "$headers = if ($password.Length -gt 0) { @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('opencode:' + $password)) } } else { @{} }",
    "$active = Invoke-RestMethod -Method Get -Uri ($base + '/api/session/active') -Headers $headers",
    "$sessionProperty = if ($null -ne $active.data) { $active.data.PSObject.Properties | Select-Object -First 1 } else { $null }",
    "$sessionId = if ($null -ne $sessionProperty) { $sessionProperty.Name } elseif ($null -ne $active.id) { $active.id } else { $null }",
    "if ([string]::IsNullOrEmpty($sessionId)) { throw 'No active Windows OpenCode session' }",
    `$body = @{ name = 'playwright-${action}'; text = '' } | ConvertTo-Json -Compress`,
    "Invoke-RestMethod -Method Post -Uri ($base + '/api/session/' + $sessionId + '/command') -Headers $headers -ContentType 'application/json' -Body $body | Out-Null",
  ].join("; ")
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    windowsHide: true,
    stdio: "ignore",
  })
  if (result.status !== 0) throw new Error("Windows Playwright owner request failed")
}

export function configDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
  fileExists: (path: string) => boolean = existsSync,
): string {
  const configuredDirectory = env.OPENCODE_CONFIG_DIR
  if (
    configuredDirectory !== undefined &&
    configuredDirectory.length > 0 &&
    (fileExists(join(configuredDirectory, "opencode.json")) ||
      fileExists(join(configuredDirectory, "opencode.jsonc")) ||
      fileExists(join(configuredDirectory, "cli.json")))
  ) {
    return configuredDirectory
  }
  return join(homeDirectory, ".config", "opencode")
}

function optionString(options: PluginOptions, name: string): string | undefined {
  const value = options[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionInteger(
  options: PluginOptions,
  name: string,
  fallback: string | undefined,
  defaultValue: number,
): number {
  const value = options[name] ?? fallback
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""))
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue
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

function resolvedSecretPath(configDir: string, value: string): string {
  return isAbsolute(value) ? value : join(configDir, value)
}

export function bridgeConfigFromOptions(
  options: PluginOptions,
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Partial<BridgeConfig> {
  const extensionTokenFile =
    optionString(options, "extensionTokenFile") ??
    env.OPENCODE_PLAYWRIGHT_EXTENSION_TOKEN_FILE ??
    ".secrets/playwright-key"
  const proxyTokenFile =
    optionString(options, "proxyTokenFile") ??
    env.OPENCODE_PLAYWRIGHT_PROXY_TOKEN_FILE ??
    ".secrets/playwright-mcp-proxy-key"
  const autoGenerateProxyToken =
    optionString(options, "proxyTokenFile") === undefined &&
    env.OPENCODE_PLAYWRIGHT_PROXY_TOKEN_FILE === undefined

  return {
    configDir,
    playwrightHost: loopbackHost(
      optionString(options, "playwrightHost") ?? env.OPENCODE_PLAYWRIGHT_HOST ?? "localhost",
    ),
    playwrightPort: optionInteger(options, "playwrightPort", env.OPENCODE_PLAYWRIGHT_PORT, 8931),
    proxyHost:
      optionString(options, "proxyHost") ?? env.OPENCODE_PLAYWRIGHT_PROXY_HOST ?? "0.0.0.0",
    proxyPort: optionInteger(options, "proxyPort", env.OPENCODE_PLAYWRIGHT_PROXY_PORT, 8932),
    browserExecutable:
      optionString(options, "browserExecutable") ??
      env.OPENCODE_PLAYWRIGHT_EXECUTABLE_PATH ??
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    profileDirName:
      optionString(options, "profileDirName") ?? env.OPENCODE_PLAYWRIGHT_PROFILE_DIR_NAME ?? "Default",
    extensionTokenFile: resolvedSecretPath(configDir, extensionTokenFile),
    proxyTokenFile: resolvedSecretPath(configDir, proxyTokenFile),
    autoGenerateProxyToken,
    startupTimeoutMs: optionInteger(
      options,
      "startupTimeoutMs",
      env.OPENCODE_PLAYWRIGHT_STARTUP_TIMEOUT_MS,
      15_000,
    ),
    shutdownTimeoutMs: optionInteger(
      options,
      "shutdownTimeoutMs",
      env.OPENCODE_PLAYWRIGHT_SHUTDOWN_TIMEOUT_MS,
      5_000,
    ),
  }
}

export function proxyTokenReference(
  options: PluginOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value =
    optionString(options, "proxyTokenFile") ??
    env.OPENCODE_PLAYWRIGHT_PROXY_TOKEN_FILE ??
    ".secrets/playwright-mcp-proxy-key"
  if (isAbsolute(value)) return value
  const relative = value.startsWith("./") || value.startsWith(".\\") ? value.slice(2) : value
  return `./${relative.replaceAll("\\", "/")}`
}

export function resolveNodeExecutable(
  result: Readonly<{ status: number | null; stdout?: string | null }>,
): string {
  if (result.status !== 0) return "node"
  const executable = result.stdout?.trim()
  return executable && executable.length > 0 ? executable : "node"
}

const MCP_PROBE_TIMEOUT_MS = 1_000
const MCP_PROTOCOL_VERSION = "2025-03-26"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function initializeProtocolVersion(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (value.jsonrpc !== "2.0" || value.id !== 1 || !isRecord(value.result)) return undefined
  return typeof value.result.protocolVersion === "string" ? value.result.protocolVersion : undefined
}

async function readMcpResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (contentType.includes("application/json") || response.body === null) {
    return response.json()
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      const eventEnd = buffer.search(/\r?\n\r?\n/)
      if (eventEnd >= 0) {
        const event = buffer.slice(0, eventEnd)
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("\n")
        if (data.length > 0) return JSON.parse(data)
        buffer = buffer.slice(eventEnd + (buffer[eventEnd] === "\r" ? 4 : 2))
      }
      if (chunk.done) return undefined
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export async function probeMcp(
  endpoint: URL,
  bearerToken?: string,
): Promise<{ mcp: boolean; extension: boolean }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MCP_PROBE_TIMEOUT_MS)
  const authorization = bearerToken === undefined ? {} : { Authorization: `Bearer ${bearerToken}` }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...authorization,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "opencode-playwright-probe", version: "1.0.0" },
        },
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { mcp: false, extension: false }
    }

    const payload = await readMcpResponse(response)
    const protocolVersion = initializeProtocolVersion(payload)
    if (protocolVersion === undefined) {
      return { mcp: false, extension: false }
    }

    const sessionId = response.headers.get("mcp-session-id")
    if (sessionId !== null && sessionId.length > 0) {
      const initialized = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Mcp-Protocol-Version": protocolVersion,
          "Mcp-Session-Id": sessionId,
          ...authorization,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
        signal: controller.signal,
      })
      await initialized.body?.cancel().catch(() => undefined)
      if (!initialized.ok) return { mcp: false, extension: false }
    }

    return { mcp: true, extension: true }
  } catch {
    return { mcp: false, extension: false }
  } finally {
    clearTimeout(timeout)
  }
}

export function createBridge(options: PluginOptions = {}): PlaywrightBridge {
  const env = process.env
  const configDir = configDirectory(env)
  const resolver = createRequire(import.meta.url)
  const nodeExecutable = (() => {
    try {
      return resolveNodeExecutable(
        spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8", windowsHide: true }),
      )
    } catch {
      return "node"
    }
  })()
  const portOpen = async (host: string, port: number): Promise<boolean> => {
    const probe = async (address: string): Promise<boolean> => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 500)
      const formattedAddress = address.includes(":") ? `[${address}]` : address
      try {
        const response = await fetch(`http://${formattedAddress}:${port}`, {
          method: "HEAD",
          signal: controller.signal,
        })
        return response.status > 0
      } catch {
        return false
      } finally {
        clearTimeout(timeout)
      }
    }

    if (await probe(host)) return true
    // Windows can bind the MCP server to IPv6 loopback only, while the bridge
    // ownership check intentionally starts with its IPv4 loopback address.
    if (host === "127.0.0.1" || host === "localhost") return probe("::1")
    return false
  }

  const dependencies: BridgeDependencies = {
    platform: process.platform,
    env,
    fileExists: (path) => existsSync(path),
    readText: (path) => readFileSync(path, "utf8"),
    writeText: (path, value) => writeFileSync(path, value, "utf8"),
    resolve: (name) => resolver.resolve(name),
    isPortOpen: portOpen,
    spawn: (_command, args, options) => {
      const child = spawn(nodeExecutable, args, {
        ...options,
        windowsHide: true,
        stdio: "ignore",
      })
      if (child.pid === undefined) throw new Error("Playwright child did not receive a PID")
      return {
        pid: child.pid,
        onExit: (listener) => child.once("exit", (code) => listener(code)),
      }
    },
    gracefulKillTree: async (pid) => {
      if (process.platform === "win32") {
        const result = spawnSync("taskkill", ["/PID", String(pid), "/T"], {
          windowsHide: true,
          stdio: "ignore",
        })
        if (result.status !== 0) throw new Error("graceful process termination failed")
        return
      }
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // The child may have exited between status and cleanup.
      }
    },
    waitForExit: async (_pid, timeoutMs) => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs))
      return false
    },
    killTree: async (pid) => {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        })
        return
      }
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // The child may have exited between status and cleanup.
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    probeMcp,
    requestOwnerLifecycle:
      typeof options.ownerLifecycleRequest === "function"
        ? (options.ownerLifecycleRequest as OwnerLifecycleRequester)
        : process.platform !== "win32"
          ? (action) => Promise.resolve().then(() => requestWindowsOwnerLifecycle(action, env, configDir))
        : undefined,
    now: () => new Date(),
  }

  return new PlaywrightBridge(dependencies, bridgeConfigFromOptions(options, configDir, env))
}

function registration(status: BridgeStatus, proxyToken?: string): Record<string, unknown> {
  const config: Record<string, unknown> = {
    type: "remote",
    url: status.endpoint.href,
    oauth: false,
    disabled: false,
  }
  if (status.mode === "wsl-client") {
    config.url = status.proxyEndpoint?.href ?? status.endpoint.href
    if (proxyToken !== undefined) config.headers = { Authorization: `Bearer ${proxyToken}` }
  }
  return config
}

function redacted(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(token|secret|authorization)[=:][^\s]+/gi, "$1=[redacted]")
}

function statusText(status: BridgeStatus): string {
  return [
    "Playwright bridge",
    `Platform: ${status.mode === "wsl-client" ? "WSL" : "Windows"}`,
    `Mode: ${status.mode}`,
    `State: ${status.state}`,
    `Endpoint: ${status.endpoint.href}`,
    `PID: ${status.pid ?? "none"}`,
    `Patch applied: ${status.patchApplied ? "yes" : "no"}`,
    `Proxy: ${status.proxyEndpoint?.href ?? "none"}`,
    `Proxy state: ${status.proxyRunning ? "running" : "stopped"}`,
    `Extension: ${status.extensionConnected ? "connected" : "not connected"}`,
    `Reason: ${status.reason ? redacted(status.reason) : "none"}`,
  ].join("\n")
}

type SetupDetails = {
  configDir: string
  extensionTokenFile: string
  proxyTokenFile: string
  customProxyTokenPath: boolean
  logPath: string
}

export function playwrightInstructions(status: BridgeStatus, details: SetupDetails): string {
  const lines = [
    "Playwright setup and next steps",
    `Current state: ${status.mode} / ${status.state}`,
    `Reason: ${status.reason ? redacted(status.reason) : "none"}`,
    status.mode === "wsl-client"
      ? "The extension key belongs on Windows, not in WSL."
      : `Windows extension key: ${details.extensionTokenFile}`,
    "Alternatively, set OPENCODE_PLAYWRIGHT_EXTENSION_TOKEN on the Windows OpenCode service and restart it.",
  ]
  if (status.mode === "wsl-client") {
    lines.push(
      `Proxy key file: ${details.proxyTokenFile}`,
      details.customProxyTokenPath
        ? "A custom proxy token file is configured; ensure the same key is securely available at the configured path on Windows and WSL."
        : "Start OpenCode on Windows once; it automatically creates the default playwright-mcp-proxy-key if missing.",
      "Copy the Windows proxy key securely into the WSL OpenCode config, then restart WSL OpenCode.",
    )
    if (!details.customProxyTokenPath) {
      lines.push(
        'WIN_USER="$(cmd.exe /c echo %USERNAME% | tr -d \'\\r\')"',
        'install -D -m 600 "/mnt/c/Users/$WIN_USER/.config/opencode/.secrets/playwright-mcp-proxy-key" "$HOME/.config/opencode/.secrets/playwright-mcp-proxy-key"',
        "Adjust the source/destination paths if either OpenCode config directory is customized.",
      )
    }
  } else {
    lines.push(
      details.customProxyTokenPath
        ? `A custom proxy token file is configured (${details.proxyTokenFile}); it must already exist and is never auto-generated.`
        : `Windows automatically creates the default proxy key if missing: ${details.proxyTokenFile}`,
      "For WSL, securely copy the Windows-generated proxy key to WSL and restart WSL OpenCode.",
    )
  }
  lines.push(`Diagnostics log (errors only): ${details.logPath}`)
  return lines.join("\n")
}

function needsOwnerStartupRetry(status: BridgeStatus): boolean {
  return (
    status.mode === "windows-owner" &&
    (status.reason === "Playwright owner lock is already held" ||
      status.reason === "Playwright owner lock is unavailable")
  )
}

async function emitStatus(ctx: PluginContext, sessionID: string, status: BridgeStatus): Promise<void> {
  await ctx.session.prompt({ sessionID, text: statusText(status), resume: false })
}

async function startBridge(bridge: PlaywrightBridge): Promise<BridgeStatus> {
  const running = inFlightStarts.get(bridge)
  if (running !== undefined) return running

  const starting = bridge.start()
  inFlightStarts.set(bridge, starting)
  try {
    return await starting
  } finally {
    if (inFlightStarts.get(bridge) === starting) inFlightStarts.delete(bridge)
  }
}

function retainBridge(bridge: PlaywrightBridge): () => Promise<void> {
  const current = bridgeReferences.get(bridge)
  if (current === undefined) {
    bridgeReferences.set(bridge, { count: 1 })
  } else {
    current.count++
  }

  let released = false
  return async () => {
    if (released) return
    released = true

    const references = bridgeReferences.get(bridge)
    if (references === undefined) return
    references.count--
    if (references.count > 0) return
    bridgeReferences.delete(bridge)
    await bridge.detach()
  }
}

export async function installBridge(
  ctx: Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0],
  bridge: PlaywrightBridge,
  proxyToken?: string,
  diagnostic?: DiagnosticLogger,
  setupDetails?: SetupDetails,
): Promise<() => Promise<void>> {
  const releaseBridge = retainBridge(bridge)
  let desiredStatus: BridgeStatus | undefined
  let mcpRegistration: Awaited<ReturnType<PluginContext["mcp"]["transform"]>> | undefined
  let mcpOperation = Promise.resolve()
  let toolRegistration: Awaited<ReturnType<PluginContext["tool"]["transform"]>> | undefined
  let commandRegistration: Awaited<ReturnType<PluginContext["command"]["transform"]>> | undefined
  let retryTimer: ReturnType<typeof setInterval> | undefined
  let retryAttempts = 0
  let retryLimit: number | undefined
  let cleaned = false
  const instructionDetails = setupDetails ?? (() => {
    const configDir = configDirectory()
    const config = bridgeConfigFromOptions({}, configDir)
    return {
      configDir,
      extensionTokenFile: config.extensionTokenFile!,
      proxyTokenFile: config.proxyTokenFile!,
      customProxyTokenPath: false,
      logPath: diagnosticLogPath(),
    }
  })()

  const stopRetry = () => {
    if (retryTimer !== undefined) {
      clearInterval(retryTimer)
      retryTimer = undefined
    }
    retryAttempts = 0
    retryLimit = undefined
  }

  const retryRegistration = (limit?: number) => {
    if (retryTimer !== undefined) return
    retryLimit = limit
    retryTimer = setInterval(() => {
      if (cleaned) return
      if (retryLimit !== undefined && retryAttempts >= retryLimit) {
        stopRetry()
        return
      }
      retryAttempts++
      void startBridge(bridge)
        .then(async (next) => {
          if (cleaned) return
          await reloadRegistration(next)
          if (next.state === "ready") stopRetry()
        })
        .catch(() => undefined)
    }, 2_000)
  }

  const reloadRegistration = (status: BridgeStatus): Promise<void> => {
    desiredStatus = status
    const operation = mcpOperation.catch(() => undefined).then(async () => {
      if (mcpRegistration !== undefined) {
        await mcpRegistration.dispose()
        mcpRegistration = undefined
      }
      mcpRegistration = await ctx.mcp.transform((editor) => {
        editor.set("playwright", registration(desiredStatus ?? status, proxyToken) as never)
      })
      await ctx.mcp.reload()
    })
    mcpOperation = operation
    return operation
  }

  const removeRegistration = (): Promise<void> => {
    desiredStatus = undefined
    const operation = mcpOperation.catch(() => undefined).then(async () => {
      if (mcpRegistration === undefined) return
      await ctx.mcp.reload()
      await mcpRegistration.dispose()
      mcpRegistration = undefined
    })
    mcpOperation = operation
    return operation
  }

  try {
    const configuredStatus = bridge.status()
    await reloadRegistration(configuredStatus)
    const initialStatus = await startBridge(bridge)
    if (initialStatus.state !== "ready") {
      const reason = initialStatus.reason === "Playwright proxy token file is missing"
        ? instructionDetails.customProxyTokenPath
          ? "configured proxy token file is missing"
          : "default proxy token file is missing"
        : initialStatus.reason ?? "bridge did not become ready"
      const failure = `Bridge startup failed (mode=${initialStatus.mode}): ${reason}`
      if (loggedStartupFailures.get(bridge) !== failure) {
        loggedStartupFailures.set(bridge, failure)
        diagnostic?.(failure)
      }
    } else {
      loggedStartupFailures.delete(bridge)
    }
    await reloadRegistration(initialStatus)
    if (initialStatus.mode === "wsl-client" && initialStatus.state !== "ready") {
      retryRegistration()
    } else if (needsOwnerStartupRetry(initialStatus)) {
      retryRegistration(5)
    }

    toolRegistration = await ctx.tool.transform((editor) => {
      for (const name of unsafeTools) editor.remove(name)
    })
    await ctx.tool.reload()

    commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: "playwright-start",
        description: "Start the Playwright bridge",
        execute: async ({ sessionID }) => {
          stopRetry()
          const next = await startBridge(bridge)
          await reloadRegistration(next)
          if (next.mode === "wsl-client" && next.state !== "ready") retryRegistration()
          else if (needsOwnerStartupRetry(next)) retryRegistration(5)
          await emitStatus(ctx, sessionID, next)
        },
      })
      editor.add({
        name: "playwright-stop",
        description: "Stop the Playwright bridge",
        execute: async ({ sessionID }) => {
          stopRetry()
          await removeRegistration()
          await bridge.stop()
          await emitStatus(ctx, sessionID, bridge.status())
        },
      })
      editor.add({
        name: "playwright-restart",
        description: "Restart the Playwright bridge",
        execute: async ({ sessionID }) => {
          stopRetry()
          await removeRegistration()
          const next = await bridge.restart()
          await reloadRegistration(next)
          if (next.mode === "wsl-client" && next.state !== "ready") retryRegistration()
          else if (needsOwnerStartupRetry(next)) retryRegistration(5)
          await emitStatus(ctx, sessionID, next)
        },
      })
      editor.add({
        name: "playwright-status",
        description: "Show Playwright bridge status",
        execute: async ({ sessionID }) => emitStatus(ctx, sessionID, bridge.status()),
      })
      editor.add({
        name: "playwright-instructions",
        description: "Show Playwright setup and next steps",
        execute: async ({ sessionID }) => {
          await ctx.session.prompt({
            sessionID,
            text: playwrightInstructions(bridge.status(), instructionDetails),
            resume: false,
          })
        },
      })
    })

    return async () => {
      if (cleaned) return
      cleaned = true
      stopRetry()
      let failure: unknown
      try {
        await removeRegistration()
      } catch (error) {
        failure = error
      }
      try {
        await releaseBridge()
      } catch (error) {
        if (failure === undefined) failure = error
      }
      try {
        await commandRegistration!.dispose()
      } catch (error) {
        if (failure === undefined) failure = error
      }
      try {
        await toolRegistration!.dispose()
      } catch (error) {
        if (failure === undefined) failure = error
      }
      if (failure !== undefined) throw failure
    }
  } catch (error) {
    diagnostic?.(`installBridge failed: ${diagnosticError(error)}`)
    if (typeof error === "object" && error !== null) loggedSetupErrors.add(error)
    cleaned = true
    stopRetry()
    try {
      await removeRegistration()
    } catch {
      // Preserve the setup failure while still attempting bridge shutdown.
    }
    try {
      if (commandRegistration !== undefined) await commandRegistration.dispose()
    } catch {
      // Preserve the setup failure.
    }
    try {
      if (toolRegistration !== undefined) await toolRegistration.dispose()
    } catch {
      // Preserve the setup failure.
    }
    await releaseBridge()
    throw error
  }
}

export default Plugin.define({
  id: "playwright-bridge",
  async setup(ctx) {
    const configDir = configDirectory()
    const config = bridgeConfigFromOptions(ctx.options, configDir)
    const log = createDiagnosticLogger()
    if (sharedBridge === undefined) {
      sharedBridge = createBridge(ctx.options)
      if (process.platform !== "win32") {
        try {
          const configDir = configDirectory()
          const tokenFile = bridgeConfigFromOptions(ctx.options, configDir).proxyTokenFile
          sharedProxyToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim() || undefined
        } catch {
          sharedProxyToken = undefined
        }
      }
    }
    try {
      const cleanup = await installBridge(ctx, sharedBridge, sharedProxyToken, log, {
        configDir,
        extensionTokenFile: config.extensionTokenFile!,
        proxyTokenFile: config.proxyTokenFile!,
        customProxyTokenPath:
          optionString(ctx.options, "proxyTokenFile") !== undefined ||
          process.env.OPENCODE_PLAYWRIGHT_PROXY_TOKEN_FILE !== undefined,
        logPath: diagnosticLogPath(),
      })
      return cleanup
    } catch (error) {
      if (typeof error !== "object" || error === null || !loggedSetupErrors.has(error)) {
        log(`Setup failed: ${diagnosticError(error)}`)
      }
      throw error
    }
  },
})
