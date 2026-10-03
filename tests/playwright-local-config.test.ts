import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { configDirectory } from "../src/index"
import {
  loadLocalConfig,
  LocalConfigError,
  localConfigPath,
  type LocalConfigFileSystem,
} from "../src/local-config"

const temporaryDirectories = new Set<string>()

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true })
  temporaryDirectories.clear()
})

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "playwright-local-config-test-"))
  temporaryDirectories.add(path)
  return path
}

function fileSystem(overrides: Partial<LocalConfigFileSystem> = {}): LocalConfigFileSystem {
  return {
    readFileSync: (path, encoding) => fs.readFileSync(path, encoding),
    lstatSync: (path) => fs.lstatSync(path),
    mkdirSync: (path, options) => fs.mkdirSync(path, options),
    openSync: (path, flags, mode) => fs.openSync(path, flags, mode),
    writeFileSync: (fd, data, encoding) => fs.writeFileSync(fd, data, encoding),
    closeSync: (fd) => fs.closeSync(fd),
    linkSync: (existingPath, newPath) => fs.linkSync(existingPath, newPath),
    unlinkSync: (path) => fs.unlinkSync(path),
    ...overrides,
  }
}

function expectLocalConfigError(run: () => unknown, configPath: string, reason: string): LocalConfigError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(LocalConfigError)
    expect(error).toMatchObject({ path: configPath, reason })
    expect((error as Error).message).toBe(`${configPath}: ${reason}`)
    return error as LocalConfigError
  }
  throw new Error("Expected local config loading to fail")
}

