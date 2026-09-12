/**
 * Scale and edge-case suite.
 *
 * Every other suite uses 6-20 tabs. A tab manager's actual job is coping with
 * far more than that, and with the degenerate cases (no tabs, one tab, all
 * pinned, many windows). This drives those.
 *
 * Usage: node scripts/stress-e2e.mjs
 */
import { chromium } from "playwright-core"
import { profileDir, sweepStaleProfiles } from "./profile.mjs"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir, tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { createServer } from "node:http"

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

/**
 * Serves every path with a fixed page and no redirects.
 *
 * Seeding fake paths on real hosts does not work for the duplicate test: those
 * hosts redirect, so the URL set shifts underneath the assertion and the test
 * reports a phantom duplicate. A local server keeps every URL exactly as
 * written, which is what makes the expected-removals arithmetic trustworthy.
 */
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" })
  res.end("<!doctype html><title>stress</title><h1>ok</h1>")
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
/*
 * Unref straight away. A listening socket is a live handle, so it keeps Node's
 * event loop alive; the suite would print its result and then hang forever
 * instead of exiting, stalling any CI job and leaving a stray process holding
 * the browser profile. Unref'd, the process exits as soon as the real work
 * drains, and this happens even if the run throws before teardown.
 */
server.unref()
const PORT = server.address().port
const stableUrl = (i) => `http://127.0.0.1:${PORT}/p/${i}?s=${i}`

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok, detail: String(detail).slice(0, 200) })
  console.error(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`)
}

/** A wide spread of real hosts, so the classifier has genuine work to do. */
const HOSTS = [
  "github.com/vercel/next.js",
  "gitlab.com/gitlab-org/gitlab",
  "developer.mozilla.org/en-US/docs/Web/API",
  "stackoverflow.com/questions/1",
  "www.amazon.com/dp/B0BXYZ",
  "www.etsy.com/listing/123",
  "news.ycombinator.com",
  "www.nytimes.com",
  "www.theguardian.com",
  "www.youtube.com/watch?v=abc",
  "open.spotify.com/playlist/1",
  "www.reddit.com/r/programming",
  "mail.google.com/mail/u/0",
  "docs.google.com/document/d/1",
  "www.figma.com/file/abc",
  "linear.app/orbit/board",
  "www.chase.com",
  "chatgpt.com",
  "arxiv.org/abs/2401.00001",
  "www.booking.com/hotel/us/x.html",
  "en.wikipedia.org/wiki/Tab",
  "www.zillow.com/homes/1",
  "www.espn.com/nba",
  "store.steampowered.com/app/1",
  "www.mayoclinic.org/diseases-conditions",
  "www.irs.gov/forms",
  "www.allrecipes.com/recipe/1",
  "www.tradingview.com/chart",
  "www.coinbase.com/price",
  "www.airbnb.com/rooms/1",
]

sweepStaleProfiles()
const ctx = await chromium.launchPersistentContext(profileDir("orbit-stress"), {
  executablePath: findChromium(),
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${CLONE}`,
    `--load-extension=${CLONE}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
  ],
  timeout: 90_000,
})

const ctl = await ctx.newPage()
await ctl.goto(`chrome-extension://${extId}/hub.html`, { waitUntil: "domcontentloaded" })
const send = (m) => ctl.evaluate((msg) => chrome.runtime.sendMessage(msg), m)

const chromeState = () =>
  ctl.evaluate(async () => {
    const tabs = await chrome.tabs.query({})
    const groups = await chrome.tabGroups.query({})
    return {
      tabs: tabs.map((t) => ({ id: t.id, url: t.url, groupId: t.groupId, pinned: t.pinned })),
      groups: groups.map((g) => ({ id: g.id, title: g.title, collapsed: g.collapsed })),
      windows: (await chrome.windows.getAll({ populate: false })).map((w) => w.id),
    }
  })

async function realCount() {
  const st = await chromeState()
  return st.tabs.filter((t) => t.url && !t.url.startsWith("chrome-extension://")).length
}

/** Creates tabs in bulk, in parallel batches, then waits until they are real. */
async function bulkSeed(count, { windowId } = {}) {
  const before = await realCount()
  const urls = Array.from({ length: count }, (_, i) => {
    const host = HOSTS[i % HOSTS.length]
    return `https://${host}${host.includes("?") ? "&" : "?"}s=${i}`
  })

  // create in chunks so we do not flood the browser at once
  for (let i = 0; i < urls.length; i += 25) {
    const chunk = urls.slice(i, i + 25)
    await ctl.evaluate(
      async ({ list, win }) => {
        await Promise.all(
          list.map((u) =>
            chrome.tabs.create({ url: u, active: false, ...(win != null ? { windowId: win } : {}) }).catch(() => null),
          ),
        )
      },
      { list: chunk, win: windowId ?? null },
    )
  }

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if ((await realCount()) >= before + count) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

async function closeAllButControl() {
  const keep = ctl.url()
  await ctl.evaluate(async (k) => {
    const tabs = await chrome.tabs.query({})
    const ids = tabs.filter((t) => t.url !== k).map((t) => t.id)
    if (ids.length) await chrome.tabs.remove(ids)
  }, keep)
  await new Promise((r) => setTimeout(r, 600))
}

try {
  /* ---- 1. degenerate: a single tab ---- */
  console.error("[stress] single tab")
  await closeAllButControl()
  await bulkSeed(1)
  const oneRes = await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  // `ok` here is the message envelope: true means the handler ran to completion
  // without throwing. With a single tab it may legitimately report nothing to do.
  check(
    "edge/one tab: handler completes without throwing",
    oneRes?.ok === true,
    `ok=${oneRes?.ok} error=${oneRes?.error ?? "none"}`,
  )
  const afterOne = await chromeState()
  check("edge/one tab is left alone", afterOne.tabs.filter((t) => t.url?.startsWith("https://")).length === 1, "")

  /* ---- 2. degenerate: every tab pinned ---- */
  console.error("[stress] all pinned")
  await bulkSeed(8)
  await ctl.evaluate(async () => {
    const tabs = await chrome.tabs.query({})
    for (const t of tabs) {
      if (t.url?.startsWith("https://")) await chrome.tabs.update(t.id, { pinned: true }).catch(() => null)
    }
  })
  await new Promise((r) => setTimeout(r, 1200))
  const pinnedBefore = await chromeState()
  const pinnedRes = await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  const pinnedAfter = await chromeState()
  check(
    "edge/all-pinned: handler completes without throwing",
    pinnedRes?.ok === true,
    `ok=${pinnedRes?.ok} error=${pinnedRes?.error ?? "none"}`,
  )
  check(
    "edge/all-pinned leaves every tab open",
    pinnedAfter.tabs.length === pinnedBefore.tabs.length,
    `${pinnedBefore.tabs.length} -> ${pinnedAfter.tabs.length}`,
  )
  check(
    "edge/all-pinned creates no groups (chrome cannot group pinned tabs)",
    pinnedAfter.groups.length === 0,
    `${pinnedAfter.groups.length} groups`,
  )

  // unpin for the rest
  await ctl.evaluate(async () => {
    const tabs = await chrome.tabs.query({})
    for (const t of tabs) if (t.pinned) await chrome.tabs.update(t.id, { pinned: false }).catch(() => null)
  })
  await new Promise((r) => setTimeout(r, 800))

  /* ---- 3. scale: 300 tabs ---- */
  console.error("[stress] seeding 300 tabs")
  await closeAllButControl()
  const seeded = await bulkSeed(300)
  const before300 = await chromeState()
  check("scale/seeded 300 tabs", seeded, `${before300.tabs.length} tabs present`)

  const t0 = Date.now()
  const bigRes = await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  const organizeMs = Date.now() - t0
  const after300 = await chromeState()

  check(
    "scale/organize completes on 300 tabs",
    !!bigRes?.ok,
    `${organizeMs}ms, groups=${bigRes?.data?.groups}, grouped=${bigRes?.data?.tabsGrouped}`,
  )
  check(
    "scale/organize finishes in a sane time",
    organizeMs < 30_000,
    `${organizeMs}ms`,
  )
  check(
    "scale/no tabs lost",
    after300.tabs.length === before300.tabs.length,
    `${before300.tabs.length} -> ${after300.tabs.length}`,
  )
  const groupedCount = after300.tabs.filter((t) => t.groupId !== -1).length
  check(
    "scale/most tabs end up grouped",
    groupedCount >= 250,
    `${groupedCount}/${after300.tabs.length} grouped`,
  )
  check(
    "scale/group count stays sane",
    after300.groups.length > 0 && after300.groups.length <= 40,
    `${after300.groups.length} groups`,
  )
  check(
    "scale/every group has a title",
    after300.groups.every((g) => (g.title ?? "").length > 0),
    after300.groups.filter((g) => !g.title).length + " untitled",
  )

  /* ---- 4. scale: the Hub renders 300 stars ---- */
  console.error("[stress] rendering the hub with 300 tabs")
  const hub = await ctx.newPage()
  await hub.setViewportSize({ width: 1440, height: 900 })
  const hubErrors = []
  hub.on("pageerror", (e) => hubErrors.push(e.message.slice(0, 150)))
  const th0 = Date.now()
  await hub.goto(`chrome-extension://${extId}/hub.html`, { waitUntil: "domcontentloaded" })
  await hub.waitForSelector(".star", { timeout: 30_000 }).catch(() => undefined)
  const hubMs = Date.now() - th0

  const stars = await hub.locator(".star").count()
  const planets = await hub.locator(".planet").count()
  check("scale/hub renders every star", stars >= 300, `${stars} stars`)
  check("scale/hub renders the planets", planets > 0, `${planets} planets`)
  check("scale/hub paints within a sane time", hubMs < 20_000, `${hubMs}ms`)
  check("scale/hub has no page errors at scale", hubErrors.length === 0, hubErrors.slice(0, 2).join(" | "))

  // The check that actually catches star overflow. An earlier build capped the
  // orbit rings and dropped the remainder onto the planet centre, so a large
  // group collapsed into one point. Counting stars did NOT catch that; counting
  // distinct on-screen positions does.
  const geom = await hub.evaluate(() => {
    const boxes = [...document.querySelectorAll(".star")].map((s) => {
      const r = s.getBoundingClientRect()
      return `${Math.round(r.left)},${Math.round(r.top)}`
    })
    return { total: boxes.length, distinct: new Set(boxes).size }
  })
  check(
    "scale/every star has its own on-screen position",
    geom.distinct === geom.total,
    `${geom.total} stars, ${geom.distinct} distinct positions`,
  )

  // marquee across a big canvas should still be responsive
  const canvas = await hub.locator(".hub-canvas").boundingBox()
  if (canvas) {
    const tm = Date.now()
    await hub.mouse.move(canvas.x + 20, canvas.y + 30)
    await hub.mouse.down()
    await hub.mouse.move(canvas.x + canvas.width - 30, canvas.y + canvas.height - 40, { steps: 12 })
    await hub.waitForTimeout(250)
    const selected = await hub.locator(".star.selected").count()
    const marqueeMs = Date.now() - tm
    await hub.mouse.up()
    check("scale/marquee stays responsive at 300 tabs", marqueeMs < 8000, `${marqueeMs}ms`)
    check("scale/marquee selects a large set", selected >= 100, `${selected} selected`)
  }
  await hub.close()

  /* ---- 5. scale: duplicate cleaning at 300 tabs ---- */
  console.error("[stress] duplicate cleaning at scale")
  // Replace the redirect-prone real-host tabs with stable local ones, so the
  // expected-removals arithmetic cannot be invalidated by a redirect.
  await closeAllButControl()
  const STABLE = 120
  const stableSeed = async (indices) => {
    const before = await realCount()
    await ctl.evaluate(
      async ({ list, port }) => {
        for (const i of list) {
          await chrome.tabs
            .create({ url: `http://127.0.0.1:${port}/p/${i}?s=${i}`, active: false })
            .catch(() => null)
        }
      },
      { list: indices, port: PORT },
    )
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if ((await realCount()) >= before + indices.length) return
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  await stableSeed(Array.from({ length: STABLE }, (_, i) => i))
  // every url gets 2 extra copies, so exactly 2 must be removed per url
  await stableSeed(Array.from({ length: STABLE }, (_, i) => i))
  await stableSeed(Array.from({ length: STABLE }, (_, i) => i))
  const dupBefore = await chromeState()
  void stableUrl

  // Mirror of the product's normalisation (src/shared/format.ts), so the test can
  // compute the expected survivor set independently rather than trusting the
  // extension's own answer.
  const TRACKING = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
    "mc_cid",
    "mc_eid",
    "igshid",
    "ref_src",
    "ref",
  ])
  const norm = (raw) => {
    try {
      const u = new URL(raw)
      u.hash = ""
      for (const p of TRACKING) u.searchParams.delete(p)
      u.searchParams.sort()
      let s = u.toString()
      if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "")
      return s
    } catch {
      return raw.split("#")[0]
    }
  }

  const counts = new Map()
  for (const t of dupBefore.tabs) {
    if (!t.url || t.url.startsWith("chrome")) continue
    const k = norm(t.url)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const expectedRemovals = [...counts.values()].reduce((n, c) => n + (c - 1), 0)
  const duplicateKeys = [...counts.entries()].filter(([, c]) => c > 1)

  const td0 = Date.now()
  const dupRes = await send({ type: "CLEAN_DUPLICATES" })
  const dupMs = Date.now() - td0
  // closes are asynchronous; let the browser settle before reading back, or a
  // tab that is mid-removal shows up as a missing survivor
  await new Promise((r) => setTimeout(r, 2500))
  const dupAfter = await chromeState()

  check("scale/duplicate scan completes", !!dupRes?.ok, `${dupMs}ms, found=${dupRes?.data?.found}`)
  check("scale/duplicate scan is not pathologically slow", dupMs < 20_000, `${dupMs}ms`)
  check(
    "scale/duplicate scan removed exactly the excess copies",
    (dupRes?.data?.closed ?? 0) === expectedRemovals,
    `closed ${dupRes?.data?.closed}, expected ${expectedRemovals} (${duplicateKeys.length} duplicated urls)`,
  )

  const afterCounts = new Map()
  for (const t of dupAfter.tabs) {
    if (!t.url || t.url.startsWith("chrome")) continue
    const k = norm(t.url)
    afterCounts.set(k, (afterCounts.get(k) ?? 0) + 1)
  }
  const stillDuplicated = [...afterCounts.entries()].filter(([, c]) => c > 1)
  check(
    "scale/no duplicates survive the scan",
    stillDuplicated.length === 0,
    `${stillDuplicated.length} still duplicated`,
  )

  const survivorsKept = [...counts.keys()].filter((k) => afterCounts.has(k)).length
  check(
    "scale/every distinct url keeps exactly one survivor",
    survivorsKept === counts.size,
    `${survivorsKept}/${counts.size} distinct urls still present`,
  )

  /* ---- 6. scale: search across 300 tabs ---- */
  const searchRes = await send({ type: "SEARCH_TABS", query: "github" })
  check(
    "scale/search returns results quickly",
    !!searchRes?.ok && Array.isArray(searchRes.data?.results),
    `${searchRes?.data?.results?.length ?? 0} hits`,
  )

  /* ---- 7. multi-window ---- */
  console.error("[stress] multi-window")
  const second = await ctl.evaluate(async () => {
    const w = await chrome.windows.create({ url: "about:blank", focused: false })
    return w.id
  })
  await bulkSeed(15, { windowId: second })
  const multiBefore = await chromeState()
  check("scale/created a second window with tabs", multiBefore.windows.length >= 2, `${multiBefore.windows.length} windows`)

  const allRes = await send({ type: "ORGANIZE", method: "category", scope: "all_windows" })
  const multiAfter = await chromeState()
  check("scale/all-windows organize completes", !!allRes?.ok, `groups=${allRes?.data?.groups}`)
  check(
    "scale/all-windows keeps every tab",
    multiAfter.tabs.length >= multiBefore.tabs.length - 1,
    `${multiBefore.tabs.length} -> ${multiAfter.tabs.length}`,
  )

  /* ---- 8. window closed mid-flight ---- */
  console.error("[stress] window closing mid-pass")
  await ctl.evaluate(async (id) => {
    await chrome.windows.remove(id).catch(() => null)
  }, second)
  await new Promise((r) => setTimeout(r, 700))
  const orphanRes = await send({ type: "ORGANIZE", method: "last_access", scope: "current_window" })
  check(
    "edge/organize survives a window disappearing",
    orphanRes?.ok === true,
    `ok=${orphanRes?.ok} error=${orphanRes?.error ?? "none"}`,
  )

  /* ---- 9. degenerate: no tabs at all ---- */
  console.error("[stress] no tabs")
  await closeAllButControl()
  const emptyRes = await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  // the envelope's ok means the handler ran; the organizer's verdict is data.ok
  check(
    "edge/no tabs: handler completes without throwing",
    emptyRes?.ok === true,
    `envelope ok=${emptyRes?.ok}`,
  )
  check(
    "edge/no tabs reports 'nothing to organize' rather than inventing groups",
    emptyRes?.data?.ok === false && /nothing to organize/i.test(emptyRes?.data?.error ?? ""),
    `data.ok=${emptyRes?.data?.ok} error="${emptyRes?.data?.error}"`,
  )
  const emptyState = await chromeState()
  check("edge/no tabs creates no groups", emptyState.groups.length === 0, `${emptyState.groups.length} groups`)

  /* ---- 10. chrome:// and extension pages are never grouped ---- */
  await ctl.evaluate(async () => {
    await chrome.tabs.create({ url: "chrome://version", active: false }).catch(() => null)
    await chrome.tabs.create({ url: "chrome-extension://" + chrome.runtime.id + "/options.html", active: false }).catch(() => null)
  })
  await new Promise((r) => setTimeout(r, 1500))
  await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  const privileged = await chromeState()
  const bad = privileged.tabs.filter(
    (t) => (t.url?.startsWith("chrome://") || t.url?.startsWith("chrome-extension://")) && t.groupId !== -1,
  )
  check("edge/browser-internal pages are never grouped", bad.length === 0, `${bad.length} grouped`)
} catch (e) {
  check("harness", false, `threw: ${String(e).slice(0, 250)}`)
}

const passed = results.filter((r) => r.ok).length
writeFileSync(resolve(OUT, "stress-e2e.json"), JSON.stringify({ passed, total: results.length, results }, null, 2))
console.error(`\n[stress] ${passed}/${results.length} checks passed`)
await ctx.close()
server.close()
// `process.exitCode`, not `process.exit()`: exiting outright can truncate the
// buffered PASS/FAIL lines above, which are the only record of what ran.
process.exitCode = passed === results.length ? 0 : 1
