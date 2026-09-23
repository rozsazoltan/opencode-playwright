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

## Browser extension and tokens

Install the Playwright browser extension. Its upstream source is maintained in the
[microsoft/playwright GitHub repository](https://github.com/microsoft/playwright);
the [Chrome Web Store listing](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)
is also available. After installing it in Brave, click the Playwright extension
icon and copy the authentication key shown by its status UI.

On the Windows machine running the bridge, store that extension key in
`<OpenCode config>/.secrets/playwright-key` (by default,
`%USERPROFILE%\.config\opencode\.secrets\playwright-key`). Alternatively,
provide it directly to the Windows OpenCode service process:

```powershell
$env:OPENCODE_PLAYWRIGHT_EXTENSION_TOKEN = "<extension-key>"
```

Restart OpenCode after changing the environment so its service inherits the value.
The file is used when this variable is unset; a set-but-empty variable is an error.
Never commit or paste either token into `opencode.json`.

The proxy has a separate bearer token, distinct from the browser extension key.
When the Windows owner starts for the first time, it creates the default proxy token
file if it is missing, and never overwrites an existing file. Windows and WSL must
use that same file contents. Keep all secret files private and out of version control.

1. Start OpenCode on Windows once. The default file is
   `$HOME/.config/opencode/.secrets/playwright-mcp-proxy-key` (typically
   `%USERPROFILE%\.config\opencode\.secrets\playwright-mcp-proxy-key`).
2. In WSL, copy the Windows-created file into WSL's native OpenCode config, then
   restart WSL OpenCode so its read-on-setup token is refreshed:

```sh
WIN_USER="$(cmd.exe /c echo %USERNAME% | tr -d '\r')"
install -D -m 600 "/mnt/c/Users/$WIN_USER/.config/opencode/.secrets/playwright-mcp-proxy-key" \
  "$HOME/.config/opencode/.secrets/playwright-mcp-proxy-key"
```

If your Windows profile is not under `/mnt/c/Users`, adjust the source path to its
mounted location. Never display or paste either token value. Run `/playwright-instructions`
in OpenCode for current status and setup-specific next steps.

`/playwright-status` and `/playwright-instructions` post fixed-format user messages
without starting an agent response. The text is saved in the session history;
it is not an assistant message.

## Configuration environment variables

All entries are optional unless noted. File paths may be absolute or relative to
the OpenCode config directory. The defaults below apply when no plugin option or
environment override is set.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` (Windows: `%USERPROFILE%\.config\opencode`) | OpenCode config and `.secrets` directory. |
| `OPENCODE_PLAYWRIGHT_EXTENSION_TOKEN` | Unset; reads the extension key file instead | Extension key passed privately to the Playwright MCP child process. Set on the Windows OpenCode service only. |
| `OPENCODE_PLAYWRIGHT_EXTENSION_TOKEN_FILE` | `.secrets/playwright-key` | Path to the extension key file. Ignored when the direct token environment variable is set. |
| `OPENCODE_PLAYWRIGHT_PROXY_TOKEN_FILE` | `.secrets/playwright-mcp-proxy-key` | Path to the proxy bearer token file; same token must be present on Windows and WSL. |
| `OPENCODE_PLAYWRIGHT_HOST` | `localhost` | Loopback host for the Windows Playwright MCP server. Non-loopback values are restricted to `127.0.0.1`. |
| `OPENCODE_PLAYWRIGHT_PORT` | `8931` | MCP server port, bound to loopback on Windows. |
| `OPENCODE_PLAYWRIGHT_PROXY_HOST` | `0.0.0.0` | Bind address for the proxy that WSL connects to. Source-IP checks allow only addresses in the currently discovered WSL vEthernet NAT subnet. |
| `OPENCODE_PLAYWRIGHT_PROXY_PORT` | `8932` | Authenticated proxy port used by WSL. |
| `OPENCODE_PLAYWRIGHT_WINDOWS_HOST` | Auto-detected from WSL routing/DNS; fallback `127.0.0.1` | Windows host address WSL uses to reach the MCP proxy. |
| `OPENCODE_PLAYWRIGHT_EXECUTABLE_PATH` | `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe` | Brave executable path. |
| `OPENCODE_PLAYWRIGHT_PROFILE_DIR_NAME` | `Default` | Brave profile directory used by Playwright. |
| `OPENCODE_PLAYWRIGHT_STARTUP_TIMEOUT_MS` | `15000` | Maximum time to wait for MCP readiness. |
| `OPENCODE_PLAYWRIGHT_STARTUP_POLL_MS` | `100` | Interval between readiness checks. |
| `OPENCODE_PLAYWRIGHT_SHUTDOWN_TIMEOUT_MS` | `5000` | Graceful child-process shutdown timeout before force cleanup. |
| `OPENCODE_PLAYWRIGHT_WINDOWS_SERVICE_URL` | `http://127.0.0.1:49374` | Windows OpenCode service API used by WSL to request owner start/stop. |
| `OPENCODE_SERVER_PASSWORD` | Unset; falls back to `service.json` when present | Password for the Windows OpenCode service API; unrelated to either Playwright token. |

### Why there are two ports

Port `8931` is the local Playwright MCP server launched beside Brave on Windows.
Port `8932` is a separate authenticated proxy that WSL can reach; it forwards
requests to the local MCP server and requires the shared proxy token. Keeping the
MCP server on loopback avoids exposing it directly to WSL or the network, while the
proxy provides the controlled cross-WSL connection. The two ports must be distinct.

The proxy continues to bind to `0.0.0.0`, but checks each connection's source IP
against the currently discovered WSL `vEthernet` NAT subnet and fails closed when
that subnet cannot be discovered. This is a source-subnet check, not WSL process
identity or full network isolation: the proxy does not verify the incoming network
interface, and any client whose source address is in the same subnet can match.
Windows may still show an OS firewall warning because the proxy binds on all
interfaces; the plugin does not change firewall settings. Do not add port forwarding
or expose the proxy port beyond the trusted host/network. The proxy bearer token
remains mandatory in addition to the source-IP check.

This access model relies on WSL NAT networking. Mirrored networking and WSL
localhost/loopback access may not present a source address in the discovered NAT
subnet and are not supported by this subnet check.

## Logs

The plugin writes error-focused diagnostics to `opencode-playwright-bridge.log` in
OpenCode's log directory. For OpenCode 2.0.15, this is resolved from
`$XDG_DATA_HOME/opencode/log`, or defaults to `~/.local/share/opencode/log` when
`XDG_DATA_HOME` is unset. This location follows OpenCode's internal path behavior
and may change in a future OpenCode release.

`PLAYWRIGHT_MCP_EXTENSION_TOKEN` is set internally for the MCP child process from
the configured extension key; it is not the name of the user-facing override.

## Playwright focus patch

Before starting the Windows owner, the bridge applies the version-pinned patch to its
plugin-resolved `playwright-core` bundle. The extension creates new tabs with
`active: false`, keeping the user's previously active tab focused. The patch is
idempotent, and the bridge fails closed if the bundle is unavailable, unwritable, or
does not have the expected shape. WSL clients do not modify a bundle.

The patch artifact under `patches/` is kept for review and reproducibility; the bridge
applies the same narrowly scoped source change at runtime.

## Development

This repository uses Bun for testing:

```sh
bun install
bun run test
```
