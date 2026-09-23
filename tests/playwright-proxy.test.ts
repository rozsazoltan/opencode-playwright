import { afterEach, describe, expect, test } from "bun:test"
import { createConnection } from "node:net"
import { createProxyHandler, startProxy } from "../src/proxy"

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
