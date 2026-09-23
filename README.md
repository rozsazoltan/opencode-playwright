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

## Playwright patch note

The bridge checks that its resolved `playwright-core` bundle contains the required
no-focus behavior before starting the Windows owner. Patch files in this repository
are maintainer artifacts, not a patched Playwright runtime.

Package-local `patchedDependencies` metadata cannot patch OpenCode's separately
resolved Playwright runtime. This package therefore does not claim to ship or
install a patched runtime. Ensure the Playwright runtime resolved by OpenCode has
the required behavior before using the Windows owner mode.

## Development

This repository uses Bun for testing:

```sh
bun install
bun run test
```
