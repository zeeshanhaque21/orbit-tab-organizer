/**
 * Claims guard.
 *
 * Every setting this extension exposes must actually be READ somewhere. Two
 * real bugs in this project were settings that were stored, surfaced as a toggle
 * in the UI, and never consulted:
 *
 *   - `dontShowDuplicateCleanNotice` — the nag it exists to silence kept showing
 *   - `whatsNewSeenVersion`          — the notice it gates could never appear
 *
 * Neither is reachable by a behavioural test, because there is no behaviour to
 * test. The only way to catch them is to check the claim itself: does anything
 * consume this key?
 *
 * Usage: node scripts/claims.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const srcDir = resolve(root, "src")
const constantsPath = resolve(srcDir, "shared/constants.ts")

let failures = 0
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`)
  failures++
}
const pass = (msg) => console.error(`  PASS  ${msg}`)

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|mjs)$/.test(p)) out.push(p)
  }
  return out
}

/** The keys declared in DEFAULT_SETTINGS, in source order. */
function declaredKeys() {
  const text = readFileSync(constantsPath, "utf8")
  const start = text.indexOf("DEFAULT_SETTINGS")
  if (start === -1) return []
  const open = text.indexOf("{", start)
  // walk to the matching brace
  let depth = 0
  let end = open
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = text.slice(open + 1, end)
  return [...body.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1])
}

const keys = declaredKeys()
if (keys.length === 0) {
  console.error("  FAIL  could not parse DEFAULT_SETTINGS")
  process.exit(1)
}

// everything except the declaration site itself
const sources = walk(srcDir)
  .filter((f) => f !== constantsPath)
  .map((f) => ({ file: f, text: readFileSync(f, "utf8") }))

console.error(`[claims] checking ${keys.length} settings keys are actually consumed`)

const inert = []
for (const key of keys) {
  const re = new RegExp(`\\b${key}\\b`)
  const hits = sources.filter((s) => re.test(s.text))
  if (hits.length === 0) inert.push(key)
}

if (inert.length) {
  for (const key of inert) {
    fail(`setting \`${key}\` is declared but never read outside constants.ts`)
  }
} else {
  pass(`every setting is consumed (${keys.length} keys)`)
}

/* ------------------------------------------------------------------ */
/* The same idea for the options page: every switch must bind a key     */
/* ------------------------------------------------------------------ */

// A control that writes a key nobody reads is the same defect one level up.
const optionsSrc = sources.find((s) => s.file.endsWith("options.ts"))?.text ?? ""
const boundKeys = new Set()
for (const m of optionsSrc.matchAll(/change\(\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
  boundKeys.add(m[1])
}
const unknown = [...boundKeys].filter((k) => !keys.includes(k))
if (unknown.length) {
  for (const k of unknown) fail(`options page writes \`${k}\`, which is not a declared setting`)
} else if (boundKeys.size) {
  pass(`every key the options page writes is declared (${boundKeys.size} bound)`)
}

/* ------------------------------------------------------------------ */
/* A string must not promise a capability the code does not have        */
/* ------------------------------------------------------------------ */

/*
 * The third member of this family. The first two were a setting nobody read and
 * a switch nobody bound; this is the same defect in prose. The Hub's hover
 * preview read "visit this tab to capture it" while `src/` contained no capture
 * API of any kind, so the promise could never be kept — and it survived every
 * behavioural test, because there is no behaviour to test.
 *
 * Deliberately narrow: it only fires when the capability is genuinely absent, so
 * implementing one makes the check pass rather than forcing the wording to stay
 * negative.
 */
const CAPABILITIES = [
  {
    name: "tab screenshot capture",
    present: /captureVisibleTab/,
    promise: /visit this tab to capture|will be captured|screenshot of this tab|preview thumbnail on hover/i,
  },
]

for (const cap of CAPABILITIES) {
  const haveIt = sources.some((s) => cap.present.test(s.text))
  if (haveIt) {
    pass(`${cap.name}: implemented, so wording about it is allowed`)
    continue
  }
  const liars = sources.filter((s) => cap.promise.test(s.text))
  if (liars.length) {
    for (const s of liars) {
      fail(
        `${s.file.replace(`${root}/`, "")} promises ${cap.name}, but nothing in src implements it`,
      )
    }
  } else {
    pass(`${cap.name}: not implemented, and no string promises it`)
  }
}

console.error(failures ? `\n[claims] ${failures} problem(s)` : "\n[claims] clean")
process.exitCode = failures ? 1 : 0
