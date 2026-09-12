/**
 * Checks the two claims `scripts/profile.mjs` makes that no suite covers.
 *
 *   1. A profile directory is still removed when the process is killed with
 *      SIGTERM, not just when it exits normally.
 *   2. The startup sweep cannot delete a profile belonging to a suite that is
 *      running right now.
 *
 * Both matter because a browser profile that is never removed eventually fills
 * the volume, and because suites really do run concurrently here.
 *
 * Usage: npm run check:profile
 *
 * Exit code 0 means both claims hold.
 */
import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const profileModule = resolve(here, "profile.mjs")
const { profileDir, sweepStaleProfiles } = await import(profileModule)

let failures = 0
const report = (ok, label, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`)
}

/* ---- 1. cleanup survives SIGTERM ---- */
// The child signals *itself*, so the handler runs exactly as it would on a real
// SIGTERM without this script having to guess a pid.
const CHILD = `
import { mkdirSync } from "node:fs"
const { profileDir } = await import(${JSON.stringify(profileModule)})
const dir = profileDir("orbit-sigtermtest")
mkdirSync(dir, { recursive: true })
console.log(dir)
setTimeout(() => process.kill(process.pid, "SIGTERM"), 400)
setInterval(() => {}, 1000)
`
const run = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
  encoding: "utf8",
  timeout: 20_000,
})
const dir = (run.stdout || "").trim()
report(!!dir, "sigterm/child reported its profile directory", dir || "nothing printed")
report(
  run.status === 143,
  "sigterm/child exited on the signal",
  `exit=${run.status} (143 expected)`,
)
report(!existsSync(dir), "sigterm/profile directory was removed", dir)

/* ---- 2. the sweep spares a live suite ---- */
const fresh = join(tmpdir(), `orbit-freshtest-${Date.now()}`)
const stale = join(tmpdir(), `orbit-oldtest-${Date.now()}`)
mkdirSync(fresh, { recursive: true })
mkdirSync(stale, { recursive: true })
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
utimesSync(stale, twoHoursAgo, twoHoursAgo)

const swept = sweepStaleProfiles() // default one-hour guard
report(existsSync(fresh), "sweep/leaves a freshly created profile alone", fresh)
report(!existsSync(stale), "sweep/removes a profile older than the guard", `${swept} swept`)

// tidy up whichever survived
for (const d of [fresh, stale]) {
  if (existsSync(d)) rmSync(d, { recursive: true, force: true })
}

console.log(failures === 0 ? "\n[profile] both claims hold" : `\n[profile] ${failures} failed`)
process.exitCode = failures === 0 ? 0 : 1
