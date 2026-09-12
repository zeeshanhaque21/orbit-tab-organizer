/**
 * By Category against a real AI endpoint, driven through the built extension.
 *
 * The unit tests prove the batching *logic* against a real HTTP server, and a
 * separate measurement proves the endpoint's placement behaviour. Neither proves
 * the extension actually does it: that the settings reach the organizer, that one
 * organize pass makes several calls, and that the merged answer lands as real
 * Chrome tab groups. That is what this suite covers.
 *
 * ## Why the redirect
 *
 * A custom endpoint would be the natural thing to point at, but
 * `ensureHostAccess()` calls `chrome.permissions.request`, and the grant bubble
 * is browser UI that Playwright cannot click — measured in
 * `archive/host-permission-probe.mjs`. So instead we use a host the manifest
 * *already* declares (`https://api.openai.com/*`), which needs no request, and
 * redirect that hostname to a local TLS server with `--host-resolver-rules`.
 * `archive/ai-endpoint-redirect-probe.mjs` confirms the redirect lands.
 *
 * Usage: node scripts/ai-e2e.mjs
 */
import { chromium } from "playwright-core"
import { profileDir, sweepStaleProfiles } from "./profile.mjs"
import { createServer } from "node:https"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir, tmpdir } from "node:os"
import { createHash } from "node:crypto"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DIST = resolve(root, "dist")
const OUT = resolve(root, "_verify")
mkdirSync(OUT, { recursive: true })

const TAB_COUNT = 150
const BATCH = 100

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok, detail: String(detail).slice(0, 240) })
  console.error(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`)
}

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

/* ---------------------------------------------------------------- */
/* A stand-in for the model endpoint                                 */
/* ---------------------------------------------------------------- */

/*
 * Deliberately not under the `orbit-` prefix: `profile.mjs` sweeps `orbit-*`
 * directories older than an hour on the assumption they are leaked browser
 * profiles, and these certs are meant to persist between runs.
 */
const certDir = resolve(tmpdir(), "ai-e2e-cert")
mkdirSync(certDir, { recursive: true })
const certPath = resolve(certDir, "cert.pem")
const keyPath = resolve(certDir, "key.pem")
if (!existsSync(certPath)) {
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2",
      "-subj", "/CN=api.openai.com",
      "-addext", "subjectAltName=DNS:api.openai.com",
    ],
    { stdio: "ignore" },
  )
}

/** Every call the extension made, in order. */
const calls = []
/** Set to a non-zero index to make that call fail. */
let failCallAt = -1

const server = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        /* leave empty */
      }
      const system = body?.messages?.[0]?.content ?? ""
      let ids = []
      try {
        ids = JSON.parse(body?.messages?.[1]?.content ?? "[]").map((t) => String(t.id))
      } catch {
        /* leave empty */
      }
      calls.push({ system, ids, url: req.url ?? "" })

      if (calls.length === failCallAt) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "stand-in failure" } }))
        return
      }

      // Answer the way the real prompt asks: one object, category -> ids.
      // Split in two so the merge path is exercised rather than a single bucket.
      const half = Math.ceil(ids.length / 2)
      const content = JSON.stringify({
        Development: ids.slice(0, half),
        Research: ids.slice(half),
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  },
)
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port

/* ---------------------------------------------------------------- */

sweepStaleProfiles()
const ctx = await chromium.launchPersistentContext(profileDir("orbit-ai-e2e"), {
  executablePath: findChromium(),
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    `--host-resolver-rules=MAP api.openai.com:443 127.0.0.1:${port}`,
    "--ignore-certificate-errors",
  ],
})

const id = extId(DIST)
const ctl = await ctx.newPage()
await ctl.goto(`chrome-extension://${id}/hub.html`)
await ctl.waitForTimeout(1500)

const send = (msg) =>
  ctl.evaluate((m) => chrome.runtime.sendMessage(m).catch((e) => ({ ok: false, error: String(e) })), msg)

const chromeState = () =>
  ctl.evaluate(async () => {
    const tabs = await chrome.tabs.query({})
    const groups = await chrome.tabGroups.query({})
    return {
      tabs: tabs.map((t) => ({ id: t.id, groupId: t.groupId })),
      groups: groups.map((g) => ({ id: g.id, title: g.title })),
    }
  })

const REAL_URLS = [
  "https://github.com/vercel/next.js/pull/60123",
  "https://developer.mozilla.org/en-US/docs/Web/API/AbortController/signal",
  "https://stackoverflow.com/questions/7891234/how-do-i-debounce-in-react-hooks",
  "https://www.amazon.com/dp/B0C1234XYZ/ref=sr_1_3?keywords=headphones",
  "https://news.ycombinator.com/item?id=38475612",
  "https://www.nytimes.com/2026/09/11/us/politics/some-article.html",
  "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
  "https://arxiv.org/abs/2401.12345v2",
  "https://mail.google.com/mail/u/0/#inbox/abc123",
  "https://docs.google.com/spreadsheets/d/1a2B3c4D5e6F7g8H9i0J/edit",
]

async function seedTabs(n) {
  for (let i = 0; i < n; i += 25) {
    const list = []
    for (let j = i; j < Math.min(i + 25, n); j++) {
      const u = REAL_URLS[j % REAL_URLS.length]
      list.push(`${u}${u.includes("?") ? "&" : "?"}ai=${j}`)
    }
    await ctl.evaluate(
      async (urls) => {
        await Promise.all(urls.map((u) => chrome.tabs.create({ url: u, active: false }).catch(() => null)))
      },
      list,
    )
  }
  // wait for them to settle
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const n2 = await ctl.evaluate(() => chrome.tabs.query({}).then((t) => t.length))
    if (n2 >= n) return true
    await ctl.waitForTimeout(400)
  }
  return false
}

