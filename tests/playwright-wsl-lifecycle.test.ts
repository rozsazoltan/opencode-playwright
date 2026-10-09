import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlaywrightBridge, type BridgeDependencies } from "../src/bridge"
import {
  bridgeConfigFromOptions,
  installBridge,
  requestWindowsOwnerLifecycle,
  type WindowsOwnerLifecycleExecutor,
} from "../src/index"

const temporaryDirectories = new Set<string>()
const nativeSetInterval = globalThis.setInterval
const nativeClearInterval = globalThis.clearInterval
let retryCallbacks: Array<() => void> = []

afterEach(() => {
  globalThis.setInterval = nativeSetInterval
  globalThis.clearInterval = nativeClearInterval
  retryCallbacks = []
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true })
  temporaryDirectories.clear()
})

function wslBridge(options: {
  probe?: (signal?: AbortSignal) => Promise<{ mcp: boolean; extension: boolean }>
  readToken?: () => string
  request?: (action: "start" | "stop" | "restart") => Promise<void>
  startupTimeoutMs?: number
  startupPollMs?: number
} = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "playwright-wsl-lifecycle-"))
  temporaryDirectories.add(configDir)
  const lifecycleRequests: string[] = []
  const probes: Array<{ endpoint: URL; token?: string; signal?: AbortSignal }> = []

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
    probeMcp: async (endpoint, token, signal) => {
      probes.push({ endpoint, token, signal })
      return options.probe?.(signal) ?? { mcp: false, extension: false }
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
    startupTimeoutMs: options.startupTimeoutMs ?? 20,
    startupPollMs: options.startupPollMs ?? 5,
  })

  return { bridge, lifecycleRequests, probes }
}

function pluginContext() {
  const commands = new Map<string, { execute(input: any): Promise<void> }>()
  let mcpReloads = 0
  const context = {
    mcp: {
      transform: async (callback: (editor: any) => void) => {
        callback({ set: () => undefined })
        return { dispose: async () => undefined }
      },
      reload: async () => { mcpReloads++ },
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
        callback({ add: (command: { name: string; execute(input: any): Promise<void> }) => {
          commands.set(command.name, command)
        } })
        return { dispose: async () => undefined }
      },
    },
    session: { prompt: async () => undefined },
  }
  return { context, commands, get mcpReloads() { return mcpReloads } }
}

