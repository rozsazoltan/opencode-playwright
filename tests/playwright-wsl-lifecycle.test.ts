import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlaywrightBridge, type BridgeDependencies } from "../src/bridge"
import { installBridge } from "../src/index"

const temporaryDirectories = new Set<string>()

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true })
  temporaryDirectories.clear()
})

function wslBridge(options: {
  probe?: () => Promise<{ mcp: boolean; extension: boolean }>
  readToken?: () => string
  request?: (action: "start" | "stop" | "restart") => Promise<void>
} = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "playwright-wsl-lifecycle-"))
  temporaryDirectories.add(configDir)
  const lifecycleRequests: string[] = []
  const probes: Array<{ endpoint: URL; token?: string }> = []

  const dependencies: BridgeDependencies = {
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    fileExists: () => true,
    readText: () => options.readToken?.() ?? "proxy-secret",
    writeText: () => undefined,
    resolve: (name) => name,
    isPortOpen: async () => false,
    spawn: () => ({ pid: 1234, onExit: () => undefined }),
    killTree: async () => undefined,
    sleep: async () => undefined,
    probeMcp: async (endpoint, token) => {
      probes.push({ endpoint, token })
      return options.probe?.() ?? { mcp: false, extension: false }
    },
    now: () => new Date("2026-09-23T00:00:00.000Z"),
    requestOwnerLifecycle: async (action) => {
      lifecycleRequests.push(action)
      await options.request?.(action)
    },
  }

  const bridge = new PlaywrightBridge(dependencies, {
    configDir,
    endpoint: new URL("http://127.0.0.1:8931/mcp"),
    proxyEndpoint: new URL("http://127.0.0.1:8932/mcp"),
    startupTimeoutMs: 20,
    startupPollMs: 5,
  })

  return { bridge, lifecycleRequests, probes }
}

describe("WSL owner lifecycle fast path", () => {
  test("plugin cleanup detaches from a ready proxy without stopping the Windows owner", async () => {
    const { bridge, lifecycleRequests, probes } = wslBridge({
      probe: async () => ({ mcp: true, extension: true }),
      request: async () => { throw new Error("service session unavailable") },
    })

    const ctx = {
      mcp: {
        transform: async (callback: (editor: any) => void) => {
          callback({ set: () => undefined })
          return { dispose: async () => undefined }
        },
        reload: async () => undefined,
      },
      tool: {
        transform: async (callback: (editor: any) => void) => {
          callback({ remove: () => undefined })
          return { dispose: async () => undefined }
        },
        reload: async () => undefined,
      },
      command: {
        transform: async (callback: (editor: any) => void) => {
          callback({ add: () => undefined })
          return { dispose: async () => undefined }
        },
      },
      session: { prompt: async () => undefined },
    }
    const cleanup = await installBridge(ctx as any, bridge)

    expect(bridge.status().state).toBe("ready")
    expect(bridge.status().extensionConnected).toBe(true)
    expect(lifecycleRequests).toEqual([])
    expect(probes).toHaveLength(1)
    expect(probes[0]?.token).toBe("proxy-secret")
    await cleanup()
    expect(lifecycleRequests).toEqual([])
  })

  test("explicit stop still requests the Windows owner", async () => {
    const { bridge, lifecycleRequests } = wslBridge()

    await bridge.stop()

    expect(lifecycleRequests).toEqual(["stop"])
    expect(bridge.status().state).toBe("stopped")
  })

  test("a pending WSL probe cannot restore ready after detach", async () => {
    let finishProbe!: (value: { mcp: boolean; extension: boolean }) => void
    const { bridge, lifecycleRequests } = wslBridge({
      probe: () => new Promise((resolve) => { finishProbe = resolve }),
    })

    const starting = bridge.start()
    await bridge.detach()
    finishProbe({ mcp: true, extension: true })
    await starting

    expect(bridge.status().state).toBe("stopped")
    expect(lifecycleRequests).toEqual([])
  })

  test("probes the authenticated proxy for the full deadline after a failed start request", async () => {
    let probeCount = 0
    const { bridge, lifecycleRequests, probes } = wslBridge({
      probe: async () => {
        probeCount++
        if (probeCount === 1) return new Promise(() => undefined)
        return { mcp: true, extension: true }
      },
      request: async () => { throw new Error("service session unavailable") },
    })

    const status = await bridge.start()

    expect(status.state).toBe("ready")
    expect(lifecycleRequests).toEqual(["start"])
    expect(probes.map(({ token }) => token)).toEqual(["proxy-secret", "proxy-secret"])
  })

  test("reports a controlled owner error when the proxy remains unavailable", async () => {
    const { bridge, lifecycleRequests, probes } = wslBridge({
      probe: async () => new Promise(() => undefined),
      request: async () => { throw new Error("service session unavailable") },
    })

    const status = await bridge.start()

    expect(status.state).toBe("failed")
    expect(status.reason).toBe("Windows Playwright owner request failed")
    expect(lifecycleRequests).toEqual(["start"])
    expect(probes).toHaveLength(2)
  })

  test("requests the Windows owner when the proxy is not ready", async () => {
    const { bridge, lifecycleRequests, probes } = wslBridge()

    const status = await bridge.start()

    expect(status.state).toBe("failed")
    expect(status.reason).toBe("Windows Playwright proxy is not ready")
    expect(lifecycleRequests).toEqual(["start"])
    expect(probes).toHaveLength(2)
  })

  test("restart always requests the Windows owner even when its proxy is ready", async () => {
    const { bridge, lifecycleRequests, probes } = wslBridge({
      probe: async () => ({ mcp: true, extension: true }),
    })

    const status = await bridge.restart()

    expect(status.state).toBe("ready")
    expect(lifecycleRequests).toEqual(["restart"])
    expect(probes).toHaveLength(1)
  })

  test("fails closed on proxy-token read failures without exposing raw errors", async () => {
    const { bridge, lifecycleRequests, probes } = wslBridge({
      readToken: () => { throw new Error("sensitive proxy-secret filesystem detail") },
    })

    const status = await bridge.start()

    expect(status.state).toBe("failed")
    expect(status.reason).toBe("Windows Playwright proxy probe failed")
    expect(status.reason).not.toContain("sensitive")
    expect(lifecycleRequests).toEqual(["start"])
    expect(probes).toHaveLength(0)
  })

  test("fails closed when the proxy token is empty", async () => {
    const { bridge, lifecycleRequests, probes } = wslBridge({
      readToken: () => "   ",
    })

    const status = await bridge.start()

    expect(status.state).toBe("failed")
    expect(status.reason).toBe("Windows Playwright proxy probe failed")
    expect(lifecycleRequests).toEqual(["start"])
    expect(probes).toHaveLength(0)
  })
})
