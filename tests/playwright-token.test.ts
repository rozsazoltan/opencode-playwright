import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlaywrightBridge, type BridgeDependencies } from "../src/bridge"
import { bridgeConfigFromOptions } from "../src/index"

const temporaryDirectories = new Set<string>()
const patchedBundle = `async createTarget(url3) {
        const tab2 = await this._sendToExtension("chrome.tabs.create", [{ url: url3, active: false }]);
        // MCP page activation intentionally suppressed.
        await tab2.updateWebMCPTools();
        await context.startRecording();
        // MCP page activation intentionally suppressed.
        response2.addTextResult`

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true })
  temporaryDirectories.clear()
})

function fixture(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  readProxyToken?: (path: string) => string
} = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "playwright-token-test-"))
  temporaryDirectories.add(configDir)
  const defaultTokenPath = join(configDir, ".secrets", "playwright-mcp-proxy-key")
  const dependencies: BridgeDependencies = {
    platform: options.platform ?? "win32",
    env: { OPENCODE_CONFIG_DIR: configDir, ...options.env },
    fileExists: (path) => path === defaultTokenPath ? existsSync(path) : true,
    readText: (path) => {
      if (path === defaultTokenPath) {
        if (options.readProxyToken !== undefined) return options.readProxyToken(path)
        return readFileSync(path, "utf8")
      }
      if (path.endsWith("playwright-key")) return "extension-token"
      return patchedBundle
    },
    writeText: () => undefined,
    resolve: (name) => name,
    isPortOpen: async () => false,
    spawn: () => ({ pid: 4242, onExit: () => undefined }),
    killTree: async () => undefined,
    sleep: async () => undefined,
    probeMcp: async () => ({ mcp: true, extension: true }),
    now: () => new Date("2026-09-21T00:00:00.000Z"),
    startProxy: () => ({ url: new URL("http://127.0.0.1:8932/mcp"), stop: () => undefined }),
  }
  return { configDir, defaultTokenPath, dependencies }
}

describe("Windows default proxy token", () => {
  test("creates a random 32-byte hex token on first start", async () => {
    const { defaultTokenPath, dependencies } = fixture()
    const status = await new PlaywrightBridge(dependencies).start()
    const token = readFileSync(defaultTokenPath, "utf8")

    expect(status.state).toBe("ready")
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== "win32") expect(statSync(defaultTokenPath).mode & 0o777).toBe(0o600)
  })

  test("plugin-resolved default config enables Windows token generation", async () => {
    const { configDir, defaultTokenPath, dependencies } = fixture()
    const config = bridgeConfigFromOptions({}, configDir, dependencies.env)
    const status = await new PlaywrightBridge(dependencies, config).start()

    expect(status.state).toBe("ready")
    expect(existsSync(defaultTokenPath)).toBe(true)
  })

  test("preserves an existing default token", async () => {
    const { defaultTokenPath, dependencies } = fixture()
    mkdirSync(join(dependencies.env.OPENCODE_CONFIG_DIR!, ".secrets"), { recursive: true })
    writeFileSync(defaultTokenPath, "keep-this-token")

    const status = await new PlaywrightBridge(dependencies).start()

    expect(status.state).toBe("ready")
    expect(readFileSync(defaultTokenPath, "utf8")).toBe("keep-this-token")
  })

  test("concurrent first starts preserve the single published token", async () => {
    const { defaultTokenPath, dependencies } = fixture()
    await Promise.all([
      new PlaywrightBridge(dependencies).start(),
      new PlaywrightBridge(dependencies).start(),
    ])

    expect(readFileSync(defaultTokenPath, "utf8")).toMatch(/^[0-9a-f]{64}$/)
  })

  test("does not create a missing explicitly configured token", async () => {
    const { configDir, defaultTokenPath, dependencies } = fixture()
    const explicitPath = join(configDir, ".secrets", "custom-token")
    dependencies.fileExists = (path) => path === explicitPath ? existsSync(path) : true
    const status = await new PlaywrightBridge(dependencies, { proxyTokenFile: explicitPath }).start()

    expect(status.state).toBe("failed")
    expect(status.reason).toBe("Playwright proxy token file is missing")
    expect(existsSync(explicitPath)).toBe(false)
    expect(existsSync(defaultTokenPath)).toBe(false)
  })

  test("does not expose filesystem errors while generating the default key", async () => {
    const { configDir, dependencies } = fixture()
    const config = bridgeConfigFromOptions({}, configDir, dependencies.env)
    const blocker = join(configDir, "not-a-directory")
    writeFileSync(blocker, "not a directory")
    const inaccessible = join(blocker, "key")
    dependencies.fileExists = (path) => path === inaccessible ? false : true
    const status = await new PlaywrightBridge(dependencies, {
      ...config,
      proxyTokenFile: inaccessible,
      autoGenerateProxyToken: true,
    }).start()

    expect(status.state).toBe("failed")
    expect(status.reason).toBe("Playwright default proxy token could not be created")
    expect(status.reason).not.toContain(configDir)
  })

  test("never creates the token from WSL", async () => {
    const { defaultTokenPath, dependencies } = fixture({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    })
    const status = await new PlaywrightBridge(dependencies).start()

    expect(status.state).toBe("failed")
    expect(existsSync(defaultTokenPath)).toBe(false)
  })

  test("fails safely for empty and unreadable existing token files", async () => {
    const { defaultTokenPath, dependencies } = fixture()
    mkdirSync(join(dependencies.env.OPENCODE_CONFIG_DIR!, ".secrets"), { recursive: true })
    writeFileSync(defaultTokenPath, "")
    const empty = await new PlaywrightBridge(dependencies).start()
    expect(empty.reason).toBe("Playwright proxy token is empty")

    writeFileSync(defaultTokenPath, "sensitive-marker")
    dependencies.readText = (path) => {
      if (path === defaultTokenPath) throw new Error("sensitive-marker")
      return patchedBundle
    }
    const unreadable = await new PlaywrightBridge(dependencies).start()
    expect(unreadable.state).toBe("failed")
    expect(unreadable.reason).toBe("Playwright proxy token file could not be read")
    expect(unreadable.reason).not.toContain("sensitive-marker")
  })
})
