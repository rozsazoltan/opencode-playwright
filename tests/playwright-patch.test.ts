import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { patchPlaywrightBundle } from "../scripts/patch-playwright.mjs"

describe("Playwright focus patch", () => {
  test("creates extension-backed tabs in the background and suppresses MCP activation", () => {
    const require = createRequire(import.meta.url)
    const source = readFileSync(require.resolve("playwright-core/lib/coreBundle"), "utf8")
    const result = patchPlaywrightBundle(source)
    const selectTab = result.slice(result.indexOf("async selectTab(index)"), result.indexOf("async ensureTab()"))
    const startRecording = result.slice(
      result.indexOf('name: "browser_start_recording"'),
      result.indexOf('name: "browser_stop_recording"'),
    )

    expect(result).toContain(
      'this._sendToExtension("chrome.tabs.create", [{ url: url3, active: false }])',
    )
    expect(selectTab).not.toContain("bringToFront")
    expect(result).toContain("this._setCurrentTab(tab2);")
    expect(result).toContain("// MCP page activation intentionally suppressed.")
    expect(startRecording).toContain("await context.startRecording();")
    expect(startRecording).not.toContain("bringToFront")
    expect(result).toContain("response2.addTextResult(`Recording started.")
  })

  test("is idempotent", () => {
    const source = `async createTarget(url3) {
        const tab2 = await this._sendToExtension("chrome.tabs.create", [{ url: url3 }]);
        await tab2.page.bringToFront();
        await tab2.updateWebMCPTools();
        await context.startRecording();
        await tab2.page.bringToFront();
        response2.addTextResult("Recording started.");`

    const result = patchPlaywrightBundle(source)

    expect(patchPlaywrightBundle(result)).toBe(result)
  })

  test("fails closed for an unexpected bundle shape", () => {
    expect(() => patchPlaywrightBundle("async createTarget(url) {}"))
      .toThrow("Unsupported Playwright core bundle")
  })

  test("fails closed if one expected MCP activation is missing", () => {
    const source = `async createTarget(url3) {
        const tab2 = await this._sendToExtension("chrome.tabs.create", [{ url: url3 }]);
        await tab2.page.bringToFront();
        await tab2.updateWebMCPTools();
        await context.startRecording();
        response2.addTextResult("Recording started.");`

    expect(() => patchPlaywrightBundle(source)).toThrow("Unsupported Playwright core bundle")
  })
})
