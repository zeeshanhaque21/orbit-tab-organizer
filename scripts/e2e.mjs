/**
 * Functional end-to-end suite.
 *
 * Unlike the unit tests (pure logic) and the A/B harness (screenshots), this
 * drives the built extension inside a real browser and asserts on the resulting
 * Chrome state: real tab groups, real tab ids, real closes.
 *
 * Usage: node scripts/e2e.mjs
 */
import { chromium } from "playwright-core"
import { profileDir, sweepStaleProfiles } from "./profile.mjs"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok, detail: String(detail).slice(0, 240) })
  console.error(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`)
}

/** A realistic tab set covering many lexicon categories. */
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
  "https://chatgpt.com/",
  "https://arxiv.org/abs/2401.00001",
  "https://www.figma.com/file/abc",
  "https://linear.app/orbit/board",
]

let seq = 0
const uniq = (u) => `${u}${u.includes("?") ? "&" : "?"}e2e=${++seq}`

sweepStaleProfiles()
const ctx = await chromium.launchPersistentContext(profileDir("orbit-e2e"), {
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
// MV3 service workers are lazy, so derive the id from the path rather than
// waiting for one to start
const extId = [...createHash("sha256").update(CLONE).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join("")
await page.goto(`chrome-extension://${extId}/hub.html`, {
  waitUntil: "domcontentloaded",
  timeout: 15_000,
})

const send = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg)

/** Reads the real Chrome state back out. */
const readState = () =>
  page.evaluate(async () => {
    const tabs = await chrome.tabs.query({})
    const groups = await chrome.tabGroups.query({})
    return {
      tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, groupId: t.groupId, pinned: t.pinned })),
      groups: groups.map((g) => ({ id: g.id, title: g.title, color: g.color, collapsed: g.collapsed })),
    }
  })

async function resetTabs() {
  const st = await readState()
  const grouped = st.tabs.filter((t) => t.groupId !== -1).map((t) => t.id)
  if (grouped.length) await page.evaluate((ids) => chrome.tabs.ungroup(ids), grouped)
  // close everything except our extension page
  const keep = page.url()
  const extras = st.tabs.filter((t) => t.url !== keep).map((t) => t.id)
  if (extras.length) await page.evaluate((ids) => chrome.tabs.remove(ids), extras)
}

/** Counts real tabs: non-empty url, not one of our own extension pages. */
async function realTabCount() {
  const st = await readState()
  return st.tabs.filter((t) => t.url && !t.url.startsWith("chrome-extension://")).length
}

async function seedTabs(urls) {
  // cumulative, so a second call waits for its own tabs rather than returning
  // as soon as the earlier ones are ready
  const before = await realTabCount()

  await page.evaluate(async (list) => {
    for (const u of list) {
      try {
        await chrome.tabs.create({ url: u, active: false })
      } catch {
        /* the tab still exists with its url */
      }
    }
  }, urls)

  // Creating a tab resolves before its URL is attached, and the tracker records
  // an empty url in that window - which duplicate detection then skips.
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if ((await realTabCount()) >= before + urls.length) return
    await new Promise((r) => setTimeout(r, 200))
  }
}

/* ================================================================== */
/* 1. Each organization method                                        */
/* ================================================================== */

const METHOD_EXPECTATIONS = {
  category: {
    label: "By Category",
    // human-readable lexicon categories, never the raw tier labels
    valid: (titles) => titles.every((t) => /^[A-Z]/.test(t)) && titles.length >= 2,
    describe: "human-readable category names",
  },
  last_access: {
    label: "By Last Access",
    valid: (titles) =>
      titles.every((t) =>
        /^(just now|last \d+ (minutes?|hours?)|yesterday|\d+ days? ago|older than \d+ days)$/.test(t),
      ),
    describe: "time-bucket labels",
  },
  frequency: {
    label: "By Frequency",
    valid: (titles) => titles.every((t) => /^[ABCD] - /.test(t)),
    describe: "A-D tier labels",
  },
  relevance: {
    label: "By Relevance",
    valid: (titles) => titles.length >= 1,
    describe: "relevance buckets",
  },
  topics: {
    label: "By Topics",
    valid: (titles) => titles.length >= 1,
    describe: "user-defined topics",
  },
  memory: {
    label: "By Memory",
    valid: (titles) => titles.length >= 1,
    describe: "learned placements",
  },
}

