/**
 * Orbit Hub — the "Universe" surface.
 *
 * Spaces are Chrome windows, planets are tab groups (sized by tab count) and
 * stars are tabs orbiting their planet. Ungrouped tabs orbit a distinct
 * "free-floating" cluster inside their space.
 *
 * Everything here is plain DOM plus inline SVG: no framework, no charting
 * library. The layout maths lives in small pure functions (`planetRadius`,
 * `starSlots`, `packRows`, `circleInRect`, ...) so it stays testable, and the
 * renderer is a straight function of (state) -> DOM.
 */
import { COLOR_HEX, GROUP_COLORS } from "./shared/constants"
import type {
  GroupColor,
  GroupId,
  HubState,
  Message,
  RecycleEntry,
  TabId,
  TabRecord,
  WindowId,
} from "./shared/types"
import { $, clear, h, icon, favicon } from "./shared/dom"
import {
  absoluteTime,
  clamp,
  debounce,
  displayTitle,
  hostOf,
  isRestrictedUrl,
  plural,
  timeAgo,
} from "./shared/format"
import { modal, promptModal, send, toast } from "./shared/ui"

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Sidebar collapse flag. Hub-local: Chrome has no equivalent. */
const SIDEBAR_KEY = "orbit_hub_sidebar_collapsed_v1"
/** Per-group "collapsed in the hub" flag (hub-local, Chrome has no equivalent). */
const COLLAPSED_KEY = "orbit_hub_collapsed_groups_v1"

/** Sentinel group id for the ungrouped / free-floating cluster. */
const UNGROUPED: GroupId = -1

const STAR_R = 8
const PLANET_MIN_R = 22
const PLANET_MAX_R = 58
const SPACE_PAD = 22
const SPACE_HEADER = 44
const SPACE_GAP = 18
const CELL_GAP = 22
const CANVAS_PAD = 18
const RING_STEP = STAR_R * 2 + 9
const MAX_RINGS = 4
const STAR_SPACING = STAR_R * 2 + 8
const DRAG_THRESHOLD = 4
/** Vertical room reserved between the planet body and its first orbit, for the label. */
const LABEL_BAND = 26
const LABEL_MAX = 18

/*
 * Hover previews show the tab's title, URL and usage — not a screenshot. The
 * reference captures thumbnails, which needs broad host access it warns the user
 * about ("a permission prompt mentioning all websites"); asking for less is a
 * deliberate difference here, so this says what it is instead of promising a
 * capture that no code performs. `scripts/claims.mjs` fails the build if a
 * string promises a capability the source does not have.
 */
const PREVIEW_PLACEHOLDER = "No preview thumbnails — Orbit never asks to capture your pages."

/* ------------------------------------------------------------------ */
/* Pure geometry                                                       */
/* ------------------------------------------------------------------ */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Planet radius grows with the square root of the tab count, then clamps. */
export function planetRadius(tabCount: number): number {
  const n = Math.max(0, tabCount)
  return clamp(PLANET_MIN_R + Math.sqrt(n) * 5.2, PLANET_MIN_R, PLANET_MAX_R)
}

/** How many stars fit on one orbit without overlapping. */
export function ringCapacity(orbitR: number, spacing = STAR_SPACING): number {
  return Math.max(1, Math.floor((2 * Math.PI * orbitR) / spacing))
}

/**
 * Stars shrink as a group grows, so a dense orbit stays legible instead of
 * overlapping into a single blob.
 */
export function starRadius(tabCount: number): number {
  return clamp(STAR_R - Math.max(0, tabCount) * 0.02, 3.5, STAR_R)
}

export interface RingSlot {
  radius: number
  /** index within this ring */
  index: number
  /** number of stars sharing this ring */
  total: number
}

/**
 * Assigns every star a (ring, index) slot, spilling into outer rings when full.
 * The first ring clears the label band drawn just under the planet body.
 *
 * Always returns EXACTLY `starCount` slots. An earlier version stopped after a
 * fixed number of rings and left the remainder unplaced; `computeLayout` then
 * fell back to the planet centre, so every overflow star was stacked on one
 * point - visually merged, and impossible to hit-test individually. A group of
 * 200 tabs silently became 134 distinct stars.
 *
 * Ring count is now unbounded, and both the star radius and the ring spacing
 * tighten as the group grows, so a 300-tab planet stays a sane size rather than
 * sprawling off the canvas.
 */
export function starSlots(starCount: number, planetR: number): RingSlot[] {
  const slots: RingSlot[] = []
  const total = Math.max(0, starCount)
  if (total === 0) return slots

  const r = starRadius(total)
  const spacing = r * 2 + 6
  const step = spacing + 1

  let remaining = total
  let radius = planetR + r + LABEL_BAND
  while (remaining > 0) {
    const cap = ringCapacity(radius, spacing)
    const n = Math.min(cap, remaining)
    for (let i = 0; i < n; i++) slots.push({ radius, index: i, total: n })
    remaining -= n
    radius += step
  }
  return slots
}

/** Polar -> cartesian, starting at 12 o'clock and going clockwise. */
export function starPoint(
  center: Point,
  radius: number,
  index: number,
  total: number,
  phase = -Math.PI / 2,
): Point {
  const step = (2 * Math.PI) / Math.max(1, total)
  const angle = phase + step * index
  return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }
}

export interface Cell {
  w: number
  h: number
}

/**
 * Lays cells out left-to-right, wrapping when the next one would overflow
 * `maxWidth`. Returns each cell's centre plus the total block height.
 */
export function packRows(
  cells: Cell[],
  maxWidth: number,
  gap: number,
): { positions: Point[]; height: number } {
  const positions: Point[] = []
  let x = 0
  let y = 0
  let rowH = 0
  for (const cell of cells) {
    if (x > 0 && x + cell.w > maxWidth) {
      x = 0
      y += rowH + gap
      rowH = 0
    }
    positions.push({ x: x + cell.w / 2, y: y + cell.h / 2 })
    x += cell.w + gap
    rowH = Math.max(rowH, cell.h)
  }
  return { positions, height: rowH === 0 ? 0 : y + rowH }
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

/** True when a circle overlaps an axis-aligned rectangle (marquee hit test). */
export function circleInRect(c: Point, radius: number, r: Rect): boolean {
  const nx = clamp(c.x, r.x, r.x + r.w)
  const ny = clamp(c.y, r.y, r.y + r.h)
  const dx = c.x - nx
  const dy = c.y - ny
  return dx * dx + dy * dy <= radius * radius
}

/**
 * Deterministic decorative starfield for a space, so the backdrop looks the
 * same on every render. Pure: same seed + rect always yields the same dots.
 */
export function starfield(
  seed: number,
  count: number,
  rect: Rect,
): Array<{ x: number; y: number; r: number; o: number }> {
  let s = (Math.abs(Math.trunc(seed)) * 9301 + 49297) % 233280 || 7
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  const dots: Array<{ x: number; y: number; r: number; o: number }> = []
  for (let i = 0; i < count; i++) {
    dots.push({
      x: rect.x + rnd() * rect.w,
      y: rect.y + rnd() * rect.h,
      r: 0.6 + rnd() * 1.1,
      o: 0.1 + rnd() * 0.28,
    })
  }
  return dots
}

/* ------------------------------------------------------------------ */
/* Layout model                                                        */
/* ------------------------------------------------------------------ */

export interface StarNode {
  tab: TabRecord
  center: Point
  r: number
}

export interface PlanetNode {
  /** UNGROUPED (-1) for the free-floating cluster */
  groupId: GroupId
  windowId: WindowId
  title: string
  color: GroupColor | null
  collapsed: boolean
  center: Point
  radius: number
  /** furthest point of the outermost orbit, used for hit-testing and packing */
  outer: number
  stars: StarNode[]
}

export interface SpaceNode {
  windowId: WindowId
  focused: boolean
  rect: Rect
  title: string
  planets: PlanetNode[]
  dots: Array<{ x: number; y: number; r: number; o: number }>
}

export interface LayoutModel {
  width: number
  height: number
  spaces: SpaceNode[]
  stars: StarNode[]
}

interface PlanetPlan {
  groupId: GroupId
  title: string
  color: GroupColor | null
  collapsed: boolean
  tabs: TabRecord[]
}

/** Turns hub state into positioned spaces/planets/stars for a given width. */
export function computeLayout(
  hub: HubState,
  width: number,
  collapsedGroups: Set<GroupId>,
): LayoutModel {
  const innerW = Math.max(360, width - CANVAS_PAD * 2)
  const spaces: SpaceNode[] = []
  const allStars: StarNode[] = []

  const tabsByWindow = new Map<WindowId, TabRecord[]>()
  for (const tab of hub.tabs) {
    // The organizer never groups browser-internal pages, so showing them here
    // would offer drag actions that cannot work - and let the Hub draw, group,
    // teleport, or recycle *itself*. Filter them out so both surfaces agree.
    if (isRestrictedUrl(tab.url)) continue
    const list = tabsByWindow.get(tab.windowId)
    if (list) list.push(tab)
    else tabsByWindow.set(tab.windowId, [tab])
  }

  // Windows the background did not report (defensive: never lose a tab).
  const windowIds: WindowId[] = hub.windows.map((w) => w.id)
  for (const id of tabsByWindow.keys()) if (!windowIds.includes(id)) windowIds.push(id)

  let y = CANVAS_PAD

  windowIds.forEach((windowId, spaceIndex) => {
    const tabs = tabsByWindow.get(windowId) ?? []
    const groups = hub.groups.filter((g) => g.windowId === windowId)
    const plans: PlanetPlan[] = []

    for (const g of groups) {
      plans.push({
        groupId: g.id,
        title: g.title?.trim() || "Untitled group",
        color: g.color,
        collapsed: collapsedGroups.has(g.id),
        tabs: tabs.filter((t) => t.groupId === g.id),
      })
    }

    const grouped = new Set(groups.map((g) => g.id))
    const loose = tabs.filter((t) => !grouped.has(t.groupId))
    if (loose.length > 0) {
      plans.push({
        groupId: UNGROUPED,
        title: "Free-floating",
        color: null,
        collapsed: false,
        tabs: loose,
      })
    }

    const geometry = plans.map((p) => {
      const radius = planetRadius(p.tabs.length)
      const slots = p.collapsed ? [] : starSlots(p.tabs.length, radius)
      const maxRing = slots.reduce((m, s) => Math.max(m, s.radius), radius)
      // the cell must clear the outermost star's own radius, not a fixed one
      const outer =
        slots.length > 0 ? maxRing + starRadius(p.tabs.length) + 10 : radius + LABEL_BAND
      return { radius, slots, outer }
    })

    const cells: Cell[] = geometry.map((g) => ({ w: g.outer * 2, h: g.outer * 2 }))
    const packed = packRows(cells, innerW - SPACE_PAD * 2, CELL_GAP)
    const bodyH = Math.max(packed.height, 96)
    const rect: Rect = {
      x: CANVAS_PAD,
      y,
      w: innerW,
      h: SPACE_HEADER + bodyH + SPACE_PAD,
    }

    const planets: PlanetNode[] = plans.map((plan, i) => {
      const geo = geometry[i]
      const pos = packed.positions[i] ?? { x: SPACE_PAD, y: bodyH / 2 }
      const center: Point = {
        x: rect.x + SPACE_PAD + pos.x,
        y: rect.y + SPACE_HEADER + pos.y,
      }
      const stars: StarNode[] = plan.tabs.map((tab, si) => {
        const slot = geo.slots[si]
        // starSlots always covers every tab, so the centre fallback is a
        // belt-and-braces guard rather than a real path
        const at = slot ? starPoint(center, slot.radius, slot.index, slot.total) : center
        return { tab, center: at, r: starRadius(plan.tabs.length) }
      })
      // A collapsed planet hides its stars, so they are neither drawn nor
      // hit-testable until it is expanded again.
      if (!plan.collapsed) for (const star of stars) allStars.push(star)
      return {
        groupId: plan.groupId,
        windowId,
        title: plan.title,
        color: plan.color,
        collapsed: plan.collapsed,
        center,
        radius: geo.radius,
        outer: geo.outer,
        stars,
      }
    })

    const dotCount = clamp(Math.round((rect.w * rect.h) / 11000), 10, 90)
    spaces.push({
      windowId,
      focused: hub.windows.find((w) => w.id === windowId)?.focused ?? false,
      rect,
      title: `Space ${spaceIndex + 1}`,
      planets,
      dots: starfield(windowId + spaceIndex + 1, dotCount, rect),
    })

    y += rect.h + SPACE_GAP
  })

  return {
    width: innerW + CANVAS_PAD * 2,
    height: Math.max(y + CANVAS_PAD - SPACE_GAP, 320),
    spaces,
    stars: allStars,
  }
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

export function tabMatches(tab: TabRecord, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    displayTitle(tab).toLowerCase().includes(q) ||
    tab.url.toLowerCase().includes(q) ||
    hostOf(tab.url).toLowerCase().includes(q)
  )
}

export function groupMatches(title: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  return q.length > 0 && title.toLowerCase().includes(q)
}

/** Wraps every occurrence of `query` in a <mark>, without ever using innerHTML. */
export function highlightText(text: string, query: string): DocumentFragment {
  const out = document.createDocumentFragment()
  const needle = query.trim().toLowerCase()
  if (!needle) {
    out.appendChild(document.createTextNode(text))
    return out
  }
  const hay = text.toLowerCase()
  let i = 0
  while (i < text.length) {
    const at = hay.indexOf(needle, i)
    if (at === -1) {
      out.appendChild(document.createTextNode(text.slice(i)))
      break
    }
    if (at > i) out.appendChild(document.createTextNode(text.slice(i, at)))
    out.appendChild(h("mark", { class: "hl", text: text.slice(at, at + needle.length) }))
    i = at + needle.length
  }
  return out
}

export function truncateLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

/** Only ever hand http(s)/data-image URLs to an <img>/<image>. */
function safeIconUrl(url: string): string | null {
  if (!url) return null
  if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url)) return url
  return null
}