describe("local plugin config", () => {
  test("accepts empty objects with JSON whitespace and preserves existing bytes", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const contents = " \n\t{ }\r\n"
    fs.writeFileSync(path, contents)

    expect(loadLocalConfig(configDir)).toEqual({})
    expect(loadLocalConfig(configDir)).toEqual({})
    expect(fs.readFileSync(path, "utf8")).toBe(contents)
  })

  test.each([
    ["null", "null"],
    ["array", "[]"],
    ["string", '"value"'],
    ["number", "1"],
    ["boolean", "true"],
    ["empty file", ""],
    ["unknown key", '{"feature":"SECRET_MARKER"}'],
    ["prototype key", '{"__proto__":{}}'],
    ["comment", "{/* comment */}"],
    ["trailing comma", "{,}"],
    ["malformed JSON", "{not-json"],
  ])("rejects %s without exposing contents or changing bytes", (_label, contents) => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    fs.writeFileSync(path, contents)

    const error = expectLocalConfigError(
      () => loadLocalConfig(configDir),
      path,
      "must contain strict JSON for an empty object ({})",
    )

    expect(error.message).not.toContain("SECRET_MARKER")
    expect(error.message).not.toContain("__proto__")
    expect(fs.readFileSync(path, "utf8")).toBe(contents)
  })

  test("creates default config through complete atomic publication with private permissions", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    let sawCompleteTemporaryFile = false
    let openOptions: { flags: string; mode: number } | undefined
    const adapter = fileSystem({
      openSync: (temporaryPath, flags, mode) => {
        openOptions = { flags, mode }
        return fs.openSync(temporaryPath, flags, mode)
      },
      linkSync: (temporaryPath, destination) => {
        expect(destination).toBe(path)
        expect(fs.existsSync(destination)).toBe(false)
        expect(fs.readFileSync(temporaryPath, "utf8")).toBe("{}\n")
        sawCompleteTemporaryFile = true
        fs.linkSync(temporaryPath, destination)
      },
    })

    expect(loadLocalConfig(configDir, adapter)).toEqual({})
    expect(sawCompleteTemporaryFile).toBe(true)
    expect(openOptions).toEqual({ flags: "wx", mode: 0o600 })
    expect(fs.readFileSync(path, "utf8")).toBe("{}\n")
    if (process.platform !== "win32") expect(fs.statSync(path).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(configDir)).toEqual(["opencode-playwright.json"])
  })

  test("creates missing parent directories and preserves default bytes on later loads", () => {
    const root = temporaryDirectory()
    const configDir = join(root, "nested", "config")
    const path = localConfigPath(configDir)

    expect(loadLocalConfig(configDir)).toEqual({})
    expect(fs.readFileSync(path, "utf8")).toBe("{}\n")
    expect(loadLocalConfig(configDir)).toEqual({})
    expect(fs.readFileSync(path, "utf8")).toBe("{}\n")
  })

  test("does not reset unreadable or non-file existing paths", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const bytes = "{\"kept\":true}"
    fs.writeFileSync(path, bytes)
    const denied = fileSystem({
      readFileSync: () => {
        throw Object.assign(new Error("private filesystem detail"), { code: "EACCES" })
      },
    })

    const deniedError = expectLocalConfigError(
      () => loadLocalConfig(configDir, denied),
      path,
      "existing file could not be read; check permissions and file type",
    )
    expect(deniedError.message).not.toContain("private filesystem detail")
    expect(fs.readFileSync(path, "utf8")).toBe(bytes)

    fs.unlinkSync(path)
    fs.mkdirSync(path)
    expectLocalConfigError(
      () => loadLocalConfig(configDir),
      path,
      "existing file could not be read; check permissions and file type",
    )
    expect(fs.statSync(path).isDirectory()).toBe(true)
  })

  test("does not create or clean up when read misses but lstat finds a dangling destination", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    let reads = 0
    let opens = 0
    let links = 0
    let unlinks = 0
    const adapter = fileSystem({
      readFileSync: () => {
        reads++
        throw Object.assign(new Error("missing target"), { code: "ENOENT" })
      },
      lstatSync: () => ({ isSymbolicLink: () => true }),
      openSync: () => {
        opens++
        throw new Error("must not create temporary file")
      },
      linkSync: () => { links++ },
      unlinkSync: () => { unlinks++ },
    })

    expectLocalConfigError(
      () => loadLocalConfig(configDir, adapter),
      path,
      "existing file could not be read; check permissions and file type",
    )
    expect(reads).toBe(2)
    expect(opens).toBe(0)
    expect(links).toBe(0)
    expect(unlinks).toBe(0)
    expect(fs.existsSync(path)).toBe(false)
  })

  test("rereads once when a valid config appears after an initial missing read", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const winnerBytes = " \n{}\t"
    let reads = 0
    const adapter = fileSystem({
      readFileSync: (readPath, encoding) => {
        reads++
        if (readPath === path && reads === 1) {
          fs.writeFileSync(path, winnerBytes)
          throw Object.assign(new Error("published concurrently"), { code: "ENOENT" })
        }
        return fs.readFileSync(readPath, encoding)
      },
    })

    expect(loadLocalConfig(configDir, adapter)).toEqual({})
    expect(reads).toBe(2)
    expect(fs.readFileSync(path, "utf8")).toBe(winnerBytes)
    expect(fs.readdirSync(configDir)).toEqual(["opencode-playwright.json"])
  })

  test("sanitizes and preserves an invalid config published after an initial missing read", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const winnerBytes = '{"secret":"SECRET_MARKER"}'
    let reads = 0
    const adapter = fileSystem({
      readFileSync: (readPath, encoding) => {
        reads++
        if (readPath === path && reads === 1) {
          fs.writeFileSync(path, winnerBytes)
          throw Object.assign(new Error("published concurrently"), { code: "ENOENT" })
        }
        return fs.readFileSync(readPath, encoding)
      },
    })

    const error = expectLocalConfigError(
      () => loadLocalConfig(configDir, adapter),
      path,
      "must contain strict JSON for an empty object ({})",
    )
    expect(reads).toBe(2)
    expect(error.message).not.toContain("SECRET_MARKER")
    expect(fs.readFileSync(path, "utf8")).toBe(winnerBytes)
    expect(fs.readdirSync(configDir)).toEqual(["opencode-playwright.json"])
  })

  test("does not unlink a contender when exclusive temporary-file creation fails", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const contenderBytes = "owned by another process"
    let contenderPath = ""
    const adapter = fileSystem({
      openSync: (temporaryPath) => {
        contenderPath = temporaryPath
        fs.writeFileSync(temporaryPath, contenderBytes)
        throw Object.assign(new Error("already exists"), { code: "EEXIST" })
      },
    })

    expectLocalConfigError(
      () => loadLocalConfig(configDir, adapter),
      path,
      "could not create the file; check directory permissions",
    )
    expect(fs.readFileSync(contenderPath, "utf8")).toBe(contenderBytes)
    expect(fs.existsSync(path)).toBe(false)
    expect(fs.readdirSync(configDir)).toEqual([contenderPath.slice(configDir.length + 1)])
  })

  test("does not publish after close failure and cleans its own temporary file", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    let descriptor: number | undefined
    let closeAttempts = 0
    let links = 0
    const adapter = fileSystem({
      openSync: (temporaryPath, flags, mode) => {
        descriptor = fs.openSync(temporaryPath, flags, mode)
        return descriptor
      },
      closeSync: (fd) => {
        closeAttempts++
        if (closeAttempts === 1) throw new Error("SECRET close failure")
        fs.closeSync(fd)
      },
      linkSync: () => { links++ },
    })

    const error = expectLocalConfigError(
      () => loadLocalConfig(configDir, adapter),
      path,
      "could not create the file; check directory permissions",
    )
    expect(error.message).not.toContain("SECRET")
    expect(descriptor).toBeDefined()
    expect(closeAttempts).toBe(2)
    expect(links).toBe(0)
    expect(fs.readdirSync(configDir)).toEqual([])
  })

  test("removes its temporary file after write failure without exposing filesystem details", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const adapter = fileSystem({
      writeFileSync: () => {
        throw Object.assign(new Error("SECRET filesystem detail"), { code: "EIO" })
      },
    })

    const error = expectLocalConfigError(
      () => loadLocalConfig(configDir, adapter),
      path,
      "could not create the file; check directory permissions",
    )
    expect(error.message).not.toContain("SECRET")
    expect(fs.existsSync(path)).toBe(false)
    expect(fs.readdirSync(configDir)).toEqual([])
  })

  test("fails closed when hard-link publication is unavailable and cleans its temporary file", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const adapter = fileSystem({
      linkSync: () => {
        throw Object.assign(new Error("raw hard-link error"), { code: "EOPNOTSUPP" })
      },
    })

    const error = expectLocalConfigError(
      () => loadLocalConfig(configDir, adapter),
      path,
      "could not publish atomically; use a filesystem that supports hard links",
    )
    expect(error.message).not.toContain("raw hard-link error")
    expect(fs.existsSync(path)).toBe(false)
    expect(fs.readdirSync(configDir)).toEqual([])
  })

  test("accepts and preserves a valid concurrently published winner", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const winnerBytes = " \n{}\t"
    const adapter = fileSystem({
      linkSync: (_temporaryPath, destination) => {
        fs.writeFileSync(destination, winnerBytes)
        throw Object.assign(new Error("already exists"), { code: "EEXIST" })
      },
    })

    expect(loadLocalConfig(configDir, adapter)).toEqual({})
    expect(fs.readFileSync(path, "utf8")).toBe(winnerBytes)
    expect(fs.readdirSync(configDir)).toEqual(["opencode-playwright.json"])
  })

  test("two competing loads succeed when publication overlaps", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    let innerResult: Record<string, never> | undefined
    const adapter = fileSystem({
      linkSync: (temporaryPath, destination) => {
        expect(destination).toBe(path)
        expect(fs.existsSync(destination)).toBe(false)
        innerResult = loadLocalConfig(configDir)
        fs.linkSync(temporaryPath, destination)
      },
    })

    const outerResult = loadLocalConfig(configDir, adapter)

    expect(innerResult).toEqual({})
    expect(outerResult).toEqual({})
    expect(fs.readFileSync(path, "utf8")).toBe("{}\n")
    expect(fs.readdirSync(configDir)).toEqual(["opencode-playwright.json"])
  })

  test("rejects invalid concurrent winner without overwriting it", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const winnerBytes = '{"key":"SECRET_MARKER"}'
    const adapter = fileSystem({
      linkSync: (_temporaryPath, destination) => {
        fs.writeFileSync(destination, winnerBytes)
        throw Object.assign(new Error("already exists"), { code: "EEXIST" })
      },
    })

    const error = expectLocalConfigError(
      () => loadLocalConfig(configDir, adapter),
      path,
      "must contain strict JSON for an empty object ({})",
    )
    expect(error.message).not.toContain("SECRET_MARKER")
    expect(fs.readFileSync(path, "utf8")).toBe(winnerBytes)
  })

  test("reports a bounded error when concurrent winner disappears", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    let raced = false
    const adapter = fileSystem({
      linkSync: (_temporaryPath, destination) => {
        fs.writeFileSync(destination, "{}")
        raced = true
        throw Object.assign(new Error("already exists"), { code: "EEXIST" })
      },
      readFileSync: (readPath, encoding) => {
        if (raced && readPath === path) {
          fs.unlinkSync(path)
          raced = false
          throw Object.assign(new Error("disappeared"), { code: "ENOENT" })
        }
        return fs.readFileSync(readPath, encoding)
      },
    })

    expectLocalConfigError(
      () => loadLocalConfig(configDir, adapter),
      path,
      "concurrent file disappeared before validation; restore it and retry setup",
    )
    expect(fs.existsSync(path)).toBe(false)
    expect(fs.readdirSync(configDir)).toEqual([])
  })

  test("does not mask publication failure when temporary cleanup also fails", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const adapter = fileSystem({
      linkSync: () => {
        throw Object.assign(new Error("publish secret"), { code: "EOPNOTSUPP" })
      },
      unlinkSync: () => {
        throw new Error("cleanup secret")
      },
    })

    const error = expectLocalConfigError(
      () => loadLocalConfig(configDir, adapter),
      path,
      "could not publish atomically; use a filesystem that supports hard links",
    )
    expect(error.message).not.toContain("cleanup secret")
    expect(error.message).not.toContain("publish secret")
    expect(fs.readdirSync(configDir).some((name) => name.endsWith(".tmp"))).toBe(true)
  })

  test("reports cleanup failure safely when no earlier failure occurred", () => {
    const configDir = temporaryDirectory()
    const path = localConfigPath(configDir)
    const adapter = fileSystem({
      unlinkSync: () => {
        throw new Error("cleanup secret")
      },
    })

    const error = expectLocalConfigError(
      () => loadLocalConfig(configDir, adapter),
      path,
      "temporary file could not be removed; check directory permissions",
    )
    expect(error.message).not.toContain("cleanup secret")
    expect(fs.readFileSync(path, "utf8")).toBe("{}\n")
  })

  test("uses config directory override only with recognized markers and keeps native roots", () => {
    const override = "/custom/opencode"
    for (const marker of ["opencode.json", "opencode.jsonc", "cli.json"]) {
      expect(configDirectory({ OPENCODE_CONFIG_DIR: override }, "/native/home", (path) => path === join(override, marker)))
        .toBe(override)
    }

    expect(configDirectory({ OPENCODE_CONFIG_DIR: override }, "/home/wsl-user", () => false)).toBe(
      join("/home/wsl-user", ".config", "opencode"),
    )
    expect(configDirectory({}, "C:\\Users\\windows-user", () => false)).toBe(
      join("C:\\Users\\windows-user", ".config", "opencode"),
    )
  })

  test("validates config on every plugin setup before bridge or registration effects", async () => {
    const configDir = temporaryDirectory()
    const diagnosticsDir = join(configDir, "diagnostics")
    const path = localConfigPath(configDir)
    fs.writeFileSync(join(configDir, "opencode.json"), "{}")
    fs.mkdirSync(path)

    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    const previousDataHome = process.env.XDG_DATA_HOME
    process.env.OPENCODE_CONFIG_DIR = configDir
    process.env.XDG_DATA_HOME = diagnosticsDir
    let effects = 0
    const context = {
      options: {},
      mcp: { transform: async () => { effects++; throw new Error("unexpected bridge effect") } },
      tool: { transform: async () => { effects++; throw new Error("unexpected bridge effect") } },
      command: { transform: async () => { effects++; throw new Error("unexpected bridge effect") } },
      session: { hook: async () => { effects++; throw new Error("unexpected bridge effect") } },
    }
    const setup = (plugin as unknown as { setup(context: unknown): Promise<unknown> }).setup

    try {
      await expect(setup(context)).rejects.toMatchObject({
        reason: "existing file could not be read; check permissions and file type",
      })

      fs.rmdirSync(path)
      fs.writeFileSync(path, '{"secret":"SECRET_MARKER"}')
      await expect(setup(context)).rejects.toMatchObject({
        reason: "must contain strict JSON for an empty object ({})",
      })

      expect(effects).toBe(0)
      const diagnosticPath = join(diagnosticsDir, "opencode", "log", "opencode-playwright-bridge.log")
      const diagnostics = fs.readFileSync(diagnosticPath, "utf8")
      expect(diagnostics).toContain(path)
      expect(diagnostics).toContain("must contain strict JSON for an empty object ({})")
      expect(diagnostics).not.toContain("SECRET_MARKER")
    } finally {
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousDataHome
    }
  })
})
