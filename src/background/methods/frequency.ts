/**
 * By Frequency / Prediction.
 *
 * Local and deterministic: every activation is weighted by how long ago it
 * happened, so a tab you touched five minutes ago outranks one you touched
 * yesterday even if the older one has more total visits. Tabs are then split
 * into four probability tiers, A through D.
 *
 * This runs entirely offline. An AI pass can re-rank afterwards, but it is
 * never required.
 */
import { FREQUENCY_TIER_LABELS, type FrequencyTier } from "../../shared/constants"
import type { GroupingInstructions, TabRecord } from "../../shared/types"

/** Recency half-life: after this long, a visit counts for half as much. */
export const HALF_LIFE_MS = 3 * 60 * 60 * 1000

/** Weight of a single activation that happened `ageMs` ago. */
export function decay(ageMs: number, halfLifeMs = HALF_LIFE_MS): number {
  return Math.pow(0.5, Math.max(0, ageMs) / halfLifeMs)
}

export interface FrequencyScore {
  id: number
  score: number
  visits: number
  lastAccess: number
}

/** Scores every record. Tabs with no recorded activations score 0. */
export function scoreFrequency(records: TabRecord[], now = Date.now()): FrequencyScore[] {
  return records
    .map((r) => {
      const visits = r.accessHistory.length
      let score = 0
      // only real recorded activations count; a tab we merely observed once
      // still has one entry, so it is never unfairly demoted
      for (const t of r.accessHistory) score += decay(now - t)
      return { id: r.id, score, visits, lastAccess: r.lastAccess }
    })
    .sort((a, b) => b.score - a.score || b.lastAccess - a.lastAccess)
}

/**
 * Splits the scored tabs into tiers A-D.
 *
 * A tab with no recorded activations always falls to D. The remaining tabs are
 * cut into quartiles, and a tab with no activity is never promoted above one
 * with real usage.
 */
export function tierFrequency(
  records: TabRecord[],
  now = Date.now(),
  fractions: [number, number, number] = [0.25, 0.25, 0.25],
): GroupingInstructions {
  const scored = scoreFrequency(records, now)
  const active = scored.filter((s) => s.visits > 0 && s.score > 0)
  const dormant = scored.filter((s) => s.visits === 0 || s.score === 0)

  const n = active.length
  const aEnd = Math.ceil(n * fractions[0])
  const bEnd = aEnd + Math.ceil(n * fractions[1])
  const cEnd = bEnd + Math.ceil(n * fractions[2])

  const tiers: Record<FrequencyTier, number[]> = { A: [], B: [], C: [], D: [] }
  active.forEach((s, i) => {
    if (i < aEnd) tiers.A.push(s.id)
    else if (i < bEnd) tiers.B.push(s.id)
    else if (i < cEnd) tiers.C.push(s.id)
    else tiers.D.push(s.id)
  })
  for (const s of dormant) tiers.D.push(s.id)

  const out: GroupingInstructions = {}
  for (const tier of ["A", "B", "C", "D"] as FrequencyTier[]) {
    if (tiers[tier].length) out[FREQUENCY_TIER_LABELS[tier]] = tiers[tier]
  }
  return out
}

/**
 * Places the top `count` tabs of a tier ordering into a single "Most used"
 * group, used by the popup's quick preview.
 */
export function topTabs(records: TabRecord[], count: number, now = Date.now()): number[] {
  return scoreFrequency(records, now)
    .slice(0, count)
    .map((s) => s.id)
}

/** Applies an AI-provided tier ordering, validating ids against the real set. */
export function applyAiTiers(
  raw: unknown,
  validIds: Set<number>,
): GroupingInstructions | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const out: GroupingInstructions = {}
  const seen = new Set<number>()

  for (const key of ["A", "B", "C", "D"]) {
    const val = obj[key]
    if (!Array.isArray(val)) continue
    const ids: number[] = []
    for (const v of val) {
      const id = typeof v === "number" ? v : Number(v)
      if (Number.isFinite(id) && validIds.has(id) && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    if (ids.length) out[FREQUENCY_TIER_LABELS[key as FrequencyTier]] = ids
  }

  return Object.keys(out).length ? out : null
}
