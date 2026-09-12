/**
 * Generates the extension icon set procedurally (no image dependencies).
 *
 * Draws an "orbit" mark: a rounded-square gradient tile with a thin elliptical
 * orbital ring, a planet and a core. Rendered at 4x and box-downsampled, so
 * edges are anti-aliased. Stroke weights are size-aware so the mark still
 * reads at 16px.
 */
import { deflateSync } from "node:zlib"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/icons")
const SIZES = [16, 32, 48, 64, 128]
const SS = 4 // supersample factor

/* ---------- minimal PNG encoder ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/* ---------- drawing ---------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const mix = (a, b, t) => a + (b - a) * t
const smooth = (t) => t * t * (3 - 2 * t)

/** Signed distance to a rounded rectangle centred on the origin. */
function sdRoundRect(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r)
  const qy = Math.abs(py) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

// orbit ellipse, in unit space, rotated so it reads as a tilted ring
const TILT = (-20 * Math.PI) / 180
const RX = 0.30
const RY = 0.125
const COS = Math.cos(TILT)
const SIN = Math.sin(TILT)

/** Planet sits on the ring, upper right. Derived from the ellipse at theta=-50deg. */
const PLANET = [0.149, -0.156]

/** Renders one pixel of the mark in unit space. */
function sample(u, v, size) {
  const x = u - 0.5
  const y = v - 0.5
  const aa = 0.7 / size // ~1.4px edge ramp

  // ---- tile ----
  const d = sdRoundRect(x, y, 0.5, 0.5, 0.24)
  const tileA = clamp01(0.5 - d / (2 * aa))
  if (tileA <= 0) return [0, 0, 0, 0]

  // indigo -> violet, diagonal
  const g = smooth(clamp01(u * 0.35 + v * 0.65))
  let r = mix(0x63, 0x8b, g)
  let gg = mix(0x66, 0x5c, g)
  let b = mix(0xf1, 0xf6, g)

  // soft top-left sheen
  const sheen = clamp01(1 - Math.hypot(x + 0.24, y + 0.24) / 0.95)
  const s = sheen * sheen * 0.22
  r = mix(r, 0xff, s)
  gg = mix(gg, 0xff, s)
  b = mix(b, 0xff, s)

  // ---- orbital ring ----
  const rxv = x * COS - y * SIN
  const ryv = x * SIN + y * COS
  const er = Math.hypot(rxv / RX, ryv / RY)
  const th = Math.max(0.030, 1.7 / size) // stroke weight in unit space
  const ringT = clamp01((th - Math.abs(er - 1) * RX) / th)
  if (ringT > 0) {
    // dim the far side so it reads as an orbit rather than a flat hoop
    const depth = clamp01(0.5 + 0.5 * (ryv / RY))
    const a = ringT * (0.30 + 0.70 * depth) * 0.95
    r = mix(r, 0xff, a)
    gg = mix(gg, 0xff, a)
    b = mix(b, 0xff, a)
  }

  // ---- planet + its glow ----
  const pd = Math.hypot(x - PLANET[0], y - PLANET[1])
  const pr = Math.max(0.050, 2.5 / size)
  const glow = clamp01(1 - pd / (pr * 3.1))
  if (glow > 0) {
    const a = glow * glow * 0.30
    r = mix(r, 0xff, a)
    gg = mix(gg, 0xff, a)
    b = mix(b, 0xff, a)
  }
  const planet = clamp01((pr - pd) / aa)
  if (planet > 0) {
    r = mix(r, 0xff, planet)
    gg = mix(gg, 0xff, planet)
    b = mix(b, 0xff, planet)
  }

  // ---- core ----
  const cd = Math.hypot(x, y)
  const cr = Math.max(0.024, 1.3 / size)
  const core = clamp01((cr - cd) / aa)
  if (core > 0) {
    r = mix(r, 0xff, core)
    gg = mix(gg, 0xff, core)
    b = mix(b, 0xff, core)
  }

  // ---- two satellites ----
  for (const [sx, sy, sr0] of [
    [-0.185, -0.225, 0.020],
    [0.275, 0.245, 0.016],
  ]) {
    const sr = Math.max(sr0, 1.0 / size)
    const t = clamp01((sr - Math.hypot(x - sx, y - sy)) / aa)
    if (t > 0) {
      r = mix(r, 0xff, t * 0.9)
      gg = mix(gg, 0xff, t * 0.9)
      b = mix(b, 0xff, t * 0.9)
    }
  }

  return [r, gg, b, tileA * 255]
}

function render(size) {
  const out = Buffer.alloc(size * size * 4)
  const n = size * SS

  // accumulate premultiplied, then un-premultiply after downsampling
  const acc = new Float64Array(n * n * 4)
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const c = sample((px + 0.5) / n, (py + 0.5) / n, size)
      const i = (py * n + px) * 4
      const av = c[3] / 255
      acc[i] = c[0] * av
      acc[i + 1] = c[1] * av
      acc[i + 2] = c[2] * av
      acc[i + 3] = av
    }
  }

  const k = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * n + (x * SS + sx)) * 4
          r += acc[i]
          g += acc[i + 1]
          b += acc[i + 2]
          a += acc[i + 3]
        }
      }
      const aAvg = a / k
      const o = (y * size + x) * 4
      // channels are accumulated premultiplied and already in 0..255, so
      // un-premultiply then clamp to a byte - do NOT rescale by 255 again
      out[o] = aAvg > 0 ? Math.min(255, Math.round(r / k / aAvg)) : 0
      out[o + 1] = aAvg > 0 ? Math.min(255, Math.round(g / k / aAvg)) : 0
      out[o + 2] = aAvg > 0 ? Math.min(255, Math.round(b / k / aAvg)) : 0
      out[o + 3] = Math.round(clamp01(aAvg) * 255)
    }
  }
  return out
}

mkdirSync(OUT, { recursive: true })
for (const size of SIZES) {
  writeFileSync(resolve(OUT, `icon${size}.png`), encodePNG(size, size, render(size)))
  console.log(`icon${size}.png`)
}
console.log(`wrote ${SIZES.length} icons to public/icons`)