function letterOf(url: string): string {
  const host = hostOf(url)
  return (host || "?").charAt(0).toUpperCase()
}

/* ------------------------------------------------------------------ */
/* SVG helpers                                                         */
/* ------------------------------------------------------------------ */

const SVG_NS = "http://www.w3.org/2000/svg"

type Attrs = Record<string, string | number | null | undefined>

function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Array<Node | string | null | undefined>
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue
      el.setAttribute(k, String(v))
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    el.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
  }
  return el
}

/** Sets a CSS custom property, which the stylesheet then consumes. */
function setVar(el: Element, name: string, value: string): void {
  ;(el as HTMLElement | SVGElement).style.setProperty(name, value)
}

/* ------------------------------------------------------------------ */
/* Local storage                                                       */
/* ------------------------------------------------------------------ */

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0")
  } catch {
    /* storage can be unavailable; the hub still works in-memory */
  }
}

function readCollapsedGroups(): Set<GroupId> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is number => typeof v === "number"))
  } catch {
    return new Set()
  }
}

function writeCollapsedGroups(ids: Set<GroupId>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]))
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

type Status = "loading" | "ready" | "error"

interface DragState {
  tabIds: TabId[]
  pointer: Point
  planet: { windowId: WindowId; groupId: GroupId } | null
  windowId: WindowId | null
  zone: "move" | "recycle" | null
}

interface PendingDrag {
  tabIds: TabId[]
  origin: Point
  moved: boolean
}

interface MarqueeState {
  origin: Point
  base: Set<TabId>
  additive: boolean
  active: boolean
}

