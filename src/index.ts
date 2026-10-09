import { Plugin } from "@opencode/plugin"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import {
  loadLocalConfig,
  LocalConfigError,
  type LocalConfig,
  validWindowsServiceUrl,
} from "./local-config"
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
const inFlightWslProxyRetries = new WeakMap<PlaywrightBridge, Promise<BridgeStatus>>()
const automaticRetryStates = new WeakMap<PlaywrightBridge, { version: number; suspended: boolean }>()
const bridgeReferences = new WeakMap<PlaywrightBridge, { count: number }>()
const loggedStartupFailures = new WeakMap<PlaywrightBridge, string>()
const loggedSetupErrors = new WeakSet<object>()

type PluginContext = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0]
type PluginOptions = Readonly<Record<string, unknown>>

type OwnerLifecycleRequester = (action: OwnerLifecycleAction) => Promise<void>
type DiagnosticLogger = (message: string) => void

const WINDOWS_OWNER_HTTP_TIMEOUT_SECONDS = 10
const WINDOWS_OWNER_PROCESS_TIMEOUT_MS = 25_000

type WindowsOwnerLifecycleCommandOptions = {
  timeout: number
  windowsHide: true
  stdio: "ignore"
}

type WindowsOwnerLifecycleCommandResult = {
  status: number | null
  error?: unknown
}

export type WindowsOwnerLifecycleExecutor = (
  command: "powershell.exe",
  args: string[],
  options: WindowsOwnerLifecycleCommandOptions,
) => WindowsOwnerLifecycleCommandResult

const TOOL_SELECTION_GUIDANCE = [
  "Tool selection guidance:",
  "- GitHub MCP is the first choice for GitHub repositories, issues, pull requests, and releases.",
  "- Jina/webfetch is the first choice for static/public quick content and search.",
  "- Use Playwright for JavaScript-rendered, interactive, authenticated/session-based content, visual or actual browser state, and when webfetch/Jina returns 403 or a bot/CAPTCHA challenge.",
  "- Do not attempt to bypass bot/CAPTCHA challenges. If user action is needed, ask the user to complete it in their browser, then continue from a Playwright snapshot/current page.",
].join("\n")

const PLAYWRIGHT_URL_USAGE = "Usage: /playwright <http(s) URL> [context]"

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}

function currentPagePrompt(request: string): string {
  return [
    "Use the existing Playwright MCP integration to inspect the currently selected browser tab with browser_snapshot (use browser_tabs only if needed), then answer the request below. Do not navigate.",
    request.length > 0 ? `Request:\n${request}` : "Summarize the current page.",
  ].join("\n\n")
}

function urlPrompt(url: string, context: string): string {
  return [
    `Use the existing Playwright MCP integration to navigate with browser_navigate to exactly this URL: ${url}`,
    "Then inspect the browser_snapshot/current page and fulfill the entire request context below.",
    context.length > 0 ? `Request context:\n${context}` : "Request context: inspect and summarize the page.",
  ].join("\n\n")
}

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

