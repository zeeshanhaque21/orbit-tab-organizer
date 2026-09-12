/**
 * Hub layout geometry.
 *
 * Regression tests for the star-overflow bug: `starSlots` used to stop after a
 * fixed number of rings and leave the remainder unplaced, and `computeLayout`
 * fell back to the planet centre. Every star past the cap was stacked on one
 * point - visually merged, and impossible to hit-test individually. A group of
 * 200 tabs silently became 134 distinct stars.
 */
import { beforeAll, describe, expect, it } from "vitest"
import type { GroupColor, HubState, TabRecord } from "../src/shared/types"

/* ------------------------------------------------------------------ */
/* A minimal DOM, so hub.ts can be imported outside a browser          */
/* ------------------------------------------------------------------ */

/**
 * hub.ts builds its SVG shell at module scope, so importing it in Node needs
 * just enough DOM for that to succeed. Only the handful of methods the module
 * actually calls are implemented; anything else throws, so a new DOM dependency
 * surfaces loudly instead of silently passing.
 */
function installDomShim() {
  // dom.ts does `c instanceof Node`, so the stub nodes must be real instances
  class FakeNode {}
  class FakeElement extends FakeNode {}

  const makeNode = (): Record<string, unknown> => {
    const node = new FakeElement() as unknown as Record<string, unknown>
    node.children = []
    node.style = {}
    node.dataset = {}
    node.classList = { add() {}, remove() {}, toggle() {}, contains: () => false }
    node.setAttribute = () => {}
    node.getAttribute = () => null
    node.removeAttribute = () => {}
    node.appendChild = (child: unknown) => {
      ;(node.children as unknown[]).push(child)
      return child
    }
    node.removeChild = () => {}
    node.addEventListener = () => {}
    node.removeEventListener = () => {}
    node.querySelector = () => null
    node.querySelectorAll = () => []
    node.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 })
    node.focus = () => {}
    node.remove = () => {}
    node.textContent = ""
    node.innerHTML = ""
    return node
  }

  const documentStub = {
    createElement: makeNode,
    createElementNS: makeNode,
    createTextNode: makeNode,
    createDocumentFragment: makeNode,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    body: makeNode(),
    documentElement: makeNode(),
    visibilityState: "visible",
  }

  const g = globalThis as unknown as Record<string, unknown>
  g.Node = FakeNode
  g.Element = FakeElement
  g.document = documentStub
  g.window = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    devicePixelRatio: 1,
  }
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.requestAnimationFrame = (g.window as { requestAnimationFrame: unknown }).requestAnimationFrame
  g.cancelAnimationFrame = (g.window as { cancelAnimationFrame: unknown }).cancelAnimationFrame
  g.getComputedStyle = (g.window as { getComputedStyle: unknown }).getComputedStyle
  g.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  }
}

installDomShim()

// ask the module for its geometry without starting the UI
;(globalThis as { __ORBIT_NO_BOOT__?: boolean }).__ORBIT_NO_BOOT__ = true

// imported after the shim, so the module-level DOM work succeeds
const hub = await import("../src/hub")
const { computeLayout, organizationScore, planetRadius, ringCapacity, starPoint, starRadius, starSlots } = hub

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function tab(id: number, groupId: number, windowId = 1): TabRecord {
  const now = Date.now()
  return {
    id,
    windowId,
    url: `https://site${id}.example/p`,
    title: `Tab ${id}`,
    lastAccess: now,
    accessHistory: [now],
    firstSeen: now,
    sessionSwitches: 0,
    groupId,
    pinned: false,
    active: false,
    audible: false,
    discarded: false,
    favIconUrl: "",
  }
}

function hubWith(counts: number[]): HubState {
  const tabs: TabRecord[] = []
  const groups: HubState["groups"] = []
  let id = 1
  counts.forEach((n, gi) => {
    const gid = gi + 1
    groups.push({
      id: gid,
      windowId: 1,
      title: `Group ${gid}`,
      color: "blue" as GroupColor,
      collapsed: false,
    })
    for (let i = 0; i < n; i++) tabs.push(tab(id++, gid))
  })
  return {
    windows: [{ id: 1, focused: true, tabCount: tabs.length }],
    groups,
    tabs,
    canUndo: false,
  }
}

/* ------------------------------------------------------------------ */

describe("starSlots", () => {
  it("returns exactly one slot per star", () => {
    for (const n of [1, 2, 5, 20, 50, 100, 134, 135, 200, 300, 500, 1000]) {
      const slots = starSlots(n, planetRadius(n))
      expect(slots, `count ${n}`).toHaveLength(n)
    }
  })

  it("regression: 200 stars are no longer capped at 134", () => {
    const slots = starSlots(200, planetRadius(200))
    expect(slots.length).toBe(200)
    expect(slots.length).toBeGreaterThan(134)
  })

  it("gives every star a distinct position", () => {
    for (const n of [50, 134, 200, 400]) {
      const r = planetRadius(n)
      const slots = starSlots(n, r)
      const points = slots.map((s) => {
        const p = starPoint({ x: 0, y: 0 }, s.radius, s.index, s.total)
        return `${p.x.toFixed(2)},${p.y.toFixed(2)}`
      })
      expect(new Set(points).size, `count ${n}`).toBe(n)
    }
  })

  it("never places two stars from the same ring on top of each other", () => {
    const slots = starSlots(300, planetRadius(300))
    const byRing = new Map<number, Set<string>>()
    for (const s of slots) {
      const p = starPoint({ x: 0, y: 0 }, s.radius, s.index, s.total)
      const key = `${p.x.toFixed(2)},${p.y.toFixed(2)}`
      const set = byRing.get(s.radius) ?? new Set()
      set.add(key)
      byRing.set(s.radius, set)
    }
    for (const [radius, set] of byRing) {
      const inRing = slots.filter((s) => s.radius === radius).length
      expect(set.size, `ring at ${radius.toFixed(1)}`).toBe(inRing)
    }
  })

  it("handles zero and one without looping forever", () => {
    expect(starSlots(0, 40)).toEqual([])
    expect(starSlots(1, 40)).toHaveLength(1)
  })

  it("keeps the outermost ring within a sane radius for a huge group", () => {
    const slots = starSlots(1000, planetRadius(1000))
    const max = Math.max(...slots.map((s) => s.radius))
    // a 1000-tab group should still be a manageable disc, not a sprawl
    expect(max).toBeLessThan(700)
  })

  it("tightens spacing as the group grows", () => {
    const small = starSlots(10, planetRadius(10))
    const big = starSlots(400, planetRadius(400))
    const smallStep = small[1] ? small[1].radius - small[0].radius : 0
    const bigStep = big[1] ? big[1].radius - big[0].radius : 0
    expect(bigStep).toBeLessThanOrEqual(smallStep)
  })
})

