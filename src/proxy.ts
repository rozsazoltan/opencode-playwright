import { timingSafeEqual } from "node:crypto"

export type ProxyOptions = {
  hostname: string
  port: number
  targetOrigin: URL
  bearerToken: string
}

export type StartedProxy = {
  url: URL
  stop(closeActiveConnections?: boolean): void
}

const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE"])
const ALLOWED_PATHS = new Set(["/mcp", "/health"])
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function copiedHeaders(headers: Headers, excluded: ReadonlySet<string> = new Set()): Headers {
  const result = new Headers()
  const connectionHeaders = new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  )

  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase()
    if (
      excluded.has(lowerName) ||
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      connectionHeaders.has(lowerName)
    ) {
      continue
    }
    result.append(name, value)
  }
  return result
}

function authorized(request: Request, bearerToken: string): boolean {
  const authorization = request.headers.get("authorization")
  if (authorization === null || !authorization.startsWith("Bearer ")) return false

  const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8")
  const expected = Buffer.from(bearerToken, "utf8")
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function createProxyHandlerInternal(
  options: Pick<ProxyOptions, "targetOrigin" | "bearerToken">,
): (request: Request, acceptMcpStream?: (request: Request) => void) => Promise<Response> {
  const targetOrigin = new URL(options.targetOrigin.href)

  return async (request, acceptMcpStream) => {
    const sourceUrl = new URL(request.url)
    if (!ALLOWED_METHODS.has(request.method) || !ALLOWED_PATHS.has(sourceUrl.pathname)) {
      return new Response("Not found", { status: 404 })
    }
    if (!authorized(request, options.bearerToken)) {
      return new Response("Unauthorized", { status: 401 })
    }

    const targetUrl = new URL(targetOrigin.href)
    targetUrl.pathname = sourceUrl.pathname
    targetUrl.search = sourceUrl.search

    const body = request.body
    const requestInit = {
      method: request.method,
      headers: copiedHeaders(request.headers, new Set(["authorization", "host"])),
      body,
      duplex: "half",
      redirect: "manual",
    } satisfies RequestInit & { duplex: "half" }

    try {
      const upstream = await fetch(targetUrl, requestInit)
      if (sourceUrl.pathname === "/mcp" && upstream.ok && upstream.body !== null) {
        acceptMcpStream?.(request)
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: copiedHeaders(upstream.headers),
      })
    } catch {
      return new Response("Playwright bridge upstream unavailable", { status: 502 })
    }
  }
}

export function createProxyHandler(
  options: Pick<ProxyOptions, "targetOrigin" | "bearerToken">,
): (request: Request) => Promise<Response> {
  const handler = createProxyHandlerInternal(options)
  return (request) => handler(request)
}

export function startProxy(options: ProxyOptions): StartedProxy {
  const handler = createProxyHandlerInternal(options)
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    idleTimeout: 10,
    http2: false,
    fetch(request, server) {
      return handler(request, (acceptedRequest) => server.timeout(acceptedRequest, 0))
    },
  })

  return {
    url: new URL("/mcp", server.url),
    stop(closeActiveConnections) {
      server.stop(closeActiveConnections)
    },
  }
}