export function requestWindowsOwnerLifecycle(
  action: OwnerLifecycleAction,
  env: NodeJS.ProcessEnv,
  configDir: string,
  execute: WindowsOwnerLifecycleExecutor = (command, args, options) => spawnSync(command, args, options),
  configuredServiceUrl?: string,
): void {
  const serviceUrl = (
    configuredServiceUrl ?? env.OPENCODE_PLAYWRIGHT_WINDOWS_SERVICE_URL ?? "http://127.0.0.1:49374"
  ).replace(/\/+$/, "")
  if (!validWindowsServiceUrl(serviceUrl)) {
    throw new Error("windowsServiceUrl must use HTTPS unless it targets loopback")
  }
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
    `$active = Invoke-RestMethod -Method Get -Uri ($base + '/api/session/active') -Headers $headers -TimeoutSec ${WINDOWS_OWNER_HTTP_TIMEOUT_SECONDS}`,
    "$sessionProperty = if ($null -ne $active.data) { $active.data.PSObject.Properties | Select-Object -First 1 } else { $null }",
    "$sessionId = if ($null -ne $sessionProperty) { $sessionProperty.Name } elseif ($null -ne $active.id) { $active.id } else { $null }",
    "if ([string]::IsNullOrEmpty($sessionId)) { throw 'No active Windows OpenCode session' }",
    `$body = @{ name = 'playwright-${action}'; text = '' } | ConvertTo-Json -Compress`,
    `Invoke-RestMethod -Method Post -Uri ($base + '/api/session/' + $sessionId + '/command') -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec ${WINDOWS_OWNER_HTTP_TIMEOUT_SECONDS} | Out-Null`,
  ].join("; ")
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  let result: WindowsOwnerLifecycleCommandResult
  try {
    result = execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      timeout: WINDOWS_OWNER_PROCESS_TIMEOUT_MS,
      windowsHide: true,
      stdio: "ignore",
    })
  } catch {
    throw new Error("Windows Playwright owner request failed")
  }
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Windows Playwright owner request failed")
  }
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
  configured: number | undefined,
  fallback: string | undefined,
  defaultValue: number,
): number {
  const value = options[name] ?? configured ?? fallback
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
  localConfig: LocalConfig = {},
): Partial<BridgeConfig> & { windowsServiceUrl: string } {
  const optionProxyTokenFile = optionString(options, "proxyTokenFile")
  const configuredProxyTokenFile = localConfig.proxyTokenFile
  const extensionTokenFile =
    optionString(options, "extensionTokenFile") ??
    localConfig.extensionTokenFile ??
    env.OPENCODE_PLAYWRIGHT_EXTENSION_TOKEN_FILE ??
    ".secrets/playwright-key"
  const proxyTokenFile =
    optionProxyTokenFile ??
    configuredProxyTokenFile ??
    env.OPENCODE_PLAYWRIGHT_PROXY_TOKEN_FILE ??
    ".secrets/playwright-mcp-proxy-key"
  const autoGenerateProxyToken =
    optionProxyTokenFile === undefined &&
    configuredProxyTokenFile === undefined &&
    env.OPENCODE_PLAYWRIGHT_PROXY_TOKEN_FILE === undefined
  const playwrightPort = optionInteger(
    options,
    "playwrightPort",
    localConfig.playwrightPort,
    env.OPENCODE_PLAYWRIGHT_PORT,
    8931,
  )
  const proxyPort = optionInteger(
    options,
    "proxyPort",
    localConfig.proxyPort,
    env.OPENCODE_PLAYWRIGHT_PROXY_PORT,
    8932,
  )
  const windowsServiceUrl =
    optionString(options, "windowsServiceUrl") ??
    localConfig.windowsServiceUrl ??
    env.OPENCODE_PLAYWRIGHT_WINDOWS_SERVICE_URL ??
    "http://127.0.0.1:49374"

  if (playwrightPort === proxyPort) {
    throw new Error("playwrightPort and proxyPort must be different")
  }
  if (!validWindowsServiceUrl(windowsServiceUrl)) {
    throw new Error("windowsServiceUrl must use HTTPS unless it targets loopback")
  }

  return {
    configDir,
    playwrightHost: loopbackHost(
      optionString(options, "playwrightHost") ??
        localConfig.playwrightHost ??
        env.OPENCODE_PLAYWRIGHT_HOST ??
        "localhost",
    ),
    playwrightPort,
    proxyHost:
      optionString(options, "proxyHost") ??
      localConfig.proxyHost ??
      env.OPENCODE_PLAYWRIGHT_PROXY_HOST ??
      "0.0.0.0",
    proxyPort,
    windowsHost:
      optionString(options, "windowsHost") ??
      localConfig.windowsHost ??
      env.OPENCODE_PLAYWRIGHT_WINDOWS_HOST,
    browserExecutable:
      optionString(options, "browserExecutable") ??
      localConfig.browserExecutable ??
      env.OPENCODE_PLAYWRIGHT_EXECUTABLE_PATH ??
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    profileDirName:
      optionString(options, "profileDirName") ??
      localConfig.profileDirName ??
      env.OPENCODE_PLAYWRIGHT_PROFILE_DIR_NAME ??
      "Default",
    extensionTokenFile: resolvedSecretPath(configDir, extensionTokenFile),
    proxyTokenFile: resolvedSecretPath(configDir, proxyTokenFile),
    autoGenerateProxyToken,
    startupTimeoutMs: optionInteger(
      options,
      "startupTimeoutMs",
      localConfig.startupTimeoutMs,
      env.OPENCODE_PLAYWRIGHT_STARTUP_TIMEOUT_MS,
      15_000,
    ),
    startupPollMs: optionInteger(
      options,
      "startupPollMs",
      localConfig.startupPollMs,
      env.OPENCODE_PLAYWRIGHT_STARTUP_POLL_MS,
      100,
    ),
    shutdownTimeoutMs: optionInteger(
      options,
      "shutdownTimeoutMs",
      localConfig.shutdownTimeoutMs,
      env.OPENCODE_PLAYWRIGHT_SHUTDOWN_TIMEOUT_MS,
      5_000,
    ),
    windowsServiceUrl,
  }
}

