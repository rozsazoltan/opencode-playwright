import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bridgeConfigFromOptions,
  configDirectory,
  installBridge,
  probeMcp,
  proxyTokenReference,
  resolveNodeExecutable,
} from "../src/index"
import { PlaywrightBridge, type BridgeDependencies, type BridgeStatus } from "../src/bridge"
import type { ProxyOptions, StartedProxy } from "../src/proxy"

const temporaryDirectories = new Set<string>()
const nativeFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = nativeFetch
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true })
  temporaryDirectories.clear()
})

function fakeDependencies(): BridgeDependencies {
  const configDir = mkdtempSync(join(tmpdir(), "playwright-bridge-test-"))
  temporaryDirectories.add(configDir)

  return {
    platform: "win32",
    env: { OPENCODE_CONFIG_DIR: configDir },
    fileExists: () => true,
    readText: () => "async doCreateNewPage() { background: true; focus: false }",
    resolve: (name) => name,
    isPortOpen: async () => false,
    spawn: () => ({ pid: 4242, onExit: () => undefined }),
    killTree: async () => undefined,
    sleep: async () => undefined,
    probeMcp: async () => ({ mcp: true, extension: true }),
    now: () => new Date("2026-09-21T00:00:00.000Z"),
    startProxy: () => ({ url: new URL("http://127.0.0.1:8932/mcp"), stop: () => undefined }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function ownerFile(dependencies: BridgeDependencies): string {
  return join(dependencies.env.OPENCODE_CONFIG_DIR!, "playwright-mcp-owner.json")
}

function adapterStatus(
  state: BridgeStatus["state"],
  mode: BridgeStatus["mode"] = "windows-owner",
): BridgeStatus {
  return {
    mode,
    state,
    endpoint: new URL("http://127.0.0.1:8931/mcp"),
    proxyEndpoint: new URL("http://127.0.0.1:8932/mcp"),
    proxyRunning: state === "ready",
    pid: state === "ready" ? 4242 : undefined,
    patchApplied: state === "ready",
    extensionConnected: state === "ready",
    reason: state === "ready" ? undefined : "proxy token=SECRET_MARKER",
  }
}

function adapterContext(options: {
  initialStatus?: BridgeStatus
  failMcpReload?: boolean
  failToolTransform?: boolean
  failCommandTransform?: boolean
} = {}) {
  const calls: string[] = []
  const servers = new Map<string, Record<string, unknown>>()
  const removedTools: string[] = []
  const commands = new Map<string, { execute(input: { sessionID: string }): Promise<void> }>()
  const synthetic: string[] = []
  let toolDisposed = 0
  let commandDisposed = 0
  const ctx = {
    mcp: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          set: (name: string, config: Record<string, unknown>) => servers.set(name, config),
          remove: (name: string) => {
            calls.push(`mcp.remove:${name}`)
            servers.delete(name)
          },
        })
        return { dispose: async () => undefined }
      },
      reload: async () => {
        calls.push("mcp.reload")
        if (options.failMcpReload) throw new Error("mcp reload failed")
      },
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        if (options.failToolTransform) throw new Error("tool transform failed")
        callback({ remove: (name: string) => removedTools.push(name) })
        return { dispose: async () => { toolDisposed++ } }
      },
      reload: async () => undefined,
    },
    command: {
      transform: async (callback: (editor: any) => void) => {
        if (options.failCommandTransform) throw new Error("command transform failed")
        callback({ add: (command: { name: string; execute(input: { sessionID: string }): Promise<void> }) => commands.set(command.name, command) })
        return { dispose: async () => { commandDisposed++ } }
      },
    },
    session: { synthetic: async ({ text }: { text: string }) => synthetic.push(text) },
  }
  return { ctx, calls, servers, removedTools, commands, synthetic, get toolDisposed() { return toolDisposed }, get commandDisposed() { return commandDisposed } }
}

function fakeAdapterBridge(initialStatus = adapterStatus("ready")) {
  let current = initialStatus
  const lifecycle: string[] = []
  const bridge = {
    start: async () => {
      lifecycle.push("start")
      current = adapterStatus(initialStatus.state, current.mode)
      return current
    },
    stop: async () => {
      lifecycle.push("stop")
      current = adapterStatus("stopped", current.mode)
    },
    restart: async () => {
      lifecycle.push("restart")
      current = adapterStatus("ready", current.mode)
      return current
    },
    status: () => current,
  }
  return { bridge: bridge as unknown as PlaywrightBridge, lifecycle }
}

