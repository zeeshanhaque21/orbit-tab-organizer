/**
 * Generates progress.html from the real verification reports.
 *
 * Every number on the page is read from `_verify/*.json`, which the suites
 * write as they run. Nothing is typed in by hand, so the page cannot drift out
 * of sync with reality or quietly overstate the state of the build - the same
 * failure mode that produced several of the bugs in this project.
 *
 * Usage: node scripts/progress.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const verifyDir = resolve(root, "_verify")
const out = resolve(root, "progress.html")

const read = (name) => {
  const p = resolve(verifyDir, name)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Suites                                                              */
/* ------------------------------------------------------------------ */

const SUITES = [
  { file: "e2e.json", label: "Core", blurb: "All six methods, undo, duplicates, recycle, groups, settings, saved groups, topics, auto-organize." },
  { file: "popup-e2e.json", label: "Popup", blurb: "The surface users touch most: tour, methods, scope, organize, undo, search, rename, combine." },
  { file: "hub-e2e.json", label: "Hub", blurb: "The observer: stars, planets, drag, marquee, search, popover, teleport, combine, keyboard access." },
  { file: "options-e2e.json", label: "Options", blurb: "Every control writes through to storage; provider presets; shortcut table." },
  { file: "commands-e2e.json", label: "Commands", blurb: "The four accelerators are registered and the manifest declares the keys we expect." },
  { file: "stress-e2e.json", label: "Scale", blurb: "300 tabs, degenerate cases: one tab, none, all pinned, a window closing mid-pass." },
  { file: "offline-e2e.json", label: "Offline", blurb: "Every non-AI method with the browser forced offline — the brief's second measurable criterion." },
  { file: "ai-e2e.json", label: "AI path", blurb: "By Category against a stand-in endpoint through the built extension: batch split, cross-batch naming, real Chrome groups, graceful batch failure." },
  { file: "package-e2e.json", label: "Packaged", blurb: "Extracts the shipped zip and loads that in Chromium. Catches a broken package." },
]

const suites = SUITES.map((s) => ({ ...s, report: read(s.file) })).filter((s) => s.report)

const unit = (() => {
  // read the count out of the last vitest run if it left a log
  const log = resolve(verifyDir, "unit.log")
  if (!existsSync(log)) return null
  const m = readFileSync(log, "utf8").match(/Tests\s+(\d+) passed/)
  return m ? Number(m[1]) : null
})()

const totalChecks = suites.reduce((n, s) => n + (s.report.total ?? 0), 0)
const totalPassed = suites.reduce((n, s) => n + (s.report.passed ?? 0), 0)
const allGreen = suites.every((s) => s.report.passed === s.report.total)

/* ------------------------------------------------------------------ */
/* Sizes                                                               */
/* ------------------------------------------------------------------ */

const zipPath = resolve(root, "orbit-extension.zip")
const zipKB = existsSync(zipPath) ? statSync(zipPath).size / 1024 : null

const distJs = (() => {
  const assets = resolve(root, "dist/assets")
  if (!existsSync(assets)) return null
  let bytes = 0
  for (const f of readdirSync(assets)) {
    if (f.endsWith(".js")) bytes += statSync(resolve(assets, f)).size
  }
  const bg = resolve(root, "dist/background.js")
  if (existsSync(bg)) bytes += statSync(bg).size
  return bytes / 1024
})()

/* ------------------------------------------------------------------ */
/* Bugs, parsed from the README                                        */
/* ------------------------------------------------------------------ */

/*
 * Read the numbered list out of README.md's "Bugs this suite caught" section
 * rather than keeping a copy here. A hand-maintained copy is how a progress page
 * starts lying: the README list reached 28 entries while this array still had
 * 17, and the footer below claimed every figure was read from a file.
 */
