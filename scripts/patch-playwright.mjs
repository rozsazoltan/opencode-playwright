import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const replacements = [
  [
    `async createTarget(url3) {
        const tab2 = await this._sendToExtension("chrome.tabs.create", [{ url: url3 }]);`,
    `async createTarget(url3) {
        const tab2 = await this._sendToExtension("chrome.tabs.create", [{ url: url3, active: false }]);`,
  ],
  [
    `        await tab2.page.bringToFront();
        await tab2.updateWebMCPTools();`,
    `        // MCP page activation intentionally suppressed.
        await tab2.updateWebMCPTools();`,
  ],
  [
    `        await context.startRecording();
        await tab2.page.bringToFront();
        response2.addTextResult`,
    `        await context.startRecording();
        // MCP page activation intentionally suppressed.
        response2.addTextResult`,
  ],
]

export function patchPlaywrightBundle(source) {
  const matches = replacements.map(([unpatched, patched]) => {
    const unpatchedCount = source.split(unpatched).length - 1
    const patchedCount = source.split(patched).length - 1
    if (unpatchedCount + patchedCount !== 1) return undefined
    return unpatchedCount === 1 ? [unpatched, patched] : undefined
  })

  if (matches.some((match, index) => match === undefined &&
      source.split(replacements[index][1]).length - 1 !== 1)) {
    throw new Error("Unsupported Playwright core bundle: expected pinned extension and MCP implementations")
  }

  return matches.reduce((result, match) => match ? result.replace(match[0], match[1]) : result, source)
}

export function patchPlaywrightCore(bundlePath = createRequire(import.meta.url).resolve("playwright-core/lib/coreBundle")) {
  const source = readFileSync(bundlePath, "utf8")
  const result = patchPlaywrightBundle(source)
  if (result !== source) writeFileSync(bundlePath, result, "utf8")
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  patchPlaywrightCore()
}
