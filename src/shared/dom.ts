/**
 * A very small DOM toolkit: element building, querying, and an inline icon set.
 *
 * Deliberately dependency-free. The three UI surfaces share this so they stay
 * visually consistent and the bundle stays small.
 */

type Props = Record<string, unknown> | null | undefined

const SVG_NS = "http://www.w3.org/2000/svg"

/** Creates an element. `class`, `text`, `html`, `dataset` and `style` are special. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: unknown[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  applyProps(node, props)
  append(node, children)
  return node
}

export function frag(...children: unknown[]): DocumentFragment {
  const f = document.createDocumentFragment()
  append(f, children)
  return f
}

function applyProps(node: HTMLElement, props: Props) {
  if (!props) return
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue
    if (k === "class" || k === "className") {
      if (Array.isArray(v)) node.className = v.filter(Boolean).join(" ")
      else node.className = String(v)
    } else if (k === "text") {
      node.textContent = String(v)
    } else if (k === "html") {
      node.innerHTML = String(v)
    } else if (k === "dataset") {
      Object.assign(node.dataset, v as Record<string, string>)
    } else if (k === "style" && typeof v === "object") {
      Object.assign(node.style, v as Record<string, string>)
    } else if (k === "on" && typeof v === "object") {
      for (const [evt, fn] of Object.entries(v as Record<string, EventListener>)) {
        node.addEventListener(evt, fn)
      }
    } else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else if (k in node && k !== "list" && typeof v !== "object") {
      // reflect real properties (value, checked, disabled, ...)
      ;(node as unknown as Record<string, unknown>)[k] = v
    } else if (typeof v === "string" || typeof v === "number") {
      node.setAttribute(k, String(v))
    }
  }
}

function append(parent: Node, children: unknown[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue
    if (Array.isArray(c)) append(parent, c)
    else if (c instanceof Node) parent.appendChild(c)
    else parent.appendChild(document.createTextNode(String(c)))
  }
}

/** Parses an HTML string into a single element. */
export function fromHTML<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement("template")
  t.innerHTML = html.trim()
  return t.content.firstElementChild as T
}

export function $(sel: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(sel)
}

export function $$(sel: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll(sel))
}

export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K | string,
  handler: (e: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): void {
  target.addEventListener(type, handler as EventListener, opts)
}

export function clear(node: Element) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

/**
 * 24x24 stroke icons. Each entry is either a path `d` string or an array of
 * primitives, so filled shapes (circles, rects) are expressible too.
 */
type IconPrim =
  | { t: "path"; d: string; fill?: boolean }
  | { t: "circle"; cx: number; cy: number; r: number; fill?: boolean }
  | { t: "rect"; x: number; y: number; w: number; h: number; r?: number; fill?: boolean }

