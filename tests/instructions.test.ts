import { describe, expect, it } from "vitest"
import {
  chunk,
  mergeInstructions,
  normalizeInstructions,
  tidyLabel,
  unplacedIds,
} from "../src/background/methods/util"
import { extractJson } from "../src/background/ai/provider"

const valid = new Set([1, 2, 3, 4, 5])

describe("normalizeInstructions", () => {
  it("accepts a clean object", () => {
    expect(normalizeInstructions({ Work: [1, 2], News: [3] }, valid)).toEqual({
      Work: [1, 2],
      News: [3],
    })
  })

  it("drops ids that are not real tabs", () => {
    expect(normalizeInstructions({ Work: [1, 999] }, valid)).toEqual({ Work: [1] })
  })

  it("never places the same tab twice", () => {
    expect(normalizeInstructions({ Work: [1, 2], Also: [2, 3] }, valid)).toEqual({
      Work: [1, 2],
      Also: [3],
    })
  })

  it("coerces string ids, which is what models usually emit", () => {
    expect(normalizeInstructions({ Work: ["1", "2"] }, valid)).toEqual({ Work: [1, 2] })
  })

  it("drops groups that end up empty", () => {
    expect(normalizeInstructions({ Work: [1], Empty: [777] }, valid)).toEqual({ Work: [1] })
  })

  it("rejects anything that is not a plain object", () => {
    expect(normalizeInstructions(null, valid)).toBeNull()
    expect(normalizeInstructions([1, 2], valid)).toBeNull()
    expect(normalizeInstructions("nope", valid)).toBeNull()
    expect(normalizeInstructions({ Work: "not an array" }, valid)).toBeNull()
  })

  it("caps the number of groups", () => {
    // each group needs its own tab, otherwise de-duplication would empty them
    const ids = Array.from({ length: 40 }, (_, i) => i + 1)
    const many: Record<string, number[]> = {}
    ids.forEach((id, i) => {
      many[`G${i}`] = [id]
    })
    const out = normalizeInstructions(many, new Set(ids), 5)
    expect(Object.keys(out!)).toHaveLength(5)
  })

  it("trims and shortens category names", () => {
    const long = "x".repeat(200)
    const out = normalizeInstructions({ [`  Work  `]: [1], [long]: [2] }, valid)
    expect(Object.keys(out!)[0]).toBe("Work")
    expect(Object.keys(out!)[1].length).toBe(60)
  })

  it("ignores blank group names", () => {
    expect(normalizeInstructions({ "   ": [1] }, valid)).toBeNull()
  })
})

describe("unplacedIds", () => {
  it("reports tabs no group claimed", () => {
    expect(unplacedIds({ Work: [1, 2] }, valid).sort()).toEqual([3, 4, 5])
  })

  it("is empty when everything is placed", () => {
    expect(unplacedIds({ A: [1, 2, 3, 4, 5] }, valid)).toEqual([])
  })

  it("handles a null input", () => {
    expect(unplacedIds(null, valid).sort()).toEqual([1, 2, 3, 4, 5])
  })
})

describe("mergeInstructions", () => {
  it("keeps the primary ordering and fills gaps from the secondary", () => {
    const out = mergeInstructions({ AI: [1, 2] }, { Local: [2, 3, 4] }, valid)
    expect(Object.keys(out)).toEqual(["AI", "Local"])
    expect(out["AI"]).toEqual([1, 2])
    expect(out["Local"]).toEqual([3, 4])
  })

  it("returns the secondary when the primary is null", () => {
    expect(mergeInstructions(null, { Local: [1] }, valid)).toEqual({ Local: [1] })
  })

  it("returns the primary when the secondary is null", () => {
    expect(mergeInstructions({ AI: [1] }, null, valid)).toEqual({ AI: [1] })
  })

  it("filters invalid ids from both sides", () => {
    const out = mergeInstructions({ AI: [1, 500] }, { Local: [600, 2] }, valid)
    expect(out).toEqual({ AI: [1], Local: [2] })
  })

  it("merges same-named groups across passes", () => {
    const out = mergeInstructions({ Work: [1] }, { Work: [2] }, valid)
    expect(out["Work"]).toEqual([1, 2])
  })
})

describe("chunk", () => {
  it("splits into the requested sizes", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it("returns a single chunk when the input already fits", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]])
  })

  it("handles a non-positive size", () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]])
  })
})

describe("tidyLabel", () => {
  it("collapses whitespace", () => {
    expect(tidyLabel("  Work   and   Play ")).toBe("Work and Play")
  })

  it("falls back for a blank label", () => {
    expect(tidyLabel("   ")).toBe("Misc")
  })

  it("caps the length", () => {
    expect(tidyLabel("y".repeat(100)).length).toBe(40)
  })
})

describe("extractJson", () => {
  it("parses plain json", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it("unwraps a fenced code block", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it("unwraps an unlabelled fence", () => {
    expect(extractJson("```\n{\"a\":1}\n```")).toEqual({ a: 1 })
  })

  it("ignores prose around the object", () => {
    expect(extractJson('Sure! Here you go: {"a":1} Hope that helps.')).toEqual({ a: 1 })
  })

  it("handles nested braces", () => {
    expect(extractJson('{"a":{"b":[1,2]}}')).toEqual({ a: { b: [1, 2] } })
  })

  it("is not confused by braces inside strings", () => {
    expect(extractJson('{"a":"} not the end"}')).toEqual({ a: "} not the end" })
  })

  it("is not confused by escaped quotes", () => {
    expect(extractJson('{"a":"say \\"hi\\""}')).toEqual({ a: 'say "hi"' })
  })

  it("parses a top-level array", () => {
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3])
  })

  it("throws when there is no json at all", () => {
    expect(() => extractJson("no json here")).toThrow()
  })
})
