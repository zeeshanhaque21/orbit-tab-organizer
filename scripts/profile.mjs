/**
 * Browser profile lifecycle for the e2e suites.
 *
 * Every suite launches a persistent Chromium context, which writes a profile
 * directory under the OS temp dir. Nothing ever removed those, so they piled up
 * run after run until the volume filled: with the disk at 100% Chromium's
 * renderer starts crashing ("Target crashed") and Playwright clicks start timing
 * out for no visible reason. Both symptoms were seen before this existed.
 *
 * `profileDir` registers the directory for deletion when the process ends, so
 * cleanup also happens when a suite throws or is killed rather than only on the
 * happy path. `sweepStaleProfiles` clears out anything an earlier crashed run
 * left behind, with an age guard so it can never touch a suite that is running
 * right now.
 */
import { readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Names every suite in this repo uses for its profile directory. */
const PREFIXES = ["orbit-", "probe-"]

const owned = []

function remove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best effort: a locked profile is not worth failing a suite over
  }
}

let hooked = false
function hook() {
  if (hooked) return
  hooked = true
  const bye = () => {
    for (const d of owned) remove(d)
  }
  process.on("exit", bye)
  process.on("SIGINT", () => {
    bye()
    process.exit(130)
  })
  process.on("SIGTERM", () => {
    bye()
    process.exit(143)
  })
}

/** A fresh Chromium profile directory, deleted when this process ends. */
export function profileDir(name) {
  const dir = join(tmpdir(), `${name}-${Date.now()}`)
  owned.push(dir)
  hook()
  return dir
}

/**
 * Deletes profile directories left behind by earlier runs.
 *
 * Only touches directories whose name starts with a known suite prefix, and
 * only ones older than `maxAgeMs`, so a concurrently running suite is safe.
 */
export function sweepStaleProfiles(maxAgeMs = 60 * 60 * 1000) {
  const tmp = tmpdir()
  let removed = 0
  let names
  try {
    names = readdirSync(tmp)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!PREFIXES.some((p) => name.startsWith(p))) continue
    const dir = join(tmp, name)
    try {
      if (Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue
      remove(dir)
      removed++
    } catch {
      // not ours, or already gone
    }
  }
  return removed
}
