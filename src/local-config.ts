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
import { basename, dirname, join } from "node:path"

export type LocalConfig = Record<string, never>

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
    throw new LocalConfigError(path, "must contain strict JSON for an empty object ({})")
  }

  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length > 0) {
    throw new LocalConfigError(path, "must contain strict JSON for an empty object ({})")
  }
  return {}
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