export function proxyTokenReference(
  options: PluginOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  localConfig: LocalConfig = {},
): string {
  const value =
    optionString(options, "proxyTokenFile") ??
    localConfig.proxyTokenFile ??
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
const WSL_NETWORKING_MODE_TIMEOUT_MS = 1_000
const WSL_NETWORKING_MODE_MAX_BUFFER_BYTES = 1_024

type WslNetworkingModeCommandOptions = {
  encoding: "utf8"
  timeout: number
  maxBuffer: number
  windowsHide: true
  stdio: ["ignore", "pipe", "pipe"]
}

type WslNetworkingModeCommandResult = {
  status: number | null
  stdout?: string | null
  stderr?: string | null
  error?: unknown
}

type WslNetworkingModeExecutor = (
  command: "wslinfo",
  args: ["--networking-mode"],
  options: WslNetworkingModeCommandOptions,
) => WslNetworkingModeCommandResult

export function detectWslNetworkingMode(
  execute: WslNetworkingModeExecutor = (command, args, options) => spawnSync(command, args, options),
): "nat" | "mirrored" | undefined {
  try {
    const result = execute("wslinfo", ["--networking-mode"], {
      encoding: "utf8",
      timeout: WSL_NETWORKING_MODE_TIMEOUT_MS,
      maxBuffer: WSL_NETWORKING_MODE_MAX_BUFFER_BYTES,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (result.error !== undefined || result.status !== 0) return undefined

    const mode = result.stdout?.trim()
    return mode === "nat" || mode === "mirrored" ? mode : undefined
  } catch {
    return undefined
  }
}

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
  signal?: AbortSignal,
): Promise<{ mcp: boolean; extension: boolean }> {
  if (signal?.aborted) return { mcp: false, extension: false }

  const controller = new AbortController()
  const abortProbe = () => controller.abort()
  signal?.addEventListener("abort", abortProbe, { once: true })
  if (signal?.aborted) controller.abort()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const authorization = bearerToken === undefined ? {} : { Authorization: `Bearer ${bearerToken}` }
  try {
    if (controller.signal.aborted) return { mcp: false, extension: false }
    timeout = setTimeout(() => controller.abort(), MCP_PROBE_TIMEOUT_MS)
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
    if (timeout !== undefined) clearTimeout(timeout)
    signal?.removeEventListener("abort", abortProbe)
  }
}

export function createBridge(options: PluginOptions = {}, localConfig: LocalConfig = {}): PlaywrightBridge {
  const env = process.env
  const configDir = configDirectory(env)
  const config = bridgeConfigFromOptions(options, configDir, env, localConfig)
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
      const unwrappedAddress = address.startsWith("[") && address.endsWith("]")
        ? address.slice(1, -1)
        : address
      const formattedAddress = unwrappedAddress.includes(":") ? `[${unwrappedAddress}]` : unwrappedAddress
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
    getWslNetworkingMode: detectWslNetworkingMode,
    requestOwnerLifecycle:
      typeof options.ownerLifecycleRequest === "function"
        ? (options.ownerLifecycleRequest as OwnerLifecycleRequester)
        : process.platform !== "win32"
          ? (action) => Promise.resolve().then(() =>
            requestWindowsOwnerLifecycle(action, env, configDir, undefined, config.windowsServiceUrl),
          )
        : undefined,
    now: () => new Date(),
  }

  return new PlaywrightBridge(dependencies, config)
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

function automaticRetryVersion(bridge: PlaywrightBridge): number {
  return automaticRetryStates.get(bridge)?.version ?? 0
}

function automaticRetriesSuspended(bridge: PlaywrightBridge): boolean {
  return automaticRetryStates.get(bridge)?.suspended ?? false
}

function invalidateAutomaticRetries(
  bridge: PlaywrightBridge,
  suspended = automaticRetriesSuspended(bridge),
): void {
  automaticRetryStates.set(bridge, {
    version: automaticRetryVersion(bridge) + 1,
    suspended,
  })
}

function retryWslProxy(bridge: PlaywrightBridge): Promise<BridgeStatus> {
  const running = inFlightWslProxyRetries.get(bridge)
  if (running !== undefined) return running

  const retry = bridge.retryWslProxy()
  inFlightWslProxyRetries.set(bridge, retry)
  const clear = () => {
    if (inFlightWslProxyRetries.get(bridge) === retry) inFlightWslProxyRetries.delete(bridge)
  }
  void retry.then(clear, clear)
  return retry
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
  let sessionHookRegistration: Awaited<ReturnType<PluginContext["session"]["hook"]>> | undefined
  let retryTimer: ReturnType<typeof setInterval> | undefined
  let retryAttempts = 0
  let retryLimit: number | undefined
  let retryInFlight = false
  let retryGeneration = 0
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
    retryGeneration++
    if (retryTimer !== undefined) {
      clearInterval(retryTimer)
      retryTimer = undefined
    }
    retryAttempts = 0
    retryLimit = undefined
  }

  const retryRegistration = (limit?: number) => {
    if (retryTimer !== undefined) return
    if (automaticRetriesSuspended(bridge)) invalidateAutomaticRetries(bridge, false)
    retryLimit = limit
    const generation = retryGeneration
    retryTimer = setInterval(() => {
      if (cleaned || generation !== retryGeneration || automaticRetriesSuspended(bridge)) return
      if (retryInFlight) return
      if (retryLimit !== undefined && retryAttempts >= retryLimit) {
        stopRetry()
        return
      }
      retryInFlight = true
      retryAttempts++
      const bridgeVersion = automaticRetryVersion(bridge)
      const retry = bridge.status().mode === "wsl-client"
        ? retryWslProxy(bridge)
        : startBridge(bridge)
      void retry
        .then(async (next) => {
          const isCurrent = () =>
            !cleaned && generation === retryGeneration && bridgeVersion === automaticRetryVersion(bridge)
          if (!isCurrent()) return
          await reloadRegistration(next, isCurrent)
          if (isCurrent() && next.state === "ready") stopRetry()
        })
        .catch(() => undefined)
        .finally(() => {
          retryInFlight = false
        })
    }, 2_000)
  }

  const reloadRegistration = (status: BridgeStatus, isCurrent: () => boolean = () => true): Promise<void> => {
    if (!isCurrent()) return Promise.resolve()
    desiredStatus = status
    const operation = mcpOperation.catch(() => undefined).then(async () => {
      if (!isCurrent()) return
      if (mcpRegistration !== undefined) {
        await mcpRegistration.dispose()
        mcpRegistration = undefined
      }
      if (!isCurrent()) return
      const registrationHandle = await ctx.mcp.transform((editor) => {
        editor.set("playwright", registration(desiredStatus ?? status, proxyToken) as never)
      })
      if (!isCurrent()) {
        await registrationHandle.dispose()
        return
      }
      mcpRegistration = registrationHandle
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

    if (typeof ctx.session.hook === "function") {
      sessionHookRegistration = await ctx.session.hook("context", (input) => {
        if (!input.system.some((part) => part.type === "text" && part.text === TOOL_SELECTION_GUIDANCE)) {
          input.system.push({ type: "text", text: TOOL_SELECTION_GUIDANCE })
        }
      })
    }

    commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: "playwright-start",
        description: "Start the Playwright bridge",
        execute: async ({ sessionID }) => {
          stopRetry()
          invalidateAutomaticRetries(bridge, true)
          const next = await startBridge(bridge)
          await reloadRegistration(next)
          if (next.mode === "wsl-client" && next.state !== "ready") {
            invalidateAutomaticRetries(bridge, false)
            retryRegistration()
          } else if (needsOwnerStartupRetry(next)) {
            invalidateAutomaticRetries(bridge, false)
            retryRegistration(5)
          }
          await emitStatus(ctx, sessionID, next)
        },
      })
      editor.add({
        name: "playwright-stop",
        description: "Stop the Playwright bridge",
        execute: async ({ sessionID }) => {
          stopRetry()
          invalidateAutomaticRetries(bridge, true)
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
          invalidateAutomaticRetries(bridge, true)
          await removeRegistration()
          const next = await bridge.restart()
          await reloadRegistration(next)
          if (next.mode === "wsl-client" && next.state !== "ready") {
            invalidateAutomaticRetries(bridge, false)
            retryRegistration()
          } else if (needsOwnerStartupRetry(next)) {
            invalidateAutomaticRetries(bridge, false)
            retryRegistration(5)
          }
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
      editor.add({
        name: "playwright-current",
        description: "Inspect the currently selected browser tab",
        execute: async ({ sessionID, prompt }) => {
          await ctx.session.prompt({
            sessionID,
            text: currentPagePrompt(prompt.text.trim()),
          })
        },
      })
      editor.add({
        name: "playwright",
        description: "Open a URL in Playwright and fulfill a request",
        execute: async ({ sessionID, prompt }) => {
          const trimmedPrompt = prompt.text.trim()
          const rawUrl = trimmedPrompt.split(/\s+/, 1)[0] ?? ""
          const url = parseHttpUrl(rawUrl)
          if (url === undefined) {
            await ctx.session.prompt({ sessionID, text: PLAYWRIGHT_URL_USAGE, resume: false })
            return
          }
          const context = trimmedPrompt.slice(rawUrl.length).trim()
          await ctx.session.prompt({ sessionID, text: urlPrompt(rawUrl, context) })
        },
      })
    })

    return async () => {
      if (cleaned) return
      cleaned = true
      stopRetry()
      invalidateAutomaticRetries(bridge)
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
        await sessionHookRegistration?.dispose()
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
    invalidateAutomaticRetries(bridge)
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
      if (sessionHookRegistration !== undefined) await sessionHookRegistration.dispose()
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
    const log = createDiagnosticLogger()
    try {
      const configDir = configDirectory()
      const localConfig = loadLocalConfig(configDir)
      const config = bridgeConfigFromOptions(ctx.options, configDir, process.env, localConfig)
      if (sharedBridge === undefined) {
        sharedBridge = createBridge(ctx.options, localConfig)
        if (process.platform !== "win32") {
          try {
            const tokenFile = config.proxyTokenFile
            sharedProxyToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim() || undefined
          } catch {
            sharedProxyToken = undefined
          }
        }
      }
      const cleanup = await installBridge(ctx, sharedBridge, sharedProxyToken, log, {
        configDir,
        extensionTokenFile: config.extensionTokenFile!,
        proxyTokenFile: config.proxyTokenFile!,
        customProxyTokenPath:
          optionString(ctx.options, "proxyTokenFile") !== undefined ||
          localConfig.proxyTokenFile !== undefined ||
          process.env.OPENCODE_PLAYWRIGHT_PROXY_TOKEN_FILE !== undefined,
        logPath: diagnosticLogPath(),
      })
      return cleanup
    } catch (error) {
      if (error instanceof LocalConfigError) {
        log(`Local config failed: ${error.message}`)
        loggedSetupErrors.add(error)
      } else if (typeof error !== "object" || error === null || !loggedSetupErrors.has(error)) {
        log(`Setup failed: ${diagnosticError(error)}`)
      }
      throw error
    }
  },
})
