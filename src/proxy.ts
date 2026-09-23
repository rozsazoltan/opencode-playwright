import { timingSafeEqual } from "node:crypto"
import { networkInterfaces } from "node:os"

export type ProxyOptions = {
  hostname: string
  port: number
  targetOrigin: URL
  bearerToken: string
  /** Test-only override. Production callers should use discovered WSL NAT ranges. */
  allowedClientCidrs?: string[]
  /** Test-only discovery seam. */
  discoverClientCidrs?: () => string[]
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

type Ipv4 = readonly [number, number, number, number]
type Ipv4Cidr = { network: number; prefix: number }

function parseIpv4(address: string): Ipv4 | null {
  const parts = address.split(".")
  if (parts.length !== 4) return null
  const octets = parts.map((part) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return -1
    const value = Number(part)
    return value <= 255 ? value : -1
  })
  if (octets.some((octet) => octet < 0)) return null
  return octets as unknown as Ipv4
}

function ipv4Number(address: Ipv4): number {
  return (((address[0] << 24) | (address[1] << 16) | (address[2] << 8) | address[3]) >>> 0)
}

function parseCidr(cidr: string): Ipv4Cidr | null {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr)
  if (!match) return null
  const address = parseIpv4(match[1]!)
  const prefix = Number(match[2])
  if (!address || prefix === 0 || prefix > 32) return null
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return { network: ipv4Number(address) & mask, prefix }
}

function netmaskPrefix(netmask: string): number | null {
  const address = parseIpv4(netmask)
  if (!address) return null
  const mask = ipv4Number(address)
  const inverted = (~mask) >>> 0
  if (((inverted + 1) & inverted) !== 0) return null
  return mask.toString(2).replace(/0/g, "").length
}

export function discoverWslNatCidrs(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const cidrs: string[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!/^vEthernet \(WSL/i.test(name) || !entries) continue
    for (const entry of entries) {
      if (entry.internal || (entry.family !== "IPv4" && entry.family !== 4)) continue
      const address = parseIpv4(entry.address)
      const prefix = netmaskPrefix(entry.netmask)
      if (!address || prefix === null) continue
      cidrs.push(`${entry.address}/${prefix}`)
    }
  }
  return cidrs
}

export function isAllowedClientAddress(address: string | null, cidrs: readonly string[]): boolean {
  if (address === null) return false
  const normalized = /^::ffff:/i.test(address) ? address.slice("::ffff:".length) : address
  const parsedAddress = parseIpv4(normalized)
  if (!parsedAddress) return false
  const numericAddress = ipv4Number(parsedAddress)
  return cidrs.some((cidr) => {
    const parsedCidr = parseCidr(cidr)
    if (!parsedCidr) return false
    const mask = (0xffffffff << (32 - parsedCidr.prefix)) >>> 0
    return (numericAddress & mask) === parsedCidr.network
  })
}

function validateClientCidrs(cidrs: readonly string[]): Ipv4Cidr[] {
  if (cidrs.length === 0) throw new Error("No WSL NAT client subnets could be detected")
  const parsed = cidrs.map(parseCidr)
  if (parsed.some((cidr) => cidr === null)) throw new Error("Invalid allowed client CIDR")
  return parsed as Ipv4Cidr[]
}

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
  allowedClientCidrs?: readonly string[],
): (
  request: Request,
  acceptMcpStream?: (request: Request) => void,
  clientAddress?: string | null,
) => Promise<Response> {
  const targetOrigin = new URL(options.targetOrigin.href)

  return async (request, acceptMcpStream, clientAddress) => {
    if (allowedClientCidrs && !isAllowedClientAddress(clientAddress ?? null, allowedClientCidrs)) {
      return new Response("Forbidden", { status: 403 })
    }
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
  const discovery = options.discoverClientCidrs ?? discoverWslNatCidrs
  const allowedClientCidrs = options.allowedClientCidrs ?? discovery()
  validateClientCidrs(allowedClientCidrs)
  const resolveClientCidrs = options.allowedClientCidrs
    ? () => options.allowedClientCidrs!
    : discovery
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    idleTimeout: 10,
    http2: false,
    fetch(request, server) {
      let requestCidrs: string[]
      try {
        requestCidrs = resolveClientCidrs()
        validateClientCidrs(requestCidrs)
      } catch {
        return new Response("Forbidden", { status: 403 })
      }
      return createProxyHandlerInternal(options, requestCidrs)(
        request,
        (acceptedRequest) => server.timeout(acceptedRequest, 0),
        server.requestIP(request)?.address,
      )
    },
  })

  return {
    url: new URL("/mcp", server.url),
    stop(closeActiveConnections) {
      server.stop(closeActiveConnections)
    },
  }
}