describe("starRadius", () => {
  it("shrinks with the group but never disappears", () => {
    expect(starRadius(0)).toBe(8)
    expect(starRadius(10)).toBeLessThan(8)
    expect(starRadius(1000)).toBeGreaterThanOrEqual(3.5)
  })
})

describe("ringCapacity", () => {
  it("always admits at least one star", () => {
    expect(ringCapacity(0)).toBeGreaterThanOrEqual(1)
    expect(ringCapacity(1)).toBeGreaterThanOrEqual(1)
  })

  it("grows with the radius", () => {
    expect(ringCapacity(200)).toBeGreaterThan(ringCapacity(100))
  })
})

describe("organizationScore", () => {
  it("counts a tab as organized if it is pinned, grouped, or renamed", () => {
    const pinned = tab(1, -1)
    pinned.pinned = true // organized: pinned
    const tabs = [
      pinned,
      tab(2, 7), // organized: in a group
      tab(3, -1), // organized: renamed (via the predicate)
      tab(4, -1), // nothing qualifies
    ]
    const score = organizationScore(tabs, (id) => id === 3)
    expect(score).toEqual({ total: 4, organized: 3, percent: 75 })
  })

  it("reports 0 for an empty set rather than dividing by zero", () => {
    expect(organizationScore([], () => false)).toEqual({ total: 0, organized: 0, percent: 0 })
  })

  it("is 100 when every tab qualifies", () => {
    const pinned = tab(1, -1)
    pinned.pinned = true
    expect(organizationScore([pinned, tab(2, 3)], () => false).percent).toBe(100)
  })

  it("is 0 when nothing qualifies", () => {
    expect(organizationScore([tab(1, -1), tab(2, -1), tab(3, -1)], () => false)).toEqual({
      total: 3,
      organized: 0,
      percent: 0,
    })
  })

  it("rounds to the nearest whole percent", () => {
    const pinned = tab(1, -1)
    pinned.pinned = true
    // 1 of 3 = 33.33 -> 33
    expect(organizationScore([pinned, tab(2, -1), tab(3, -1)], () => false).percent).toBe(33)
    // 2 of 3 = 66.67 -> 67
    expect(organizationScore([pinned, tab(2, 5), tab(3, -1)], () => false).percent).toBe(67)
  })

  it("counts a rename only when the predicate says so", () => {
    const tabs = [tab(1, -1)]
    expect(organizationScore(tabs, () => false).organized).toBe(0)
    expect(organizationScore(tabs, () => true).organized).toBe(1)
  })
})

describe("computeLayout at scale", () => {
  it("gives every tab a star with its own position", () => {
    const hub = hubWith([300])
    const layout = computeLayout(hub, 1440, new Set())
    expect(layout.stars).toHaveLength(300)

    const points = layout.stars.map((s) => `${s.center.x.toFixed(1)},${s.center.y.toFixed(1)}`)
    const distinct = new Set(points).size
    // allow a little slack for two stars on adjacent rings rounding together,
    // but the old build collapsed 166 of 300 onto a single point
    expect(distinct).toBeGreaterThan(295)
  })

  it("regression: no pile-up on the planet centre", () => {
    const hub = hubWith([200])
    const layout = computeLayout(hub, 1440, new Set())
    const planet = layout.spaces[0].planets[0]
    const atCentre = layout.stars.filter(
      (s) =>
        Math.abs(s.center.x - planet.center.x) < 0.5 &&
        Math.abs(s.center.y - planet.center.y) < 0.5,
    )
    expect(atCentre.length).toBe(0)
  })

  it("keeps every tab across several groups", () => {
    const hub = hubWith([150, 150, 50])
    const layout = computeLayout(hub, 1440, new Set())
    expect(layout.stars).toHaveLength(350)
  })

  it("draws no stars for a collapsed group", () => {
    const hub = hubWith([40])
    const layout = computeLayout(hub, 1440, new Set([1]))
    expect(layout.stars).toHaveLength(0)
    expect(layout.spaces[0].planets[0].collapsed).toBe(true)
  })

  it("reports a canvas tall enough for what it laid out", () => {
    const hub = hubWith([100, 100])
    const layout = computeLayout(hub, 1440, new Set())
    const bottom = Math.max(
      ...layout.spaces.map((s) => s.rect.y + s.rect.h),
    )
    expect(layout.height).toBeGreaterThanOrEqual(bottom)
  })
})
