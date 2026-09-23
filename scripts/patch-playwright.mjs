import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const unpatched = `async createTarget(url3) {
        const tab2 = await this._sendToExtension("chrome.tabs.create", [{ url: url3 }]);`
const patched = `async createTarget(url3) {
        const tab2 = await this._sendToExtension("chrome.tabs.create", [{ url: url3, active: false }]);`

export function patchPlaywrightBundle(source) {
  if (source.includes(patched)) return source

  const occurrences = source.split(unpatched).length - 1
  if (occurrences !== 1) {
    throw new Error("Unsupported Playwright core bundle: expected one extension createTarget implementation")
  }

  return source.replace(unpatched, patched)
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