describe("playwright bridge plugin options", () => {
  test("uses the resolved Node executable and falls back when resolution fails", () => {
    expect(resolveNodeExecutable({ status: 0, stdout: "C:\\tools\\node.exe\r\n" })).toBe(
      "C:\\tools\\node.exe",
    )
    expect(resolveNodeExecutable({ status: 1, stdout: "C:\\tools\\node.exe\n" })).toBe("node")
    expect(resolveNodeExecutable({ status: 0, stdout: "   " })).toBe("node")
  })

  test("accepts a configured directory containing opencode.json", () => {
    const environment = { OPENCODE_CONFIG_DIR: "C:\\configured" }
    const exists = (path: string) => path === join(environment.OPENCODE_CONFIG_DIR, "opencode.json")

    expect(configDirectory(environment, "C:\\home", exists)).toBe(environment.OPENCODE_CONFIG_DIR)
  })

  test("accepts a configured directory containing opencode.jsonc", () => {
    const environment = { OPENCODE_CONFIG_DIR: "C:\\configured" }
    const exists = (path: string) => path === join(environment.OPENCODE_CONFIG_DIR, "opencode.jsonc")

    expect(configDirectory(environment, "C:\\home", exists)).toBe(environment.OPENCODE_CONFIG_DIR)
  })

  test("falls back when the configured directory contains neither config file", () => {
    const environment = { OPENCODE_CONFIG_DIR: "\\" }
    const exists = () => false

    expect(configDirectory(environment, "C:\\home", exists)).toBe(join("C:\\home", ".config", "opencode"))
  })

  test("falls back when OPENCODE_CONFIG_DIR is absent", () => {
    const exists = () => false

    expect(configDirectory({}, "C:\\home", exists)).toBe(join("C:\\home", ".config", "opencode"))
  })

  test("maps owner options and normalizes a non-loopback Playwright host", () => {
    const configDir = mkdtempSync(join(tmpdir(), "playwright-options-owner-"))
    temporaryDirectories.add(configDir)
    const config = bridgeConfigFromOptions(
      {
        playwrightPort: 9041,
        proxyPort: 9042,
        playwrightHost: "192.168.1.20",
        proxyHost: "192.168.1.21",
        browserExecutable: "C:\\Brave\\brave.exe",
        profileDirName: "Profile 2",
        extensionTokenFile: ".secrets/extension-token",
        proxyTokenFile: ".secrets/owner-proxy-token",
         startupTimeoutMs: 3210,
         shutdownTimeoutMs: 6543,
      },
      configDir,
      {},
    )

    expect(config).toMatchObject({
      playwrightPort: 9041,
      proxyPort: 9042,
      playwrightHost: "127.0.0.1",
      proxyHost: "192.168.1.21",
      browserExecutable: "C:\\Brave\\brave.exe",
      profileDirName: "Profile 2",
      extensionTokenFile: join(configDir, ".secrets", "extension-token"),
      proxyTokenFile: join(configDir, ".secrets", "owner-proxy-token"),
       startupTimeoutMs: 3210,
       shutdownTimeoutMs: 6543,
    })
  })

  test("maps WSL overrides and keeps the MCP file reference token-free", () => {
    const configDir = mkdtempSync(join(tmpdir(), "playwright-options-wsl-"))
    temporaryDirectories.add(configDir)
    const options = {
      playwrightPort: 9041,
      proxyPort: 9042,
      playwrightHost: "127.0.0.1",
      proxyHost: "0.0.0.0",
      extensionTokenFile: ".secrets/wsl-extension-token",
      proxyTokenFile: ".secrets/wsl-proxy-token",
       startupTimeoutMs: 4321,
       shutdownTimeoutMs: 7654,
    }
    const config = bridgeConfigFromOptions(options, configDir, {
      WSL_DISTRO_NAME: "Ubuntu",
      OPENCODE_PLAYWRIGHT_WINDOWS_HOST: "172.20.0.1",
    })

    expect(config).toMatchObject({
      playwrightPort: 9041,
      proxyPort: 9042,
      playwrightHost: "127.0.0.1",
      proxyHost: "0.0.0.0",
      proxyTokenFile: join(configDir, ".secrets", "wsl-proxy-token"),
       startupTimeoutMs: 4321,
       shutdownTimeoutMs: 7654,
    })
    expect(proxyTokenReference(options, {})).toBe("./.secrets/wsl-proxy-token")
    expect(proxyTokenReference({}, {})).toBe("./.secrets/playwright-mcp-proxy-key")
  })
})