async function closeAllButControl() {
  await ctl.evaluate(async () => {
    const all = await chrome.tabs.query({})
    const kill = all.filter((t) => t.url?.startsWith("http")).map((t) => t.id).filter(Boolean)
    if (kill.length) await chrome.tabs.remove(kill).catch(() => null)
  })
  await ctl.waitForTimeout(700)
}

async function configure(over = {}) {
  await ctl.evaluate(
    async (patch) => {
      const cur = (await chrome.storage.local.get("settings")).settings ?? {}
      await chrome.storage.local.set({
        settings: { ...cur, ...patch, ai: { ...(cur.ai ?? {}), ...patch.ai } },
      })
    },
    {
      method: "category",
      scope: "current_window",
      ai: {
        provider: "custom",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "stand-in-key",
        model: "stand-in-model",
        temperature: 0.1,
        batchSize: BATCH,
        ...(over.ai ?? {}),
      },
    },
  )
  await ctl.waitForTimeout(600)
}

/* ---------------------------------------------------------------- */
/* 1. the redirect really carries the extension's traffic            */
/* ---------------------------------------------------------------- */

await configure()
await closeAllButControl()
calls.length = 0
await seedTabs(TAB_COUNT)
const seeded = await chromeState()
check("setup/seeded the tabs", seeded.tabs.length >= TAB_COUNT, `${seeded.tabs.length} tabs`)

const before = await chromeState()
const res = await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
check("ai/organize completes", !!res?.ok, res?.error ?? "")

/* ---------------------------------------------------------------- */
/* 2. the request stream                                             */
/* ---------------------------------------------------------------- */

const expected = [100, 50]
check(
  "ai/split into batches of aiBatch",
  JSON.stringify(calls.map((c) => c.ids.length)) === JSON.stringify(expected),
  `saw ${JSON.stringify(calls.map((c) => c.ids.length))}, expected ${JSON.stringify(expected)}`,
)
check(
  "ai/sent every batch, not just the first",
  calls.flatMap((c) => c.ids).length === TAB_COUNT,
  `${calls.flatMap((c) => c.ids).length} of ${TAB_COUNT} ids reached the endpoint`,
)
check(
  "ai/posted to the chat completions path",
  calls.every((c) => c.url.includes("/chat/completions")),
  calls[0]?.url ?? "",
)
check(
  "ai/told later batches which names came before",
  calls.length > 1 &&
    !calls[0].system.includes("Earlier batches already used") &&
    calls[1].system.includes("Earlier batches already used"),
  calls.length > 1 ? `batch 2 hint: ${calls[1].system.includes("Earlier batches already used")}` : "",
)

/* ---------------------------------------------------------------- */
/* 3. the answer landed as real Chrome groups                        */
/* ---------------------------------------------------------------- */

const after = await chromeState()
check("ai/created real tab groups", after.groups.length > 0, `${after.groups.length} groups`)
check(
  "ai/named them from the model's answer",
  after.groups.some((g) => g.title === "Development") &&
    after.groups.some((g) => g.title === "Research"),
  after.groups.map((g) => g.title).join(", "),
)
const grouped = after.tabs.filter((t) => t.groupId !== -1).length
check("ai/grouped the tabs", grouped > 0, `${grouped} of ${after.tabs.length} grouped`)
check(
  "ai/lost no tabs",
  after.tabs.length === before.tabs.length,
  `${before.tabs.length} -> ${after.tabs.length}`,
)

/* ---------------------------------------------------------------- */
/* 4. a failing batch degrades instead of breaking                   */
/* ---------------------------------------------------------------- */

await closeAllButControl()
calls.length = 0
failCallAt = 1 // the first call fails
await seedTabs(150)
const res2 = await send({ type: "ORGANIZE", method: "category", scope: "current_window" })
const after2 = await chromeState()
check("failure/organize still completes", !!res2?.ok, res2?.error ?? "")
/*
 * This second pass takes the *incremental* path, because the first pass left
 * `lastOrganizationMethod = "category"` and lockGroups defaults on. That path
 * used to drop the AI error on the floor while the full pass reported it, so a
 * repeat run that silently fell back to the lexicon looked identical to one the
 * model had answered. Both paths now carry it.
 */
check(
  "failure/reports the batch that failed",
  typeof res2?.data?.error === "string" && res2.data.error.includes("1/"),
  res2?.data?.error ?? "(no error reported)",
)
check(
  "failure/tells the caller it fell back to the local engine",
  res2?.data?.fallback === "local",
  `fallback=${res2?.data?.fallback ?? "undefined"}`,
)
check("failure/tabs are still grouped", after2.groups.length > 0, `${after2.groups.length} groups`)

/* ---------------------------------------------------------------- */

/* Same report shape as the other suites, so `progress.mjs` picks it up. */
const passed = results.filter((r) => r.ok).length
writeFileSync(
  resolve(OUT, "ai-e2e.json"),
  JSON.stringify(
    {
      passed,
      total: results.length,
      results,
      calls: calls.map((c) => ({ n: c.ids.length, url: c.url })),
    },
    null,
    2,
  ),
)

const failed = results.length - passed
console.error(`\n[ai] ${passed}/${results.length} checks passed`)

await ctx.close()
await new Promise((r) => server.close(() => r()))
process.exit(failed ? 1 : 0)