const BUGS = (() => {
  let md
  try {
    md = readFileSync(resolve(root, "README.md"), "utf8")
  } catch {
    return []
  }
  const at = md.indexOf("### Bugs this suite caught")
  if (at === -1) return []
  const body = md.slice(at).split("\n### ")[0]

  const raw = []
  let cur = null
  for (const line of body.split("\n")) {
    const m = line.match(/^\d+\.\s+(.*)$/)
    if (m) {
      if (cur) raw.push(cur)
      cur = m[1]
    } else if (cur && /^\s{2,}\S/.test(line)) {
      cur += ` ${line.trim()}`
    } else if (cur && !line.trim()) {
      // blank line between entries; keep the current one open
    } else if (cur) {
      break // unindented prose ends the list
    }
  }
  if (cur) raw.push(cur)

  return raw.map((e) => {
    const m = e.match(/^\*\*(.+?)\*\*\s*([\s\S]*)$/)
    const title = (m ? m[1] : e).replace(/\s+/g, " ").replace(/\.$/, "").trim()
    const why = (m ? m[2] : "").replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim()
    return [title, why.length > 220 ? `${why.slice(0, 217)}…` : why]
  })
})()

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0)

const suiteCards = suites
  .map((s) => {
    const ok = s.report.passed === s.report.total
    const failures = (s.report.results ?? []).filter((r) => !r.ok)
    const rows = (s.report.results ?? [])
      .map(
        (r) =>
          `<li class="${r.ok ? "ok" : "bad"}"><span class="mark">${r.ok ? "✓" : "✗"}</span><span class="nm">${esc(r.name)}</span>${
            r.detail ? `<span class="dt">${esc(String(r.detail).slice(0, 90))}</span>` : ""
          }</li>`,
      )
      .join("")
    return `
      <details class="suite ${ok ? "green" : "red"}"${ok ? "" : " open"}>
        <summary>
          <span class="name">${esc(s.label)}</span>
          <span class="count">${s.report.passed}/${s.report.total}</span>
          <span class="bar"><i style="width:${pct(s.report.passed, s.report.total)}%"></i></span>
        </summary>
        <p class="blurb">${esc(s.blurb)}</p>
        ${failures.length ? `<p class="warn">${failures.length} failing</p>` : ""}
        <ul class="checks">${rows}</ul>
      </details>`
  })
  .join("")

const bugRows = BUGS.map(
  ([title, why], i) => `<tr><td class="n">${i + 1}</td><td><strong>${esc(title)}</strong><br><span class="why">${esc(why)}</span></td></tr>`,
).join("")

const sizeRows = [
  ["Shipped (zip)", zipKB != null ? `${zipKB.toFixed(1)} KB` : "—"],
  ["JavaScript, uncompressed", distJs != null ? `${distJs.toFixed(1)} KB` : "—"],
]
  .map(([k, a]) => `<tr><td>${esc(k)}</td><td class="num ours">${esc(a)}</td></tr>`)
  .join("")