describe("MCP readiness probe", () => {
  test("performs a successful Streamable HTTP initialize handshake", async () => {
    const requests: RequestInit[] = []
    globalThis.fetch = (async (_input, init) => {
      requests.push(init ?? {})
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} },
          }),
          {
            headers: { "content-type": "application/json", "mcp-session-id": "session-fixture" },
          },
        )
      }
      return new Response(null, { status: 202 })
    }) as typeof fetch

    await expect(probeMcp(new URL("http://127.0.0.1:8931/mcp"))).resolves.toEqual({
      mcp: true,
      extension: true,
    })

    expect(requests).toHaveLength(2)
    expect(requests[0].method).toBe("POST")
    expect(requests[0].headers).toEqual({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    })
    expect(JSON.parse(String(requests[0].body))).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    })
    expect(requests[1].headers).toEqual({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Protocol-Version": "2025-03-26",
      "Mcp-Session-Id": "session-fixture",
    })
  })

  test("sends the optional bearer token on each request in an authenticated probe", async () => {
    const requests: RequestInit[] = []
    globalThis.fetch = (async (_input, init) => {
      requests.push(init ?? {})
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} },
        }),
        { headers: { "content-type": "application/json", "mcp-session-id": "session-fixture" } },
      )
    }) as typeof fetch

    await expect(probeMcp(new URL("http://127.0.0.1:8932/mcp"), "probe-token-fixture")).resolves.toEqual({
      mcp: true,
      extension: true,
    })

    expect(requests[0].headers).toMatchObject({ Authorization: "Bearer probe-token-fixture" })
    expect(requests[1].headers).toMatchObject({ Authorization: "Bearer probe-token-fixture" })
  })

  test("rejects an unsuccessful initialize response", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "invalid" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch

    await expect(probeMcp(new URL("http://127.0.0.1:8931/mcp"))).resolves.toEqual({
      mcp: false,
      extension: false,
    })
  })

  test(
    "aborts and cleans up a timed-out initialize request",
    async () => {
      let aborted = false
      globalThis.fetch = (async (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
        })
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
      }) as typeof fetch

      await expect(probeMcp(new URL("http://127.0.0.1:8931/mcp"))).resolves.toEqual({
        mcp: false,
        extension: false,
      })
      expect(aborted).toBe(true)
    },
    1_500,
  )
})

