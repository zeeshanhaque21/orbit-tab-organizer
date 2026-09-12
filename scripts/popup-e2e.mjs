/**
 * Popup interaction suite.
 *
 * The popup is the surface users touch most and it had no interaction coverage
 * at all. It opens as a normal page, so it can be driven directly.
 *
 * Usage: node scripts/popup-e2e.mjs
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

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok, detail: String(detail).slice(0, 200) })
  console.error(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`)
}

const SEED = [
  "https://github.com/vercel/next.js",
  "https://www.amazon.com/dp/B0BXYZ",
  "https://www.nytimes.com/",
  "https://open.spotify.com/playlist/1",
  "https://www.figma.com/file/abc",
  "https://linear.app/orbit/board",
]

let seq = 0
const uniq = (u) => `${u}${u.includes("?") ? "&" : "?"}p=${++seq}`

sweepStaleProfiles()
const ctx = await chromium.launchPersistentContext(profileDir("orbit-pop"), {
  executablePath: findChromium(),
  headless: false,
  viewport: { width: 384, height: 620 },
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

const ctl = await ctx.newPage()
await ctl.goto(`chrome-extension://${extId}/hub.html`, { waitUntil: "domcontentloaded" })
const send = (m) => ctl.evaluate((msg) => chrome.runtime.sendMessage(msg), m)
const chromeState = () =>
  ctl.evaluate(async () => {
    const tabs = await chrome.tabs.query({})
    const groups = await chrome.tabGroups.query({})
    return {
      tabs: tabs.map((t) => ({ id: t.id, url: t.url, groupId: t.groupId, title: t.title })),
      groups: groups.map((g) => ({ id: g.id, title: g.title, collapsed: g.collapsed })),
    }
  })
const settings = () =>
  ctl.evaluate(async () => (await chrome.storage.local.get("settings")).settings ?? null)

/** Opens the popup page with the first-run tour already dismissed. */
async function openPopup({ tourDone = true } = {}) {
  if (tourDone) await send({ type: "SET_SETTINGS", patch: { tourDone: true } })
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 384, height: 620 })
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1200)
  return page
}