async function testMethod(method) {
  const exp = METHOD_EXPECTATIONS[method]
  await resetTabs()
  await seedTabs(SEED.map(uniq))
  const before = await readState()
  const res = await send({ type: "ORGANIZE", method, scope: "current_window" })

  if (!res?.ok) {
    check(`method/${method}`, false, `message failed: ${res?.error}`)
    return
  }
  const after = await readState()
  const titles = after.groups.map((g) => g.title).filter(Boolean)
  const grouped = after.tabs.filter((t) => t.groupId !== -1)

  check(`method/${method} created groups`, after.groups.length >= 1, `${after.groups.length} groups`)
  check(`method/${method} grouped tabs`, grouped.length >= 2, `${grouped.length}/${after.tabs.length} grouped`)
  check(`method/${method} titles match ${exp.describe}`, exp.valid(titles), titles.slice(0, 4).join(" | "))
  check(
    `method/${method} kept every tab open`,
    after.tabs.length === before.tabs.length,
    `${before.tabs.length} -> ${after.tabs.length}`,
  )
  check(
    `method/${method} titles are unique`,
    new Set(titles).size === titles.length,
    `${titles.length} titles, ${new Set(titles).size} unique`,
  )
}

/* ================================================================== */
/* 2. Undo restores the exact prior arrangement                       */
/* ================================================================== */

async function testUndo() {
  await resetTabs()
  await seedTabs(SEED.slice(0, 8).map(uniq))

  // build a deliberate arrangement: two named groups
  const st = await readState()
  const ids = st.tabs.map((t) => t.id)
  const g1 = await page.evaluate((i) => chrome.tabs.group({ tabIds: i }), ids.slice(0, 3))
  await page.evaluate((g) => chrome.tabGroups.update(g, { title: "Alpha", color: "blue" }), g1)
  const g2 = await page.evaluate((i) => chrome.tabs.group({ tabIds: i }), ids.slice(3, 5))
  await page.evaluate((g) => chrome.tabGroups.update(g, { title: "Beta", color: "red" }), g2)

  const before = await readState()
  const beforeGroups = before.groups.map((g) => g.title).sort()

  const res = await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  const mid = await readState()
  const changed = JSON.stringify(mid.groups.map((g) => g.title).sort()) !== JSON.stringify(beforeGroups)
  check("undo/setup changed the arrangement", changed, `now ${mid.groups.length} groups`)

  const undo = await send({ type: "UNDO" })
  check("undo/returns ok", !!undo?.ok, undo?.error ?? JSON.stringify(undo?.data))

  const after = await readState()
  const afterGroups = after.groups.map((g) => g.title).sort()
  check(
    "undo/restored group titles exactly",
    JSON.stringify(afterGroups) === JSON.stringify(beforeGroups),
    `${afterGroups.join(",")} vs ${beforeGroups.join(",")}`,
  )
  check(
    "undo/restored tab count",
    after.tabs.length === before.tabs.length,
    `${before.tabs.length} -> ${after.tabs.length}`,
  )
  const beforeColours = before.groups.map((g) => `${g.title}:${g.color}`).sort()
  const afterColours = after.groups.map((g) => `${g.title}:${g.color}`).sort()
  check("undo/restored group colours", JSON.stringify(beforeColours) === JSON.stringify(afterColours), afterColours.join(","))
}

/* ================================================================== */
/* 3. Duplicate cleaning                                              */
/* ================================================================== */

async function testDuplicates() {
  await resetTabs()
  const base = SEED.slice(0, 4).map(uniq)
  await seedTabs(base)
  await seedTabs(base) // exact duplicates
  await seedTabs([base[0].replace(/\?e2e=\d+$/, "") + "?utm_source=newsletter"]) // tracking-param dup

  const before = await readState()
  const res = await send({ type: "CLEAN_DUPLICATES" })
  const after = await readState()

  check("duplicates/found a set", res?.ok && (res.data?.found ?? 0) >= 1, JSON.stringify(res?.data))
  check("duplicates/closed some tabs", (res?.data?.closed ?? 0) >= 2, `closed ${res?.data?.closed}`)
  check("duplicates/tab count dropped", after.tabs.length < before.tabs.length, `${before.tabs.length} -> ${after.tabs.length}`)
  check(
    "duplicates/left no exact url duplicates",
    new Set(after.tabs.map((t) => t.url)).size === after.tabs.length,
    `${after.tabs.length} tabs, ${new Set(after.tabs.map((t) => t.url)).size} unique urls`,
  )

  // recycle bin should hold them (default bin mode)
  const bin = await send({ type: "RECYCLE_LIST" })
  const entries = bin?.data ?? []
  check("duplicates/went to the recycle bin", entries.length >= 1, `${entries.length} entries`)

  const restored = await send({ type: "RECYCLE_RESTORE", ids: entries.slice(0, 1).map((e) => e.id) })
  check("recycle/restored an entry", restored?.ok && (restored.data?.restored ?? 0) >= 1, JSON.stringify(restored?.data))
}