const state = {
  status: "loading" as Status,
  error: "",
  hub: null as HubState | null,
  recycle: [] as RecycleEntry[],
  selected: new Set<TabId>(),
  search: "",
  collapsedGroups: readCollapsedGroups(),
  sidebarCollapsed: readFlag(SIDEBAR_KEY),
  layout: null as LayoutModel | null,
  previewTabId: null as TabId | null,
  previewTimer: 0 as ReturnType<typeof setTimeout> | 0,
  activeGroup: null as { windowId: WindowId; groupId: GroupId } | null,
  /** which tabs the Organization Score covers */
  scoreScope: "window" as "window" | "all",
  /** the window this hub page lives in, resolved from Chrome rather than a cached flag */
  selfWindowId: null as WindowId | null,
  /** tab ids carrying a user-given name, so the score can count them as organized */
  renamedIds: new Set<TabId>(),
  drag: null as DragState | null,
  width: 900,
  /** set once the hub has adopted Chrome's own collapse state on first load */
  seeded: false,
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

interface Shell {
  app: HTMLElement
  sidebar: HTMLElement
  sidebarBody: HTMLElement
  searchInput: HTMLInputElement
  searchCount: HTMLElement
  statLine: HTMLElement
  collapseBtn: HTMLButtonElement
  refreshBtn: HTMLButtonElement
  reorderBtn: HTMLButtonElement
  mergeBtn: HTMLButtonElement
  undoBtn: HTMLButtonElement
  organizeBtn: HTMLButtonElement
  canvasWrap: HTMLElement
  stage: HTMLElement
  dock: HTMLElement
  dockMove: HTMLElement
  dockRecycle: HTMLElement
  dockHint: HTMLElement
  selbar: HTMLElement
  results: HTMLElement
  overlay: HTMLElement | null
}

function iconBtn(
  name: string,
  title: string,
  onClick: () => void,
  cls = "btn btn-icon",
): HTMLButtonElement {
  return h(
    "button",
    {
      class: cls,
      type: "button",
      title,
      "aria-label": title,
      on: { click: onClick },
    },
    icon(name, 16),
  )
}

function mountShell(): Shell {
  const app = $("#app") ?? document.body
  clear(app)
  document.body.classList.add("hub-body")

  /* ---- sidebar ---- */
  const sidebarBody = h("div", { class: "hub-sidebar-body" })
  const sidebar = h("aside", { class: "hub-sidebar", id: "hub-sidebar" }, sidebarBody)

  /* ---- topbar ---- */
  const searchInput = h("input", {
    class: "input hub-search-input",
    type: "search",
    placeholder: "Search tabs, groups and URLs…",
    spellcheck: false,
    "aria-label": "Search tabs",
  })
  const searchCount = h("span", { class: "hub-search-count small" })
  const statLine = h("div", { class: "hub-stats small muted" })

  const collapseBtn = h(
    "button",
    { class: "btn btn-sm", type: "button", title: "Collapse or expand every Chrome tab group" },
    icon("layers", 14),
    h("span", { text: "Collapse all" }),
  )
  const refreshBtn = iconBtn("refresh", "Reload the universe", () => void refresh())
  const reorderBtn = h(
    "button",
    { class: "btn btn-sm", type: "button", title: "Match the visual order to the real tab strip" },
    icon("grid", 14),
    h("span", { text: "Reorder groups" }),
  )
  const mergeBtn = h(
    "button",
    {
      class: "btn btn-sm",
      type: "button",
      title: "Pull every tab from every window into this one. Undo puts them back.",
    },
    icon("merge", 14),
    h("span", { text: "Combine windows" }),
  )
  // The Hub is a full-window surface, so undo belongs here too - otherwise
  // "Combine windows" promises a way back that this surface cannot offer.
  const undoBtn = h(
    "button",
    { class: "btn btn-sm", type: "button", title: "Undo the last organization or merge" },
    icon("undo", 14),
    h("span", { text: "Undo" }),
  )
  const organizeBtn = h(
    "button",
    { class: "btn btn-sm btn-primary", type: "button" },
    icon("sparkles", 14),
    h("span", { text: "Organize now" }),
  )

  const topbar = h(
    "header",
    { class: "hub-topbar" },
    iconBtn("list", "Toggle sidebar", () => toggleSidebar()),
    h(
      "div",
      { class: "hub-brand" },
      icon("orbit", 18),
      h("span", { class: "hub-brand-name", text: "Orbit Hub" }),
    ),
    h("div", { class: "hub-search" }, icon("search", 15), searchInput, searchCount),
    h(
      "div",
      { class: "hub-topbar-actions" },
      statLine,
      undoBtn,
      reorderBtn,
      mergeBtn,
      collapseBtn,
      organizeBtn,
      refreshBtn,
    ),
  )

  /* ---- canvas ---- */
  const stage = h("div", { class: "hub-stage" })
  const canvasWrap = h("div", { class: "hub-canvas", id: "hub-canvas" }, stage)

  const main = h("section", { class: "hub-main" }, topbar, canvasWrap)
  app.appendChild(h("div", { class: "hub-root" }, sidebar, main))

  /* ---- fixed chrome ---- */
  const dockHint = h("div", { class: "hub-dock-hint small", text: "Drag a star here" })
  const dockMove = h(
    "div",
    { class: "hub-dock-zone", "data-zone": "move" },
    icon("arrow-right", 15),
    h("span", { text: "Teleport" }),
    h("span", { class: "small faint", text: "another window" }),
  )
  const dockRecycle = h(
    "div",
    { class: "hub-dock-zone danger", "data-zone": "recycle" },
    icon("trash", 15),
    h("span", { text: "Recycle" }),
    h("span", { class: "small faint", text: "close the tabs" }),
  )
  const dock = h("div", { class: "hub-dock" }, dockHint, h("div", { class: "hub-dock-row" }, dockMove, dockRecycle))

  const selbar = h("div", { class: "hub-selbar hidden" })
  const results = h("aside", { class: "hub-results hidden" })

  document.body.appendChild(dock)
  document.body.appendChild(selbar)
  document.body.appendChild(results)

  return {
    app,
    sidebar,
    sidebarBody,
    searchInput,
    searchCount,
    statLine,
    collapseBtn,
    refreshBtn,
    reorderBtn,
    mergeBtn,
    undoBtn,
    organizeBtn,
    canvasWrap,
    stage,
    dock,
    dockMove,
    dockRecycle,
    dockHint,
    selbar,
    results,
    overlay: null,
  }
}

// mountShell touches the DOM, so it is skipped outside a browser. It is left as
// null rather than a stub: the pure geometry below never reads `els`, and an
// accidental read should fail loudly in a test rather than silently pass.
const els: Shell = typeof document !== "undefined" ? mountShell() : (null as unknown as Shell)

/* ------------------------------------------------------------------ */
/* Derived helpers over state                                          */
/* ------------------------------------------------------------------ */

function hubOrNull(): HubState | null {
  return state.hub
}

function groupTitle(groupId: GroupId): string {
  const hub = hubOrNull()
  if (!hub) return ""
  if (groupId === UNGROUPED) return "Free-floating"
  return hub.groups.find((g) => g.id === groupId)?.title ?? "Group"
}

function groupColor(groupId: GroupId): GroupColor | null {
  const hub = hubOrNull()
  if (!hub || groupId === UNGROUPED) return null
  return hub.groups.find((g) => g.id === groupId)?.color ?? null
}

function starById(tabId: TabId): StarNode | null {
  return state.layout?.stars.find((s) => s.tab.id === tabId) ?? null
}

function planetAt(point: Point): PlanetNode | null {
  const layout = state.layout
  if (!layout) return null
  let best: PlanetNode | null = null
  let bestDist = Infinity
  for (const space of layout.spaces) {
    for (const planet of space.planets) {
      const d = distance(point, planet.center)
      if (d <= planet.outer && d < bestDist) {
        best = planet
        bestDist = d
      }
    }
  }
  return best
}

function spaceAt(point: Point): SpaceNode | null {
  return state.layout?.spaces.find((sp) => pointInRect(point, sp.rect)) ?? null
}

/**
 * The tabs the universe actually draws.
 *
 * Browser-internal pages are excluded, because `computeLayout` excludes them —
 * the organizer never groups them, so the Hub must not offer drag, teleport or
 * recycle on them either. Filtering here rather than at each call site is the
 * point: this used to return the raw record list, so the toolbar and the sidebar
 * counted every record while the space card counted only drawn stars, and a
 * window holding `about:blank` and the Hub page read "2 tabs" in two places and
 * "0 tabs" in a third. Same rule, one place.
 */
function visibleTabs(): TabRecord[] {
  return (state.hub?.tabs ?? []).filter((t) => !isRestrictedUrl(t.url))
}

function matchingTabs(): TabRecord[] {
  const q = state.search.trim()
  if (!q) return []
  // A group-name hit surfaces that group's tabs too, matching the way the
  // planet itself lights up on a group-name match.
  const hitGroups = new Set(
    (state.hub?.groups ?? []).filter((g) => groupMatches(g.title, q)).map((g) => g.id),
  )
  return visibleTabs().filter((t) => tabMatches(t, q) || hitGroups.has(t.groupId))
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render(): void {
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed)
  renderTopbar()
  renderSidebar()
  renderCanvas()
  renderSelbar()
  renderResults()
}

function renderTopbar(): void {
  const hub = state.hub
  // `visibleTabs` already excludes what the universe does not draw, so this
  // agrees with the space card beside it and with the sidebar list.
  const tabs = visibleTabs().length
  const groups = hub?.groups.length ?? 0
  const windows = hub?.windows.length ?? 0

  if (state.status === "error") {
    els.statLine.textContent = "Unavailable"
  } else if (state.status === "loading") {
    els.statLine.textContent = "Loading…"
  } else {
    els.statLine.textContent = `${plural(windows, "space")} · ${plural(groups, "group")} · ${plural(tabs, "tab")}`
  }

  const allCollapsed = (hub?.groups.length ?? 0) > 0 && (hub?.groups.every((g) => isCollapsed(g.id)) ?? false)
  const label = els.collapseBtn.querySelector("span")
  if (label) label.textContent = allCollapsed ? "Expand all" : "Collapse all"

  els.collapseBtn.disabled = state.status !== "ready"
  els.refreshBtn.disabled = state.status === "loading"
  // nothing to combine with a single window
  els.mergeBtn.disabled = state.status !== "ready" || (state.hub?.windows.length ?? 0) <= 1
  els.undoBtn.disabled = state.status !== "ready" || !state.hub?.canUndo
}

function renderSidebar(): void {
  clear(els.sidebarBody)
  const hub = state.hub

  /* Spaces */
  const spaces = h("div", { class: "hub-nav" })
  if (hub && hub.windows.length > 0) {
    hub.windows.forEach((win, i) => {
      const count = visibleTabs().filter((t) => t.windowId === win.id).length
      const groups = hub.groups.filter((g) => g.windowId === win.id).length
      const item = h(
        "button",
        {
          class: `hub-nav-item${win.focused ? " current" : ""}`,
          type: "button",
          on: { click: () => scrollToSpace(win.id) },
        },
        h("span", { class: "hub-nav-dot" }),
        h(
          "span",
          { class: "col grow" },
          h("span", { class: "hub-nav-name truncate", text: `Space ${i + 1}` }),
          h("span", { class: "small faint truncate", text: `${plural(count, "tab")} · ${plural(groups, "group")}` }),
        ),
        win.focused ? h("span", { class: "badge", text: "Focus" }) : null,
      )
      spaces.appendChild(item)
    })
  } else {
    spaces.appendChild(h("div", { class: "small faint hub-nav-empty", text: "No windows reported." }))
  }

  /* Recycle bin */
  const recycleHead = h(
    "div",
    { class: "hub-panel-head" },
    h("span", { class: "hub-panel-title", text: "Recycle bin" }),
    h("span", { class: "badge", text: String(state.recycle.length) }),
  )
  const recycleList = h("div", { class: "hub-recycle" })
  if (state.recycle.length === 0) {
    recycleList.appendChild(
      h("div", { class: "small faint hub-recycle-empty", text: "Closed tabs land here so you can bring them back." }),
    )
  } else {
    for (const entry of state.recycle.slice(0, 60)) {
      recycleList.appendChild(
        h(
          "div",
          { class: "hub-recycle-item" },
          favicon(entry.url, entry.favIconUrl, 15),
          h(
            "div",
            { class: "col grow" },
            h("span", { class: "truncate", text: displayTitle({ title: entry.title, url: entry.url }) }),
            h("span", {
              class: "small faint truncate",
              text: `${hostOf(entry.url) || entry.reason} · ${timeAgo(entry.closedAt)}`,
            }),
          ),
          iconBtn("undo", "Restore this tab", () => void restoreRecycle([entry.id]), "btn btn-icon btn-sm"),
        ),
      )
    }
  }
  const recycleActions = h(
    "div",
    { class: "hub-panel-actions" },
    h(
      "button",
      {
        class: "btn btn-sm btn-block",
        type: "button",
        disabled: state.recycle.length === 0,
        on: { click: () => void restoreRecycle(state.recycle.map((e) => e.id)) },
      },
      icon("undo", 13),
      h("span", { text: "Restore all" }),
    ),
    h(
      "button",
      {
        class: "btn btn-sm btn-block btn-danger",
        type: "button",
        disabled: state.recycle.length === 0,
        on: { click: () => void clearRecycle() },
      },
      icon("trash", 13),
      h("span", { text: "Empty bin" }),
    ),
  )

  /* Legend */
  const legend = h(
    "div",
    { class: "hub-legend small muted" },
    legendRow("globe", "Space", "a Chrome window"),
    legendRow("folder", "Planet", "a tab group"),
    legendRow("star", "Star", "one tab, in orbit"),
    legendRow("grid", "Marquee", "drag empty space to multi-select"),
  )

  els.sidebarBody.append(
    h("div", { class: "hub-panel" }, h("div", { class: "hub-panel-head" }, h("span", { class: "hub-panel-title", text: "Spaces" })), spaces),
    h("div", { class: "hub-panel" }, renderScorePanel()),
    h("div", { class: "hub-panel" }, renderUsagePanel()),
    h("div", { class: "hub-panel" }, renderAccessedPanel()),
    h("div", { class: "hub-panel" }, recycleHead, recycleList, recycleActions),
    h("div", { class: "hub-panel" }, h("div", { class: "hub-panel-head" }, h("span", { class: "hub-panel-title", text: "Legend" })), legend),
    h(
      "div",
      { class: "hub-panel" },
      h("div", { class: "hub-panel-head" }, h("span", { class: "hub-panel-title", text: "Go to" })),
      renderHubNav(),
    ),
  )
}

/**
 * How organized the tabs are.
 *
 * The rule is deliberately plain: a tab counts as organized if it is pinned, in
 * a tab group, or has been renamed. Nothing cleverer — a metric the user cannot
 * predict is a metric they will not trust, so the definition is the whole
 * definition and the panel states it in place.
 */
export function organizationScore(
  tabs: TabRecord[],
  renamed: (id: TabId) => boolean,
): { total: number; organized: number; percent: number } {
  const total = tabs.length
  if (!total) return { total: 0, organized: 0, percent: 0 }
  const organized = tabs.filter((t) => t.pinned || t.groupId !== -1 || renamed(t.id)).length
  return { total, organized, percent: Math.round((organized / total) * 100) }
}

function renderScorePanel(): HTMLElement {
  // "This window" must mean the window the user is actually looking at. Reading
  // it from the cached `focused` flag in hub state gave a stale answer whenever
  // windows had come and gone, and the score silently described a different
  // window than the one on screen.
  const score = organizationScore(scopedTabs(), (id) => Boolean(state.renamedIds?.has(id)))

  const scopeBtn = h(
    "button",
    {
      class: "btn btn-sm hub-score-scope",
      type: "button",
      title: "Choose whether the score covers this window or every window",
    },
    h("span", { text: state.scoreScope === "all" ? "All windows" : "This window" }),
  )
  scopeBtn.addEventListener("click", () => {
    state.scoreScope = state.scoreScope === "all" ? "window" : "all"
    render()
  })

  return h(
    "div",
    { class: "hub-score" },
    h(
      "div",
      { class: "hub-score-head" },
      h("span", { class: "hub-panel-title", text: "Organization Score" }),
      h(
        "span",
        {
          class: "hub-help",
          title:
            "A tab counts as organized if it is pinned, in a tab group, or has been renamed — that's the whole rule.",
          "aria-label":
            "How is Organization Score calculated? A tab counts as organized if it is pinned, in a tab group, or has been renamed — that's the whole rule.",
          text: "?",
        },
      ),
    ),
    h(
      "div",
      { class: "hub-score-body" },
      // With nothing in scope there is no score to report. "0%" would read as a
      // failing grade when the truth is that there is nothing to grade — and the
      // sibling panels already say "No tabs in scope.", so match them.
      h("span", {
        class: "hub-score-pct",
        text: score.total === 0 ? "—" : `${score.percent}%`,
      }),
      h("span", {
        class: "small faint",
        text:
          score.total === 0
            ? "No tabs in scope."
            : `${score.organized} of ${score.total} ${score.total === 1 ? "tab" : "tabs"} organized`,
      }),
    ),
    h("div", { class: "hub-score-bar" }, h("i", { style: `width:${score.percent}%` })),
    scopeBtn,
  )
}

/** The tabs the Organization Score and the usage panels cover. */
function scopedTabs(): TabRecord[] {
  return state.scoreScope === "all"
    ? visibleTabs()
    : visibleTabs().filter((t) => t.windowId === state.selfWindowId)
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Tab Usage — how recently the open tabs were last used.
 *
 * The reference's own explainer: "Keeping only tabs you actually revisit — and
 * closing the rest — is a good habit." So it is a recency summary rather than a
 * list: how many are warm, and how many have gone cold.
 */
function renderUsagePanel(): HTMLElement {
  const tabs = scopedTabs()
  const now = Date.now()
  const usedThisHour = tabs.filter((t) => now - t.lastAccess < HOUR_MS).length
  const usedToday = tabs.filter((t) => now - t.lastAccess < DAY_MS).length
  const cold = tabs.length - usedToday

  const row = (label: string, value: number, cls = "") =>
    h(
      "div",
      { class: `hub-usage-row ${cls}`.trim() },
      h("span", { class: "small", text: label }),
      h("span", { class: "small hub-usage-n", text: String(value) }),
    )

  return h(
    "div",
    { class: "hub-score" },
    h(
      "div",
      { class: "hub-score-head" },
      h("span", { class: "hub-panel-title", text: "Tab Usage" }),
      h("span", {
        class: "hub-help",
        title:
          "How recently your open tabs were last used. Keeping only tabs you actually revisit — and closing the rest — is a good habit.",
        "aria-label":
          "What does Tab Usage show? How recently your open tabs were last used. Keeping only tabs you actually revisit — and closing the rest — is a good habit.",
        text: "?",
      }),
    ),
    tabs.length === 0
      ? h("div", { class: "small faint", text: "No tabs in scope." })
      : h(
          "div",
          { class: "hub-usage" },
          row("Used in the last hour", usedThisHour),
          row("Used today", usedToday),
          row("Not used today", cold, cold > 0 ? "cold" : ""),
        ),
  )
}

/**
 * Most / Least Accessed — ranked by how many times you switched back to each tab
 * this session. The reference states the rule: "Resets when you restart the
 * browser", which is why the counter is session-scoped rather than persisted
 * across a browser start.
 */
function renderAccessedPanel(): HTMLElement {
  const tabs = scopedTabs()
  const ranked = [...tabs].sort(
    (a, b) => (b.sessionSwitches ?? 0) - (a.sessionSwitches ?? 0) || b.lastAccess - a.lastAccess,
  )
  const most = ranked.slice(0, 3)
  const least = ranked.slice(-3).reverse().filter((t) => !most.includes(t))

  const line = (t: TabRecord) =>
    h(
      "div",
      { class: "hub-usage-row" },
      h("span", { class: "small truncate", text: displayTitle(t) }),
      h("span", { class: "small hub-usage-n", text: String(t.sessionSwitches ?? 0) }),
    )

  return h(
    "div",
    { class: "hub-score" },
    h(
      "div",
      { class: "hub-score-head" },
      h("span", { class: "hub-panel-title", text: "Most accessed" }),
      h("span", {
        class: "hub-help",
        title:
          "Ranked by how many times you've switched back to each tab this browser session. Resets when you restart the browser.",
        "aria-label":
          "How is this ranked? Ranked by how many times you've switched back to each tab this browser session. Resets when you restart the browser.",
        text: "?",
      }),
    ),
    tabs.length === 0
      ? h("div", { class: "small faint", text: "No tabs in scope." })
      : h(
          "div",
          { class: "hub-usage" },
          ...most.map(line),
          least.length
            ? h("div", { class: "hub-usage-sep small faint", text: "Least accessed" })
            : null,
          ...least.map(line),
        ),
  )
}

/**
 * The Hub's own navigation.
 *
 * The reference Hub exposes "Saved Groups" and "Settings" as nav entries, so a
 * user can get out of the observer to the rest of the extension. Without this the
 * Hub was a dead end — there was no route to settings from the surface you spend
 * the most time in.
 */
function renderHubNav(): HTMLElement {
  const link = (iconName: string, label: string, hash: string) =>
    h(
      "button",
      {
        class: "hub-nav-item",
        type: "button",
        title: `Open ${label} in the settings page`,
        on: {
          click: () => {
            void chrome.runtime.openOptionsPage()
            // the options page reads this to scroll to the right section
            void chrome.storage.local.set({ __orbitSection: hash })
          },
        },
      },
      h("span", { class: "hub-nav-dot hub-nav-dot-link" }, icon(iconName, 13)),
      h("span", { class: "hub-nav-name", text: label }),
    )

  return h(
    "div",
    { class: "hub-nav" },
    link("save", "Saved groups", "saved"),
    link("settings", "Settings", "general"),
  )
}

function legendRow(iconName: string, label: string, detail: string): HTMLElement {
  return h(
    "div",
    { class: "hub-legend-row" },
    icon(iconName, 13),
    h("span", { class: "hub-legend-label", text: label }),
    // not `truncate`: in the narrow sidebar the ellipsis swallowed the end of
    // the phrase ("drag empty space to multi…"), which is the whole point of it
    h("span", { class: "faint hub-legend-detail", text: detail }),
  )
}

function renderCanvas(): void {
  clear(els.stage)
  els.overlay = null

  if (state.status === "loading") {
    els.stage.appendChild(renderSkeleton())
    return
  }
  if (state.status === "error") {
    els.stage.appendChild(renderErrorState())
    return
  }
  const hub = state.hub
  if (!hub || hub.tabs.length === 0) {
    els.stage.appendChild(renderEmptyState())
    return
  }

  const width = Math.max(420, els.canvasWrap.clientWidth || state.width)
  state.width = width
  const layout = computeLayout(hub, width, state.collapsedGroups)
  state.layout = layout

  els.stage.style.width = `${layout.width}px`
  els.stage.style.height = `${Math.round(layout.height)}px`

  const svg = buildUniverse(layout)
  els.stage.appendChild(svg)
  svg.appendChild(marqueeRect)

  const overlay = h("div", { class: "hub-overlay" })
  els.stage.appendChild(overlay)
  els.overlay = overlay

  renderPopover()
  renderPreview()
  applySearchClasses()
}

function renderSkeleton(): HTMLElement {
  const wrap = h("div", { class: "hub-skeleton" })
  for (let i = 0; i < 2; i++) {
    const space = h("div", { class: "hub-skeleton-space" })
    space.appendChild(h("div", { class: "skeleton hub-skeleton-title" }))
    const row = h("div", { class: "hub-skeleton-row" })
    for (let j = 0; j < 4; j++) {
      row.appendChild(h("div", { class: `skeleton hub-skeleton-planet p${j % 3}` }))
    }
    space.appendChild(row)
    wrap.appendChild(space)
  }
  return wrap
}

function renderErrorState(): HTMLElement {
  return h(
    "div",
    { class: "empty hub-state" },
    icon("shield", 34),
    h("div", { class: "empty-title", text: "The universe is out of reach" }),
    h("div", {
      class: "small",
      text: state.error || "The Orbit service worker did not answer.",
    }),
    h("div", {
      class: "small faint",
      text: "Open this page from the extension (toolbar icon → Orbit Hub) rather than from the file system.",
    }),
    h(
      "button",
      { class: "btn btn-primary", type: "button", on: { click: () => void refresh() } },
      icon("refresh", 14),
      h("span", { text: "Try again" }),
    ),
  )
}

function renderEmptyState(): HTMLElement {
  return h(
    "div",
    { class: "empty hub-state" },
    icon("orbit", 36),
    h("div", { class: "empty-title", text: "Your universe is empty" }),
    h("div", { class: "small", text: "Open a few tabs and they will appear here as stars." }),
    h(
      "button",
      { class: "btn", type: "button", on: { click: () => void refresh() } },
      icon("refresh", 14),
      h("span", { text: "Refresh" }),
    ),
  )
}

/* ---- the universe ---- */

const marqueeRect = s("rect", { class: "marquee", x: 0, y: 0, width: 0, height: 0 })

function buildUniverse(layout: LayoutModel): SVGSVGElement {
  const svg = s(
    "svg",
    {
      class: "universe",
      width: layout.width,
      height: layout.height,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      "aria-label": "Tab universe",
    },
    s(
      "defs",
      null,
      s(
        "radialGradient",
        { id: "hubSpaceGlow", cx: "16%", cy: "0%", r: "90%" },
        s("stop", { offset: "0%", class: "hub-glow-a" }),
        s("stop", { offset: "72%", class: "hub-glow-b" }),
      ),
      s(
        "radialGradient",
        { id: "hubPlanetSheen", cx: "34%", cy: "28%", r: "78%" },
        s("stop", { offset: "0%", class: "hub-sheen-a" }),
        s("stop", { offset: "100%", class: "hub-sheen-b" }),
      ),
    ),
  )

  for (const space of layout.spaces) {
    svg.appendChild(buildSpace(space))
  }
  return svg
}

function buildSpace(space: SpaceNode): SVGGElement {
  const g = s("g", {
    class: `space${space.focused ? " focused" : ""}`,
    "data-window-id": space.windowId,
  })
  const { x, y, w, h } = space.rect

  g.appendChild(s("rect", { class: "space-bg", x, y, width: w, height: h, rx: 20 }))
  g.appendChild(s("rect", { class: "space-glow", x, y, width: w, height: h, rx: 20, fill: "url(#hubSpaceGlow)" }))

  for (const dot of space.dots) {
    const c = s("circle", { class: "space-dot", cx: dot.x, cy: dot.y, r: dot.r })
    c.style.setProperty("opacity", String(dot.o))
    g.appendChild(c)
  }

  g.appendChild(
    s("text", { class: "space-title", x: x + SPACE_PAD, y: y + 27 }, space.title),
  )
  g.appendChild(
    s(
      "text",
      { class: "space-meta", x: x + w - SPACE_PAD, y: y + 27, "text-anchor": "end" },
      `${plural(space.planets.reduce((n, p) => n + p.stars.length, 0), "tab")} · window ${space.windowId}${
        space.focused ? " · focused" : ""
      }`,
    ),
  )

  /*
   * A space with nothing drawable used to render as a large blank card, which
   * reads as a broken surface rather than an empty one. Say why it is empty.
   */
  const drawn = space.planets.reduce((n, p) => n + p.stars.length, 0)
  if (drawn === 0) {
    g.appendChild(
      s(
        "text",
        { class: "space-empty", x: x + w / 2, y: y + SPACE_HEADER + 36, "text-anchor": "middle" },
        "Nothing to draw yet — browser and extension pages are never grouped.",
      ),
    )
  }

  for (const planet of space.planets) {
    g.appendChild(buildPlanet(planet))
  }
  return g
}

function buildPlanet(planet: PlanetNode): SVGGElement {
  const n = planet.stars.length
  const g = s("g", {
    class: `planet${planet.groupId === UNGROUPED ? " unassigned" : ""}${planet.collapsed ? " collapsed" : ""}`,
    "data-group-id": planet.groupId,
    "data-window-id": planet.windowId,
    // reachable and operable without a pointer, like the stars it holds
    role: "button",
    tabindex: 0,
    "aria-label": `${planet.title}, ${n} ${n === 1 ? "tab" : "tabs"}, ${planet.collapsed ? "collapsed" : "expanded"}. Press Enter to ${planet.collapsed ? "expand" : "collapse"}.`,
    "aria-expanded": String(!planet.collapsed),
  })
  setVar(g, "--planet-color", planet.color ? COLOR_HEX[planet.color] : "var(--faint)")

  g.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    e.stopPropagation()
    toggleGroupCollapsed(planet.groupId)
  })

  const { center, radius, outer } = planet

  /* orbit rings */
  const ringRadii = new Set<number>()
  for (const star of planet.stars) {
    const d = distance(star.center, center)
    if (d > radius + 1) ringRadii.add(Math.round(d * 10) / 10)
  }
  for (const r of ringRadii) {
    g.appendChild(s("circle", { class: "orbit-ring", cx: center.x, cy: center.y, r }))
  }

  /* hit / drop halo */
  g.appendChild(s("circle", { class: "planet-halo", cx: center.x, cy: center.y, r: outer }))

  /* body */
  g.appendChild(s("circle", { class: "planet-body", cx: center.x, cy: center.y, r: radius }))
  g.appendChild(
    s("circle", { class: "planet-sheen", cx: center.x, cy: center.y, r: radius, fill: "url(#hubPlanetSheen)" }),
  )

  /* the tab count reads inside the body; the group name sits under it, where
     there is real horizontal room, instead of being crushed into the circle */
  g.appendChild(
    s(
      "text",
      {
        class: "planet-count",
        x: center.x,
        y: center.y + Math.max(4, radius * 0.16),
        "text-anchor": "middle",
        "font-size": String(clamp(radius * 0.62, 11, 21).toFixed(1)),
      },
      String(planet.stars.length),
    ),
  )
  g.appendChild(
    s(
      "text",
      { class: "planet-name", x: center.x, y: center.y + radius + 16, "text-anchor": "middle" },
      truncateLabel(planet.title, LABEL_MAX),
    ),
  )
  const sub = planet.collapsed ? "collapsed" : planet.color ? "" : "no group"
  if (sub) {
    g.appendChild(
      s(
        "text",
        { class: "planet-sub", x: center.x, y: center.y + radius + 29, "text-anchor": "middle" },
        sub,
      ),
    )
  }

  if (planet.collapsed) {
    g.appendChild(
      s("circle", { class: "planet-collapsed-ring", cx: center.x, cy: center.y, r: radius + 5 }),
    )
  } else {
    for (const star of planet.stars) {
      g.appendChild(buildStar(star, planet))
    }
  }
  return g
}

