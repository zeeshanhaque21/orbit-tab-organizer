import { describe, expect, it } from "vitest"
import { bucketFor, bucketLastAccess } from "../src/background/methods/lastAccess"
import { LAST_ACCESS_BUCKETS, LAST_ACCESS_ORDER } from "../src/shared/constants"
import { DAY, HOUR, MIN, rec } from "./helpers"

describe("bucketFor", () => {
  it("puts a fresh tab in 'just now'", () => {
    expect(bucketFor(0)).toBe("just now")
    expect(bucketFor(59_999)).toBe("just now")
  })

  it("treats boundaries as belonging to the newer bucket", () => {
    // ranges are half-open: [min, max), so exactly 60s is the next bucket up
    expect(bucketFor(60_000)).toBe("last 5 minutes")
    expect(bucketFor(5 * MIN)).toBe("last 15 minutes")
    expect(bucketFor(15 * MIN)).toBe("last 30 minutes")
    expect(bucketFor(30 * MIN)).toBe("last 45 minutes")
    expect(bucketFor(45 * MIN)).toBe("last hour")
    expect(bucketFor(HOUR)).toBe("last 2 hours")
  })

  it("handles the multi-hour and day buckets", () => {
    expect(bucketFor(2 * HOUR)).toBe("last 3 hours")
    expect(bucketFor(6 * HOUR)).toBe("last 12 hours")
    expect(bucketFor(12 * HOUR)).toBe("last 24 hours")
    expect(bucketFor(24 * HOUR)).toBe("yesterday")
    expect(bucketFor(48 * HOUR)).toBe("2 days ago")
    expect(bucketFor(72 * HOUR)).toBe("older than 2 days")
    expect(bucketFor(400 * DAY)).toBe("older than 2 days")
  })
})

describe("bucket ranges", () => {
  it("are contiguous with no gaps and no overlaps", () => {
    const sorted = [...LAST_ACCESS_BUCKETS].sort((a, b) => a.minAgoMs - b.minAgoMs)
    expect(sorted[0].minAgoMs).toBe(0)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].minAgoMs).toBe(sorted[i - 1].maxAgoMs)
    }
    expect(sorted[sorted.length - 1].maxAgoMs).toBe(Infinity)
  })

  it("covers every millisecond value exactly once", () => {
    for (const ago of [0, 1, 59_999, 60_000, 3 * HOUR, 47 * HOUR, 100 * DAY]) {
      const hits = LAST_ACCESS_BUCKETS.filter((b) => ago >= b.minAgoMs && ago < b.maxAgoMs)
      expect(hits).toHaveLength(1)
    }
  })
})

describe("bucketLastAccess", () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0)

  it("groups tabs by recency and drops empty buckets", () => {
    const records = [
      rec({ url: "https://a.com", lastAccess: now - 10_000 }),
      rec({ url: "https://b.com", lastAccess: now - 2 * MIN }),
      rec({ url: "https://c.com", lastAccess: now - 3 * DAY }),
    ]

    const out = bucketLastAccess(records, now)
    expect(Object.keys(out)).toEqual(["older than 2 days", "last 5 minutes", "just now"])
    expect(out["just now"]).toHaveLength(1)
    expect(out["last 5 minutes"]).toHaveLength(1)
    expect(out["older than 2 days"]).toHaveLength(1)
  })

  it("returns groups oldest first", () => {
    const records = [
      rec({ url: "https://fresh.com", lastAccess: now }),
      rec({ url: "https://old.com", lastAccess: now - 100 * DAY }),
      rec({ url: "https://mid.com", lastAccess: now - 3 * HOUR }),
    ]
    const keys = Object.keys(bucketLastAccess(records, now))
    const expectedOrder = LAST_ACCESS_ORDER.filter((l) => keys.includes(l))
    expect(keys).toEqual(expectedOrder)
    expect(keys[0]).toBe("older than 2 days")
    expect(keys[keys.length - 1]).toBe("just now")
  })

  it("places every tab exactly once", () => {
    const records = Array.from({ length: 40 }, (_, i) =>
      rec({ url: `https://site${i}.com`, lastAccess: now - i * 37 * MIN }),
    )
    const out = bucketLastAccess(records, now)
    const placed = Object.values(out).flat()
    expect(placed).toHaveLength(40)
    expect(new Set(placed).size).toBe(40)
  })

  it("returns nothing for an empty input", () => {
    expect(bucketLastAccess([], now)).toEqual({})
  })
})