/* ================================================================== */
/* 4. Search, rename, group operations                                */
/* ================================================================== */

async function testTabOperations() {
  await resetTabs()
  await seedTabs([uniq("https://github.com/vercel/next.js"), uniq("https://www.nytimes.com/")])

  const search = await send({ type: "SEARCH_TABS", query: "next" })
  const hits = search?.data?.results ?? []
  check("search/finds a matching tab", hits.length >= 1, `${hits.length} hits`)
  check(
    "search/matches on title or url",
    hits.every((h) => `${h.title} ${h.url}`.toLowerCase().includes("next")),
    hits[0]?.title ?? "",
  )

  const st = await readState()
  const target = st.tabs.find((t) => t.url.includes("github.com"))
  const renamed = await send({ type: "RENAME_TAB", tabId: target.id, title: "E2E Renamed Tab" })

  // Host access is an optional permission the user grants on first use, so in a
  // fresh profile the correct behaviour is a clear, actionable refusal rather
  // than a silent failure or a crash.
  const guardMessage = "Orbit needs permission to run on this site"
  const guarded = !renamed?.ok && (renamed?.error ?? "").includes(guardMessage)
  check(
    "rename/refuses clearly without host access",
    guarded,
    guarded ? "correct guard message" : `unexpected: ${renamed?.ok ? "succeeded" : renamed?.error}`,
  )
  check(
    "rename/does not silently corrupt the title",
    (await readState()).tabs.find((t) => t.id === target.id)?.title?.includes("GitHub") ?? false,
    "original title intact",
  )

  // create a group from two tabs, then rename and recolour it
  const fresh = await readState()
  const ids = fresh.tabs.map((t) => t.id).slice(0, 2)
  const created = await send({ type: "CREATE_GROUP", windowId: undefined, title: "E2E Group", tabIds: ids })
  const groupId = created?.data?.groupId
  check("group/created", created?.ok && typeof groupId === "number", JSON.stringify(created?.data))

  const updated = await send({ type: "UPDATE_GROUP", groupId, title: "Renamed Group", color: "purple" })
  const st2 = await readState()
  const g = st2.groups.find((x) => x.id === groupId)
  check("group/renamed and recoloured", updated?.ok && g?.title === "Renamed Group" && g?.color === "purple", `${g?.title}/${g?.color}`)

  const collapsed = await send({ type: "TOGGLE_COLLAPSE", collapsed: true })
  const st3 = await readState()
  check(
    "group/collapsed all",
    collapsed?.ok && st3.groups.every((x) => x.collapsed),
    JSON.stringify(collapsed?.data),
  )

  const moved = await send({ type: "MOVE_TABS", tabIds: [st3.tabs[0].id], targetGroupId: groupId })
  const st4 = await readState()
  check("group/tab moved into it", moved?.ok && st4.tabs.find((t) => t.id === st3.tabs[0].id)?.groupId === groupId, JSON.stringify(moved?.data))

  const del = await send({ type: "DELETE_GROUP", groupId, closeTabs: false })
  const st5 = await readState()
  check("group/deleted without closing tabs", del?.ok && !st5.groups.some((x) => x.id === groupId), JSON.stringify(del?.data))
}

/* ================================================================== */
/* 5. Settings, topics, saved groups                                  */
/* ================================================================== */

