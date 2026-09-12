/**
 * Verifies the SHIPPED artifact, not dist/.
 *
 * Extracts orbit-extension.zip to a temp directory, loads that in Chromium, and
 * checks all three surfaces render with no console errors. This is the check
 * that catches a broken package - for example a shared chunk wrongly pruned as
 * "unreferenced", which leaves dist/ perfectly healthy and the zip broken.
 *
 * Usage: node scripts/verify-package.mjs
 */
import { chromium } from "playwright-core"
import { profileDir, sweepStaleProfiles } from "./profile.mjs"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir, tmpdir } from "node:os"
import { createHash } from "node:crypto"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ZIP = resolve(root, "orbit-extension.zip")
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

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok, detail: String(detail).slice(0, 200) })
  console.error(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`)
}

if (!existsSync(ZIP)) {
  console.error("orbit-extension.zip not found - run `npm run package` first")
  process.exit(1)
}

// Chrome hashes the CANONICAL path to derive an unpacked extension's id. On
// macOS the temp dir is under /var, which is a symlink to /private/var, so
// hashing the literal path yields an id Chrome does not recognise and every
// navigation is blocked.
const staging = profileDir("orbit-pkg")
mkdirSync(staging, { recursive: true })
// resolve AFTER creating it: Chrome hashes the CANONICAL path, and on macOS the
// temp dir is under /var, a symlink to /private/var. Hashing the literal path
// yields an id Chrome does not recognise, so every navigation is blocked.
const unpacked = realpathSync(staging)
execFileSync("unzip", ["-qo", ZIP, "-d", unpacked])
console.error(`[pkg] extracted to ${unpacked}`)

const extId = [...createHash("sha256").update(unpacked).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join("")

sweepStaleProfiles()
const ctx = await chromium.launchPersistentContext(profileDir("orbit-pkgprof"), {
  executablePath: findChromium(),
  headless: false,
  viewport: { width: 1280, height: 900 },
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${unpacked}`,
    `--load-extension=${unpacked}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
  ],
  timeout: 60_000,
})

try {
  // the manifest must be valid enough for Chrome to have loaded it
  const page = await ctx.newPage()
  const surfaces = ["popup", "hub", "options"]
  for (const surface of surfaces) {
    const errors = []
    page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)))
    const res = await page
      .goto(`chrome-extension://${extId}/${surface}.html`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      })
      .catch((e) => ({ ok: () => false, status: () => String(e).slice(0, 80) }))

    const ok = typeof res?.ok === "function" && res.ok()
    // a missing chunk surfaces as a module-load error, so wait a beat and look
    await page.waitForTimeout(1200)
    const bodyText = await page.evaluate(() => document.body?.innerText?.length ?? 0)
    check(
      `package/${surface}.html loads from the zip`,
      ok && bodyText > 0,
      ok ? `${bodyText} chars rendered` : String(res?.status?.() ?? "load failed"),
    )
    check(`package/${surface} has no module errors`, errors.length === 0, errors.slice(0, 2).join(" | "))
  }

  // the service worker must start, which is what actually proves the bundles resolve
  const deadline = Date.now() + 8000
  while (ctx.serviceWorkers().length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300))
  }
  check(
    "package/service worker starts",
    ctx.serviceWorkers().length > 0,
    `${ctx.serviceWorkers().length} worker(s)`,
  )
} catch (e) {
  check("package/harness", false, String(e).slice(0, 200))
}

const passed = results.filter((r) => r.ok).length
writeFileSync(resolve(OUT, "package-e2e.json"), JSON.stringify({ passed, total: results.length, results }, null, 2))
console.error(`\n[pkg] ${passed}/${results.length} checks passed`)
await ctx.close()
rmSync(unpacked, { recursive: true, force: true })
process.exitCode = passed === results.length ? 0 : 1