function buildStar(star: StarNode, planet: PlanetNode): SVGGElement {
  const tab = star.tab
  const label = displayTitle(tab)
  const host = hostOf(tab.url)
  const g = s("g", {
    class: `star${tab.active ? " active" : ""}${tab.pinned ? " pinned" : ""}${tab.discarded ? " discarded" : ""}`,
    "data-tab-id": tab.id,
    "data-group-id": planet.groupId,
    "data-window-id": planet.windowId,
    transform: `translate(${star.center.x} ${star.center.y})`,
    // The universe is drawn in SVG, so without these a keyboard or screen
    // reader user cannot reach an individual tab at all.
    role: "button",
    tabindex: 0,
    "aria-label": `${label} - ${host}${tab.pinned ? ", pinned" : ""}${tab.active ? ", current tab" : ""}. Press Enter to open.`,
  })
  setVar(g, "--planet-color", planet.color ? COLOR_HEX[planet.color] : "var(--faint)")

  g.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    e.stopPropagation()
    void activateTab(tab.id)
  })
  g.addEventListener("focus", () => {
    // keep the focused star in view when tabbing through a large universe
    g.scrollIntoView({ block: "nearest", inline: "nearest" })
  })

  g.appendChild(s("circle", { class: "star-body", cx: 0, cy: 0, r: star.r }))

  const iconUrl = safeIconUrl(tab.favIconUrl)
  if (iconUrl) {
    g.appendChild(
      s("image", {
        class: "star-img",
        href: iconUrl,
        x: -5,
        y: -5,
        width: 10,
        height: 10,
        preserveAspectRatio: "xMidYMid meet",
      }),
    )
  } else {
    g.appendChild(s("text", { class: "star-letter", x: 0, y: 3.4, "text-anchor": "middle" }, letterOf(tab.url)))
  }

  g.appendChild(s("circle", { class: "star-ring", cx: 0, cy: 0, r: star.r }))
  if (tab.pinned) g.appendChild(s("circle", { class: "star-pin", cx: star.r - 2.5, cy: -star.r + 2.5, r: 2.6 }))
  return g
}

