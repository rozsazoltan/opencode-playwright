# opencode-playwright

An OpenCode plugin that manages the Playwright MCP bridge on Windows and exposes it
to OpenCode through a WSL proxy when needed.

## Installation

Add the plugin to OpenCode's configuration using a pinned Git commit:

```json
{
  "plugins": [
    "opencode-playwright@git+https://github.com/rozsazoltan/opencode-playwright.git#<commit>"
  ]
}
```

Replace `<commit>` with the commit you want to install. A release tag can be used in
place of a commit hash, for example `#v0.1.0`. OpenCode loads the TypeScript entrypoint
directly, so no build step or generated `dist/` directory is required.

The plugin expects the normal OpenCode Playwright extension and token setup used by
the bridge. See the environment variable names in `src/index.ts`
for optional host, port, executable, profile, token-file, and timeout overrides.

## Playwright focus patch

On installation, the package applies the version-pinned patch to its own resolved
`playwright-core` bundle. The extension creates new tabs with `active: false`, keeping
the user's previously active tab focused. The bridge verifies this patch before
starting the Windows owner and fails closed if the expected bundle shape is not found.

The patch runs from the package's `postinstall` script, so install scripts must be
enabled. The patch artifact under `patches/` is kept for review and reproducibility;
the install script applies the same narrowly scoped source change.

## Development

This repository uses Bun for testing:

```sh
bun install
bun run test
```
