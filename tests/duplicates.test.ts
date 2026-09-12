import { describe, expect, it } from "vitest"
import { findDuplicates } from "../src/background/duplicates"
import { normalizeUrl } from "../src/shared/format"
import { rec } from "./helpers"

describe("normalizeUrl", () => {
  it("drops the fragment", () => {
    expect(normalizeUrl("https://a.com/page#section")).toBe("https://a.com/page")
  })

  it("removes tracking parameters", () => {
    expect(normalizeUrl("https://a.com/p?utm_source=nl&utm_campaign=x&id=7")).toBe(
      "https://a.com/p?id=7",
    )
  })

  it("sorts the remaining parameters so order does not matter", () => {
    expect(normalizeUrl("https://a.com/p?b=2&a=1")).toBe(normalizeUrl("https://a.com/p?a=1&b=2"))
  })

  it("treats a bare trailing slash as the same page", () => {
    expect(normalizeUrl("https://a.com/")).toBe(normalizeUrl("https://a.com"))
  })

  it("keeps meaningful query parameters", () => {
    expect(normalizeUrl("https://a.com/search?q=orbit")).toBe("https://a.com/search?q=orbit")
  })

  it("returns malformed input unchanged apart from the fragment", () => {
    expect(normalizeUrl("not a url#x")).toBe("not a url")
  })
})

describe("findDuplicates", () => {
  it("finds nothing when every tab is distinct", () => {
    const records = [rec({ url: "https://a.com" }), rec({ url: "https://b.com" })]
    expect(findDuplicates(records, "url")).toEqual([])
  })

  it("groups identical urls", () => {
    const a = rec({ url: "https://a.com/page" })
    const b = rec({ url: "https://a.com/page" })
    const sets = findDuplicates([a, b], "url")
    expect(sets).toHaveLength(1)
    expect(sets[0].remove).toEqual([b.id])
    expect(sets[0].keep).toBe(a.id)
  })

  it("treats tracking differences as duplicates", () => {
    const a = rec({ url: "https://a.com/page" })
    const b = rec({ url: "https://a.com/page?utm_source=news" })
    expect(findDuplicates([a, b], "url")).toHaveLength(1)
  })

  it("keeps the active tab", () => {
    const plain = rec({ url: "https://a.com/p", lastAccess: Date.now() })
    const active = rec({ url: "https://a.com/p", active: true, lastAccess: 0 })
    const sets = findDuplicates([plain, active], "url")
    expect(sets[0].keep).toBe(active.id)
  })

  it("keeps a pinned tab over an unpinned one", () => {
    const loose = rec({ url: "https://a.com/p", lastAccess: Date.now() })
    const pinned = rec({ url: "https://a.com/p", pinned: true, lastAccess: 0 })
    const sets = findDuplicates([loose, pinned], "url")
    expect(sets[0].keep).toBe(pinned.id)
  })

  it("otherwise keeps the most recently accessed", () => {
    const older = rec({ url: "https://a.com/p", lastAccess: 1000 })
    const newer = rec({ url: "https://a.com/p", lastAccess: 9000 })
    const sets = findDuplicates([older, newer], "url")
    expect(sets[0].keep).toBe(newer.id)
    expect(sets[0].remove).toEqual([older.id])
  })

  it("never removes a pinned tab when protectPinned is on", () => {
    const pinned = rec({ url: "https://a.com/p", pinned: true, lastAccess: 0 })
    const newer = rec({ url: "https://a.com/p", lastAccess: 9000 })
    const sets = findDuplicates([pinned, newer], "url", { protectPinned: true })
    // the pinned tab survives the cull, so only the unpinned duplicate is removed
    expect(sets[0].keep).toBe(pinned.id)
    expect(sets[0].remove).toEqual([newer.id])
  })

  it("requires matching titles in title_url mode", () => {
    const a = rec({ url: "https://a.com/p", title: "Alpha" })
    const b = rec({ url: "https://a.com/p", title: "Beta" })
    expect(findDuplicates([a, b], "title_url")).toEqual([])
    expect(findDuplicates([a, b], "url")).toHaveLength(1)
  })

  it("skips browser-internal urls", () => {
    const a = rec({ url: "chrome://newtab/" })
    const b = rec({ url: "chrome://newtab/" })
    expect(findDuplicates([a, b], "url")).toEqual([])
  })

  it("only considers the requested windows", () => {
    const a = rec({ url: "https://a.com/p", windowId: 1 })
    const b = rec({ url: "https://a.com/p", windowId: 2 })
    expect(findDuplicates([a, b], "url", { windowIds: [1] })).toEqual([])
    expect(findDuplicates([a, b], "url", { windowIds: [1, 2] })).toHaveLength(1)
  })

  it("reports one set per duplicate cluster", () => {
    const records = [
      rec({ url: "https://a.com/p" }),
      rec({ url: "https://a.com/p" }),
      rec({ url: "https://a.com/p" }),
      rec({ url: "https://b.com/q" }),
      rec({ url: "https://b.com/q" }),
    ]
    const sets = findDuplicates(records, "url")
    expect(sets).toHaveLength(2)
    expect(sets.flatMap((s) => s.remove)).toHaveLength(3)
  })
})
