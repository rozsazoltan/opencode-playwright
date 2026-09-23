import { afterEach, describe, expect, test } from "bun:test"
import { createConnection } from "node:net"
import {
  createProxyHandler,
  discoverWslNatCidrs,
  isAllowedClientAddress,
  startProxy,
} from "../src/proxy"

const servers = new Set<ReturnType<typeof Bun.serve>>()

afterEach(() => {
  for (const server of servers) server.stop(true)
  servers.clear()
})

function createTestProxy(bearerToken: string) {
  let requestCount = 0
  let lastRequest:
    | {
        authorization: string | null
        body: string
        forwardedHeader: string | null
        method: string
        pathname: string
        search: string
      }
    | undefined

  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requestCount++
      const url = new URL(request.url)
      lastRequest = {
        authorization: request.headers.get("authorization"),
        body: await request.text(),
        forwardedHeader: request.headers.get("x-forwarded-test"),
        method: request.method,
        pathname: url.pathname,
        search: url.search,
      }
      const body = new ReadableStream<string>({
        start(controller) {
          controller.enqueue("upstream-")
          controller.enqueue("stream")
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain", "x-upstream": "preserved" },
      })
    },
  })
  servers.add(upstream)

  const targetOrigin = new URL(`http://127.0.0.1:${upstream.port}`)
  return {
    handler: createProxyHandler({ targetOrigin, bearerToken }),
    lastRequest: () => lastRequest,
    targetOrigin,
    upstreamRequests: () => requestCount,
  }
}

