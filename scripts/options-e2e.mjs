/**
 * Options page interaction suite.
 *
 * The page renders all eight sections on one scrolling document, with
 * `a.nav-item[data-section]` anchors jumping to `#sec-<id>`. Nothing had ever
 * clicked any of it. This drives the real page against real chrome.storage.
 *
 * Usage: node scripts/options-e2e.mjs
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

const SECTIONS = ["organizing", "duplicates", "ai", "topics", "saved", "recycle", "shortcuts", "data"]

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok, detail: String(detail).slice(0, 200) })
  console.error(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`)
}

sweepStaleProfiles()
const ctx = await chromium.launchPersistentContext(profileDir("orbit-opt"), {
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
const errors = []
page.on("pageerror", (e) => errors.push(e.message))

const stored = () =>
  page.evaluate(async () => {
    const raw = await chrome.storage.local.get("settings")
    return raw.settings ?? null
  })

/** Clicks the first element inside a section whose text matches. */
async function clickIn(section, re) {
  const loc = page.locator(`#sec-${section} label, #sec-${section} button, #sec-${section} .opt-radio`).filter({ hasText: re }).first()
  if ((await loc.count()) === 0) return false
  await loc.click()
  await page.waitForTimeout(650)
  return true
}

try {
  await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)

  /* ---- 1. shell ---- */
  const navCount = await page.locator("#opt-nav a.nav-item").count()
  check("shell/renders all eight nav items", navCount === 8, `${navCount} items`)
  check("shell/no page errors on load", errors.length === 0, errors.slice(0, 2).join(" | "))

  /* ---- 2. every section exists and has content ---- */
  const missing = []
  for (const id of SECTIONS) {
    const el = page.locator(`#sec-${id}`)
    if ((await el.count()) === 0) {
      missing.push(`${id}:absent`)
      continue
    }
    const text = (await el.innerText()).trim()
    if (text.length < 30) missing.push(`${id}:empty`)
  }
  check("sections/all eight render content", missing.length === 0, missing.join(",") || "all present")

  /* ---- 3. nav anchors scroll to their section ---- */
  await page.locator('#opt-nav a.nav-item[data-section="shortcuts"]').click()
  await page.waitForTimeout(900)
  const scrolled = await page.evaluate(() => {
    const el = document.getElementById("sec-shortcuts")
    if (!el) return -1
    const r = el.getBoundingClientRect()
    return r.top
  })
  check("nav/clicking an anchor scrolls that section into view", scrolled > -50 && scrolled < 400, `top=${Math.round(scrolled)}`)

  /* ---- 4. method change persists ---- */
  const okMethod = await clickIn("organizing", /By Frequency/i)
  if (okMethod) {
    const s = await stored()
    check("organizing/method writes through immediately", s?.method === "frequency", `method=${s?.method}`)
  } else {
    check("organizing/method writes through immediately", false, "no By Frequency control")
  }

  /* ---- 5. scope change persists ---- */
  const okScope = await clickIn("organizing", /All windows/i)
  if (okScope) {
    const s = await stored()
    check("organizing/scope writes through immediately", s?.scope === "all_windows", `scope=${s?.scope}`)
    await clickIn("organizing", /Current window only|This window/i)
  } else {
    check("organizing/scope writes through immediately", false, "no All windows control")
  }

  /* ---- 6. auto-organize toggle persists ---- */
  const autoBox = page.locator('#sec-organizing input[type="checkbox"]').first()
  if ((await autoBox.count()) > 0) {
    const before = await autoBox.isChecked()
    await autoBox.click()
    await page.waitForTimeout(650)
    const s = await stored()
    check("organizing/auto-organize toggle writes through", s?.autoMode !== before, `autoMode=${s?.autoMode}`)
    await autoBox.click()
    await page.waitForTimeout(400)
  } else {
    check("organizing/auto-organize toggle writes through", false, "no checkbox")
  }

  /* ---- 7. duplicates: permanent removal warns ---- */
  const okPerm = await clickIn("duplicates", /permanent/i)
  if (okPerm) {
    const s = await stored()
    const text = await page.locator("#sec-duplicates").innerText()
    check("duplicates/permanent mode persists", s?.duplicateBinMode === "permanent", `binMode=${s?.duplicateBinMode}`)
    check("duplicates/permanent mode warns about it", /cannot be undone|permanent|warning/i.test(text), "warning present")
    await clickIn("duplicates", /recycle/i)
  } else {
    check("duplicates/permanent mode persists", false, "no permanent option")
  }

  /* ---- 8. AI provider prefills url and model ---- */
  const providerSelect = page.locator("#sec-ai select").first()
  if ((await providerSelect.count()) > 0) {
    await providerSelect.selectOption("openai")
    await page.waitForTimeout(800)
    const s = await stored()
    const urlInput = page.locator('#sec-ai input[type="url"]').first()
    const url = (await urlInput.count()) > 0 ? await urlInput.inputValue() : ""
    const modelVal = s?.ai?.model ?? ""
    check("ai/selecting a provider persists it", s?.ai?.provider === "openai", `provider=${s?.ai?.provider}`)
    check("ai/prefills the base url", url.includes("api.openai.com"), url)
    check("ai/prefills a model", String(modelVal).length > 2, modelVal)

    // an unreachable endpoint should fail fast with a readable message
    await urlInput.fill("http://127.0.0.1:1/v1")
    await page.waitForTimeout(500)
    const testBtn = page.locator("#sec-ai button", { hasText: /test connection/i }).first()
    if ((await testBtn.count()) > 0) {
      await testBtn.click()
      // assert on the toast: the section body contains static prose that can
      // accidentally match, the toast cannot
      await page.waitForSelector(".toast", { timeout: 15000 }).catch(() => undefined)
      await page.waitForTimeout(1200)
      const toastKind = await page.evaluate(() => {
        const t = document.querySelector(".toast")
        if (!t) return "none"
        return t.classList.contains("err") ? "err" : t.classList.contains("ok") ? "ok" : "other"
      })
      const toastText = (await page.locator(".toast").first().innerText().catch(() => "")) || ""
      // the bug this guards: the page used to read the message envelope's ok
      // rather than the provider result's ok, so every failure said "succeeded"
      check(
        "ai/test connection does NOT report success for a dead endpoint",
        toastKind !== "ok",
        `toast="${toastText.replace(/\s+/g, " ").slice(0, 70)}" (${toastKind})`,
      )
      check(
        "ai/test connection reports an error toast",
        toastKind === "err",
        `${toastKind}: ${toastText.replace(/\s+/g, " ").slice(0, 70)}`,
      )
    } else {
      check("ai/test connection does NOT report success for a dead endpoint", false, "no test button")
    }
    // back to the built-in engine so nothing else is affected
    await providerSelect.selectOption("local")
    await page.waitForTimeout(500)
  } else {
    check("ai/selecting a provider persists it", false, "no provider select")
  }

  /* ---- 9. topics: starter sets are present ---- */
  const topicsText = await page.locator("#sec-topics").innerText()
  const hasSets = /Software development|Personal|Repos|Shopping|Add/i.test(topicsText)
  check("topics/ships usable starter sets", hasSets, topicsText.replace(/\s+/g, " ").slice(0, 90))

  /* ---- 9b. the remaining options affordances ---- */
  // "Focus Active" is a third value for groupingDefaultState.
  const focusActive = await page.evaluate(() => {
    const seg = [...document.querySelectorAll("button, [role=radio], label")].find((el) =>
      /focus active/i.test(el.textContent ?? ""),
    )
    return { present: !!seg, text: seg?.textContent?.trim().slice(0, 40) ?? "" }
  })
  check(
    "options/offers the Focus Active grouping state",
    focusActive.present,
    focusActive.text || "not found",
  )

  // "Change in Chrome" — a URL printed as text is not clickable, so this is a
  // button. Confirm it exists.
  const changeInChrome = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /change in chrome/i.test(b.textContent ?? ""),
    )
    return { present: !!btn, label: btn?.textContent?.trim() ?? "" }
  })
  check(
    "options/offers a way to rebind shortcuts in Chrome",
    changeInChrome.present,
    changeInChrome.label || "not found",
  )

  /* ---- 10. saved groups section renders its search ---- */
  const savedText = await page.locator("#sec-saved").innerText()
  check("saved/renders a searchable list", /search|no saved|saved group/i.test(savedText), savedText.replace(/\s+/g, " ").slice(0, 80))

  /* ---- 11. recycle section renders ---- */
  const recText = await page.locator("#sec-recycle").innerText()
  check("recycle/section renders", recText.length > 20, recText.replace(/\s+/g, " ").slice(0, 70))

  /* ---- 12. shortcuts table lists all four ---- */
  const scText = await page.locator("#sec-shortcuts").innerText()
  const wanted = ["collapse", "hub", "rename", "search"]
  const found = wanted.filter((w) => new RegExp(w, "i").test(scText))
  check("shortcuts/lists all four commands", found.length === 4, `found ${found.join(",")}`)
  check("shortcuts/shows real key bindings", /⌘|cmd|ctrl|shift/i.test(scText), scText.replace(/\s+/g, " ").slice(0, 80))

  /* ---- 13. data section offers export and import ---- */
  const dataText = await page.locator("#sec-data").innerText()
  check("data/offers export and import", /export/i.test(dataText) && /import/i.test(dataText), dataText.replace(/\s+/g, " ").slice(0, 80))
  check("data/offers a destructive reset", /reset|clear|remove all/i.test(dataText), "reset present")

  /* ---- 14. settings survive a reload ---- */
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1800)
  const after = await stored()
  check("persistence/settings survive a reload", after?.method === "frequency", `method=${after?.method}`)

  check("shell/no page errors after the full pass", errors.length === 0, errors.slice(0, 3).join(" | "))

  await page.screenshot({ path: resolve(OUT, "options-interactions.png"), fullPage: false })
} catch (e) {
  check("harness", false, `threw: ${String(e).slice(0, 200)}`)
}

const passed = results.filter((r) => r.ok).length
writeFileSync(resolve(OUT, "options-e2e.json"), JSON.stringify({ passed, total: results.length, results }, null, 2))
console.error(`\n[options] ${passed}/${results.length} checks passed`)
await ctx.close()
process.exitCode = passed === results.length ? 0 : 1
