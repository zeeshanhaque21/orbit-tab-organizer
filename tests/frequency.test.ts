import { describe, expect, it } from "vitest"
import {
  HALF_LIFE_MS,
  applyAiTiers,
  decay,
  scoreFrequency,
  tierFrequency,
} from "../src/background/methods/frequency"
import { FREQUENCY_TIER_LABELS } from "../src/shared/constants"
import { DAY, HOUR, MIN, rec } from "./helpers"

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)

describe("decay", () => {
  it("is 1 for something touched right now", () => {
    expect(decay(0)).toBeCloseTo(1, 10)
  })

  it("halves after one half-life", () => {
    expect(decay(HALF_LIFE_MS)).toBeCloseTo(0.5, 10)
    expect(decay(2 * HALF_LIFE_MS)).toBeCloseTo(0.25, 10)
  })

  it("decreases monotonically with age", () => {
    let prev = Infinity
    for (const age of [0, MIN, HOUR, DAY, 30 * DAY]) {
      const v = decay(age)
      expect(v).toBeLessThan(prev)
      prev = v
    }
  })

  it("treats a future timestamp as brand new rather than negative", () => {
    expect(decay(-5000)).toBe(1)
  })
})

describe("scoreFrequency", () => {
  it("ranks a recently used tab above an old one", () => {
    const fresh = rec({ url: "https://fresh.com", accessHistory: [NOW - MIN], lastAccess: NOW - MIN })
    const stale = rec({ url: "https://stale.com", accessHistory: [NOW - 10 * DAY], lastAccess: NOW - 10 * DAY })
    const [first] = scoreFrequency([stale, fresh], NOW)
    expect(first.id).toBe(fresh.id)
  })

  it("lets recent activity outweigh a higher total visit count", () => {
    // touched once, moments ago
    const recent = rec({ url: "https://recent.com", accessHistory: [NOW - 1000] })
    // touched twenty times, but all a week ago
    const busyOld = rec({
      url: "https://busy.com",
      accessHistory: Array.from({ length: 20 }, (_, i) => NOW - 7 * DAY + i * 1000),
    })
    const [first] = scoreFrequency([recent, busyOld], NOW)
    expect(first.id).toBe(recent.id)
  })

  it("counts recorded activations as visits", () => {
    const r = rec({ url: "https://a.com", accessHistory: [NOW - MIN, NOW - 2 * MIN, NOW - 3 * MIN] })
    const [s] = scoreFrequency([r], NOW)
    expect(s.visits).toBe(3)
  })

  it("scores a tab with no history at zero", () => {
    const r = rec({ url: "https://a.com", accessHistory: [] })
    const [s] = scoreFrequency([r], NOW)
    expect(s.score).toBe(0)
    expect(s.visits).toBe(0)
  })
})

describe("tierFrequency", () => {
  const build = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      rec({
        url: `https://site${i}.com`,
        accessHistory: [NOW - i * 10 * MIN],
        lastAccess: NOW - i * 10 * MIN,
      }),
    )

  it("puts the most recently used tab in tier A", () => {
    const records = build(8)
    const out = tierFrequency(records, NOW)
    expect(out[FREQUENCY_TIER_LABELS.A]).toContain(records[0].id)
    expect(out[FREQUENCY_TIER_LABELS.D]).toContain(records[7].id)
  })

  it("splits into four quartiles and drops empties", () => {
    const out = tierFrequency(build(8), NOW)
    expect(Object.keys(out)).toEqual([
      FREQUENCY_TIER_LABELS.A,
      FREQUENCY_TIER_LABELS.B,
      FREQUENCY_TIER_LABELS.C,
      FREQUENCY_TIER_LABELS.D,
    ])
    expect(out[FREQUENCY_TIER_LABELS.A]).toHaveLength(2)
    expect(out[FREQUENCY_TIER_LABELS.B]).toHaveLength(2)
    expect(out[FREQUENCY_TIER_LABELS.C]).toHaveLength(2)
    expect(out[FREQUENCY_TIER_LABELS.D]).toHaveLength(2)
  })

  it("always demotes a tab with no recorded activity to tier D", () => {
    const never = rec({ url: "https://never.com", accessHistory: [] })
    const out = tierFrequency([...build(6), never], NOW)
    expect(out[FREQUENCY_TIER_LABELS.D]).toContain(never.id)
  })

  it("places every tab exactly once", () => {
    const records = build(15)
    const out = tierFrequency(records, NOW)
    const placed = Object.values(out).flat()
    expect(placed).toHaveLength(15)
    expect(new Set(placed).size).toBe(15)
  })

  it("handles a single tab without crashing", () => {
    const out = tierFrequency(build(1), NOW)
    expect(Object.values(out).flat()).toHaveLength(1)
  })

  it("returns nothing for no tabs", () => {
    expect(tierFrequency([], NOW)).toEqual({})
  })
})

describe("applyAiTiers", () => {
  const valid = new Set([1, 2, 3, 4])

  it("accepts a well-formed tier object", () => {
    const out = applyAiTiers({ A: [1, 2], B: [3], C: [], D: [4] }, valid)
    expect(out).toEqual({
      [FREQUENCY_TIER_LABELS.A]: [1, 2],
      [FREQUENCY_TIER_LABELS.B]: [3],
      [FREQUENCY_TIER_LABELS.D]: [4],
    })
  })

  it("drops ids that are not real tabs", () => {
    const out = applyAiTiers({ A: [1, 999] }, valid)
    expect(out?.[FREQUENCY_TIER_LABELS.A]).toEqual([1])
  })

  it("never lists a tab twice across tiers", () => {
    const out = applyAiTiers({ A: [1], B: [1, 2] }, valid)
    expect(out?.[FREQUENCY_TIER_LABELS.A]).toEqual([1])
    expect(out?.[FREQUENCY_TIER_LABELS.B]).toEqual([2])
  })

  it("coerces string ids", () => {
    const out = applyAiTiers({ A: ["2", "3"] }, valid)
    expect(out?.[FREQUENCY_TIER_LABELS.A]).toEqual([2, 3])
  })

  it("returns null when nothing is usable", () => {
    expect(applyAiTiers(null, valid)).toBeNull()
    expect(applyAiTiers({ A: "nope" }, valid)).toBeNull()
    expect(applyAiTiers({ A: [99, 98] }, valid)).toBeNull()
  })
})
