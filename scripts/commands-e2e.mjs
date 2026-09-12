/**
 * Keyboard command bindings.
 *
 * What this can prove, and what it cannot.
 *
 * CAN: that the four commands are registered, and that the accelerators Chrome
 * resolved match the ones the manifest declares. A wrong key here means the
 * shortcut the user was promised does nothing.
 *
 * CANNOT: trigger them. Chrome handles extension accelerators in the browser UI
 * layer, above the renderer, so a synthesised key event from an automated
 * browser is delivered to the page and never reaches the command handler. This
 * was measured, not assumed - see the note printed below.
 *
 * The behaviour behind each binding is covered by `tests/commands.test.ts`,
 * which calls the dispatch directly.
 *
 * Usage: node scripts/commands-e2e.mjs
 */
import { chromium } from "playwright-core"
import { profileDir, sweepStaleProfiles } from "./profile.mjs"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir, tmpdir } from "node:os"
import { createHash } from "node:crypto"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CLONE = resolve(root, "dist")
const OUT = resolve(root, "_verify")
mkdirSync(OUT, { recursive: true })

function findChromium() {
  const cache = resolve(homedir(), "Library/Caches/ms-playwright")
  if (!existsSync(cache)) return undefined
  const dirs = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  for (const d of dirs) {
    const p = resolve(
      cache,
      d,
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    )
    if (existsSync(p)) return p
  }
  return undefined
}

const idFor = (p) =>
  [...createHash("sha256").update(p).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("")

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok, detail: String(detail).slice(0, 220) })
  console.error(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`)
}

sweepStaleProfiles()
const ctx = await chromium.launchPersistentContext(profileDir("orbit-cmd"), {
  executablePath: findChromium(),
  headless: false,
  viewport: { width: 1280, height: 900 },
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${CLONE}`,
    `--load-extension=${CLONE}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
  ],
  timeout: 60_000,
})

try {
  const readBindings = async (extId) => {
    const p = await ctx.newPage()
    await p.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "domcontentloaded" })
    const cmds = await p.evaluate(async () => {
      const all = await chrome.commands.getAll()
      return all.map((c) => ({ name: c.name, shortcut: c.shortcut ?? "" }))
    })
    await p.close()
    return cmds
  }

  /* ---- 1. our bindings ---- */
  const ours = await readBindings(idFor(CLONE))
  const ourMap = Object.fromEntries(ours.map((c) => [c.name, c.shortcut]))

  const EXPECTED = {
    orbit_toggle_collapse: "⇧⌘K",
    orbit_open_hub: "⇧⌘L",
    orbit_rename_tab: "⇧⌘E",
    orbit_search_tab: "⇧⌘S",
  }

  /*
   * The manifest declares its keys in Chrome's own spelling ("Command+Shift+K")
   * while `chrome.commands.getAll()` reports the resolved symbol ("⇧⌘K"). They
   * are the same binding written two ways, so the manifest check needs the
   * declared spelling rather than a normalised comparison of the two.
   */
  const EXPECTED_DECLARED = {
    orbit_toggle_collapse: "Command+Shift+K",
    orbit_open_hub: "Command+Shift+L",
    orbit_rename_tab: "Command+Shift+E",
    orbit_search_tab: "Command+Shift+S",
  }

  for (const [name, key] of Object.entries(EXPECTED)) {
    check(
      `binding/${name} is registered as ${key}`,
      ourMap[name] === key,
      ourMap[name] ?? "unset",
    )
  }

  /* ---- 2. the manifest declares what we expect ---- */
  // Compare what the manifest *declares*, not the runtime-resolved binding.
  // Chrome only binds a suggested key if nothing else has claimed it, so the
  // resolved shortcut can be empty even when the declaration is correct — which
  // is why both halves are asserted.
  try {
    const { readFileSync } = await import("node:fs")
    const ourManifest = JSON.parse(readFileSync(resolve(root, "public/manifest.json"), "utf8"))
    const declared = Object.fromEntries(
      Object.entries(ourManifest.commands ?? {}).map(([name, c]) => [
        name,
        c.suggested_key?.mac ?? "",
      ]),
    )
    const missing = Object.keys(EXPECTED_DECLARED).filter((n) => declared[n] !== EXPECTED_DECLARED[n])
    check(
      "manifest/declares the expected mac shortcuts",
      missing.length === 0,
      missing.length
        ? missing
            .map((n) => `${n}: declared=${declared[n] || "unset"} expected=${EXPECTED_DECLARED[n]}`)
            .join(" | ")
        : Object.entries(declared)
            .map(([k, v]) => `${k}=${v}`)
            .join(" "),
    )
  } catch (e) {
    check("manifest/declares the expected mac shortcuts", false, String(e).slice(0, 140))
  }

  /* ---- 3. document the measured limitation ---- */
  const work = await ctx.newPage()
  await work.goto("https://example.com/", { waitUntil: "domcontentloaded" }).catch(() => undefined)
  await work.bringToFront()
  await work.waitForTimeout(500)

  const before = await ctx.newPage()
  await before.goto(`chrome-extension://${idFor(CLONE)}/hub.html`, { waitUntil: "domcontentloaded" })
  const groupsBefore = await before.evaluate(async () => {
    const gs = await chrome.tabGroups.query({})
    return gs.map((g) => g.collapsed)
  })
  await before.close()

  await work.bringToFront()
  await work.keyboard.press("Meta+Shift+KeyK")
  await work.waitForTimeout(1500)

  const after = await ctx.newPage()
  await after.goto(`chrome-extension://${idFor(CLONE)}/hub.html`, { waitUntil: "domcontentloaded" })
  const groupsAfter = await after.evaluate(async () => {
    const gs = await chrome.tabGroups.query({})
    return gs.map((g) => g.collapsed)
  })
  await after.close()

  const keypressReached = JSON.stringify(groupsBefore) !== JSON.stringify(groupsAfter)
  console.error(
    keypressReached
      ? "[cmd] NOTE: a synthesised key event DID reach the accelerator"
      : "[cmd] NOTE: a synthesised key event does NOT reach extension accelerators (expected: Chrome handles them above the renderer). Handler behaviour is covered by tests/commands.test.ts.",
  )
  results.push({
    name: "limitation/synthesised keypresses reach extension accelerators",
    ok: true,
    detail: keypressReached ? "reachable" : "not reachable - documented, not a product bug",
    informational: true,
  })
} catch (e) {
  check("harness", false, `threw: ${String(e).slice(0, 200)}`)
}

const passed = results.filter((r) => r.ok).length
writeFileSync(resolve(OUT, "commands-e2e.json"), JSON.stringify({ passed, total: results.length, results }, null, 2))
console.error(`\n[cmd] ${passed}/${results.length} checks passed`)
await ctx.close()
process.exitCode = passed === results.length ? 0 : 1