/* ---- search-driven classes ---- */

function applySearchClasses(): void {
  const layout = state.layout
  if (!layout) return
  const query = state.search.trim()
  const svg = els.stage.querySelector(".universe")
  if (!svg) return

  // One match set drives the stars, the planets and the results panel, so a
  // group-name hit lights up the same tabs the panel lists.
  const matched = new Set(matchingTabs().map((t) => t.id))

  for (const star of layout.stars) {
    const el = svg.querySelector(`[data-tab-id="${star.tab.id}"]`)
    if (!el) continue
    const isMatch = query.length > 0 && matched.has(star.tab.id)
    el.classList.toggle("match", isMatch)
    el.classList.toggle("dim", query.length > 0 && !isMatch)
    el.classList.toggle("selected", state.selected.has(star.tab.id))
  }

  for (const space of layout.spaces) {
    for (const planet of space.planets) {
      const el = svg.querySelector(
        `.planet[data-group-id="${planet.groupId}"][data-window-id="${planet.windowId}"]`,
      )
      if (!el) continue
      const nameHit = groupMatches(planet.title, query)
      const starHit = planet.stars.some((st) => matched.has(st.tab.id))
      el.classList.toggle("match", query.length > 0 && (nameHit || starHit))
    }
  }
}

function refreshSelectionClasses(): void {
  const svg = els.stage.querySelector(".universe")
  if (!svg) return
  for (const el of svg.querySelectorAll<SVGGElement>(".star")) {
    el.classList.toggle("selected", state.selected.has(Number(el.dataset.tabId)))
  }
}

/* ---- selection toolbar ---- */

function renderSelbar(): void {
  const count = state.selected.size
  els.selbar.classList.toggle("hidden", count === 0)
  if (count === 0) {
    clear(els.selbar)
    return
  }
  clear(els.selbar)

  const hub = state.hub
  const ids = [...state.selected]
  const first = hub?.tabs.find((t) => t.id === ids[0])
  const windowId = first?.windowId ?? hub?.windows[0]?.id ?? -1

  const groupSelect = h("select", { class: "select hub-selbar-select", "aria-label": "Move to group" })
  groupSelect.appendChild(h("option", { value: "", text: "Move to group…" }))
  groupSelect.appendChild(h("option", { value: "none", text: "Ungroup" }))
  for (const g of hub?.groups.filter((g) => g.windowId === windowId) ?? []) {
    groupSelect.appendChild(h("option", { value: String(g.id), text: g.title || "Untitled group" }))
  }
  groupSelect.addEventListener("change", () => {
    const v = groupSelect.value
    groupSelect.value = ""
    if (!v) return
    void moveTabs(ids, v === "none" ? null : Number(v), windowId)
  })

  const windowSelect = h("select", { class: "select hub-selbar-select", "aria-label": "Move to window" })
  windowSelect.appendChild(h("option", { value: "", text: "Move to window…" }))
  for (const w of hub?.windows ?? []) {
    windowSelect.appendChild(h("option", { value: String(w.id), text: `Space · window ${w.id}` }))
  }
  windowSelect.addEventListener("change", () => {
    const v = windowSelect.value
    windowSelect.value = ""
    if (!v) return
    void moveTabs(ids, null, Number(v))
  })

  els.selbar.append(
    h("span", { class: "hub-selbar-count", text: `${plural(count, "tab")} selected` }),
    groupSelect,
    windowSelect,
    h(
      "button",
      { class: "btn btn-sm", type: "button", on: { click: () => void createGroupFromSelection(ids, windowId) } },
      icon("plus", 13),
      h("span", { text: "New group" }),
    ),
    h(
      "button",
      { class: "btn btn-sm btn-danger", type: "button", on: { click: () => void closeTabs(ids) } },
      icon("trash", 13),
      h("span", { text: "Recycle" }),
    ),
    h(
      "button",
      { class: "btn btn-sm btn-ghost", type: "button", on: { click: () => clearSelection() } },
      h("span", { text: "Clear" }),
    ),
  )
}

/* ---- search results ---- */

/**
 * The reference's Hub search is "Search open tabs or the web" — it falls through
 * to a web search when nothing local matches. This is that fall-through, offered
 * explicitly so it is a choice rather than something that happens behind you.
 */
function webSearchRow(query: string): HTMLElement {
  const q = query.trim()
  return h(
    "button",
    {
      class: "btn btn-sm hub-websearch",
      type: "button",
      title: `Search the web for "${q}"`,
      on: {
        click: () => {
          void chrome.tabs.create({
            url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
            active: true,
          })
        },
      },
    },
    icon("search", 13),
    h("span", { text: `Search the web for “${q.slice(0, 40)}”` }),
  )
}

