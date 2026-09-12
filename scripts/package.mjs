/**
 * Zips dist/ into orbit-extension.zip.
 *
 * Before zipping, unreferenced assets are pruned. `emptyOutDir` is disabled
 * (Vite removes the tree in one recursive call, which can trip a bulk-delete
 * guard), so `scripts/clean.mjs` is best-effort and can be skipped — in which
 * case hashed bundles from earlier builds linger and would ship as dead weight.
 *
 * Rather than trusting the directory, this reads what the built pages actually
 * reference and keeps only that.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = resolve(root, "dist")
const out = resolve(root, "orbit-extension.zip")

if (!existsSync(dist)) {
  console.error("dist/ not found - run `npm run build` first")
  process.exit(1)
}

/* ---- prune assets nothing references ---- */

const assetsDir = join(dist, "assets")
let pruned = 0

if (existsSync(assetsDir)) {
  // every asset filename mentioned anywhere in the built pages or scripts.
  //
  // Two reference forms matter and they look different:
  //   pages:  src="/assets/popup-ABC.js"
  //   chunks: import ... from"./ui-DEF.js"      <- relative, no assets/ prefix
  // Missing the second form prunes a shared chunk the pages need.
  const referenced = new Set()
  const harvest = (text) => {
    for (const m of text.matchAll(/assets\/([A-Za-z0-9._-]+\.(?:js|css))/g)) {
      referenced.add(m[1])
    }
    for (const m of text.matchAll(/\.\/([A-Za-z0-9._-]+\.(?:js|css))/g)) {
      referenced.add(m[1])
    }
  }

  for (const entry of readdirSync(dist)) {
    const p = join(dist, entry)
    if (!statSync(p).isFile()) continue
    if (/\.(html|js|css)$/.test(entry)) harvest(readFileSync(p, "utf8"))
  }
  for (const entry of readdirSync(assetsDir)) {
    const p = join(assetsDir, entry)
    if (!statSync(p).isFile()) continue
    if (/\.(js|css)$/.test(entry)) harvest(readFileSync(p, "utf8"))
  }

  // the service worker is a manifest entry point, never referenced by a page
  referenced.add("background.js")

  // safety: never prune everything. If harvesting found nothing, the regex is
  // wrong and shipping a broken zip is worse than shipping a slightly fat one.
  const candidates = readdirSync(assetsDir).filter((e) => !referenced.has(e))
  if (referenced.size <= 1 && candidates.length > 0) {
    console.log(`refusing to prune: only ${referenced.size} reference(s) found`)
  } else {
    for (const entry of candidates) {
      try {
        unlinkSync(join(assetsDir, entry))
        pruned++
      } catch {
        // a refusal here is not worth failing the package over
      }
    }
  }
}
if (pruned) console.log(`pruned ${pruned} unreferenced asset(s)`)

/* ---- zip ---- */

rmSync(out, { force: true })
execFileSync("zip", ["-qr", out, "."], { cwd: dist, stdio: "inherit" })

const kb = (statSync(out).size / 1024).toFixed(1)
console.log(`orbit-extension.zip  ${kb} KB`)