const generated = new Date().toISOString().replace("T", " ").slice(0, 19)

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Orbit — build progress</title>
<style>
  :root{
    --bg:#f7f7f8; --surface:#fff; --border:#e4e4e7; --text:#18181b; --muted:#71717a;
    --green:#15803d; --green-bg:#f0fdf4; --red:#b91c1c; --red-bg:#fef2f2; --accent:#4f46e5;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:940px;margin:0 auto;padding:40px 24px 80px}
  header{margin-bottom:28px}
  h1{margin:0 0 6px;font-size:26px;letter-spacing:-.02em}
  .sub{color:var(--muted);font-size:14px}
  .verdict{display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:7px 14px;
    border-radius:999px;font-weight:600;font-size:14px}
  .verdict.green{background:var(--green-bg);color:var(--green);border:1px solid #bbf7d0}
  .verdict.red{background:var(--red-bg);color:var(--red);border:1px solid #fecaca}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:26px 0 34px}
  .tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
  .tile .v{font-size:24px;font-weight:650;letter-spacing:-.02em}
  .tile .k{color:var(--muted);font-size:12.5px;text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
    margin:38px 0 12px;font-weight:600}
  .suite{background:var(--surface);border:1px solid var(--border);border-radius:12px;
    margin-bottom:10px;overflow:hidden}
  .suite summary{display:grid;grid-template-columns:1fr auto 120px;align-items:center;gap:14px;
    padding:14px 16px;cursor:pointer;list-style:none}
  .suite summary::-webkit-details-marker{display:none}
  .suite .name{font-weight:600}
  .suite .count{font-variant-numeric:tabular-nums;color:var(--muted);font-size:13.5px}
  .suite .bar{height:6px;background:#ececf0;border-radius:999px;overflow:hidden}
  .suite .bar i{display:block;height:100%;background:var(--green)}
  .suite.red .bar i{background:var(--red)}
  .blurb{margin:0;padding:0 16px 10px;color:var(--muted);font-size:13.5px}
  .warn{margin:0;padding:0 16px 10px;color:var(--red);font-weight:600;font-size:13.5px}
  .checks{list-style:none;margin:0;padding:0 16px 14px;border-top:1px solid var(--border)}
  .checks li{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:10px;
    padding:5px 0;font-size:13px;align-items:baseline}
  .checks .mark{color:var(--green)}
  .checks li.bad .mark{color:var(--red)}
  .checks .nm{min-width:0}
  .checks .dt{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
  table{width:100%;border-collapse:collapse;background:var(--surface);
    border:1px solid var(--border);border-radius:12px;overflow:hidden}
  th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);font-size:13.5px}
  th{color:var(--muted);font-weight:600;font-size:12.5px;text-transform:uppercase;letter-spacing:.05em}
  tr:last-child td{border-bottom:0}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .ours{font-weight:650;color:var(--accent)}
  td.n{color:var(--muted);font-variant-numeric:tabular-nums;width:34px}
  .why{color:var(--muted);font-size:12.5px}
  footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--border);
    color:var(--muted);font-size:12.5px}
  code{background:#f0f0f3;padding:1.5px 5px;border-radius:4px;font-size:12.5px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Orbit — build and verification status</h1>
    <div class="sub">Manifest V3 · no account · no telemetry · every figure below is read from a report file</div>
    <div class="verdict ${allGreen ? "green" : "red"}">
      ${allGreen ? "✓" : "✗"} ${totalPassed}/${totalChecks} automated checks passing
    </div>
  </header>

  <div class="tiles">
    <div class="tile"><div class="v">${totalChecks}</div><div class="k">e2e checks</div></div>
    ${unit != null ? `<div class="tile"><div class="v">${unit}</div><div class="k">unit tests</div></div>` : ""}
    <div class="tile"><div class="v">${suites.length}</div><div class="k">suites</div></div>
    <div class="tile"><div class="v">${BUGS.length}</div><div class="k">bugs found</div></div>
    <div class="tile"><div class="v">${zipKB != null ? zipKB.toFixed(0) : "—"}</div><div class="k">KB shipped</div></div>
  </div>

  <h2>Suites</h2>
  ${suiteCards || '<p class="sub">No reports yet — run <code>npm run e2e:all</code>.</p>'}

  <h2>Size</h2>
  <table>
    <thead><tr><th></th><th class="num">Orbit</th></tr></thead>
    <tbody>${sizeRows}</tbody>
  </table>

  <h2>Bugs found by testing, not by reading</h2>
  <table><tbody>${bugRows}</tbody></table>

  <footer>
    Generated ${esc(generated)} by <code>npm run progress</code> from the reports in <code>_verify/</code>.
    Every figure above is read from those files — none is written by hand, so the page cannot
    drift out of sync with what actually ran.
  </footer>
</div>
</body>
</html>
`

writeFileSync(out, html)
console.error(`progress.html written  (${suites.length} suites, ${totalPassed}/${totalChecks} checks)`)