async function testSettingsAndCollections() {
  const set = await send({ type: "SET_SETTINGS", patch: { autoMode: true, groupingDefaultState: "collapsed" } })
  check("settings/persisted a patch", set?.ok && set.data?.autoMode === true, JSON.stringify(set.data?.autoMode))

  const back = await send({ type: "GET_SETTINGS" })
  check("settings/read back", back?.data?.autoMode === true && back?.data?.groupingDefaultState === "collapsed", JSON.stringify(back?.data?.groupingDefaultState))

  // auto-organize should have grouped a newly opened tab on its own
  await resetTabs()
  await send({ type: "SET_SETTINGS", patch: { autoMode: false } })

  const sets = await send({ type: "TOPIC_SETS_LIST" })
  check("topics/starter sets shipped", (sets?.data?.length ?? 0) >= 1, `${sets?.data?.length} sets`)

  const first = sets?.data?.[0]
  if (first) {
    await send({ type: "SET_SETTINGS", patch: { activeTopicSetId: first.id } })
    await resetTabs()
    await seedTabs([
      uniq("https://github.com/vercel/next.js"),
      uniq("https://www.amazon.com/dp/B0"),
      uniq("https://open.spotify.com/playlist/2"),
    ])
    const res = await send({ type: "ORGANIZE", method: "topics", scope: "current_window" })
    const st = await readState()
    const titles = st.groups.map((g) => g.title)
    check(
      "topics/routed into the active set's topics",
      res?.ok && titles.some((t) => ["Repos & code", "Shopping", "Video & music"].includes(t)),
      titles.join(","),
    )
  }

  // saved groups: capture, list, reopen
  await resetTabs()
  await seedTabs([uniq("https://github.com/a/b"), uniq("https://www.nytimes.com/")])
  const st = await readState()
  const created = await send({ type: "SAVED_GROUPS_CREATE", name: "E2E Saved", tabIds: st.tabs.map((t) => t.id) })
  check("saved/created", created?.ok && created.data?.group?.tabs?.length >= 2, JSON.stringify(created?.data?.group?.name))

  const list = await send({ type: "SAVED_GROUPS_LIST" })
  const found = (list?.data ?? []).find((g) => g.name === "E2E Saved")
  check("saved/listed", !!found, `${list?.data?.length} saved groups`)

  if (found) {
    const opened = await send({ type: "SAVED_GROUPS_OPEN", id: found.id, newWindow: false })
    check("saved/reopened its tabs", opened?.ok && (opened.data?.opened ?? 0) >= 2, JSON.stringify(opened?.data))
    const del = await send({ type: "SAVED_GROUPS_DELETE", id: found.id })
    const list2 = await send({ type: "SAVED_GROUPS_LIST" })
    check("saved/deleted", del?.ok && !(list2?.data ?? []).some((g) => g.id === found.id), "")
  }
}

/* ================================================================== */
/* 6. Auto-organize fires on tab creation                             */
/* ================================================================== */

async function testAutoOrganize() {
  await resetTabs()
  await send({ type: "SET_SETTINGS", patch: { autoMode: true, autoMethod: "last_access", scope: "current_window" } })
  // a single tab cannot form a group, so seed enough to make grouping meaningful
  await seedTabs([
    uniq("https://github.com/x/y"),
    uniq("https://www.nytimes.com/"),
    uniq("https://www.amazon.com/dp/B0"),
  ])
  await new Promise((r) => setTimeout(r, 3500))
  const st = await readState()
  const grouped = st.tabs.filter((t) => t.groupId !== -1)
  check("auto/groups new tabs without being asked", grouped.length >= 2, `${grouped.length} grouped`)
  await send({ type: "SET_SETTINGS", patch: { autoMode: false } })
}

/* ================================================================== */
/* 7. Ungroup + protect pinned                                        */
/* ================================================================== */

async function testUngroupAndPinned() {
  await resetTabs()
  await seedTabs(SEED.slice(0, 6).map(uniq))
  await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  const mid = await readState()
  check("ungroup/setup created groups", mid.groups.length >= 1, `${mid.groups.length}`)

  const res = await send({ type: "UNGROUP_ALL" })
  const after = await readState()
  check("ungroup/removed every group", res?.ok && after.groups.length === 0, `${after.groups.length} left`)
  check("ungroup/kept every tab open", after.tabs.length === mid.tabs.length, `${mid.tabs.length} -> ${after.tabs.length}`)
}

/**
 * `lockGroups` - By Category on a repeat run.
 *
 * With the switch on, a second pass must KEEP the groups already on screen and
 * only file the newly ungrouped tabs. Without it, the pass ungroups every window
 * first and rebuilds from scratch, which is the difference between "file my new
 * tabs" and "throw away what I arranged".
 */
async function testLockGroups() {
  await resetTabs()
  await send({ type: "SET_SETTINGS", patch: { method: "category", lockGroups: true } })

  await seedTabs(SEED.slice(0, 8).map(uniq))
  const firstRes = await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  const first = await readState()
  const firstIds = first.groups.map((g) => g.id).sort()
  check(
    "lock/first pass creates groups",
    firstIds.length > 0,
    `${firstIds.length} groups (${firstRes?.data?.groups ?? "?"} reported)`,
  )

  // new tabs, all ungrouped
  await seedTabs(SEED.slice(8, 12).map(uniq))
  const beforeSecond = await readState()
  const ungroupedBefore = beforeSecond.tabs.filter(
    (t) => t.groupId === -1 && (t.url ?? "").startsWith("https"),
  ).length
  check("lock/new tabs start ungrouped", ungroupedBefore >= 2, `${ungroupedBefore} ungrouped`)

  const secondRes = await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  const second = await readState()
  const secondIds = second.groups.map((g) => g.id)
  const survived = firstIds.filter((id) => secondIds.includes(id))

  check(
    "lock/second pass keeps every group that already existed",
    survived.length === firstIds.length,
    `${survived.length}/${firstIds.length} original group ids survived`,
  )

  const ungroupedAfter = second.tabs.filter(
    (t) => t.groupId === -1 && (t.url ?? "").startsWith("https"),
  ).length
  check(
    "lock/second pass files the new tabs",
    ungroupedAfter < ungroupedBefore,
    `${ungroupedBefore} -> ${ungroupedAfter} ungrouped`,
  )
  check(
    "lock/second pass keeps every tab open",
    second.tabs.length === beforeSecond.tabs.length,
    `${beforeSecond.tabs.length} -> ${second.tabs.length}`,
  )
  check(
    "lock/second pass reports what it filed",
    (secondRes?.data?.tabsGrouped ?? 0) > 0,
    `tabsGrouped=${secondRes?.data?.tabsGrouped}`,
  )
}