describe("PlaywrightBridge", () => {
  test("Windows passes the trimmed extension token only to the MCP child environment", async () => {
    const dependencies = fakeDependencies()
    const sourceEnvironment = dependencies.env
    const sourceEnvironmentSnapshot = { ...sourceEnvironment }
    let childEnvironment: NodeJS.ProcessEnv | undefined
    dependencies.readText = (path) =>
      path.endsWith("playwright-key")
        ? "  extension-token-fixture  \n"
        : "async doCreateNewPage() { background: true; focus: false }"
    dependencies.spawn = (_command, _args, options) => {
      childEnvironment = options.env
      return { pid: 4242, onExit: () => undefined }
    }

    await new PlaywrightBridge(dependencies).start()

    expect(sourceEnvironment).toEqual(sourceEnvironmentSnapshot)
    expect(childEnvironment).toEqual({
      ...sourceEnvironmentSnapshot,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "extension-token-fixture",
    })
    expect(childEnvironment).not.toBe(sourceEnvironment)
  })

  test("Windows rejects an empty extension token before spawning", async () => {
    const dependencies = fakeDependencies()
    let spawned = false
    dependencies.readText = (path) =>
      path.endsWith("playwright-key")
        ? " \n\t "
        : "async doCreateNewPage() { background: true; focus: false }"
    dependencies.spawn = () => {
      spawned = true
      throw new Error("must not spawn")
    }

    const status = await new PlaywrightBridge(dependencies).start()

    expect(spawned).toBe(false)
    expect(status).toMatchObject({
      state: "failed",
      reason: "Playwright prerequisites validation failed",
    })
  })

  test("Windows starts the authenticated proxy only after loopback MCP readiness", async () => {
    const dependencies = fakeDependencies()
    const events: string[] = []
    let receivedSeparateToken = false
    let receivedLoopbackTarget = false
    let receivedBinding = false
    dependencies.readText = (path) => {
       if (path.endsWith("playwright-mcp-proxy-key")) return "proxy-token\n"
      return "async doCreateNewPage() { background: true; focus: false }"
    }
    dependencies.probeMcp = async () => {
      events.push("probe")
      return { mcp: true, extension: true }
    }
    dependencies.startProxy = (options: ProxyOptions): StartedProxy => {
      events.push("proxy-start")
      receivedSeparateToken = options.bearerToken === "proxy-token"
      receivedLoopbackTarget = options.targetOrigin.href === "http://127.0.0.1:8931/mcp"
       receivedBinding = options.hostname === "192.168.50.10" && options.port === 8932
      return { url: new URL("http://127.0.0.1:8932/mcp"), stop: () => undefined }
    }

     const bridge = new PlaywrightBridge(dependencies, { proxyHost: "192.168.50.10" })
    const status = await bridge.start()

    expect(events).toEqual(["probe", "proxy-start"])
    expect(receivedSeparateToken).toBe(true)
    expect(receivedLoopbackTarget).toBe(true)
    expect(receivedBinding).toBe(true)
    expect(status.proxyEndpoint?.href).toBe("http://127.0.0.1:8932/mcp")
    await bridge.stop()
  })

  test("Windows stops the proxy before requesting child termination", async () => {
    const dependencies = fakeDependencies()
    const events: string[] = []
    dependencies.startProxy = () => ({
      url: new URL("http://127.0.0.1:8932/mcp"),
      stop: () => events.push("proxy-stop"),
    })
    dependencies.gracefulKillTree = async () => {
      events.push("child-graceful")
    }
    dependencies.waitForExit = async () => false
    dependencies.killTree = async () => {
      events.push("child-force")
    }

    const bridge = new PlaywrightBridge(dependencies)
    await bridge.start()
    await bridge.stop()

    expect(events).toEqual(["proxy-stop", "child-graceful", "child-force"])
  })

  test("Windows graceful shutdown does not force-kill an exited child", async () => {
    const dependencies = fakeDependencies()
    const events: string[] = []
    let onExit: ((code: number | null) => void) | undefined
    dependencies.spawn = () => ({
      pid: 4242,
      onExit: (listener) => {
        onExit = listener
      },
    })
    dependencies.gracefulKillTree = async (pid) => {
      events.push(`graceful:${pid}`)
      onExit!(0)
    }
    dependencies.killTree = async () => {
      events.push("force")
    }

    const bridge = new PlaywrightBridge(dependencies, { shutdownTimeoutMs: 20 })
    await bridge.start()
    await bridge.stop()

    expect(events).toEqual(["graceful:4242"])
    expect(bridge.status().state).toBe("stopped")
    expect(existsSync(ownerFile(dependencies))).toBe(false)
  })

  test("Windows shutdown force-kills exactly once after the graceful timeout", async () => {
    const dependencies = fakeDependencies()
    const events: string[] = []
    dependencies.gracefulKillTree = async (pid) => {
      events.push(`graceful:${pid}`)
    }
    dependencies.waitForExit = async (pid, timeoutMs) => {
      events.push(`wait:${pid}:${timeoutMs}`)
      return false
    }
    dependencies.killTree = async (pid) => {
      events.push(`force:${pid}`)
    }

    const bridge = new PlaywrightBridge(dependencies, { shutdownTimeoutMs: 37 })
    await bridge.start()
    await bridge.stop()

    expect(events).toEqual(["graceful:4242", "wait:4242:37", "force:4242"])
    expect(bridge.status().state).toBe("stopped")
    expect(existsSync(ownerFile(dependencies))).toBe(false)
  })

  test("graceful shutdown errors still force-clean the owned child", async () => {
    const dependencies = fakeDependencies()
    const events: string[] = []
    dependencies.gracefulKillTree = async () => {
      events.push("graceful")
      throw new Error("secret graceful failure")
    }
    dependencies.killTree = async () => {
      events.push("force")
    }

    const bridge = new PlaywrightBridge(dependencies)
    await bridge.start()
    await expect(bridge.stop()).rejects.toThrow("graceful shutdown failed")

    expect(events).toEqual(["graceful", "force"])
    expect(bridge.status().state).toBe("stopped")
    expect(existsSync(ownerFile(dependencies))).toBe(false)
  })

  test("WSL constructs the Windows proxy endpoint without starting a proxy", async () => {
    const dependencies = fakeDependencies()
    dependencies.platform = "linux"
    dependencies.env = {
      WSL_DISTRO_NAME: "Ubuntu",
      OPENCODE_PLAYWRIGHT_WINDOWS_HOST: "172.20.0.1",
      OPENCODE_PLAYWRIGHT_PROXY_PORT: "9342",
    }
    let proxyStarted = false
    let probeToken: string | undefined
    dependencies.readText = (path) =>
      path.endsWith("playwright-mcp-proxy-key")
        ? "wsl-proxy-token-fixture\n"
        : "async doCreateNewPage() { background: true; focus: false }"
    dependencies.probeMcp = async (_endpoint, bearerToken) => {
      probeToken = bearerToken
      return { mcp: true, extension: true }
    }
    dependencies.startProxy = () => {
      proxyStarted = true
      throw new Error("must not start proxy")
    }

    const status = await new PlaywrightBridge(dependencies).start()

    expect(proxyStarted).toBe(false)
    expect(status.proxyEndpoint?.href).toBe("http://172.20.0.1:9342/mcp")
    expect(status.proxyRunning).toBe(true)
    expect(probeToken).toBe("wsl-proxy-token-fixture")
  })

  test("WSL prefers the default route gateway over the resolv.conf nameserver", async () => {
    const dependencies = fakeDependencies()
    dependencies.platform = "linux"
    dependencies.env = { WSL_DISTRO_NAME: "Ubuntu" }
    dependencies.readText = (path) => {
      if (path === "/proc/net/route") {
        return [
          "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
          "eth0\t00000000\t010011AC\t0003\t0\t0\t100\t00000000\t0\t0\t0",
        ].join("\n")
      }
      if (path === "/etc/resolv.conf") return "nameserver 10.0.0.53\n"
      if (path.endsWith("playwright-mcp-proxy-key")) return "wsl-proxy-token-fixture\n"
      return "async doCreateNewPage() { background: true; focus: false }"
    }
    dependencies.probeMcp = async () => ({ mcp: true, extension: true })

    const status = await new PlaywrightBridge(dependencies).start()

    expect(status.endpoint.href).toBe("http://172.17.0.1:8931/mcp")
    expect(status.proxyEndpoint?.href).toBe("http://172.17.0.1:8932/mcp")
  })

  test("WSL falls back to the resolv.conf nameserver when the route is malformed", async () => {
    const dependencies = fakeDependencies()
    dependencies.platform = "linux"
    dependencies.env = { WSL_DISTRO_NAME: "Ubuntu" }
    dependencies.readText = (path) => {
      if (path === "/proc/net/route") return "eth0 00000000 not-an-ip"
      if (path === "/etc/resolv.conf") return "nameserver 10.0.0.53\n"
      if (path.endsWith("playwright-mcp-proxy-key")) return "wsl-proxy-token-fixture\n"
      return "async doCreateNewPage() { background: true; focus: false }"
    }
    dependencies.probeMcp = async () => ({ mcp: true, extension: true })

    const status = await new PlaywrightBridge(dependencies).start()

    expect(status.proxyEndpoint?.href).toBe("http://10.0.0.53:8932/mcp")
  })

  test("WSL falls back to loopback when the route and resolv.conf are unavailable", async () => {
    const dependencies = fakeDependencies()
    dependencies.platform = "linux"
    dependencies.env = { WSL_DISTRO_NAME: "Ubuntu" }
    dependencies.readText = (path) => {
      if (path === "/proc/net/route" || path === "/etc/resolv.conf") throw new Error("missing")
      if (path.endsWith("playwright-mcp-proxy-key")) return "wsl-proxy-token-fixture\n"
      return "async doCreateNewPage() { background: true; focus: false }"
    }
    dependencies.probeMcp = async () => ({ mcp: true, extension: true })

    const status = await new PlaywrightBridge(dependencies).start()

    expect(status.endpoint.href).toBe("http://127.0.0.1:8931/mcp")
    expect(status.proxyEndpoint?.href).toBe("http://127.0.0.1:8932/mcp")
  })

  test("WSL never spawns a local Playwright process", async () => {
    const dependencies = fakeDependencies()
    dependencies.platform = "linux"
    dependencies.env = { WSL_DISTRO_NAME: "Ubuntu" }
    let spawned = false
    dependencies.spawn = () => {
      spawned = true
      throw new Error("must not spawn")
    }

    const bridge = new PlaywrightBridge(dependencies)
    const status = await bridge.start()

    expect(status.mode).toBe("wsl-client")
    expect(spawned).toBe(false)
  })

  test("a listening server without the Brave extension is degraded", async () => {
    const dependencies = fakeDependencies()
    dependencies.probeMcp = async () => ({ mcp: true, extension: false })

    const bridge = new PlaywrightBridge(dependencies)
    const status = await bridge.start()

    expect(status.state).toBe("degraded")
    expect(status.reason).toContain("extension")
    await bridge.stop()
  })

  test("does not kill an unrelated process on an occupied port", async () => {
    const dependencies = fakeDependencies()
    dependencies.isPortOpen = async () => true
    let killed = false
    dependencies.killTree = async () => {
      killed = true
    }

    const status = await new PlaywrightBridge(dependencies).start()

    expect(status.state).toBe("failed")
    expect(status.reason).toContain("foreign-owned port")
    expect(killed).toBe(false)
  })

  test("stopping kills only the tracked child", async () => {
    const dependencies = fakeDependencies()
    let killedPid: number | undefined
    dependencies.killTree = async (pid) => {
      killedPid = pid
    }

    const bridge = new PlaywrightBridge(dependencies)
    await bridge.start()
    await bridge.stop()

    expect(killedPid).toBe(4242)
    expect(bridge.status().state).toBe("stopped")
  })

  test("a child exit during a readiness probe cannot be overwritten by the late probe result", async () => {
    const dependencies = fakeDependencies()
    const probeStarted = deferred<void>()
    const probeResult = deferred<{ mcp: boolean; extension: boolean }>()
    let onExit: ((code: number | null) => void) | undefined
    dependencies.spawn = () => ({
      pid: 4242,
      onExit: (listener) => {
        onExit = listener
      },
    })
    dependencies.probeMcp = () => {
      probeStarted.resolve()
      return probeResult.promise
    }

    const bridge = new PlaywrightBridge(dependencies)
    const starting = bridge.start()
    await probeStarted.promise
    onExit!(1)
    probeResult.resolve({ mcp: true, extension: true })

    expect((await starting).state).toBe("failed")
    expect(bridge.status().state).toBe("failed")
  })

  test("stop during start cannot be overwritten by the late probe result", async () => {
    const dependencies = fakeDependencies()
    const probeStarted = deferred<void>()
    const probeResult = deferred<{ mcp: boolean; extension: boolean }>()
    dependencies.probeMcp = () => {
      probeStarted.resolve()
      return probeResult.promise
    }

    const bridge = new PlaywrightBridge(dependencies)
    const starting = bridge.start()
    await probeStarted.promise
    await bridge.stop()
    probeResult.resolve({ mcp: true, extension: true })

    expect((await starting).state).toBe("stopped")
    expect(bridge.status().state).toBe("stopped")
  })

  test(
    "a pending readiness probe is bounded by the startup deadline",
    async () => {
      const dependencies = fakeDependencies()
      dependencies.probeMcp = () => new Promise(() => undefined)

      const status = await new PlaywrightBridge(dependencies, {
        startupTimeoutMs: 1,
        startupPollMs: 1,
      }).start()

      expect(status.state).toBe("failed")
      expect(status.reason).toContain("timed out")
    },
    100,
  )

  test("a rejected termination preserves ownership for a successful retry", async () => {
    const dependencies = fakeDependencies()
    let attempts = 0
    dependencies.killTree = async () => {
      attempts++
      if (attempts === 1) throw new Error("termination failed")
    }

    const bridge = new PlaywrightBridge(dependencies)
    await bridge.start()

    await expect(bridge.stop()).rejects.toThrow("termination failed")
    expect(bridge.status().state).toBe("stopping")
    expect(bridge.status().pid).toBe(4242)
    expect(existsSync(ownerFile(dependencies))).toBe(true)

    await bridge.stop()
    expect(bridge.status().state).toBe("stopped")
    expect(existsSync(ownerFile(dependencies))).toBe(false)
  })

  test("timeout cleanup failure returns a redacted failed status", async () => {
    const dependencies = fakeDependencies()
    dependencies.probeMcp = async () => ({ mcp: false, extension: false })
    dependencies.killTree = async () => {
      throw new Error("SYNTHETIC_SECRET_MARKER")
    }

    const bridge = new PlaywrightBridge(dependencies, {
      startupTimeoutMs: 1,
      startupPollMs: 1,
    })
    const status = await bridge.start()

    expect(status.state).toBe("failed")
    expect(status.pid).toBe(4242)
    expect(status.reason).not.toContain("SYNTHETIC_SECRET_MARKER")

    dependencies.killTree = async () => undefined
    await bridge.stop()
  })

  test("a bridge that did not acquire the lock cannot remove another bridge's record", async () => {
    const dependencies = fakeDependencies()
    const owner = new PlaywrightBridge(dependencies)
    const contender = new PlaywrightBridge(dependencies)
    await owner.start()

    const contenderStatus = await contender.start()
    expect(contenderStatus.state).toBe("failed")
    expect(contenderStatus.reason).toBe("Playwright owner lock is already held")
    await contender.stop()

    expect(existsSync(ownerFile(dependencies))).toBe(true)
    await owner.stop()
  })

  test("recovers a stale owner record when both PIDs and ports are inactive", async () => {
    const dependencies = fakeDependencies()
    dependencies.isProcessRunning = () => false
    writeFileSync(
      ownerFile(dependencies),
      JSON.stringify({ ownerPid: 99101, mcpPid: 99102, startedAt: "2026-09-22T00:00:00.000Z" }),
      "utf8",
    )

    const status = await new PlaywrightBridge(dependencies).start()

    expect(status.state).toBe("ready")
    expect(status.pid).toBe(4242)
  })

  test("does not recover a stale-looking record while either bridge port is occupied", async () => {
    const dependencies = fakeDependencies()
    dependencies.isProcessRunning = () => false
    dependencies.isPortOpen = async (_host, port) => port === 8931
    writeFileSync(
      ownerFile(dependencies),
      JSON.stringify({ ownerPid: 99201, mcpPid: 99202, startedAt: "2026-09-22T00:00:00.000Z" }),
      "utf8",
    )

    const status = await new PlaywrightBridge(dependencies).start()

    expect(status.state).toBe("failed")
    expect(status.reason).toBe("foreign-owned port is already listening")
    expect(existsSync(ownerFile(dependencies))).toBe(true)
  })

  test("dependency failures use controlled public diagnostics", async () => {
    const dependencies = fakeDependencies()
    dependencies.resolve = () => {
      throw new Error("SYNTHETIC_SECRET_MARKER")
    }

    const status = await new PlaywrightBridge(dependencies).start()

    expect(status.state).toBe("failed")
    expect(status.reason).not.toContain("SYNTHETIC_SECRET_MARKER")
  })

  test("restarting an already-owned child preserves patch verification", async () => {
    const dependencies = fakeDependencies()
    let portOpen = false
    dependencies.isPortOpen = async () => portOpen
    const bridge = new PlaywrightBridge(dependencies)
    expect((await bridge.start()).patchApplied).toBe(true)

    portOpen = true
    const status = await bridge.start()

    expect(status.state).toBe("ready")
    expect(status.patchApplied).toBe(true)
    await bridge.stop()
  })

  test("the Windows adapter registers the ready bridge and cleans up in order", async () => {
    const dependencies = fakeDependencies()
    const calls: string[] = []
    dependencies.startProxy = () => ({
      url: new URL("http://127.0.0.1:8932/mcp"),
      stop: () => calls.push("proxy.stop"),
    })
    dependencies.killTree = async (pid) => calls.push(`child.kill:${pid}`)

    const servers = new Map<string, Record<string, unknown>>()
    const removedTools: string[] = []
    const commands = new Map<string, { execute(input: { sessionID: string }): Promise<void> }>()
    const synthetic: string[] = []
    const ctx = {
      mcp: {
        transform: async (callback: (editor: any) => void) => {
          callback({
            set: (name: string, config: Record<string, unknown>) => servers.set(name, config),
            remove: (name: string) => {
              calls.push(`mcp.remove:${name}`)
              servers.delete(name)
            },
          })
          return { dispose: async () => undefined }
        },
        reload: async () => calls.push("mcp.reload"),
      },
      tool: {
        transform: async (callback: (editor: any) => void) => {
          callback({ remove: (name: string) => removedTools.push(name) })
          return { dispose: async () => undefined }
        },
        reload: async () => undefined,
      },
      command: {
        transform: async (callback: (editor: any) => void) => {
          callback({ add: (command: { name: string; execute(input: { sessionID: string }): Promise<void> }) => commands.set(command.name, command) })
          return { dispose: async () => undefined }
        },
      },
      session: {
        synthetic: async ({ text }: { text: string }) => synthetic.push(text),
      },
    }

    const bridge = new PlaywrightBridge(dependencies)
    const cleanup = await installBridge(ctx as any, bridge)

    expect(servers.get("playwright")).toEqual({
      type: "remote",
      url: "http://127.0.0.1:8931/mcp",
      oauth: false,
      disabled: false,
    })
    expect(removedTools).toEqual([
      "playwright_browser_tabs",
      "playwright_browser_run_code_unsafe",
    ])
    expect(commands.has("playwright-start")).toBe(true)
    expect(commands.has("playwright-stop")).toBe(true)
    expect(commands.has("playwright-restart")).toBe(true)
    expect(commands.has("playwright-status")).toBe(true)

    calls.splice(0)
    await cleanup()
    expect(calls).toEqual([
      "mcp.reload",
      "proxy.stop",
      "child.kill:4242",
    ])
    expect(synthetic).toEqual([])
  })

  test("the WSL adapter registers the Windows proxy with its resolved bearer token", async () => {
    const dependencies = fakeDependencies()
    dependencies.platform = "linux"
    dependencies.env = {
      WSL_DISTRO_NAME: "Ubuntu",
      OPENCODE_PLAYWRIGHT_WINDOWS_HOST: "172.20.0.1",
    }
    const servers = new Map<string, Record<string, unknown>>()
    const removedTools: string[] = []
    const ctx = {
      mcp: {
        transform: async (callback: (editor: any) => void) => {
          callback({
            set: (name: string, config: Record<string, unknown>) => servers.set(name, config),
            remove: () => undefined,
          })
          return { dispose: async () => undefined }
        },
        reload: async () => undefined,
      },
      tool: {
        transform: async (callback: (editor: any) => void) => {
          callback({ remove: (name: string) => removedTools.push(name) })
          return { dispose: async () => undefined }
        },
        reload: async () => undefined,
      },
      command: {
        transform: async () => ({ dispose: async () => undefined }),
      },
      session: { synthetic: async () => undefined },
    }

    await installBridge(ctx as any, new PlaywrightBridge(dependencies), "proxy-token-fixture")
    const server = servers.get("playwright")!
    expect(server).toMatchObject({
      type: "remote",
      url: "http://172.20.0.1:8932/mcp",
      oauth: false,
      disabled: false,
       headers: { Authorization: "Bearer proxy-token-fixture" },
     })
    expect(removedTools).toEqual([
      "playwright_browser_tabs",
      "playwright_browser_run_code_unsafe",
    ])
  })

  test("status distinguishes a configured proxy endpoint from a running proxy", async () => {
    const dependencies = fakeDependencies()
     dependencies.readText = (path) => path.endsWith("playwright-mcp-proxy-key")
      ? "proxy-token\n"
      : "async doCreateNewPage() { background: true; focus: false }"
    const bridge = new PlaywrightBridge(dependencies)
    expect((await bridge.start()).proxyRunning).toBe(true)
    expect(bridge.status().proxyEndpoint?.href).toBe("http://127.0.0.1:8932/mcp")

    await bridge.stop()

    expect(bridge.status().proxyEndpoint?.href).toBe("http://127.0.0.1:8932/mcp")
    expect(bridge.status().proxyRunning).toBe(false)
  })

  test("Windows lifecycle commands execute and use registration removal/reload paths", async () => {
    const { bridge, lifecycle } = fakeAdapterBridge()
    const fake = adapterContext()
    const cleanup = await installBridge(fake.ctx as any, bridge)
    fake.calls.splice(0)

    await fake.commands.get("playwright-start")!.execute({ sessionID: "session" })
    await fake.commands.get("playwright-stop")!.execute({ sessionID: "session" })
    await fake.commands.get("playwright-restart")!.execute({ sessionID: "session" })
    await fake.commands.get("playwright-status")!.execute({ sessionID: "session" })

    expect(lifecycle).toEqual(["start", "start", "stop", "restart"])
    expect(fake.calls).toEqual([
      "mcp.reload",
      "mcp.reload",
      "mcp.reload",
    ])
    expect(fake.synthetic.length).toBe(4)

    await cleanup()
    expect(fake.commandDisposed).toBe(1)
    expect(fake.toolDisposed).toBe(1)
  })

  test("WSL lifecycle commands control the Windows owner and report status", async () => {
    const { bridge, lifecycle } = fakeAdapterBridge(adapterStatus("ready", "wsl-client"))
    const fake = adapterContext()
    const cleanup = await installBridge(fake.ctx as any, bridge)
    lifecycle.splice(0)
    fake.synthetic.length = 0

    await fake.commands.get("playwright-start")!.execute({ sessionID: "session" })
    await fake.commands.get("playwright-stop")!.execute({ sessionID: "session" })
    await fake.commands.get("playwright-restart")!.execute({ sessionID: "session" })

    expect(lifecycle).toEqual(["start", "stop", "restart"])
    expect(fake.synthetic).toHaveLength(3)
    expect(fake.synthetic[0]).toContain("State: ready")
    expect(fake.synthetic[1]).toContain("State: stopped")
    expect(fake.synthetic[2]).toContain("State: ready")
    await cleanup()
  })

  test.each(["degraded", "failed"] as const)(
    "degraded/failed bridge status keeps registration and redacts operational status (%s)",
    async (state) => {
      const { bridge } = fakeAdapterBridge(adapterStatus(state))
      const fake = adapterContext()
      const cleanup = await installBridge(fake.ctx as any, bridge)

      expect(fake.servers.has("playwright")).toBe(true)
      await fake.commands.get("playwright-status")!.execute({ sessionID: "session" })
      expect(fake.synthetic[0]).toContain(`State: ${state}`)
      expect(fake.synthetic[0]).toContain("Proxy: http://127.0.0.1:8932/mcp")
      expect(fake.synthetic[0]).not.toContain("SECRET_MARKER")
      await cleanup()
    },
  )

  test("shared setup cleanup is idempotent and stops only after the final release", async () => {
    const { bridge, lifecycle } = fakeAdapterBridge()
    const first = adapterContext()
    const second = adapterContext()
    const cleanupFirst = await installBridge(first.ctx as any, bridge)
    const cleanupSecond = await installBridge(second.ctx as any, bridge)
    lifecycle.splice(0)

    await cleanupFirst()
    await cleanupFirst()
    expect(lifecycle).toEqual([])

    await cleanupSecond()
    await cleanupSecond()
    expect(lifecycle).toEqual(["stop"])
  })

  test.each([
    ["registration", { failMcpReload: true }],
    ["tool", { failToolTransform: true }],
    ["command", { failCommandTransform: true }],
  ] as const)("setup failure after bridge start shuts down the bridge (%s)", async (_label, options) => {
    const { bridge, lifecycle } = fakeAdapterBridge()
    const fake = adapterContext(options)

    await expect(installBridge(fake.ctx as any, bridge)).rejects.toThrow()
    expect(lifecycle).toContain("stop")
  })

  test("cleanup stops the bridge when registration removal fails and propagates the failure", async () => {
    const { bridge, lifecycle } = fakeAdapterBridge()
    const fake = adapterContext()
    const cleanup = await installBridge(fake.ctx as any, bridge)
    fake.ctx.mcp.reload = async () => { throw new Error("registration removal failed") }

    await expect(cleanup()).rejects.toThrow("registration removal failed")
    expect(lifecycle).toContain("stop")
    await cleanup()
  })
})
