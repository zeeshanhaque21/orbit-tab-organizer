/**
 * Offline suite.
 *
 * The brief's second measurable criterion: "every non-AI method works with the
 * network switched off". This drives the built extension with the browser forced
 * offline and asserts each method still produces groups.
 *
 * It is deliberately strict about what "offline" means: CDP emulates a genuine
 * offline condition (no DNS, no sockets), rather than merely pointing the AI
 * provider at an unreachable host. Anything that reaches for the network must
 * fail here.
 *
 * Usage: node scripts/offline-e2e.mjs
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

const extId = [...createHash("sha256").update(CLONE).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join("")

const SEED = [
  "https://github.com/vercel/next.js",
  "https://gitlab.com/gitlab-org/gitlab",
  "https://stackoverflow.com/questions/1",
  "https://www.amazon.com/dp/B0BXYZ",
  "https://www.etsy.com/listing/123",
  "https://news.ycombinator.com",
  "https://www.nytimes.com",
  "https://open.spotify.com/playlist/1",
  "https://mail.google.com/mail/u/0",
  "https://www.chase.com",
  "https://arxiv.org/abs/2401.00001",
  "https://www.figma.com/file/abc",
]

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok, detail: String(detail).slice(0, 200) })
  console.error(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`)
}

sweepStaleProfiles()
const ctx = await chromium.launchPersistentContext(profileDir("orbit-offline"), {
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

const page = await ctx.newPage()
await page.goto(`chrome-extension://${extId}/hub.html`, { waitUntil: "domcontentloaded" })
const send = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg)
const cdp = await ctx.newCDPSession(page)

const state = () =>
  page.evaluate(async () => {
    const tabs = await chrome.tabs.query({})
    const groups = await chrome.tabGroups.query({})
    return { tabs: tabs.length, groups: groups.map((g) => ({ title: g.title, color: g.color })) }
  })

async function seed(count) {
  const before = await page.evaluate(async () => (await chrome.tabs.query({})).length)
  await page.evaluate(async (urls) => {
    for (const u of urls) await chrome.tabs.create({ url: u, active: false }).catch(() => null)
  }, SEED.slice(0, count))
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const n = await page.evaluate(async () => (await chrome.tabs.query({})).length)
    if (n >= before + count) return
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function reset() {
  await page.evaluate(async () => {
    const keep = (await chrome.tabs.query({})).find((t) => (t.url ?? "").includes("hub.html"))
    const ids = (await chrome.tabs.query({})).filter((t) => t.id !== keep?.id).map((t) => t.id)
    if (ids.length) await chrome.tabs.remove(ids)
    const groups = await chrome.tabGroups.query({})
    for (const g of groups) await chrome.tabGroups.update(g.id, { collapsed: false }).catch(() => null)
  })
  await new Promise((r) => setTimeout(r, 700))
}

try {
  // a local provider, so no key is involved and the AI path cannot be the excuse
  await send({ type: "SET_SETTINGS", patch: { ai: { provider: "local", apiKey: "", model: "", baseUrl: "" } } })

  /* ---- go offline ---- */
  await cdp.send("Network.enable")
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  })
  console.error("[offline] browser is offline")

  // prove the offline condition is real before trusting any result below
  const offlineProbe = await page.evaluate(async () => {
    try {
      await fetch("https://example.com", { signal: AbortSignal.timeout(4000) })
      return { reachable: true }
    } catch (e) {
      return { reachable: false, error: String(e).slice(0, 80) }
    }
  })
  check(
    "offline/the browser really has no network",
    offlineProbe.reachable === false,
    offlineProbe.error ?? "example.com was reachable",
  )

  /* ---- every non-AI method still works ---- */
  const METHODS = [
    ["last_access", "By Last Access"],
    ["category", "By Category (lexicon)"],
    ["frequency", "By Frequency"],
    ["relevance", "By Relevance"],
    ["topics", "My Topics"],
    ["memory", "Memory"],
  ]

  for (const [method, label] of METHODS) {
    await reset()
    await seed(12)
    const before = await state()
    const res = await send({ type: "ORGANIZE", method, scope: "current_window" })
    await new Promise((r) => setTimeout(r, 1200))
    const after = await state()

    const ok = res?.ok === true && after.groups.length > 0
    check(
      `offline/${label} groups tabs with no network`,
      ok,
      `${after.groups.length} groups, ${res?.data?.tabsGrouped ?? 0} tabs grouped`,
    )
    check(
      `offline/${label} loses no tabs`,
      after.tabs === before.tabs,
      `${before.tabs} -> ${after.tabs}`,
    )
    // every group must carry a real title, not an error placeholder
    const untitled = after.groups.filter((g) => !(g.title ?? "").trim()).length
    check(`offline/${label} names every group`, untitled === 0, `${untitled} untitled`)
  }

  /* ---- duplicate cleaning is local too ---- */
  await reset()
  await seed(6)
  await seed(6)
  const dupRes = await send({ type: "CLEAN_DUPLICATES" })
  check(
    "offline/duplicate cleaning works with no network",
    dupRes?.ok === true,
    `found=${dupRes?.data?.found ?? "?"} closed=${dupRes?.data?.closed ?? "?"}`,
  )

  /* ---- search is local ---- */
  const searchRes = await send({ type: "SEARCH_TABS", query: "github" })
  check(
    "offline/search works with no network",
    searchRes?.ok === true && Array.isArray(searchRes.data?.results),
    `${searchRes?.data?.results?.length ?? 0} hits`,
  )

  /* ---- and an AI call fails honestly rather than hanging ---- */
  await send({ type: "SET_SETTINGS", patch: { ai: { provider: "openai", apiKey: "sk-offline-test", model: "gpt-4o-mini", baseUrl: "" } } })
  await reset()
  await seed(8)
  const t0 = Date.now()
  const aiRes = await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  const ms = Date.now() - t0
  check(
    "offline/with a cloud key set, organizing still succeeds via the local fallback",
    aiRes?.ok === true,
    `${ms}ms, fallback=${aiRes?.data?.fallback ?? "none"}`,
  )
  check(
    "offline/the failed AI call does not hang the pass",
    ms < 30_000,
    `${ms}ms`,
  )
} catch (e) {
  check("offline/harness", false, `threw: ${String(e).slice(0, 200)}`)
}

const passed = results.filter((r) => r.ok).length
writeFileSync(resolve(OUT, "offline-e2e.json"), JSON.stringify({ passed, total: results.length, results }, null, 2))
console.error(`\n[offline] ${passed}/${results.length} checks passed`)
await ctx.close()
process.exitCode = passed === results.length ? 0 : 1