function renderResults(): void {
  const query = state.search.trim()
  const matches = matchingTabs()
  els.results.classList.toggle("hidden", query.length === 0)
  clear(els.results)
  if (!query) return

  els.results.appendChild(
    h(
      "div",
      { class: "hub-results-head" },
      h("span", { class: "hub-panel-title", text: "Matches" }),
      h("span", { class: "badge", text: String(matches.length) }),
    ),
  )

  if (matches.length === 0) {
    els.results.appendChild(
      h("div", { class: "empty small" }, icon("search", 20), h("span", { text: "No tabs match that." })),
    )
    els.results.appendChild(webSearchRow(query))
    return
  }

  const list = h("div", { class: "hub-results-list" })
  for (const tab of matches.slice(0, 80)) {
    const planet = state.layout?.spaces
      .flatMap((sp) => sp.planets)
      .find((p) => p.stars.some((st) => st.tab.id === tab.id))

    const row = h(
      "button",
      {
        class: "hub-result",
        type: "button",
        title: tab.url,
        on: {
          click: () => void activateTab(tab.id),
          pointerenter: () => {
            state.previewTabId = tab.id
            renderPreview()
          },
          pointerleave: () => {
            state.previewTabId = null
            renderPreview()
          },
        },
      },
      favicon(tab.url, tab.favIconUrl, 16),
      h(
        "span",
        { class: "col grow" },
        h("span", { class: "hub-result-title truncate" }, highlightText(displayTitle(tab), query)),
        h(
          "span",
          { class: "small faint truncate" },
          highlightText(hostOf(tab.url), query),
          planet ? ` · ${planet.title}` : "",
        ),
      ),
      h("span", { class: "small faint nowrap", text: timeAgo(tab.lastAccess) }),
    )
    list.appendChild(row)
  }
  els.results.appendChild(list)
}

/* ---- overlay: preview + group popover ---- */

function renderPreview(): void {
  const overlay = els.overlay
  if (!overlay) return
  overlay.querySelector(".hub-preview")?.remove()
  const tabId = state.previewTabId
  if (tabId === null) return
  const star = starById(tabId)
  if (!star) return
  const tab = star.tab
  const query = state.search.trim()

  const card = h(
    "div",
    { class: "hub-preview card" },
    h(
      "div",
      { class: "hub-preview-head" },
      favicon(tab.url, tab.favIconUrl, 18),
      h(
        "div",
        { class: "col grow" },
        h("div", { class: "hub-preview-title" }, highlightText(displayTitle(tab), query)),
        h("div", { class: "small muted truncate", text: hostOf(tab.url) || tab.url }),
      ),
    ),
    h("div", { class: "hub-preview-url mono small", text: tab.url }),
    h(
      "div",
      { class: "hub-preview-meta small muted" },
      h("span", { class: "row gap-4" }, icon("clock", 12), h("span", { text: timeAgo(tab.lastAccess) })),
      h("span", { class: "faint nowrap", text: absoluteTime(tab.lastAccess) }),
      h("span", { class: "row gap-4" }, icon("eye", 12), h("span", { text: plural(tab.accessHistory.length, "visit") })),
      tab.pinned ? h("span", { class: "row gap-4" }, icon("pin", 12), h("span", { text: "Pinned" })) : null,
      tab.audible ? h("span", { class: "row gap-4" }, icon("zap", 12), h("span", { text: "Playing" })) : null,
    ),
    h(
      "div",
      { class: "hub-preview-shot" },
      h(
        "div",
        { class: "hub-preview-shot-empty" },
        icon("eye", 20),
        h("span", { text: PREVIEW_PLACEHOLDER }),
      ),
    ),
    h(
      "div",
      { class: "hub-preview-foot" },
      h("span", { class: "small faint", text: groupTitle(star.tab.groupId) }),
      h(
        "button",
        { class: "btn btn-sm", type: "button", on: { click: () => void activateTab(tab.id) } },
        icon("external-link", 12),
        h("span", { text: "Open" }),
      ),
    ),
  )

  overlay.appendChild(card)

  const bounds = state.layout
  const cardRect = card.getBoundingClientRect()
  const maxX = (bounds?.width ?? 900) - cardRect.width - 10
  const maxY = (bounds?.height ?? 600) - cardRect.height - 10
  const left = clamp(star.center.x + 22, 10, Math.max(10, maxX))
  const top = clamp(star.center.y - cardRect.height / 2, 10, Math.max(10, maxY))
  card.style.left = `${left}px`
  card.style.top = `${top}px`
}

function renderPopover(): void {
  const overlay = els.overlay
  if (!overlay) return
  overlay.querySelector(".hub-popover")?.remove()
  const active = state.activeGroup
  if (!active) return
  const planet = state.layout?.spaces
    .flatMap((sp) => sp.planets)
    .find((p) => p.groupId === active.groupId && p.windowId === active.windowId)
  if (!planet) return

  const isReal = planet.groupId !== UNGROUPED
  const current = planet.color

  const swatches = h("div", { class: "hub-swatches" })
  if (isReal) {
    for (const color of GROUP_COLORS) {
      const swatch = h("button", {
        class: `hub-swatch${color === current ? " active" : ""}`,
        type: "button",
        title: color,
        "aria-label": `Set group colour to ${color}`,
        on: { click: () => void setGroupColor(planet.groupId, color) },
      })
      setVar(swatch, "--sw", COLOR_HEX[color])
      swatches.appendChild(swatch)
    }
  }

  const pop = h(
    "div",
    { class: "hub-popover card" },
    h(
      "div",
      { class: "hub-popover-head" },
      h("span", { class: "group-dot" }),
      h("span", { class: "hub-popover-title truncate", text: planet.title }),
      iconBtn("x", "Close", () => closePopover(), "btn btn-icon btn-sm"),
    ),
    h("div", { class: "small faint", text: `${plural(planet.stars.length, "tab")} · window ${planet.windowId}` }),
    isReal
      ? h(
          "div",
          { class: "hub-popover-actions" },
          h(
            "button",
            { class: "btn btn-sm btn-block", type: "button", on: { click: () => void renameGroup(planet.groupId, planet.title) } },
            icon("wand", 13),
            h("span", { text: "Rename group" }),
          ),
          h(
            "button",
            {
              class: "btn btn-sm btn-block",
              type: "button",
              on: { click: () => toggleGroupCollapsed(planet.groupId) },
            },
            icon(planet.collapsed ? "chevron-right" : "chevron-down", 13),
            h("span", { text: planet.collapsed ? "Expand in hub" : "Collapse in hub" }),
          ),
          h(
            "button",
            {
              class: "btn btn-sm btn-block",
              type: "button",
              on: { click: () => void ungroupPlanet(planet) },
            },
            icon("archive", 13),
            h("span", { text: "Ungroup tabs" }),
          ),
          h(
            "button",
            {
              class: "btn btn-sm btn-block btn-danger",
              type: "button",
              on: { click: () => void removeGroup(planet.groupId) },
            },
            icon("trash", 13),
            h("span", { text: "Delete group" }),
          ),
        )
      : h("div", { class: "small faint", text: "Free-floating tabs are not in a Chrome group yet." }),
    isReal ? swatches : null,
  )
  setVar(pop, "--planet-color", planet.color ? COLOR_HEX[planet.color] : "var(--faint)")

  overlay.appendChild(pop)

  const cardRect = pop.getBoundingClientRect()
  const maxX = (state.layout?.width ?? 900) - cardRect.width - 10
  const maxY = (state.layout?.height ?? 600) - cardRect.height - 10
  pop.style.left = `${clamp(planet.center.x + planet.outer + 8, 10, Math.max(10, maxX))}px`
  pop.style.top = `${clamp(planet.center.y - cardRect.height / 2, 10, Math.max(10, maxY))}px`
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

function chromeAvailable(): boolean {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id
  } catch {
    return false
  }
}

async function refresh(): Promise<void> {
  if (!chromeAvailable()) {
    state.status = "error"
    state.error = "Chrome extension APIs are not available on this page."
    render()
    return
  }

  const hubRes = await send<HubState>({ type: "GET_HUB_STATE" })
  if (!hubRes.ok || !hubRes.data) {
    state.status = "error"
    state.error = hubRes.error ?? "The background worker returned no state."
    render()
    return
  }
  state.hub = hubRes.data
  state.status = "ready"

  // The Organization Score counts a renamed tab as organized, so the custom
  // titles have to come in with the rest of the state.
  try {
    const s = await send<{ customTabTitles?: Record<string, string> }>({ type: "GET_SETTINGS" })
    state.renamedIds = new Set(
      Object.keys(s.data?.customTabTitles ?? {})
        .map(Number)
        .filter((n) => Number.isFinite(n)),
    )
  } catch {
    state.renamedIds = new Set()
  }

  // Ask Chrome which window this page is in. Cheaper and more reliable than
  // trusting a `focused` flag that may predate the last window change.
  try {
    const w = await chrome.windows.getCurrent()
    state.selfWindowId = w.id ?? null
  } catch {
    state.selfWindowId = null
  }

  // On the first load, mirror the collapse state Chrome already has so the
  // hub opens looking like the tab strip it represents.
  if (!state.seeded) {
    state.seeded = true
    const collapsed = state.hub.groups.filter((g) => g.collapsed).map((g) => g.id)
    if (collapsed.length > 0) {
      state.collapsedGroups = new Set(collapsed)
      writeCollapsedGroups(state.collapsedGroups)
    }
  }

  const recycleRes = await send<RecycleEntry[]>({ type: "RECYCLE_LIST" })
  state.recycle = recycleRes.ok && Array.isArray(recycleRes.data) ? recycleRes.data : []

  // Drop selections that no longer exist.
  const live = new Set(state.hub.tabs.map((t) => t.id))
  for (const id of [...state.selected]) if (!live.has(id)) state.selected.delete(id)

  render()
}

const scheduleRefresh = debounce(() => void refresh(), 350)

