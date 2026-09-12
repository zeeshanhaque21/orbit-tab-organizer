/**
 * Build guards.
 *
 * Two cheap static checks that would each have caught a real bug:
 *
 * 1. An async IIFE that is never invoked. `void (async () => { ... })` creates
 *    the function and discards it, so the handler silently does nothing - and
 *    the minifier then correctly reports it as dead code by emitting `()=>{}`.
 *    That shipped once in the popup's "Ungroup all" button.
 *
 * 2. A user-facing string that disappears between source and bundle. If a
 *    handler is dropped, so are its strings, so asserting a handful of them
 *    survive minification catches the whole class.
 *
 * Usage: node scripts/lint-build.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const srcDir = resolve(root, "src")
const distDir = resolve(root, "dist")

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
    else if (p.endsWith(".ts") || p.endsWith(".mjs")) out.push(p)
  }
  return out
}

/**
 * Removes comments, respecting string literals, and keeps newlines so reported
 * line numbers still match the original file.
 *
 * Without this the brace scanner is fooled by prose: a comment reading
 * "the user's view" opens a phantom string on the apostrophe, swallows the
 * following braces, and the check reports an uninvoked IIFE that does not
 * exist. A guard that cries wolf gets ignored, so it has to read the file the
 * way the parser does.
 */
function stripComments(text) {
  let out = ""
  let i = 0
  let inStr = null
  let inLine = false
  let inBlock = false

  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]

    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      i++
      continue
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false
        i += 2
        continue
      }
      if (c === "\n") out += c
      i++
      continue
    }
    if (inStr) {
      out += c
      if (c === "\\") {
        out += n ?? ""
        i += 2
        continue
      }
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === "/" && n === "/") {
      inLine = true
      i += 2
      continue
    }
    if (c === "/" && n === "*") {
      inBlock = true
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c
      out += c
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 1. uninvoked async IIFEs                                            */
/* ------------------------------------------------------------------ */

console.error("[lint] scanning for uninvoked async IIFEs")
{
  const offenders = []
  for (const file of walk(srcDir)) {
    const text = stripComments(readFileSync(file, "utf8"))
    const marker = "void (async () => {"
    let from = 0

    for (;;) {
      const at = text.indexOf(marker, from)
      if (at === -1) break
      from = at + marker.length

      // Walk forward tracking brace depth from the opening brace, so an inner
      // object literal's `})` is not mistaken for the IIFE's own close.
      let depth = 0
      let i = at + marker.length - 1 // sit on the `{`
      let inStr = null
      let esc = false
      for (; i < text.length; i++) {
        const c = text[i]
        if (esc) {
          esc = false
          continue
        }
        if (c === "\\") {
          esc = true
          continue
        }
        if (inStr) {
          if (c === inStr) inStr = null
          continue
        }
        if (c === '"' || c === "'" || c === "`") {
          inStr = c
          continue
        }
        if (c === "{") depth++
        else if (c === "}") {
          depth--
          if (depth === 0) break
        }
      }

      // i now points at the closing `}`. The IIFE is invoked only if the next
      // two characters are `)(`.
      const after = text.slice(i + 1, i + 3)
      if (after !== ")(") {
        const line = text.slice(0, i).split("\n").length
        offenders.push(
          `${file.replace(root + "/", "")}:${line}  async IIFE is never invoked (followed by "${after}")`,
        )
      }
    }
  }

  if (offenders.length) {
    for (const o of offenders) fail(o)
  } else {
    pass("every async IIFE is invoked")
  }
}

/* ------------------------------------------------------------------ */
/* 2. critical strings survive minification                            */
/* ------------------------------------------------------------------ */

console.error("[lint] checking that user-facing strings survived the build")
{
  if (!existsSync(distDir)) {
    fail("dist/ not found - run `npm run build` first")
  } else {
    const bundle = (prefix) => {
      const hit = readdirSync(join(distDir, "assets")).find(
        (f) => f.startsWith(prefix) && f.endsWith(".js"),
      )
      return hit ? readFileSync(join(distDir, "assets", hit), "utf8") : ""
    }

    // Each entry is a string that only exists because a specific handler runs.
    // If the handler is dropped, the string goes with it.
    const expected = {
      popup: [
        "Ungroup every tab?",
        "Clean duplicates",
        "Organize Now",
        "Rename tab",
        "Order by name",
        "Collapse groups",
        "Auto-Organize",
        "Built-in engine",
        "Welcome to Orbit",
      ],
      hub: ["Orbit Hub", "Free-floating", "Recycle", "Teleport"],
      options: ["Organizing", "Duplicates", "AI provider", "My Topics", "Saved groups", "Shortcuts"],
    }

    const background = readFileSync(join(distDir, "background.js"), "utf8")
    const backgroundExpected = [
      "Nothing to undo yet",
      "orbit-organize",
      "orbit-clean",
      "orbit-rename",
      "orbit-save",
      "orbit-hub",
      "orbit-bin",
      "orbit_toggle_collapse",
      "orbit_open_hub",
      "orbit_rename_tab",
      "orbit_search_tab",
    ]

    for (const [name, list] of Object.entries({ ...expected, background: backgroundExpected })) {
      const text = name === "background" ? background : bundle(name)
      if (!text) {
        fail(`${name}: bundle not found`)
        continue
      }
      const missing = list.filter((s) => !text.includes(s))
      if (missing.length) fail(`${name}: missing from the bundle -> ${missing.join(", ")}`)
      else pass(`${name}: all ${list.length} expected strings present`)
    }
  }
}

console.error(failures ? `\n[lint] ${failures} problem(s)` : "\n[lint] clean")
process.exitCode = failures ? 1 : 0