describe("WSL owner lifecycle fast path", () => {
  test("uses local windowsServiceUrl for Windows owner API requests", () => {
    let script = ""
    const environment = { OPENCODE_PLAYWRIGHT_WINDOWS_SERVICE_URL: "https://environment-owner:4000" }
    const config = bridgeConfigFromOptions({}, "/unused", environment, {
      windowsServiceUrl: "https://configured-owner:5000/",
    })
    const executor: WindowsOwnerLifecycleExecutor = (_command, args) => {
      script = Buffer.from(args[3] ?? "", "base64").toString("utf16le")
      return { status: 0 }
    }

    requestWindowsOwnerLifecycle("start", environment, "/unused", executor, config.windowsServiceUrl)

    expect(config.windowsServiceUrl).toBe("https://configured-owner:5000/")
    expect(script).toContain("$base = 'https://configured-owner:5000'")
    expect(script).not.toContain("environment-owner")
  })

  test("rejects non-loopback HTTP owner URLs before invoking PowerShell", () => {
    let executions = 0
    const executor: WindowsOwnerLifecycleExecutor = () => {
      executions++
      return { status: 0 }
    }

    expect(() => requestWindowsOwnerLifecycle(
      "start",
      { OPENCODE_SERVER_PASSWORD: "password" },
      "/unused",
      executor,
      "http://remote-owner:5000",
    )).toThrow("windowsServiceUrl must use HTTPS unless it targets loopback")
    expect(executions).toBe(0)
  })

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

  test("background WSL retries do not overlap proxy probes or repeat owner requests", async () => {
    let holdBackgroundProbe = false
    let backgroundProbeCount = 0
    let activeBackgroundProbes = 0
    let maxActiveBackgroundProbes = 0
    const finishBackgroundProbes: Array<(value: { mcp: boolean; extension: boolean }) => void> = []
    const { bridge, lifecycleRequests } = wslBridge({
      probe: async () => {
        if (!holdBackgroundProbe) return { mcp: false, extension: false }
        backgroundProbeCount++
        activeBackgroundProbes++
        maxActiveBackgroundProbes = Math.max(maxActiveBackgroundProbes, activeBackgroundProbes)
        return new Promise<{ mcp: boolean; extension: boolean }>((resolve) => {
          finishBackgroundProbes.push(resolve)
        }).finally(() => {
          activeBackgroundProbes--
        })
      },
    })
    globalThis.setInterval = ((callback: TimerHandler) => {
      if (typeof callback === "function") retryCallbacks.push(callback as () => void)
      return retryCallbacks.length as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => undefined) as typeof clearInterval

    const first = pluginContext()
    const second = pluginContext()
    const cleanupFirst = await installBridge(first.context as any, bridge)
    const cleanupSecond = await installBridge(second.context as any, bridge)

    expect(bridge.status().state).toBe("failed")
    expect(lifecycleRequests).toEqual(["start", "start"])
    expect(retryCallbacks).toHaveLength(2)

    holdBackgroundProbe = true
    retryCallbacks[0]!()
    retryCallbacks[0]!()
    retryCallbacks[1]!()
    expect(backgroundProbeCount).toBe(1)
    expect(maxActiveBackgroundProbes).toBe(1)
    finishBackgroundProbes[0]!({ mcp: false, extension: false })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(bridge.status().state).toBe("failed")
    expect(lifecycleRequests).toEqual(["start", "start"])
    retryCallbacks[0]!()
    retryCallbacks[1]!()
    expect(backgroundProbeCount).toBe(2)
    expect(maxActiveBackgroundProbes).toBe(1)
    finishBackgroundProbes[1]!({ mcp: true, extension: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(bridge.status().state).toBe("ready")
    expect(backgroundProbeCount).toBe(2)
    expect(maxActiveBackgroundProbes).toBe(1)
    expect(lifecycleRequests).toEqual(["start", "start"])
    expect(first.mcpReloads).toBeGreaterThan(0)
    expect(second.mcpReloads).toBeGreaterThan(0)
    await cleanupFirst()
    await cleanupSecond()
    expect(lifecycleRequests).toEqual(["start", "start"])
  })

  test("first shared cleanup preserves retry probe; last cleanup aborts it", async () => {
    let holdProbe = false
    let finishProbe!: (value: { mcp: boolean; extension: boolean }) => void
    const { bridge, lifecycleRequests, probes } = wslBridge({
      probe: async () => holdProbe
        ? new Promise<{ mcp: boolean; extension: boolean }>((resolve) => { finishProbe = resolve })
        : { mcp: false, extension: false },
    })
    globalThis.setInterval = ((callback: TimerHandler) => {
      if (typeof callback === "function") retryCallbacks.push(callback as () => void)
      return retryCallbacks.length as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => undefined) as typeof clearInterval
    const first = pluginContext()
    const second = pluginContext()
    const cleanupFirst = await installBridge(first.context as any, bridge)
    const cleanupSecond = await installBridge(second.context as any, bridge)
    holdProbe = true
    retryCallbacks[0]!()
    retryCallbacks[1]!()
    const retrySignal = probes.at(-1)?.signal
    expect(retrySignal).toBeDefined()
    expect(retrySignal?.aborted).toBe(false)

    await cleanupFirst()
    expect(retrySignal?.aborted).toBe(false)
    await cleanupSecond()
    expect(retrySignal?.aborted).toBe(true)

    finishProbe({ mcp: true, extension: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.status().state).toBe("stopped")
    expect(lifecycleRequests).toEqual(["start", "start"])
  })

  test.each(["stop", "cleanup"] as const)(
    "fences pending WSL retry completion after %s",
    async (action) => {
      let holdBackgroundProbe = false
      let finishBackgroundProbe!: (value: { mcp: boolean; extension: boolean }) => void
      const { bridge, lifecycleRequests, probes } = wslBridge({
        probe: async () => holdBackgroundProbe
          ? new Promise<{ mcp: boolean; extension: boolean }>((resolve) => {
            finishBackgroundProbe = resolve
          })
          : { mcp: false, extension: false },
      })
      globalThis.setInterval = ((callback: TimerHandler) => {
        if (typeof callback === "function") retryCallbacks.push(callback as () => void)
        return retryCallbacks.length as unknown as ReturnType<typeof setInterval>
      }) as typeof setInterval
      globalThis.clearInterval = (() => undefined) as typeof clearInterval

      const setup = pluginContext()
      const sharedSetup = action === "stop" ? pluginContext() : undefined
      const cleanup = await installBridge(setup.context as any, bridge)
      const cleanupShared = sharedSetup === undefined
        ? undefined
        : await installBridge(sharedSetup.context as any, bridge)
      holdBackgroundProbe = true
      retryCallbacks[0]!()
      if (sharedSetup !== undefined) retryCallbacks[1]!()
      expect(finishBackgroundProbe).toBeDefined()

      if (action === "stop") {
        await setup.commands.get("playwright-stop")!.execute({
          sessionID: "session",
          prompt: { text: "" },
          delivery: "inline",
        })
        expect(lifecycleRequests).toEqual(["start", "start", "stop"])
      } else {
        await cleanup()
        expect(lifecycleRequests).toEqual(["start"])
      }
      const reloadsAfterAction = setup.mcpReloads
      const sharedReloadsAfterAction = sharedSetup?.mcpReloads
      const probesAfterAction = probes.length
      retryCallbacks[0]!()
      if (sharedSetup !== undefined) retryCallbacks[1]!()
      expect(probes).toHaveLength(probesAfterAction)

      finishBackgroundProbe({ mcp: true, extension: true })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(bridge.status().state).toBe("stopped")
      expect(setup.mcpReloads).toBe(reloadsAfterAction)
      if (sharedSetup !== undefined) expect(sharedSetup.mcpReloads).toBe(sharedReloadsAfterAction)
      if (action === "stop") {
        await cleanup()
        await cleanupShared!()
      }
      expect(lifecycleRequests).toEqual(action === "stop" ? ["start", "start", "stop"] : ["start"])
    },
  )

  test("explicit start and restart commands still request Windows owner lifecycle", async () => {
    const { bridge, lifecycleRequests } = wslBridge()
    globalThis.setInterval = ((callback: TimerHandler) => {
      if (typeof callback === "function") retryCallbacks.push(callback as () => void)
      return retryCallbacks.length as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => undefined) as typeof clearInterval
    const setup = pluginContext()
    const cleanup = await installBridge(setup.context as any, bridge)

    await setup.commands.get("playwright-restart")!.execute({
      sessionID: "session",
      prompt: { text: "" },
      delivery: "inline",
    })
    expect(lifecycleRequests).toEqual(["start", "restart"])

    await setup.commands.get("playwright-start")!.execute({
      sessionID: "session",
      prompt: { text: "" },
      delivery: "inline",
    })
    expect(lifecycleRequests).toEqual(["start", "restart", "start"])
    await cleanup()
    expect(lifecycleRequests).toEqual(["start", "restart", "start"])
  })

  test("late retry completion after explicit restart cannot re-register MCP", async () => {
    let holdRetryProbe = false
    let finishRetryProbe!: (value: { mcp: boolean; extension: boolean }) => void
    const { bridge, lifecycleRequests } = wslBridge({
      probe: async () => holdRetryProbe
        ? new Promise<{ mcp: boolean; extension: boolean }>((resolve) => { finishRetryProbe = resolve })
        : { mcp: false, extension: false },
    })
    globalThis.setInterval = ((callback: TimerHandler) => {
      if (typeof callback === "function") retryCallbacks.push(callback as () => void)
      return retryCallbacks.length as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => undefined) as typeof clearInterval
    const setup = pluginContext()
    const cleanup = await installBridge(setup.context as any, bridge)
    holdRetryProbe = true
    retryCallbacks[0]!()
    expect(finishRetryProbe).toBeDefined()

    holdRetryProbe = false
    await setup.commands.get("playwright-restart")!.execute({
      sessionID: "session",
      prompt: { text: "" },
      delivery: "inline",
    })
    expect(lifecycleRequests).toEqual(["start", "restart"])
    const reloadsAfterRestart = setup.mcpReloads

    finishRetryProbe({ mcp: true, extension: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.status().state).toBe("failed")
    expect(setup.mcpReloads).toBe(reloadsAfterRestart)

    await cleanup()
    expect(lifecycleRequests).toEqual(["start", "restart"])
  })

  test("explicit stop still requests the Windows owner", async () => {
    const { bridge, lifecycleRequests } = wslBridge()

    await bridge.stop()

    expect(lifecycleRequests).toEqual(["stop"])
    expect(bridge.status().state).toBe("stopped")
  })

  test("failed WSL stop reports a sanitized state and rethrows while late retry stays fenced", async () => {
    const ownerFailure = new Error("private Windows owner detail")
    let finishProbe!: (value: { mcp: boolean; extension: boolean }) => void
    const { bridge, lifecycleRequests } = wslBridge({
      probe: () => new Promise((resolve) => { finishProbe = resolve }),
      request: async (action) => {
        if (action === "stop") throw ownerFailure
      },
    })

    const retry = bridge.retryWslProxy()
    const stopping = bridge.stop()
    await expect(stopping).rejects.toBe(ownerFailure)
    expect(lifecycleRequests).toEqual(["stop"])
    expect(bridge.status()).toMatchObject({
      state: "failed",
      reason: "Windows Playwright owner request failed",
    })
    expect(bridge.status().reason).not.toContain("private Windows owner detail")

    finishProbe({ mcp: true, extension: true })
    await retry
    expect(bridge.status()).toMatchObject({
      state: "failed",
      reason: "Windows Playwright owner request failed",
    })
  })

  test.each(["resolve", "reject"] as const)(
    "stale WSL stop %s cannot overwrite newer ready start",
    async (outcome) => {
      let finishStop!: () => void
      let rejectStop!: (error: Error) => void
      let probeCount = 0
      const stopRequest = new Promise<void>((resolve, reject) => {
        finishStop = resolve
        rejectStop = reject
      })
      const stopFailure = new Error("late stop failure")
      const { bridge, lifecycleRequests } = wslBridge({
        probe: async () => {
          probeCount++
          return probeCount === 1
            ? { mcp: false, extension: false }
            : { mcp: true, extension: true }
        },
        request: (action) => action === "stop" ? stopRequest : Promise.resolve(),
      })

      const stopping = bridge.stop()
      const starting = bridge.start()
      await starting
      expect(bridge.status().state).toBe("ready")

      if (outcome === "resolve") {
        finishStop()
        await stopping
      } else {
        rejectStop(stopFailure)
        await expect(stopping).rejects.toBe(stopFailure)
      }

      expect(lifecycleRequests).toEqual(["stop", "start"])
      expect(bridge.status().state).toBe("ready")
    },
  )

  test.each(["start", "restart"] as const)(
    "explicit %s aborts active proxy retry before later probes",
    async (action) => {
      let ownerRequestStarted!: () => void
      let finishOwnerRequest!: () => void
      let firstProbeSignal: AbortSignal | undefined
      let probeCount = 0
      const ownerStarted = new Promise<void>((resolve) => { ownerRequestStarted = resolve })
      const ownerRequest = new Promise<void>((resolve) => { finishOwnerRequest = resolve })
      const { bridge, lifecycleRequests, probes } = wslBridge({
        startupTimeoutMs: 250,
        startupPollMs: 250,
        probe: (signal) => {
          probeCount++
          if (probeCount === 1) {
            firstProbeSignal = signal
            return new Promise(() => undefined)
          }
          return Promise.resolve({ mcp: false, extension: false })
        },
        request: async (requestedAction) => {
          if (requestedAction === action) {
            ownerRequestStarted()
            await ownerRequest
          }
        },
      })

      const retry = bridge.retryWslProxy()
      const lifecycle = action === "start" ? bridge.start() : bridge.restart()
      await ownerStarted

      expect(firstProbeSignal?.aborted).toBe(true)
      expect(lifecycleRequests).toEqual([action])
      expect(probes[0]?.signal?.aborted).toBe(true)
      expect(probes.slice(1).every(({ signal }) => !signal?.aborted)).toBe(true)
      await expect(Promise.race([
        retry.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
      ])).resolves.toBe(true)
      await retry

      finishOwnerRequest()
      await lifecycle
      expect(bridge.status().state).toBe("failed")
      expect(lifecycleRequests).toEqual([action])
    },
  )

  test("superseded successful owner start does not trigger a proxy probe", async () => {
    let ownerStartStarted!: () => void
    let finishOwnerStart!: () => void
    const ownerStarted = new Promise<void>((resolve) => { ownerStartStarted = resolve })
    const ownerStart = new Promise<void>((resolve) => { finishOwnerStart = resolve })
    const { bridge, lifecycleRequests, probes } = wslBridge({
      probe: async () => ({ mcp: false, extension: false }),
      request: async (action) => {
        if (action === "start") {
          ownerStartStarted()
          await ownerStart
        }
      },
    })

    const starting = bridge.start()
    await ownerStarted
    expect(probes).toHaveLength(1)

    await bridge.stop()
    finishOwnerStart()
    await starting

    expect(lifecycleRequests).toEqual(["start", "stop"])
    expect(probes).toHaveLength(1)
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

  test("bounds Windows owner requests and routes timeout through controlled failure", async () => {
    let processTimeout: number | undefined
    let script = ""
    const executor: WindowsOwnerLifecycleExecutor = (_command, args, options) => {
      processTimeout = options.timeout
      script = Buffer.from(args[3] ?? "", "base64").toString("utf16le")
      return { status: null, error: new Error("private timeout detail") }
    }
    const { bridge, lifecycleRequests } = wslBridge({
      request: async (action) => requestWindowsOwnerLifecycle(action, {}, "/unused", executor),
    })

    const status = await bridge.start()

    expect(processTimeout).toBe(25_000)
    expect(script.match(/-TimeoutSec 10/g)).toHaveLength(2)
    expect(script).toContain("Authorization = 'Basic '")
    expect(status.state).toBe("failed")
    expect(status.reason).toBe("Windows Playwright owner request failed")
    expect(status.reason).not.toContain("private timeout detail")
    expect(lifecycleRequests).toEqual(["start"])
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
