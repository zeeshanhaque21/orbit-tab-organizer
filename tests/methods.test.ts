import { describe, expect, it } from "vitest"
import {
  RELEVANCE_LABELS,
  groupByRelevance,
  jaccard,
  scoreRelevance,
  tokens,
} from "../src/background/methods/relevance"
import { forget, groupByMemory, learn, memoryStats } from "../src/background/methods/memory"
import { rec } from "./helpers"

describe("tokens", () => {
  it("drops short words and stopwords", () => {
    const t = tokens("The Quick Brown Fox")
    expect(t.has("the")).toBe(false)
    expect(t.has("quick")).toBe(true)
    expect(t.has("brown")).toBe(true)
  })

  it("handles punctuation and case", () => {
    expect(tokens("Hello, World!")).toEqual(new Set(["hello", "world"]))
  })
})

describe("jaccard", () => {
  it("is 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1)
  })

  it("is 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0)
  })

  it("is 0 when either side is empty", () => {
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0)
  })

  it("measures partial overlap", () => {
    // intersection 1, union 3
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "c"]))).toBeCloseTo(1 / 3, 10)
  })
})

describe("scoreRelevance", () => {
  const reference = rec({
    url: "https://github.com/org/repo",
    title: "orbit repository",
  })

  it("always ranks the anchor tab first", () => {
    const [s] = scoreRelevance([reference], reference)
    expect(s.score).toBe(100)
  })

  it("scores the same site higher than an unrelated one", () => {
    const sameSite = rec({ url: "https://github.com/org/other", title: "other repository" })
    const unrelated = rec({ url: "https://random-shop.example/item", title: "buy a kettle" })
    const scored = scoreRelevance([sameSite, unrelated], reference)
    const a = scored.find((s) => s.id === sameSite.id)!
    const b = scored.find((s) => s.id === unrelated.id)!
    expect(a.score).toBeGreaterThan(b.score)
    expect(a.reasons).toContain("same site")
  })

  it("gives an unrelated tab a score of zero", () => {
    const unrelated = rec({ url: "https://random-shop.example/item", title: "buy a kettle" })
    const [s] = scoreRelevance([unrelated], reference)
    expect(s.score).toBe(0)
    expect(s.reasons).toEqual([])
  })

  it("notices a shared section of the same path", () => {
    const ref = rec({ url: "https://app.example.com/projects/alpha/board", title: "Board" })
    const sibling = rec({ url: "https://app.example.com/projects/alpha/list", title: "List" })
    const [s] = scoreRelevance([sibling], ref)
    expect(s.reasons).toContain("same section")
  })
})

describe("groupByRelevance", () => {
  it("anchors the current tab in its own group", () => {
    const active = rec({ url: "https://github.com/a", title: "repo a" })
    const out = groupByRelevance([active], active.id)
    expect(out[RELEVANCE_LABELS.now]).toEqual([active.id])
  })

  it("buckets by score, most relevant first", () => {
    const active = rec({ url: "https://github.com/org/repo", title: "orbit repository" })
    const highlyRelevant = rec({ url: "https://github.com/org/repo/pulls", title: "orbit repository pulls" })
    const unrelated = rec({ url: "https://unrelated-xyz.example", title: "unrelated page" })

    const out = groupByRelevance([active, highlyRelevant, unrelated], active.id)
    expect(out[RELEVANCE_LABELS.now]).toEqual([active.id])
    expect(out[RELEVANCE_LABELS.high]).toContain(highlyRelevant.id)
    expect(out[RELEVANCE_LABELS.unrelated]).toContain(unrelated.id)
  })

  it("accounts for every tab", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      rec({ url: `https://site${i}.example/p`, title: `page ${i}` }),
    )
    const out = groupByRelevance(records, records[0].id)
    expect(Object.values(out).flat()).toHaveLength(10)
  })

  it("degrades gracefully with no active tab", () => {
    const records = [rec({ url: "https://a.example" })]
    const out = groupByRelevance(records, null)
    expect(Object.values(out).flat()).toHaveLength(1)
  })

  it("returns nothing for no tabs", () => {
    expect(groupByRelevance([], null)).toEqual({})
  })
})

describe("memory", () => {
  it("remembers where a site was filed", () => {
    const m = learn({}, "https://github.com/org/repo", "Work")
    expect(m["github.com"]).toBe("Work")
  })

  it("reduces a subdomain to its registrable site", () => {
    const m = learn({}, "https://docs.google.com/document/d/1", "Writing")
    expect(m["google.com"]).toBe("Writing")
  })

  it("returns the same object when nothing changes", () => {
    const first = learn({}, "https://github.com/x", "Work")
    expect(learn(first, "https://github.com/y", "Work")).toBe(first)
  })

  it("ignores labels we generated ourselves", () => {
    expect(learn({}, "https://github.com/x", "Other")).toEqual({})
    expect(learn({}, "https://github.com/x", "Misc")).toEqual({})
    expect(learn({}, "https://github.com/x", "")).toEqual({})
  })

  it("forgets a site", () => {
    const m = learn({}, "https://github.com/x", "Work")
    expect(forget(m, "github.com")).toEqual({})
    expect(forget(m, "not-there.com")).toBe(m)
  })

  it("replays learned choices and falls back for the rest", () => {
    const memory = { "github.com": "Work", "amazon.com": "Shopping" }
    const records = [
      rec({ url: "https://github.com/org/repo" }),
      rec({ url: "https://amazon.com/dp/B0" }),
      rec({ url: "https://reddit.com/r/x" }),
    ]
    const { groups, learnedSites } = groupByMemory(records, memory)
    expect(learnedSites).toBe(2)
    expect(groups["Work"]).toHaveLength(1)
    expect(groups["Shopping"]).toHaveLength(1)
    // reddit was never filed, so it lands in its built-in category
    expect(groups["Social"]).toHaveLength(1)
  })

  it("puts learned groups ahead of suggested ones", () => {
    const memory = { "github.com": "Work" }
    const records = [
      rec({ url: "https://reddit.com/r/x" }),
      rec({ url: "https://github.com/org/repo" }),
    ]
    const { groups } = groupByMemory(records, memory)
    expect(Object.keys(groups)[0]).toBe("Work")
  })

  it("never collides a suggested label with a learned one", () => {
    const memory = { "amazon.com": "Shopping" }
    const records = [rec({ url: "https://amazon.com/dp/B0" }), rec({ url: "https://ebay.com/itm/1" })]
    const { groups } = groupByMemory(records, memory)
    expect(Object.keys(groups).filter((k) => k.startsWith("Shopping"))).toHaveLength(2)
  })

  it("summarises what it has learned", () => {
    const m = { "github.com": "Work", "gitlab.com": "Work", "amazon.com": "Shopping" }
    expect(memoryStats(m)).toEqual({ sites: 3, groups: 2 })
  })
})