function watchChrome(): void {
  if (!chromeAvailable()) return
  try {
    chrome.tabs.onCreated.addListener(scheduleRefresh)
    chrome.tabs.onRemoved.addListener(scheduleRefresh)
    chrome.tabs.onMoved.addListener(scheduleRefresh)
    chrome.tabs.onUpdated.addListener(scheduleRefresh)
    chrome.tabs.onAttached.addListener(scheduleRefresh)
    chrome.tabs.onDetached.addListener(scheduleRefresh)
    chrome.tabs.onActivated.addListener(scheduleRefresh)
    chrome.windows.onFocusChanged.addListener(scheduleRefresh)
    chrome.tabGroups.onUpdated.addListener(scheduleRefresh)
    chrome.tabGroups.onCreated.addListener(scheduleRefresh)
    chrome.tabGroups.onRemoved.addListener(scheduleRefresh)
    chrome.tabGroups.onMoved.addListener(scheduleRefresh)
  } catch {
    /* not every surface exposes every event; a manual refresh still works */
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function run(msg: Message, okMsg?: string): Promise<boolean> {
  const res = await send(msg)
  if (!res.ok) {
    toast(res.error ?? "That did not work", "err")
    return false
  }
  if (okMsg) toast(okMsg, "ok")
  return true
}

async function activateTab(tabId: TabId): Promise<void> {
  await run({ type: "OPEN_TAB", tabId })
}

async function moveTabs(
  ids: TabId[],
  targetGroupId: GroupId | null,
  targetWindowId?: WindowId,
): Promise<void> {
  if (ids.length === 0) return
  const ok = await run({ type: "MOVE_TABS", tabIds: ids, targetGroupId, targetWindowId })
  if (!ok) return
  state.selected.clear()
  await refresh()
  toast(
    targetGroupId === null
      ? `Ungrouped ${plural(ids.length, "tab")}`
      : `Moved ${plural(ids.length, "tab")} to ${groupTitle(targetGroupId)}`,
    "ok",
  )
}

async function closeTabs(ids: TabId[]): Promise<void> {
  if (ids.length === 0) return
  const ok = await run({ type: "CLOSE_TABS", tabIds: ids }, `Recycled ${plural(ids.length, "tab")}`)
  if (!ok) return
  state.selected.clear()
  state.previewTabId = null
  await refresh()
}

async function createGroupFromSelection(ids: TabId[], windowId: WindowId): Promise<void> {
  const name = await promptModal({
    title: "New group",
    label: "Group name",
    placeholder: "e.g. Research",
    confirmText: "Create group",
  })
  if (!name) return
  const ok = await run({ type: "CREATE_GROUP", windowId, title: name, tabIds: ids })
  if (!ok) return
  state.selected.clear()
  await refresh()
  toast(`Created “${name}”`, "ok")
}

async function renameGroup(groupId: GroupId, current: string): Promise<void> {
  const name = await promptModal({
    title: "Rename group",
    label: "Group name",
    value: current,
    confirmText: "Rename",
  })
  if (!name || name === current) return
  const ok = await run({ type: "UPDATE_GROUP", groupId, title: name })
  if (!ok) return
  await refresh()
  toast(`Renamed to “${name}”`, "ok")
}

async function setGroupColor(groupId: GroupId, color: GroupColor): Promise<void> {
  const ok = await run({ type: "UPDATE_GROUP", groupId, color })
  if (!ok) return
  await refresh()
  renderPopover()
}

async function ungroupPlanet(planet: PlanetNode): Promise<void> {
  if (planet.groupId === UNGROUPED) return
  const ids = planet.stars.map((st) => st.tab.id)
  const ok = await run({ type: "MOVE_TABS", tabIds: ids, targetGroupId: null })
  if (!ok) return
  closePopover()
  await refresh()
  toast(`Ungrouped ${plural(ids.length, "tab")}`, "ok")
}

async function removeGroup(groupId: GroupId): Promise<void> {
  const confirmed = await modal({
    title: "Delete this group?",
    body: "The tabs stay open and become free-floating. Nothing is closed.",
    confirmText: "Delete group",
    danger: true,
  })
  if (!confirmed) return
  const ok = await run({ type: "DELETE_GROUP", groupId, closeTabs: false })
  if (!ok) return
  closePopover()
  await refresh()
  toast("Group deleted", "ok")
}

async function restoreRecycle(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const ok = await run({ type: "RECYCLE_RESTORE", ids }, `Restored ${plural(ids.length, "tab")}`)
  if (!ok) return
  await refresh()
}

async function clearRecycle(): Promise<void> {
  const confirmed = await modal({
    title: "Empty the recycle bin?",
    body: "Recycled tabs will be gone for good. This cannot be undone.",
    confirmText: "Empty bin",
    danger: true,
  })
  if (!confirmed) return
  const ok = await run({ type: "RECYCLE_CLEAR" }, "Recycle bin emptied")
  if (!ok) return
  await refresh()
}

async function organizeNow(): Promise<void> {
  els.statLine.textContent = "Organizing…"
  const ok = await run({ type: "ORGANIZE" })
  if (!ok) return
  await refresh()
}

async function reorderGroups(): Promise<void> {
  const ok = await run({ type: "REORDER_GROUPS" }, "Group order matched to the tab strip")
  if (!ok) return
  await refresh()
}

/**
 * Pulls every tab from every window into the focused one.
 *
 * Distinct from organizing with `scope: all_windows`: no classifier runs, no
 * groups are touched, and the tabs keep their relative order. Confirms first,
 * because collapsing several windows is not something to do by accident.
 */
async function mergeWindows(): Promise<void> {
  const windows = state.hub?.windows ?? []
  if (windows.length <= 1) {
    toast("There is only one window open.", "warn")
    return
  }

  const total = state.hub?.tabs.length ?? 0
  const confirmed = await modal({
    title: "Combine windows",
    body: `Move all ${plural(total, "tab")} from ${plural(windows.length, "window")} into one window. Undo will put them back.`,
    confirmText: "Combine",
  })
  if (!confirmed) return

  const ok = await run({ type: "MERGE_WINDOWS" })
  if (!ok) return
  await refresh()
  toast("Windows combined", "ok")
}

/** Reverses the last pass, whatever produced it. */
async function undoLastPass(): Promise<void> {
  const res = await send<{ restoredTabs: number; reopenedTabs: number }>({ type: "UNDO" })
  if (!res.ok) {
    toast(res.error ?? "Nothing to undo yet", "warn")
    return
  }
  await refresh()
  const reopened = res.data?.reopenedTabs ?? 0
  toast(reopened > 0 ? `Undone, ${plural(reopened, "tab")} reopened` : "Undone", "ok")
}

/** True when a group should be drawn as collapsed in the hub. */
function isCollapsed(groupId: GroupId): boolean {
  return state.collapsedGroups.has(groupId)
}

async function toggleCollapseAll(): Promise<void> {
  const hub = state.hub
  const groups = hub?.groups ?? []
  if (groups.length === 0) return
  const allCollapsed = groups.every((g) => isCollapsed(g.id))
  const next = !allCollapsed
  const ok = await run(
    { type: "TOGGLE_COLLAPSE", collapsed: next },
    next ? "Groups collapsed" : "Groups expanded",
  )
  if (!ok) return
  // Keep the hub's own view in step with what we just asked Chrome to do.
  state.collapsedGroups = next ? new Set(groups.map((g) => g.id)) : new Set()
  writeCollapsedGroups(state.collapsedGroups)
  await refresh()
}

function toggleGroupCollapsed(groupId: GroupId): void {
  if (state.collapsedGroups.has(groupId)) state.collapsedGroups.delete(groupId)
  else state.collapsedGroups.add(groupId)
  writeCollapsedGroups(state.collapsedGroups)
  renderCanvas()
  renderPopover()
}

function toggleSidebar(): void {
  state.sidebarCollapsed = !state.sidebarCollapsed
  writeFlag(SIDEBAR_KEY, state.sidebarCollapsed)
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed)
  window.setTimeout(() => remeasure(), 200)
}

function closePopover(): void {
  state.activeGroup = null
  renderPopover()
}

function clearSelection(): void {
  state.selected.clear()
  refreshSelectionClasses()
  renderSelbar()
}

function scrollToSpace(windowId: WindowId): void {
  const space = state.layout?.spaces.find((sp) => sp.windowId === windowId)
  if (!space) return
  els.canvasWrap.scrollTo({ top: Math.max(0, space.rect.y - 12), behavior: "smooth" })
}

/* ---- the window picker used by the Teleport drop zone ---- */

async function pickWindowAndMove(ids: TabId[]): Promise<void> {
  if (ids.length === 0) return
  const windows = state.hub?.windows ?? []
  if (windows.length <= 1) {
    toast("There is only one window open.", "warn")
    return
  }
  const select = h("select", { class: "select" })
  for (const w of windows) {
    const count = state.hub?.tabs.filter((t) => t.windowId === w.id).length ?? 0
    select.appendChild(
      h("option", {
        value: String(w.id),
        text: `Window ${w.id} — ${plural(count, "tab")}${w.focused ? " (focused)" : ""}`,
      }),
    )
  }
  await modal({
    title: "Teleport tabs",
    body: h(
      "div",
      { class: "field" },
      h("label", { class: "label", text: `Destination for ${plural(ids.length, "tab")}` }),
      select,
    ),
    confirmText: "Teleport",
    onConfirm: async () => {
      const target = Number(select.value)
      const res = await send({ type: "MOVE_TABS", tabIds: ids, targetGroupId: null, targetWindowId: target })
      if (!res.ok) throw new Error(res.error ?? "Move failed")
      state.selected.clear()
      await refresh()
    },
  })
}

/* ------------------------------------------------------------------ */
/* Interaction: drag, marquee, hover                                   */
/* ------------------------------------------------------------------ */

let pending: PendingDrag | null = null
let marquee: MarqueeState | null = null
const ghost = h("div", { class: "hub-ghost hidden" })

function toContent(clientX: number, clientY: number): Point {
  const rect = els.canvasWrap.getBoundingClientRect()
  return {
    x: clientX - rect.left + els.canvasWrap.scrollLeft,
    y: clientY - rect.top + els.canvasWrap.scrollTop,
  }
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  const target = e.target
  if (!(target instanceof Element)) return
  if (target.closest(".hub-overlay, .hub-results, .hub-dock, .hub-selbar")) return

  const point = toContent(e.clientX, e.clientY)
  const starEl = target.closest("[data-tab-id]")

  if (starEl) {
    const tabId = Number(starEl.getAttribute("data-tab-id"))
    const ids = state.selected.has(tabId) && state.selected.size > 1 ? [...state.selected] : [tabId]
    pending = { tabIds: ids, origin: point, moved: false }
    return
  }

  const planetEl = target.closest("[data-group-id]")
  if (planetEl) {
    // Click on the planet body opens the group popover; handled on pointerup.
    pending = { tabIds: [], origin: point, moved: false }
    return
  }

  // Empty canvas -> marquee.
  marquee = {
    origin: point,
    base: e.shiftKey || e.metaKey || e.ctrlKey ? new Set(state.selected) : new Set(),
    additive: e.shiftKey || e.metaKey || e.ctrlKey,
    active: true,
  }
  if (!marquee.additive) {
    state.selected.clear()
    refreshSelectionClasses()
  }
  marqueeRect.setAttribute("x", String(point.x))
  marqueeRect.setAttribute("y", String(point.y))
  marqueeRect.setAttribute("width", "0")
  marqueeRect.setAttribute("height", "0")
  marqueeRect.classList.add("on")
  e.preventDefault()
}

function onPointerMove(e: PointerEvent): void {
  const point = toContent(e.clientX, e.clientY)

  if (marquee) {
    const rect: Rect = {
      x: Math.min(marquee.origin.x, point.x),
      y: Math.min(marquee.origin.y, point.y),
      w: Math.abs(point.x - marquee.origin.x),
      h: Math.abs(point.y - marquee.origin.y),
    }
    marqueeRect.setAttribute("x", String(rect.x))
    marqueeRect.setAttribute("y", String(rect.y))
    marqueeRect.setAttribute("width", String(rect.w))
    marqueeRect.setAttribute("height", String(rect.h))
    applyMarquee(rect)
    return
  }

  if (pending && !pending.moved) {
    if (distance(pending.origin, point) < DRAG_THRESHOLD) return
    pending.moved = true
    beginDrag(pending.tabIds, point)
    pending = null
  }

  if (state.drag) {
    state.drag.pointer = point
    updateDragTargets(e.clientX, e.clientY, point)
    positionGhost(e.clientX, e.clientY)
  }
}

function onPointerUp(e: PointerEvent): void {
  if (marquee) {
    marquee.active = false
    marqueeRect.classList.remove("on")
    marquee = null
    renderSelbar()
    return
  }

  if (state.drag) {
    const drag = state.drag
    endDrag()
    void applyDrop(drag)
    return
  }

  if (pending) {
    const p = pending
    pending = null
    if (p.tabIds.length === 1) {
      void activateTab(p.tabIds[0])
    } else {
      const planetEl = (e.target instanceof Element ? e.target : null)?.closest("[data-group-id]")
      if (planetEl) {
        const groupId = Number(planetEl.getAttribute("data-group-id"))
        const windowId = Number(planetEl.getAttribute("data-window-id"))
        state.activeGroup =
          state.activeGroup?.groupId === groupId && state.activeGroup.windowId === windowId
            ? null
            : { groupId, windowId }
        renderPopover()
      }
    }
  }
}

function applyMarquee(rect: Rect): void {
  const layout = state.layout
  if (!layout || !marquee) return
  const next = new Set(marquee.additive ? marquee.base : [])
  for (const star of layout.stars) {
    if (circleInRect(star.center, star.r + 3, rect)) next.add(star.tab.id)
  }
  state.selected = next
  refreshSelectionClasses()
  els.selbar.classList.toggle("hidden", next.size === 0)
  if (next.size > 0) renderSelbar()
}

function beginDrag(tabIds: TabId[], point: Point): void {
  state.drag = { tabIds, pointer: point, planet: null, windowId: null, zone: null }
  document.body.classList.add("is-dragging")
  state.previewTabId = null
  renderPreview()
  if (!ghost.isConnected) document.body.appendChild(ghost)
  clear(ghost)
  ghost.append(icon("star", 14), h("span", { text: String(tabIds.length) }))
  ghost.classList.remove("hidden")
}

function endDrag(): void {
  state.drag = null
  document.body.classList.remove("is-dragging")
  ghost.classList.add("hidden")
  for (const el of els.stage.querySelectorAll(".drop-hover")) el.classList.remove("drop-hover")
  els.dockMove.classList.remove("over")
  els.dockRecycle.classList.remove("over")
  els.dock.classList.remove("live")
}

function updateDragTargets(clientX: number, clientY: number, point: Point): void {
  const drag = state.drag
  if (!drag) return

  const moveRect = els.dockMove.getBoundingClientRect()
  const recycleRect = els.dockRecycle.getBoundingClientRect()
  const inMove = pointInRect({ x: clientX, y: clientY }, { x: moveRect.left, y: moveRect.top, w: moveRect.width, h: moveRect.height })
  const inRecycle = pointInRect({ x: clientX, y: clientY }, { x: recycleRect.left, y: recycleRect.top, w: recycleRect.width, h: recycleRect.height })

  drag.zone = inMove ? "move" : inRecycle ? "recycle" : null
  if (drag.zone) {
    drag.planet = null
    drag.windowId = null
  } else {
    const planet = planetAt(point)
    drag.planet = planet ? { windowId: planet.windowId, groupId: planet.groupId } : null
    drag.windowId = planet ? null : spaceAt(point)?.windowId ?? null
  }

  els.dock.classList.add("live")
  for (const el of els.stage.querySelectorAll<SVGGElement>(".planet")) {
    const on =
      !!drag.planet &&
      Number(el.dataset.groupId) === drag.planet.groupId &&
      Number(el.dataset.windowId) === drag.planet.windowId
    el.classList.toggle("drop-hover", on)
  }
  for (const el of els.stage.querySelectorAll<SVGGElement>(".space")) {
    const on = drag.windowId !== null && Number(el.dataset.windowId) === drag.windowId
    el.classList.toggle("drop-hover", on)
  }
  els.dockMove.classList.toggle("over", drag.zone === "move")
  els.dockRecycle.classList.toggle("over", drag.zone === "recycle")
}

function positionGhost(clientX: number, clientY: number): void {
  ghost.style.left = `${clientX + 12}px`
  ghost.style.top = `${clientY + 12}px`
}

async function applyDrop(drag: DragState): Promise<void> {
  const ids = drag.tabIds
  if (ids.length === 0) return
  if (drag.zone === "recycle") return closeTabs(ids)
  if (drag.zone === "move") return pickWindowAndMove(ids)
  if (drag.planet) {
    const target = drag.planet.groupId === UNGROUPED ? null : drag.planet.groupId
    const planet = state.layout?.spaces
      .flatMap((sp) => sp.planets)
      .find((p) => p.groupId === drag.planet?.groupId && p.windowId === drag.planet?.windowId)
    if (planet && ids.every((id) => planet.stars.some((st) => st.tab.id === id))) return
    return moveTabs(ids, target, drag.planet.windowId)
  }
  if (drag.windowId !== null) {
    const space = state.layout?.spaces.find((sp) => sp.windowId === drag.windowId)
    const alreadyLoose =
      space?.planets
        .find((p) => p.groupId === UNGROUPED)
        ?.stars.every((st) => ids.includes(st.tab.id)) ?? false
    if (alreadyLoose) return
    return moveTabs(ids, null, drag.windowId)
  }
}

/* ---- hover preview ---- */

/** The star under a content-space point, if any. */
function starAtPoint(point: Point): StarNode | null {
  const layout = state.layout
  if (!layout) return null
  let best: StarNode | null = null
  let bestDist = Infinity
  for (const star of layout.stars) {
    const d = distance(point, star.center)
    if (d <= star.r + 3 && d < bestDist) {
      best = star
      bestDist = d
    }
  }
  return best
}

function hidePreview(): void {
  if (state.previewTimer) clearTimeout(state.previewTimer)
  state.previewTimer = 0
  if (state.previewTabId === null) return
  state.previewTabId = null
  renderPreview()
}

function attachHover(): void {
  els.canvasWrap.addEventListener("pointermove", (e) => {
    if (state.drag || marquee) return
    const target = e.target
    // Moving onto the card itself must not dismiss it.
    if (target instanceof Element && target.closest(".hub-preview, .hub-popover")) return

    const star = starAtPoint(toContent(e.clientX, e.clientY))
    if (!star) {
      hidePreview()
      return
    }
    if (state.previewTabId === star.tab.id) return

    if (state.previewTimer) clearTimeout(state.previewTimer)
    state.previewTimer = setTimeout(() => {
      state.previewTabId = star.tab.id
      renderPreview()
    }, 170)
  })

  els.canvasWrap.addEventListener("pointerleave", hidePreview)
}

/* ---- keyboard ---- */

function onKeyDown(e: KeyboardEvent): void {
  const tag = document.activeElement?.tagName ?? ""
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"

  if (e.key === "Escape") {
    if (state.search) {
      state.search = ""
      els.searchInput.value = ""
      render()
    } else if (state.activeGroup) {
      closePopover()
    } else if (state.selected.size > 0) {
      clearSelection()
    }
    return
  }
  if (typing) return

  if (e.key === "/" || (e.key === "f" && (e.metaKey || e.ctrlKey))) {
    e.preventDefault()
    els.searchInput.focus()
    els.searchInput.select()
    return
  }
  if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    const q = state.search.trim()
    state.selected = new Set(
      visibleTabs()
        .filter((t) => tabMatches(t, q))
        .map((t) => t.id),
    )
    refreshSelectionClasses()
    renderSelbar()
    return
  }
  if (e.key === "r" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault()
    void refresh()
  }
}