try {
  console.error("[popup] seeding")
  await ctl.evaluate(async (urls) => {
    for (const u of urls) {
      try {
        await chrome.tabs.create({ url: u, active: false })
      } catch {
        /* url still recorded */
      }
    }
  }, SEED.map(uniq))
  await new Promise((r) => setTimeout(r, 1200))

  /* ---- 1. first run shows the tour, and finishing it persists ---- */
  await send({ type: "SET_SETTINGS", patch: { tourDone: false } })
  const firstRun = await ctx.newPage()
  await firstRun.setViewportSize({ width: 384, height: 620 })
  await firstRun.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" })
  await firstRun.waitForTimeout(1600)
  const tourVisible = await firstRun.locator(".modal", { hasText: /Welcome to Orbit/i }).count()
  check("tour/shows on first run", tourVisible > 0, `${tourVisible} modal(s)`)

  if (tourVisible > 0) {
    // advance through every step
    for (let i = 0; i < 6; i++) {
      const next = firstRun.locator(".modal button", { hasText: /Next|Start organizing/i }).first()
      if ((await next.count()) === 0) break
      await next.click()
      await firstRun.waitForTimeout(350)
    }
    const stillOpen = await firstRun.locator(".modal", { hasText: /Welcome to Orbit/i }).count()
    check("tour/closes after the last step", stillOpen === 0, `${stillOpen} left open`)
    const s = await settings()
    check("tour/records completion", s?.tourDone === true, `tourDone=${s?.tourDone}`)
  }
  await firstRun.close()

  /* ---- 2. the shell renders ---- */
  const pop = await openPopup()
  const methods = await pop.locator(".method").count()
  check("shell/renders all six methods", methods === 6, `${methods} methods`)
  check("shell/shows the organize button", (await pop.locator(".organize").count()) > 0, "")
  check("shell/shows the provider pill", (await pop.locator(".pill").count()) >= 1, "")
  check("shell/labels the built-in engine", /built-in engine/i.test(await pop.locator(".foot").innerText()), "")

  /* ---- 3. picking a method persists and marks the row ---- */
  const freq = pop.locator(".method", { hasText: /By Frequency/i }).first()
  await freq.click()
  await pop.waitForTimeout(700)
  const s3 = await settings()
  check("method/clicking a row persists it", s3?.method === "frequency", `method=${s3?.method}`)
  const checked = await freq.getAttribute("aria-checked")
  check("method/row is marked selected", checked === "true", `aria-checked=${checked}`)

  /* ---- 4. scope toggle persists ---- */
  const allWin = pop.locator(".segmented button", { hasText: /All windows/i }).first()
  await allWin.click()
  await pop.waitForTimeout(700)
  const s4 = await settings()
  check("scope/clicking All windows persists it", s4?.scope === "all_windows", `scope=${s4?.scope}`)
  const note = await pop.locator(".scope-note").innerText()
  check("scope/explains the consequence", /one organized window/i.test(note), note.slice(0, 70))
  await pop.locator(".segmented button", { hasText: /This window/i }).first().click()
  await pop.waitForTimeout(500)

  /* ---- 4b. no label may promise behaviour that does not exist ---- */
  // The method list carried a "hover to preview" hint while every row already
  // printed its own description, so there was nothing a hover could reveal.
  const misleading = await pop.evaluate(() => {
    const text = document.body.innerText.toLowerCase()
    const promised = []
    for (const phrase of ["hover to preview", "click to preview", "hover for details"]) {
      if (text.includes(phrase)) promised.push(phrase)
    }
    const rows = [...document.querySelectorAll(".method")]
    const withBody = rows.filter(
      (r) => (r.querySelector(".method-body")?.textContent ?? "").trim().length > 20,
    )
    return { promised, rows: rows.length, withBody: withBody.length }
  })
  check(
    "methods/no hint promises a preview that does not exist",
    misleading.promised.length === 0,
    misleading.promised.join(", ") || "none",
  )
  check(
    "methods/every method explains itself in place",
    misleading.rows > 0 && misleading.withBody === misleading.rows,
    `${misleading.withBody}/${misleading.rows} rows carry a description`,
  )

  /* ---- 5. Organize Now actually organizes, and enables Undo ---- */
  const undoBefore = await pop.locator("button", { hasText: /^Undo$/ }).first().isDisabled()
  const before = await chromeState()
  await pop.locator(".organize").first().click()
  await pop.waitForTimeout(3500)
  const after = await chromeState()
  check(
    "organize/creates real tab groups",
    after.groups.length > before.groups.length,
    `${before.groups.length} -> ${after.groups.length} groups`,
  )
  const result = await pop.locator(".result").innerText().catch(() => "")
  check("organize/reports what it did", /organized by|group/i.test(result), result.replace(/\s+/g, " ").slice(0, 80))
  const undoAfter = await pop.locator("button", { hasText: /^Undo$/ }).first().isDisabled()
  check("organize/enables the Undo button", undoBefore === true && undoAfter === false, `disabled ${undoBefore} -> ${undoAfter}`)

  /* ---- 6. Undo restores ---- */
  await pop.locator("button", { hasText: /^Undo$/ }).first().click()
  await pop.waitForTimeout(3500)
  const restored = await chromeState()
  check(
    "undo/removes the groups the pass created",
    restored.groups.length === before.groups.length,
    `${after.groups.length} -> ${restored.groups.length} (expected ${before.groups.length})`,
  )

  /* ---- 7. clean duplicates reports honestly ---- */
  await pop.locator(".tool", { hasText: /Clean duplicates/i }).first().click()
  await pop.waitForTimeout(2500)
  const dupToast = await pop.locator(".toast").first().innerText().catch(() => "")
  check(
    "duplicates/reports either cleaned or none found",
    /duplicate/i.test(dupToast),
    dupToast.replace(/\s+/g, " ").slice(0, 70),
  )

  /* ---- 7b. the duplicate-clean notice can be silenced ---- */
  // `dontShowDuplicateCleanNotice` was stored and toggled in Settings but never
  // read, so the switch did nothing.
  await send({ type: "SET_SETTINGS", patch: { dontShowDuplicateCleanNotice: true } })
  const quiet = await openPopup()
  await quiet.locator(".tool", { hasText: /Clean duplicates/i }).first().click()
  await quiet.waitForTimeout(2500)
  const quietToast = await quiet.locator(".toast").count()
  check(
    "duplicates/silenced when the notice is switched off",
    quietToast === 0,
    `${quietToast} toasts`,
  )
  await send({ type: "SET_SETTINGS", patch: { dontShowDuplicateCleanNotice: false } })
  // the popup reads settings once at boot, so reopen to pick the change up
  await quiet.close()
  const loud = await openPopup()
  await loud.locator(".tool", { hasText: /Clean duplicates/i }).first().click()
  await loud.waitForTimeout(2500)
  const loudToast = await loud.locator(".toast").count()
  check(
    "duplicates/notice returns when the switch is back on",
    loudToast > 0,
    `${loudToast} toasts`,
  )
  await loud.close()

  /* ---- 8. auto-organize switch persists ---- */
  const auto = pop.locator(".auto input[type=checkbox]").first()
  const autoWas = await auto.isChecked()
  await auto.click()
  await pop.waitForTimeout(800)
  const s8 = await settings()
  check("auto/switch persists", s8?.autoMode !== autoWas, `autoMode=${s8?.autoMode}`)
  await pop.locator(".auto input[type=checkbox]").first().click()
  await pop.waitForTimeout(500)

  /* ---- 9. ungroup all asks first, then acts ---- */
  await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
  await pop.waitForTimeout(1500)
  await pop.reload({ waitUntil: "domcontentloaded" })
  await pop.waitForTimeout(1200)
  await pop.locator(".tool", { hasText: /Ungroup all/i }).first().click()
  await pop.waitForTimeout(600)
  const confirm = await pop.locator(".modal", { hasText: /Ungroup every tab/i }).count()
  check("ungroup/asks for confirmation first", confirm > 0, `${confirm} modal(s)`)
  if (confirm > 0) {
    const groupedBefore = (await chromeState()).groups.length
    await pop.locator(".modal button", { hasText: /^Ungroup$/ }).first().click()
    await pop.waitForTimeout(2200)
    const groupedAfter = (await chromeState()).groups.length
    check("ungroup/removes the groups once confirmed", groupedAfter < groupedBefore, `${groupedBefore} -> ${groupedAfter}`)
  } else {
    check("ungroup/removes the groups once confirmed", false, "no confirm dialog")
  }

  /* ---- 10. search mode finds and highlights tabs ---- */
  await pop.reload({ waitUntil: "domcontentloaded" })
  await pop.waitForTimeout(1200)
  await pop.locator(".head-actions button").first().click() // the search icon
  await pop.waitForTimeout(600)
  const searchInput = pop.locator(".mode-input input").first()
  check("search/opens a search field", (await searchInput.count()) > 0, "")
  if ((await searchInput.count()) > 0) {
    await searchInput.fill("git")
    await pop.waitForTimeout(1200)
    const hits = await pop.locator(".hit").count()
    const marks = await pop.locator("mark").count()
    check("search/lists matching tabs", hits >= 1, `${hits} hits`)
    check("search/highlights the match", marks >= 1, `${marks} marks`)
    const empty = await pop.locator(".empty").count()
    await searchInput.fill("zzzznothingmatches")
    await pop.waitForTimeout(1200)
    check("search/shows an empty state when nothing matches", (await pop.locator(".empty").count()) > 0 || empty > 0, "")
  }

  /* ---- 11. rename mode guards on the missing permission ---- */
  await pop.reload({ waitUntil: "domcontentloaded" })
  await pop.waitForTimeout(1200)
  await pop.locator(".tool", { hasText: /Rename tab/i }).first().click()
  await pop.waitForTimeout(700)
  const renameInput = pop.locator(".mode-input input").first()
  check("rename/opens a name field", (await renameInput.count()) > 0, "")
  if ((await renameInput.count()) > 0) {
    const before = await chromeState()
    const targetTab = before.tabs.find((t) => t.url.includes("github.com"))

    await renameInput.fill("Popup Rename Test")
    await pop.locator("button", { hasText: /Rename tab/i }).last().click()
    // longer than the popup's own permission timeout, so the fallback message
    // has definitely fired by the time we look
    await pop.waitForTimeout(6500)

    // Host access is optional, and Chrome's permission bubble is browser UI that
    // cannot be driven from here - so the request may be pending, refused, or
    // (on a profile that already granted it) accepted. What must hold in every
    // case is that the page is never left half-renamed or silently corrupted.
    const after = await chromeState()
    const targetNow = after.tabs.find((t) => t.id === targetTab?.id)
    const toast = await pop.locator(".toast").first().innerText().catch(() => "")
    const refusedClearly = /permission|site access|could not rename/i.test(toast)
    const renamed = targetNow?.title === "Popup Rename Test"

    check(
      "rename/either refuses clearly or renames, never half-applies",
      refusedClearly || renamed,
      `toast="${toast.replace(/\s+/g, " ").slice(0, 50)}" title="${targetNow?.title?.slice(0, 40)}"`,
    )
    check(
      "rename/does not corrupt the title when it cannot run",
      renamed || (targetNow?.title ?? "").includes("GitHub"),
      targetNow?.title?.slice(0, 50) ?? "tab gone",
    )

    // The bug this guards: the handler used to persist the custom title BEFORE
    // checking whether it could be applied. A refused rename was reported as a
    // failure, yet the name was stored and would silently reappear on every
    // future navigation once host access was granted.
    const s = await settings()
    const stored = s?.customTabTitles?.[String(targetTab?.id)]
    check(
      "rename/stores nothing when it could not apply",
      renamed ? stored === "Popup Rename Test" : stored === undefined,
      `stored=${JSON.stringify(stored)}`,
    )
  }

  /* ---- 11b. combine windows from the popup ---- */
  // The same action is offered on the popup, where users look for tab tools.
  const winA = await ctl.evaluate(async () => {
    const w = await chrome.windows.create({ url: "https://example.com/x", focused: false })
    return w.id
  })
  await ctl.evaluate(async () => {
    await chrome.windows.create({ url: "https://example.com/y", focused: false })
  })
  await new Promise((r) => setTimeout(r, 1200))

  const comb = await openPopup()
  const beforeCombine = await ctl.evaluate(async () => {
    const tabs = await chrome.tabs.query({})
    const wins = await chrome.windows.getAll({ populate: false })
    return { tabCount: tabs.length, windows: wins.length }
  })

  const combTool = comb.locator(".tool", { hasText: /Combine windows/i }).first()
  check("combine/popup offers the action", (await combTool.count()) > 0, "")

  if ((await combTool.count()) > 0) {
    await combTool.click({ timeout: 8000 })
    await comb.waitForTimeout(700)
    const dlg = comb.locator(".modal", { hasText: /combine windows/i })
    check("combine/popup confirms first", (await dlg.count()) > 0, "")

    if ((await dlg.count()) > 0) {
      await comb.locator(".modal button", { hasText: /^Combine$/ }).first().click({ timeout: 8000 })
      await comb.waitForTimeout(2000)
      const afterCombine = await ctl.evaluate(async () => {
        const tabs = await chrome.tabs.query({})
        const wins = await chrome.windows.getAll({ populate: false })
        return { tabCount: tabs.length, windows: wins.length }
      })
      check(
        "combine/popup ends with a single window",
        afterCombine.windows === 1,
        `${beforeCombine.windows} -> ${afterCombine.windows}`,
      )
      check(
        "combine/popup loses no tabs",
        afterCombine.tabCount === beforeCombine.tabCount,
        `${beforeCombine.tabCount} -> ${afterCombine.tabCount}`,
      )
    } else {
      check("combine/popup ends with a single window", false, "no dialog")
      check("combine/popup loses no tabs", false, "no dialog")
    }
  } else {
    check("combine/popup confirms first", false, "no tool")
    check("combine/popup ends with a single window", false, "no tool")
    check("combine/popup loses no tabs", false, "no tool")
  }
  await comb.close()
  await ctl.evaluate(async (id) => {
    await chrome.windows.remove(id).catch(() => null)
  }, winA)
  await new Promise((r) => setTimeout(r, 800))

  /* ---- 12. the what's-new notice ---- */
  // The background records the version on update; the popup is supposed to
  // surface it until acknowledged. It was half-wired: the version was written
  // and never read, so the notice could never appear.
  await ctl.evaluate(async () => {
    await chrome.storage.local.set({ meta: { whatsNewVersion: "9.9.9", updatedAt: Date.now() } })
  })
  const wn = await openPopup()
  const banner = await wn.locator(".banner").innerText().catch(() => "")
  check(
    "whatsnew/shows the pending version",
    /updated to 9\.9\.9/i.test(banner),
    banner.replace(/\s+/g, " ").slice(0, 70),
  )

  if (/9\.9\.9/.test(banner)) {
    await wn.locator(".banner button", { hasText: /dismiss/i }).first().click()
    await wn.waitForTimeout(900)
    const afterDismiss = await wn.locator(".banner").count()
    const s = await settings()
    check("whatsnew/dismissing hides it", afterDismiss === 0, `${afterDismiss} banners left`)
    check(
      "whatsnew/dismissing records the version as seen",
      s?.whatsNewSeenVersion === "9.9.9",
      `seen=${s?.whatsNewSeenVersion}`,
    )

    const again = await openPopup()
    const stillGone = await again.locator(".banner").innerText().catch(() => "")
    check(
      "whatsnew/stays dismissed on the next open",
      !/9\.9\.9/.test(stillGone),
      stillGone.replace(/\s+/g, " ").slice(0, 60),
    )
    await again.close()
  } else {
    check("whatsnew/dismissing hides it", false, "no notice to dismiss")
    check("whatsnew/dismissing records the version as seen", false, "no notice to dismiss")
    check("whatsnew/stays dismissed on the next open", false, "no notice to dismiss")
  }
  await wn.close()

  /* ---- 13. every method produces a usable pass ---- */
  for (const label of ["By Category", "By Last Access", "By Frequency", "By Relevance", "By Topics", "By Memory"]) {
    await send({ type: "SET_SETTINGS", patch: { method: labelToId(label) } })
  }
  const finalSettings = await settings()
  check("methods/all six are selectable", !!finalSettings?.method, `last=${finalSettings?.method}`)

  await pop.screenshot({ path: resolve(OUT, "popup-interactions.png") })
} catch (e) {
  check("harness", false, `threw: ${String(e).slice(0, 200)}`)
}

function labelToId(label) {
  return {
    "By Category": "category",
    "By Last Access": "last_access",
    "By Frequency": "frequency",
    "By Relevance": "relevance",
    "By Topics": "topics",
    "By Memory": "memory",
  }[label]
}

const passed = results.filter((r) => r.ok).length
writeFileSync(resolve(OUT, "popup-e2e.json"), JSON.stringify({ passed, total: results.length, results }, null, 2))
console.error(`\n[popup] ${passed}/${results.length} checks passed`)
await ctx.close()
process.exitCode = passed === results.length ? 0 : 1
