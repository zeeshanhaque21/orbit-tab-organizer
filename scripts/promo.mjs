/**
 * Chrome Web Store promotional images.
 *
 * The store requires one small tile (440x280) and optionally a marquee
 * (1400x560). Both are rendered from the same parametric composition, so the two
 * sizes are the same design rather than two separate drawings that drift.
 *
 * The official guidance for these images: avoid text, make sure the image works
 * when shrunk to half size, assume a light grey background, use saturated
 * colours, avoid large areas of white or light grey, fill the whole region, and
 * keep the edges well defined. The composition below follows each of those — it
 * is full-bleed saturated indigo/violet with a defined edge, the mark is
 * geometric so it survives downscaling, and the wordmark is sized to still read
 * at 50%.
 *
 * Output: `_verify/store/promo-small.png`, `_verify/store/promo-marquee.png`
 *
 * Usage: node scripts/promo.mjs
 */
import { chromium } from "playwright-core"
import { profileDir, sweepStaleProfiles } from "./profile.mjs"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = resolve(root, "_verify/store")
mkdirSync(OUT, { recursive: true })

const SIZES = [
  { name: "promo-small", w: 440, h: 280 },
  { name: "promo-marquee", w: 1400, h: 560 },
]

/* Brand tokens, taken from src/shared/theme.css rather than re-invented. */
const ACCENT = "#6366f1"
const ACCENT_2 = "#8b5cf6"

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

/**
 * The composition, in units of the shorter side so it scales identically.
 *
 * Deliberately saturated and text-light: the guidance says to avoid white and
 * light grey, so the background carries the colour, the planet is small, and the
 * glow is tight rather than a wash across the frame. The vignette is what gives
 * the region a defined edge.
 */
function scene(w, h) {
  const u = h / 280 // scale unit: everything below is authored for 440x280
  const cx = w * 0.5
  const cy = h * 0.42

  const planetR = 40 * u
  const ringRx = 104 * u
  const ringRy = 32 * u
  const ringTilt = -18

  /* A fixed field rather than random, so regenerating is reproducible. */
  const stars = [
    [0.06, 0.18, 1.6, 0.75], [0.14, 0.44, 2.4, 0.9], [0.09, 0.78, 1.4, 0.6],
    [0.21, 0.11, 1.8, 0.7], [0.24, 0.63, 1.5, 0.55], [0.31, 0.86, 2.0, 0.8],
    [0.35, 0.22, 1.3, 0.5], [0.42, 0.07, 1.7, 0.65], [0.69, 0.13, 1.5, 0.6],
    [0.74, 0.83, 2.2, 0.85], [0.81, 0.28, 2.6, 0.95], [0.88, 0.61, 1.6, 0.65],
    [0.93, 0.20, 1.4, 0.55], [0.95, 0.74, 1.9, 0.75], [0.62, 0.91, 1.4, 0.5],
    [0.55, 0.05, 1.2, 0.45], [0.17, 0.92, 1.3, 0.5], [0.47, 0.95, 1.2, 0.4],
  ]

  const starDots = stars
    .map(
      ([fx, fy, r, o]) =>
        `<circle cx="${(fx * w).toFixed(1)}" cy="${(fy * h).toFixed(1)}" r="${(r * u).toFixed(2)}" fill="#ffffff" opacity="${o}"/>`,
    )
    .join("")

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0%" stop-color="#3730a3"/>
      <stop offset="45%" stop-color="${ACCENT}"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#c4b5fd" stop-opacity="0.5"/>
      <stop offset="60%" stop-color="#a78bfa" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="planet" cx="32%" cy="28%" r="80%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="42%" stop-color="#ede9fe"/>
      <stop offset="100%" stop-color="#a78bfa"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.15"/>
      <stop offset="22%" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="78%" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.15"/>
    </linearGradient>
    <radialGradient id="vignette" cx="50%" cy="44%" r="76%">
      <stop offset="55%" stop-color="#1e1b4b" stop-opacity="0"/>
      <stop offset="100%" stop-color="#1e1b4b" stop-opacity="0.55"/>
    </radialGradient>
  </defs>

  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  ${starDots}

  <circle cx="${cx}" cy="${cy}" r="${(planetR * 2.6).toFixed(1)}" fill="url(#glow)"/>

  <g transform="rotate(${ringTilt} ${cx} ${cy})">
    <ellipse cx="${cx}" cy="${cy}" rx="${ringRx.toFixed(1)}" ry="${ringRy.toFixed(1)}"
             fill="none" stroke="url(#ring)" stroke-width="${(3.4 * u).toFixed(1)}"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${(ringRx * 0.79).toFixed(1)}" ry="${(ringRy * 0.79).toFixed(1)}"
             fill="none" stroke="#ffffff" stroke-opacity="0.2" stroke-width="${(1.4 * u).toFixed(1)}"/>
  </g>

  <circle cx="${cx}" cy="${cy}" r="${planetR.toFixed(1)}" fill="url(#planet)"/>
  <circle cx="${(cx - planetR * 0.32).toFixed(1)}" cy="${(cy - planetR * 0.36).toFixed(1)}"
          r="${(planetR * 0.17).toFixed(1)}" fill="#ffffff" opacity="0.9"/>

  <circle cx="${(cx + ringRx * 0.74).toFixed(1)}" cy="${(cy - ringRy * 0.62).toFixed(1)}"
          r="${(6.5 * u).toFixed(1)}" fill="#ffffff"/>
  <circle cx="${(cx - ringRx * 0.8).toFixed(1)}" cy="${(cy + ringRy * 0.66).toFixed(1)}"
          r="${(4.2 * u).toFixed(1)}" fill="#ffffff" opacity="0.8"/>

  <text x="${cx}" y="${(cy + planetR + 74 * u).toFixed(1)}" text-anchor="middle"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif"
        font-size="${(36 * u).toFixed(1)}" font-weight="700" letter-spacing="${(1.4 * u).toFixed(2)}"
        fill="#ffffff">Orbit</text>

  <rect width="${w}" height="${h}" fill="url(#vignette)"/>
</svg>`.trim()
}

sweepStaleProfiles()
const ctx = await chromium.launchPersistentContext(profileDir("orbit-promo"), {
  executablePath: findChromium(),
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1"],
})

const page = await ctx.newPage()
let failures = 0

for (const { name, w, h } of SIZES) {
  await page.setViewportSize({ width: w, height: h })
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;background:#6366f1}
    svg{display:block}
  </style></head><body>${scene(w, h)}</body></html>`
  await page.setContent(html, { waitUntil: "load" })
  await page.waitForTimeout(350)

  const path = resolve(OUT, `${name}.png`)
  await page.screenshot({ path, clip: { x: 0, y: 0, width: w, height: h } })

  /* Read the real dimensions and colour type back out of the file, because the
     store rejects alpha on these and the viewport is not proof of anything. */
  const buf = readFileSync(path)
  const gotW = buf.readUInt32BE(16)
  const gotH = buf.readUInt32BE(20)
  const ctype = buf[25]
  const kind = { 0: "grey", 2: "RGB (no alpha)", 3: "palette", 4: "grey+alpha", 6: "RGBA (HAS ALPHA)" }[ctype]
  const ok = gotW === w && gotH === h && ctype !== 6 && ctype !== 4
  if (!ok) failures++
  console.error(
    `  ${ok ? "PASS" : "FAIL"}  ${name}.png  ${gotW}x${gotH}  ${kind}  ${(statSync(path).size / 1024).toFixed(0)} KB`,
  )
}

await ctx.close()
process.exit(failures ? 1 : 0)