describe("Playwright proxy", () => {
  test("discovers valid IPv4 subnets only from WSL virtual Ethernet adapters", () => {
    const discovered = discoverWslNatCidrs({
      "vEthernet (WSL)": [
        { address: "172.28.64.1", netmask: "255.255.240.0", family: "IPv4", internal: false, mac: "", cidr: "172.28.64.1/20", scopeid: 0 },
        { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, mac: "", cidr: "127.0.0.1/8", scopeid: 0 },
        { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, mac: "", cidr: "fe80::1/64", scopeid: 0 },
        { address: "172.28.1.2", netmask: "255.0.255.0", family: "IPv4", internal: false, mac: "", cidr: "172.28.1.2/16", scopeid: 0 },
      ],
      "Ethernet": [
        { address: "10.0.0.1", netmask: "255.255.255.0", family: "IPv4", internal: false, mac: "", cidr: "10.0.0.1/24", scopeid: 0 },
      ],
    })

    expect(discovered).toEqual(["172.28.64.1/20"])
  })

  test("matches only IPv4 client addresses within valid CIDRs", () => {
    const cidrs = ["192.0.2.0/24"]
    expect(isAllowedClientAddress("192.0.2.45", cidrs)).toBe(true)
    expect(isAllowedClientAddress("192.0.3.45", cidrs)).toBe(false)
    expect(isAllowedClientAddress("10.0.0.1", cidrs)).toBe(false)
    expect(isAllowedClientAddress("127.0.0.1", cidrs)).toBe(false)
    expect(isAllowedClientAddress("::1", cidrs)).toBe(false)
    expect(isAllowedClientAddress("2001:db8::1", cidrs)).toBe(false)
    expect(isAllowedClientAddress("::ffff:192.0.2.45", cidrs)).toBe(true)
    expect(isAllowedClientAddress("::ffff:192.0.3.45", cidrs)).toBe(false)
    expect(isAllowedClientAddress(null, cidrs)).toBe(false)
    expect(isAllowedClientAddress("192.0.2.1", ["192.0.2.0/33"])).toBe(false)
    expect(isAllowedClientAddress("192.0.2.1", ["0.0.0.0/0"])).toBe(false)
    expect(isAllowedClientAddress("192.0.2.1", ["192.0.2.1/0"])).toBe(false)
  })

  test("startProxy fails closed when configured client CIDRs are absent or invalid", () => {
    const options = {
      hostname: "127.0.0.1",
      port: 0,
      targetOrigin: new URL("http://127.0.0.1:1"),
      bearerToken: "correct-token",
    }
    expect(() => startProxy({ ...options, allowedClientCidrs: [] })).toThrow()
    expect(() => startProxy({ ...options, allowedClientCidrs: ["192.0.2.0/33"] })).toThrow()
    expect(() => startProxy({ ...options, allowedClientCidrs: ["0.0.0.0/0"] })).toThrow()
    expect(() => startProxy({ ...options, allowedClientCidrs: ["192.0.2.1/0"] })).toThrow()
  })

  test("refreshes discovered CIDRs per request and denies requests when discovery disappears", async () => {
    const { targetOrigin, upstreamRequests } = createTestProxy("correct-token")
    let discoveryCalls = 0
    const proxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      targetOrigin,
      bearerToken: "correct-token",
      discoverClientCidrs: () => {
        discoveryCalls++
        if (discoveryCalls === 1) return ["127.0.0.1/32"]
        if (discoveryCalls === 2) return ["192.0.2.0/24"]
        return []
      },
    })

    try {
      const response = await fetch(proxy.url, {
        headers: { authorization: "Bearer correct-token" },
      })
      expect(response.status).toBe(403)
      expect(upstreamRequests()).toBe(0)

      const disappeared = await fetch(proxy.url, {
        headers: { authorization: "Bearer correct-token" },
      })
      expect(disappeared.status).toBe(403)
      expect(upstreamRequests()).toBe(0)
      expect(discoveryCalls).toBe(3)
    } finally {
      proxy.stop(true)
    }
  })

  test("startProxy rejects clients outside its configured subnet before forwarding", async () => {
    const { targetOrigin, upstreamRequests } = createTestProxy("correct-token")
    const rejectedProxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      targetOrigin,
      bearerToken: "correct-token",
      allowedClientCidrs: ["192.0.2.0/24"],
    })

    try {
      const rejected = await fetch(rejectedProxy.url, {
        headers: { authorization: "Bearer correct-token" },
      })
      expect(rejected.status).toBe(403)
      expect(await rejected.text()).toBe("Forbidden")
      expect(upstreamRequests()).toBe(0)
    } finally {
      rejectedProxy.stop(true)
    }

    const allowedProxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      targetOrigin,
      bearerToken: "correct-token",
      allowedClientCidrs: ["127.0.0.1/32"],
    })
    try {
      const allowed = await fetch(allowedProxy.url, {
        headers: { authorization: "Bearer correct-token" },
      })
      expect(allowed.status).toBe(200)
      expect(await allowed.text()).toBe("upstream-stream")
      expect(upstreamRequests()).toBe(1)
    } finally {
      allowedProxy.stop(true)
    }
  })

  test("rejects a missing bearer token without contacting upstream", async () => {
    const { handler, upstreamRequests } = createTestProxy("correct-token")

    const response = await handler(new Request("http://proxy.test/mcp", { method: "POST" }))

    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain("correct-token")
    expect(upstreamRequests()).toBe(0)
  })

  test("rejects a prefix-colliding bearer token", async () => {
    const { handler, upstreamRequests } = createTestProxy("correct-token")

    const response = await handler(
      new Request("http://proxy.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer correct-token-extra" },
      }),
    )

    expect(response.status).toBe(401)
    expect(upstreamRequests()).toBe(0)
  })

  test("rejects malformed and same-length incorrect credentials without contacting upstream", async () => {
    const { handler, upstreamRequests } = createTestProxy("correct-token")

    for (const authorization of ["Basic correct-token", "Bearer xorrect-token"]) {
      const response = await handler(
        new Request("http://proxy.test/mcp", { headers: { authorization } }),
      )
      expect(response.status).toBe(401)
    }
    expect(upstreamRequests()).toBe(0)
  })

  test("rejects unsupported routes and methods before contacting upstream", async () => {
    const { handler, upstreamRequests } = createTestProxy("correct-token")

    for (const request of [
      new Request("http://proxy.test/not-mcp"),
      new Request("http://proxy.test/mcp", {
        method: "PUT",
        headers: { authorization: "Bearer correct-token" },
      }),
    ]) {
      const response = await handler(request)
      expect(response.status).toBe(404)
    }
    expect(upstreamRequests()).toBe(0)
  })

  test("forwards an authenticated MCP request and preserves the streaming response", async () => {
    const { handler, lastRequest, upstreamRequests } = createTestProxy("correct-token")

    const response = await handler(
      new Request("http://proxy.test/mcp?session=one", {
        method: "POST",
        headers: {
          authorization: "Bearer correct-token",
          "content-type": "application/json",
          "x-forwarded-test": "yes",
        },
        body: '{"jsonrpc":"2.0"}',
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-upstream")).toBe("preserved")
    expect(await response.text()).toBe("upstream-stream")
    expect(upstreamRequests()).toBe(1)
    expect(lastRequest()).toEqual({
      authorization: null,
      body: '{"jsonrpc":"2.0"}',
      forwardedHeader: "yes",
      method: "POST",
      pathname: "/mcp",
      search: "?session=one",
    })
  })

  test("returns a fixed 502 response when the upstream connection fails", async () => {
    const handler = createProxyHandler({
      targetOrigin: new URL("http://127.0.0.1:1"),
      bearerToken: "correct-token",
    })

    const response = await handler(
      new Request("http://proxy.test/health", {
        headers: { authorization: "Bearer correct-token" },
      }),
    )

    expect(response.status).toBe(502)
    expect(await response.text()).toBe("Playwright bridge upstream unavailable")
  })

  test("startProxy owns a listener backed by the authenticated handler", async () => {
    const { targetOrigin, upstreamRequests } = createTestProxy("correct-token")
    const proxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      targetOrigin,
      bearerToken: "correct-token",
      allowedClientCidrs: ["127.0.0.1/32"],
    })

    try {
      const response = await fetch(proxy.url, {
        headers: { authorization: "Bearer correct-token" },
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("upstream-stream")
      expect(upstreamRequests()).toBe(1)
    } finally {
      proxy.stop(true)
    }
  })

  test(
    "startProxy keeps an authenticated MCP stream open beyond its finite listener timeout",
    async () => {
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        fetch() {
          let delayedChunk: ReturnType<typeof setTimeout> | undefined
          const body = new ReadableStream<string>({
            start(controller) {
              controller.enqueue("initial-")
              delayedChunk = setTimeout(() => {
                controller.enqueue("delayed")
                controller.close()
              }, 12_000)
            },
            cancel() {
              clearTimeout(delayedChunk)
            },
          })
          return new Response(body, { headers: { "content-type": "text/event-stream" } })
        },
      })
      servers.add(upstream)

      const proxy = startProxy({
        hostname: "127.0.0.1",
        port: 0,
        targetOrigin: new URL(`http://127.0.0.1:${upstream.port}`),
        bearerToken: "correct-token",
        allowedClientCidrs: ["127.0.0.1/32"],
      })

      try {
        const startedAt = performance.now()
        const response = await fetch(proxy.url, {
          headers: { authorization: "Bearer correct-token" },
        })
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        const initial = await reader.read()
        expect(decoder.decode(initial.value, { stream: true })).toBe("initial-")
        expect(initial.done).toBe(false)
        expect(performance.now() - startedAt).toBeLessThan(1_000)

        const delayed = await reader.read()
        expect(decoder.decode(delayed.value, { stream: true })).toBe("delayed")
        expect(delayed.done).toBe(false)
      } finally {
        proxy.stop(true)
      }
    },
    18_000,
  )

  test(
    "startProxy closes an incomplete unauthenticated request within the listener timeout tolerance",
    async () => {
      const { targetOrigin } = createTestProxy("correct-token")
      const proxy = startProxy({
        hostname: "127.0.0.1",
        port: 0,
        targetOrigin,
        bearerToken: "correct-token",
        allowedClientCidrs: ["127.0.0.1/32"],
      })
      const startedAt = performance.now()
      const socket = createConnection({
        host: proxy.url.hostname,
        port: Number(proxy.url.port),
      })

      try {
        const elapsed = await new Promise<number>((resolve, reject) => {
          const deadline = setTimeout(() => {
            socket.destroy()
            reject(new Error("proxy left an incomplete unauthenticated request open beyond 16 seconds"))
          }, 16_000)
          const resolveElapsed = () => {
            clearTimeout(deadline)
            resolve(performance.now() - startedAt)
          }

          socket.once("error", reject)
          socket.once("end", resolveElapsed)
          socket.once("close", resolveElapsed)
          socket.once("connect", () => {
            socket.write(
              `POST /mcp HTTP/1.1\r\nHost: ${proxy.url.host}\r\nContent-Length: 100\r\n`,
            )
          })
        })

        expect(elapsed).toBeGreaterThanOrEqual(8_000)
        expect(elapsed).toBeLessThanOrEqual(16_000)
      } finally {
        socket.destroy()
        proxy.stop(true)
      }
    },
    18_000,
  )
})
