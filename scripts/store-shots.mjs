/**
 * Chrome Web Store screenshots.
 *
 * The store requires at least one screenshot at exactly 1280x800 (or 640x400),
 * PNG or JPEG. This captures the three surfaces at that size from the built
 * extension, with a realistic tab set already organized so the shots show the
 * product doing its job rather than sitting empty.
 *
 * Output: `_verify/store/<surface>.png`
 *
 * Usage: node scripts/store-shots.mjs
 */
import { chromium } from "playwright-core"
import { profileDir, sweepStaleProfiles } from "./profile.mjs"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { createHash } from "node:crypto"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CLONE = resolve(root, "dist")
const OUT = resolve(root, "_verify/store")
mkdirSync(OUT, { recursive: true })

/** The store's required viewport. */
const SHOT = { width: 1280, height: 800 }

function findChromium() {
  const cache = resolve(homedir(), "Library/Caches/ms-playwright")
  if (!existsSync(cache)) return undefined
  for (const d of readdirSync(cache)
    .filter((x) => /^chromium-\d+$/.test(x))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))) {
    const p = resolve(
      cache,
      d,
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    )
    if (existsSync(p)) return p
  }
  return undefined
}

const extId = (p) =>
  [...createHash("sha256").update(p).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("")

/** A tab set that shows several distinct groups, so the shots are not one blob. */
const SEED = [
  "https://github.com/vercel/next.js",
  "https://gitlab.com/gitlab-org/gitlab",
  "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
  "https://stackoverflow.com/questions/11227809",
  "https://www.amazon.com/dp/B0BXYZ",
  "https://www.etsy.com/listing/123",
  "https://news.ycombinator.com/",
  "https://www.nytimes.com/",
  "https://www.youtube.com/watch?v=abc",
  "https://open.spotify.com/playlist/1",
  "https://www.reddit.com/r/programming/",
  "https://www.chase.com/",
  "https://arxiv.org/abs/2401.00001",
  "https://www.figma.com/file/abc",
  "https://linear.app/orbit/board",
  "https://docs.google.com/document/d/1",
]

sweepStaleProfiles()
const ctx = await chromium.launchPersistentContext(profileDir("orbit-store"), {
  executablePath: findChromium(),
  headless: false,
  viewport: SHOT,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${CLONE}`,
    `--load-extension=${CLONE}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
  ],
})

const id = extId(CLONE)
const ctl = await ctx.newPage()
await ctl.goto(`chrome-extension://${id}/hub.html`, { waitUntil: "domcontentloaded" })
await ctl.waitForTimeout(1200)

const send = (msg) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), msg)

/* Seed, then organize so the screenshots show a populated, grouped product. */
await ctl.evaluate(async (urls) => {
  for (let i = 0; i < urls.length; i += 8) {
    await Promise.all(
      urls.slice(i, i + 8).map((u) => chrome.tabs.create({ url: u, active: false }).catch(() => null)),
    )
  }
}, SEED)
await ctl.waitForTimeout(2500)

await send({ type: "SET_SETTINGS", patch: { method: "category", scope: "current_window" } })
await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
await ctl.waitForTimeout(2000)

/* Keep only our own pages plus the seeded tabs, and close the blank ones. */
await ctl.evaluate(async () => {
  const all = await chrome.tabs.query({})
  const kill = all.filter((t) => t.url === "about:blank").map((t) => t.id).filter(Boolean)
  if (kill.length) await chrome.tabs.remove(kill).catch(() => null)
})
await ctl.waitForTimeout(800)

async function shoot(name, url, { full = false, wait = 2200 } = {}) {
  const page = await ctx.newPage()
  await page.setViewportSize(SHOT)
  await page.goto(url, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(wait)
  const path = resolve(OUT, `${name}.png`)
  await page.screenshot({ path, fullPage: full })
  console.error(`  wrote ${name}.png`)
  await page.close()
  return path
}

await shoot("hub", `chrome-extension://${id}/hub.html`)
await shoot("popup", `chrome-extension://${id}/popup.html`)
await shoot("options", `chrome-extension://${id}/options.html`, { wait: 2600 })

/* Verify the size the store demands, rather than assuming it. */
const { statSync, readFileSync } = await import("node:fs")
for (const name of ["hub", "popup", "options"]) {
  const p = resolve(OUT, `${name}.png`)
  const st = statSync(p)
  // PNG header: width and height are big-endian uint32 at bytes 16..24
  const buf = readFileSync(p)
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  const ok = w === SHOT.width && h === SHOT.height
  console.error(
    `  ${ok ? "PASS" : "FAIL"}  ${name}.png is ${w}x${h} (${(st.size / 1024).toFixed(0)} KB)`,
  )
}

await ctx.close()
