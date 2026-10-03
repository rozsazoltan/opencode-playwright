# Project

opencode-playwright connects OpenCode to Playwright MCP on Windows.
Windows owns MCP and the browser; WSL clients use an authenticated proxy.
OpenCode loads the Bun ESM TypeScript entrypoint directly, without a build step.

- `src/index.ts`: plugin integration, configuration, and commands.
- `src/bridge.ts`: Windows owner and WSL client lifecycle.
- `src/proxy.ts`: authenticated forwarding and source-subnet checks.

## Development

```sh
bun install
bun run test
```

Keep dependency versions pinned and `bun.lock` in sync.
Make focused changes, reuse nearby patterns, and preserve unrelated user work and settings.
Add regression tests for changed behavior. Use isolated fixtures and mocks;
never test against a user's real browser or OpenCode configuration.
Update `README.md` when user-facing behavior or setup changes.

## Safety boundaries

Preserve graceful startup, shutdown, and cleanup. Keep MCP bound to loopback.
Preserve authentication and secret redaction; never expose tokens in logs or documentation.
The proxy requires bearer authentication and WSL NAT source-subnet checks.
Fail closed when the subnet cannot be verified. Subnet matching does not establish
WSL process identity or full network isolation.

## Playwright focus patch

`scripts/patch-playwright.mjs` applies a narrow, idempotent patch to the pinned bundle.
Keep the review artifact in `patches/` aligned with runtime changes.
Fail closed when the expected bundle cannot be verified.
Preserve background tab creation and no-foreground behavior for MCP tab selection
and recording, without changing internal selection or recording behavior.
Do not claim generic Playwright/CDP `Page.bringToFront` interception.
