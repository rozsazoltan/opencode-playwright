import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { patchPlaywrightBundle } from "../scripts/patch-playwright.mjs"

describe("Playwright focus patch", () => {
  test("creates extension-backed tabs in the background", () => {
    const require = createRequire(import.meta.url)
    const source = readFileSync(require.resolve("playwright-core/lib/coreBundle"), "utf8")

    expect(patchPlaywrightBundle(source)).toContain(
      'this._sendToExtension("chrome.tabs.create", [{ url: url3, active: false }])',
    )
  })

  test("is idempotent", () => {
    const source = `async createTarget(url3) {
        const tab2 = await this._sendToExtension("chrome.tabs.create", [{ url: url3 }]);`

    const result = patchPlaywrightBundle(source)

    expect(patchPlaywrightBundle(result)).toBe(result)
  })

  test("fails closed for an unexpected bundle shape", () => {
    expect(() => patchPlaywrightBundle("async createTarget(url) {}"))
      .toThrow("Unsupported Playwright core bundle")
  })
})