/* ------------------------------------------------------------------ */
/* Resize                                                              */
/* ------------------------------------------------------------------ */

function remeasure(): void {
  const width = els.canvasWrap.clientWidth || state.width
  if (Math.abs(width - state.width) < 8) return
  state.width = width
  if (state.status === "ready" && (state.hub?.tabs.length ?? 0) > 0) renderCanvas()
}

const onResize = debounce(remeasure, 140)

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function wireEvents(): void {
  els.canvasWrap.addEventListener("pointerdown", onPointerDown)
  window.addEventListener("pointermove", onPointerMove)
  window.addEventListener("pointerup", onPointerUp)
  window.addEventListener("keydown", onKeyDown)
  els.canvasWrap.addEventListener("scroll", () => {
    if (state.activeGroup) closePopover()
    if (state.previewTabId !== null) hidePreview()
  })
  els.searchInput.addEventListener("input", () => {
    state.search = els.searchInput.value
    els.searchCount.textContent = state.search.trim() ? `${matchingTabs().length} found` : ""
    applySearchClasses()
    renderResults()
  })
  els.refreshBtn.addEventListener("click", () => void refresh())
  els.collapseBtn.addEventListener("click", () => void toggleCollapseAll())
  els.reorderBtn.addEventListener("click", () => void reorderGroups())
  els.mergeBtn.addEventListener("click", () => void mergeWindows())
  els.undoBtn.addEventListener("click", () => void undoLastPass())
  els.organizeBtn.addEventListener("click", () => void organizeNow())
  attachHover()

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(onResize).observe(els.canvasWrap)
  } else {
    window.addEventListener("resize", onResize)
  }

  window.addEventListener("focus", scheduleRefresh)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleRefresh()
  })

  watchChrome()
}

function boot(): void {
  wireEvents()
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed)
  render()
  void refresh()
}

/**
 * Booting is skipped when there is no DOM, and when a test has explicitly asked
 * for the module's pure geometry without the UI. The flag exists because a DOM
 * shim makes `document` defined, which would otherwise start a real render.
 */
const skipBoot = (globalThis as { __ORBIT_NO_BOOT__?: boolean }).__ORBIT_NO_BOOT__ === true
if (typeof document !== "undefined" && !skipBoot) boot()
