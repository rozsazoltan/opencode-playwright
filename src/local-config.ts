import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { isIP } from "node:net"
import { basename, dirname, join } from "node:path"

export type LocalConfig = Partial<{
  playwrightHost: string
  playwrightPort: number
  proxyHost: string
  proxyPort: number
  windowsHost: string
  browserExecutable: string
  profileDirName: string
  extensionTokenFile: string
  proxyTokenFile: string
  startupTimeoutMs: number
  startupPollMs: number
  shutdownTimeoutMs: number
  windowsServiceUrl: string
}>

export type LocalConfigFileSystem = {
  readFileSync(path: string, encoding: "utf8"): string
  lstatSync(path: string): unknown
  mkdirSync(path: string, options: { recursive: true }): unknown
  openSync(path: string, flags: "wx", mode: number): number
  writeFileSync(fd: number, data: string, encoding: "utf8"): void
  closeSync(fd: number): void
  linkSync(existingPath: string, newPath: string): void
  unlinkSync(path: string): void
}

const localConfigFileName = "opencode-playwright.json"
const defaultContent = "{}\n"
const stringKeys = [
  "playwrightHost",
  "proxyHost",
  "windowsHost",
  "browserExecutable",
  "profileDirName",
  "extensionTokenFile",
  "proxyTokenFile",
  "windowsServiceUrl",
] as const
const integerKeys = [
  "playwrightPort",
  "proxyPort",
  "startupTimeoutMs",
  "startupPollMs",
  "shutdownTimeoutMs",
] as const
const supportedKeys = new Set<string>([...stringKeys, ...integerKeys])
const invalidConfigReason = "must contain strict JSON with only supported keys and valid values"
const maximumTimerDelayMs = 2_147_483_647

function validHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value !== value.trim()) return false
  if (/[^a-zA-Z0-9.\-]/.test(value)) return false
  return value.split(".").every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
  )
}

function validHost(value: string, allowBracketedIpv6 = true): boolean {
  if (value.startsWith("[") && value.endsWith("]")) {
    return allowBracketedIpv6 && isIP(value.slice(1, -1)) === 6
  }
  if (isIP(value) !== 0) return true
  if (!validHostname(value) || value.split(".").every((label) => /^\d+$/.test(label))) return false
  try {
    return new URL(`http://${value}`).hostname === value.toLowerCase()
  } catch {
    return false
  }
}

function validLoopbackHost(value: string): boolean {
  if (value === "localhost" || value === "::1") return true
  return isIP(value) === 4 && Number(value.split(".")[0]) === 127
}

export function validWindowsServiceUrl(value: string): boolean {
  if (value.length > 2_048 || !/^https?:\/\/[^/?#\\]+\/?$/i.test(value)) return false
  try {
    const url = new URL(value)
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) return false

    if (url.protocol === "https:") return true
    const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname
    return validLoopbackHost(hostname)
  } catch {
    return false
  }
}

function validConfigValue(key: string, value: unknown): boolean {
  if ((stringKeys as readonly string[]).includes(key)) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value !== value.trim() ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) return false
    if (key === "playwrightHost") return validLoopbackHost(value)
    if (key === "proxyHost") return validHost(value, false)
    if (key === "windowsHost") return validHost(value)
    if (key === "windowsServiceUrl") return validWindowsServiceUrl(value)
    return true
  }

  if (
    !(integerKeys as readonly string[]).includes(key) ||
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return false
  }
  if (key === "playwrightPort" || key === "proxyPort") return value <= 65_535
  return value <= maximumTimerDelayMs
}

const nodeFileSystem: LocalConfigFileSystem = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  lstatSync: (path) => lstatSync(path),
  mkdirSync: (path, options) => mkdirSync(path, options),
  openSync: (path, flags, mode) => openSync(path, flags, mode),
  writeFileSync: (fd, data, encoding) => writeFileSync(fd, data, encoding),
  closeSync: (fd) => closeSync(fd),
  linkSync: (existingPath, newPath) => linkSync(existingPath, newPath),
  unlinkSync: (path) => unlinkSync(path),
}