export const ICONS: Record<string, IconPrim[]> = {
  "arrow-right": [{ t: "path", d: "M5 12h14M13 5l7 7-7 7" }],
  archive: [
    { t: "rect", x: 2, y: 3, w: 20, h: 5, r: 1 },
    { t: "path", d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" },
  ],
  check: [{ t: "path", d: "M20 6 9 17l-5-5" }],
  "chevron-down": [{ t: "path", d: "m6 9 6 6 6-6" }],
  "chevron-right": [{ t: "path", d: "m9 6 6 6-6 6" }],
  clock: [
    { t: "circle", cx: 12, cy: 12, r: 10 },
    { t: "path", d: "M12 6v6l4 2" },
  ],
  copy: [
    { t: "rect", x: 9, y: 9, w: 13, h: 13, r: 2 },
    { t: "path", d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" },
  ],
  eye: [
    { t: "path", d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" },
    { t: "circle", cx: 12, cy: 12, r: 3 },
  ],
  "external-link": [
    { t: "path", d: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" },
  ],
  folder: [
    {
      t: "path",
      d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
    },
  ],
  globe: [
    { t: "circle", cx: 12, cy: 12, r: 10 },
    { t: "path", d: "M2 12h20" },
    { t: "path", d: "M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20" },
  ],
  grid: [
    { t: "rect", x: 3, y: 3, w: 7, h: 7, r: 1 },
    { t: "rect", x: 14, y: 3, w: 7, h: 7, r: 1 },
    { t: "rect", x: 14, y: 14, w: 7, h: 7, r: 1 },
    { t: "rect", x: 3, y: 14, w: 7, h: 7, r: 1 },
  ],
  info: [
    { t: "circle", cx: 12, cy: 12, r: 10 },
    { t: "path", d: "M12 16v-4M12 8h.01" },
  ],
  layers: [
    { t: "path", d: "m12 2 9 5-9 5-9-5 9-5" },
    { t: "path", d: "m3 12 9 5 9-5" },
    { t: "path", d: "m3 17 9 5 9-5" },
  ],
  // two windows converging into one - used by "Combine windows"
  merge: [
    { t: "rect", x: 2, y: 3, w: 7, h: 6, r: 1 },
    { t: "rect", x: 2, y: 15, w: 7, h: 6, r: 1 },
    { t: "path", d: "M11 12h5" },
    { t: "path", d: "m14 9 3 3-3 3" },
    { t: "rect", x: 18, y: 8, w: 4, h: 8, r: 1 },
  ],
  lightbulb: [
    { t: "path", d: "M9 18h6M10 22h4" },
    { t: "path", d: "M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" },
  ],
  list: [
    { t: "path", d: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
  ],
  "more-vertical": [
    { t: "circle", cx: 12, cy: 5, r: 1.4, fill: true },
    { t: "circle", cx: 12, cy: 12, r: 1.4, fill: true },
    { t: "circle", cx: 12, cy: 19, r: 1.4, fill: true },
  ],
  orbit: [
    { t: "circle", cx: 12, cy: 12, r: 3 },
    { t: "path", d: "M20.5 15.5a2.5 2.5 0 0 1-3.5 0c-1-1-1-2.5 0-3.5" },
    { t: "circle", cx: 12, cy: 12, r: 9.5 },
  ],
  pin: [
    { t: "path", d: "M12 17v5" },
    { t: "path", d: "M9 10.8V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v5.8l1.6 2.6a1 1 0 0 1-.86 1.6H8.26a1 1 0 0 1-.86-1.6Z" },
  ],
  plus: [{ t: "path", d: "M12 5v14M5 12h14" }],
  refresh: [
    { t: "path", d: "M3 12a9 9 0 0 1 15-6.7L21 8" },
    { t: "path", d: "M21 3v5h-5" },
    { t: "path", d: "M21 12a9 9 0 0 1-15 6.7L3 16" },
    { t: "path", d: "M3 21v-5h5" },
  ],
  rocket: [
    { t: "path", d: "M5 13c-1.5 1.5-2 5-2 5s3.5-.5 5-2" },
    { t: "path", d: "M14.5 3.5c3-3 6.5-2.5 6.5-2.5s.5 3.5-2.5 6.5L13 13l-2-2z" },
    { t: "path", d: "M11 11 6 9l-1 3 4 4 3-1z" },
  ],
  save: [
    { t: "path", d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" },
    { t: "path", d: "M17 21v-8H7v8M7 3v5h8" },
  ],
  search: [
    { t: "circle", cx: 11, cy: 11, r: 8 },
    { t: "path", d: "m21 21-4.3-4.3" },
  ],
  settings: [
    { t: "path", d: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" },
    { t: "path", d: "M1 14h6M9 8h6M17 16h6" },
  ],
  shield: [{ t: "path", d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }],
  sparkles: [
    { t: "path", d: "m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" },
    { t: "path", d: "M19 15.5 19.8 18l2.2.8-2.2.7L19 22l-.7-2.5-2.3-.7 2.3-.8z" },
  ],
  star: [
    { t: "path", d: "m12 2.5 3 6.1 6.7 1-4.9 4.7 1.2 6.7L12 17.8 6 21l1.2-6.7-4.9-4.7 6.7-1z" },
  ],
  trash: [
    { t: "path", d: "M3 6h18" },
    { t: "path", d: "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" },
    { t: "path", d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" },
    { t: "path", d: "M10 11v6M14 11v6" },
  ],
  undo: [
    { t: "path", d: "M3 7v6h6" },
    { t: "path", d: "M3.5 13a9 9 0 1 0 2.4-6.2L3 9" },
  ],
  wand: [
    { t: "path", d: "M3 21 13.5 10.5" },
    { t: "path", d: "M15 4V2M15 16v-2M8 9h2M20 9h2" },
    { t: "path", d: "M17.8 6.2 19 5M17.8 11.8 19 13" },
  ],
  x: [{ t: "path", d: "M18 6 6 18M6 6l12 12" }],
  zap: [{ t: "path", d: "M13 2 3 14h9l-1 8 10-12h-9z" }],
}

export type IconName = keyof typeof ICONS | (string & {})

export function icon(name: IconName, size = 16, opts?: { fill?: boolean }): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("width", String(size))
  svg.setAttribute("height", String(size))
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "1.9")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  svg.classList.add("ic")

  const prims = ICONS[name] ?? ICONS["info"]
  for (const p of prims) {
    const fill = p.fill || opts?.fill
    if (p.t === "path") {
      const el = document.createElementNS(SVG_NS, "path")
      el.setAttribute("d", p.d)
      if (fill) el.setAttribute("fill", "currentColor")
      svg.appendChild(el)
    } else if (p.t === "circle") {
      const el = document.createElementNS(SVG_NS, "circle")
      el.setAttribute("cx", String(p.cx))
      el.setAttribute("cy", String(p.cy))
      el.setAttribute("r", String(p.r))
      if (fill) el.setAttribute("fill", "currentColor")
      svg.appendChild(el)
    } else {
      const el = document.createElementNS(SVG_NS, "rect")
      el.setAttribute("x", String(p.x))
      el.setAttribute("y", String(p.y))
      el.setAttribute("width", String(p.w))
      el.setAttribute("height", String(p.h))
      if (p.r) {
        el.setAttribute("rx", String(p.r))
        el.setAttribute("ry", String(p.r))
      }
      if (fill) el.setAttribute("fill", "currentColor")
      svg.appendChild(el)
    }
  }
  return svg
}

/** A round favicon with a letter fallback, so rows never show a broken image. */
export function favicon(url: string, favIconUrl: string, size = 18): HTMLElement {
  const wrap = h("span", { class: "favicon", style: { width: `${size}px`, height: `${size}px` } })
  const letter = h("span", { class: "favicon-letter", text: (url.match(/^[a-z]+:\/\/(?:www\.)?([^./]+)/i)?.[1] ?? "?")[0].toUpperCase() })
  if (favIconUrl && !favIconUrl.startsWith("chrome")) {
    const img = h("img", { src: favIconUrl, alt: "", loading: "lazy", width: size, height: size })
    img.addEventListener("error", () => img.remove())
    wrap.appendChild(img)
  }
  wrap.appendChild(letter)
  return wrap
}