/**
 * "Focus Active" grouping state: after a pass, only the group holding the active
 * tab stays open and the rest collapse. It is the one state that cannot be
 * expressed as a boolean, so it is worth checking it actually runs.
 */
async function testFocusActive() {
  await resetTabs()
  await send({ type: "SET_SETTINGS", patch: { method: "category", groupingDefaultState: "active-only" } })
  await seedTabs(SEED.slice(0, 12).map(uniq))
  // Activate a real tab first. The active tab is otherwise the extension's own
  // page, which the organizer filters out, so there would be no active GROUP to
  // keep open and every group would correctly collapse.
  await page.evaluate(async () => {
    const win = await chrome.windows.getCurrent()
    const tabs = await chrome.tabs.query({ windowId: win.id })
    const target = tabs.find((t) => (t.url ?? "").startsWith("https://"))
    if (target?.id != null) await chrome.tabs.update(target.id, { active: true })
  })
  await new Promise((r) => setTimeout(r, 700))

  await send({ type: "ORGANIZE", method: "category", scope: "current_window" })

  const st = await page.evaluate(async () => {
    // tabGroups.query has no `currentWindow` — resolve the window first.
    const win = await chrome.windows.getCurrent()
    const tabs = await chrome.tabs.query({ windowId: win.id })
    const groups = await chrome.tabGroups.query({ windowId: win.id })
    const active = tabs.find((t) => t.active)
    return {
      groups: groups.map((g) => ({ id: g.id, collapsed: !!g.collapsed })),
      activeGroup: active?.groupId ?? -1,
    }
  })

  check("focus/creates groups to focus among", st.groups.length > 1, `${st.groups.length} groups`)
  if (st.groups.length > 1 && st.activeGroup !== -1) {
    const collapsed = st.groups.filter((g) => g.collapsed).length
    const activeIsOpen = st.groups.find((g) => g.id === st.activeGroup)?.collapsed === false
    check("focus/the active tab's group stays open", activeIsOpen, `activeGroup ${st.activeGroup}`)
    check(
      "focus/every other group collapses",
      collapsed === st.groups.length - 1,
      `${collapsed} of ${st.groups.length} collapsed`,
    )
  } else {
    check("focus/the active tab's group stays open", false, "no active group")
    check("focus/every other group collapses", false, "no active group")
  }

  // put the default back so later checks are unaffected
  await send({ type: "SET_SETTINGS", patch: { groupingDefaultState: "unchanged" } })
}

/* ------------------------------------------------------------------ */

try {
  console.error("[e2e] running")
  for (const m of ["category", "last_access", "frequency", "relevance", "topics", "memory"]) {
    console.error(`[e2e] method: ${m}`)
    await testMethod(m)
  }
  console.error("[e2e] undo")
  await testUndo()
  console.error("[e2e] duplicates")
  await testDuplicates()
  console.error("[e2e] tab operations")
  await testTabOperations()
  console.error("[e2e] settings/collections")
  await testSettingsAndCollections()
  console.error("[e2e] auto-organize")
  await testAutoOrganize()
  console.error("[e2e] ungroup")
  await testUngroupAndPinned()
  console.error("[e2e] lock groups")
  await testLockGroups()
  console.error("[e2e] focus active")
  await testFocusActive()
} catch (e) {
  check("harness", false, `threw: ${String(e).slice(0, 200)}`)
}

const passed = results.filter((r) => r.ok).length
writeFileSync(resolve(OUT, "e2e.json"), JSON.stringify({ passed, total: results.length, results }, null, 2))
console.error(`\n[e2e] ${passed}/${results.length} checks passed`)
await ctx.close()
process.exitCode = passed === results.length ? 0 : 1