export class LocalConfigError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`)
    this.name = "LocalConfigError"
  }
}

export function localConfigPath(configDir: string): string {
  return join(configDir, localConfigFileName)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = error.code
  return typeof code === "string" ? code : undefined
}

function validate(contents: string, path: string): LocalConfig {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new LocalConfigError(path, invalidConfigReason)
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalConfigError(path, invalidConfigReason)
  }

  const config = value as Record<string, unknown>
  if (
    Object.keys(config).some((key) => !supportedKeys.has(key) || !validConfigValue(key, config[key])) ||
    (config.playwrightPort !== undefined && config.playwrightPort === config.proxyPort)
  ) {
    throw new LocalConfigError(path, invalidConfigReason)
  }
  return config as LocalConfig
}

function readConfig(
  path: string,
  fileSystem: LocalConfigFileSystem,
  allowMissing: boolean,
): LocalConfig | undefined {
  let contents: string
  try {
    contents = fileSystem.readFileSync(path, "utf8")
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw new LocalConfigError(path, "existing file could not be read; check permissions and file type")
    }

    try {
      fileSystem.lstatSync(path)
    } catch (statError) {
      if (errorCode(statError) === "ENOENT") {
        if (allowMissing) return undefined
        throw new LocalConfigError(path, "concurrent file disappeared before validation; restore it and retry setup")
      }
      throw new LocalConfigError(path, "existing file could not be read; check permissions and file type")
    }

    try {
      contents = fileSystem.readFileSync(path, "utf8")
    } catch {
      throw new LocalConfigError(path, "existing file could not be read; check permissions and file type")
    }
  }

  return validate(contents, path)
}

function safeFailure(path: string, error: unknown, operation: "create" | "publish" | "cleanup"): LocalConfigError {
  if (error instanceof LocalConfigError) return error
  if (operation === "create") {
    return new LocalConfigError(path, "could not create the file; check directory permissions")
  }
  if (operation === "publish") {
    return new LocalConfigError(path, "could not publish atomically; use a filesystem that supports hard links")
  }
  return new LocalConfigError(path, "temporary file could not be removed; check directory permissions")
}

function createConfig(path: string, fileSystem: LocalConfigFileSystem): LocalConfig {
  const parent = dirname(path)
  const temporaryPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  let ownsTemporaryFile = false
  let result: LocalConfig | undefined
  let failure: LocalConfigError | undefined

  try {
    fileSystem.mkdirSync(parent, { recursive: true })
    descriptor = fileSystem.openSync(temporaryPath, "wx", 0o600)
    ownsTemporaryFile = true
    fileSystem.writeFileSync(descriptor, defaultContent, "utf8")
    fileSystem.closeSync(descriptor)
    descriptor = undefined

    try {
      fileSystem.linkSync(temporaryPath, path)
      result = {}
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw safeFailure(path, error, "publish")
      result = readConfig(path, fileSystem, false)
    }
  } catch (error) {
    failure = safeFailure(path, error, "create")
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor)
      } catch (error) {
        if (failure === undefined) failure = safeFailure(path, error, "create")
      }
    }
    if (ownsTemporaryFile) {
      try {
        fileSystem.unlinkSync(temporaryPath)
      } catch (error) {
        if (failure === undefined) failure = safeFailure(path, error, "cleanup")
      }
    }
  }

  if (failure !== undefined) throw failure
  if (result === undefined) {
    throw new LocalConfigError(path, "concurrent file disappeared before validation; restore it and retry setup")
  }
  return result
}

export function loadLocalConfig(
  configDir: string,
  fileSystem: LocalConfigFileSystem = nodeFileSystem,
): LocalConfig {
  const path = localConfigPath(configDir)
  const existing = readConfig(path, fileSystem, true)
  return existing ?? createConfig(path, fileSystem)
}
