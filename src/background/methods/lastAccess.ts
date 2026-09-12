/**
 * By Last Access - fully local and deterministic.
 *
 * A tab lands in the FIRST bucket whose range contains it, so the buckets must
 * never overlap. Empty buckets are dropped. Group order is oldest -> newest,
 * so the freshest tabs end up nearest the bottom of the list.
 */
import { LAST_ACCESS_BUCKETS, LAST_ACCESS_ORDER } from "../../shared/constants"
import type { GroupingInstructions, TabRecord } from "../../shared/types"

/** Returns the bucket label for a "ms ago" value, or null when out of range. */
export function bucketFor(agoMs: number): string | null {
  for (const b of LAST_ACCESS_BUCKETS) {
    if (agoMs >= b.minAgoMs && agoMs < b.maxAgoMs) return b.label
  }
  return null
}

/**
 * Buckets records by how long ago they were last activated.
 * Result keys follow LAST_ACCESS_ORDER (oldest first) with empties removed.
 */
export function bucketLastAccess(
  records: TabRecord[],
  now = Date.now(),
): GroupingInstructions {
  const byLabel = new Map<string, number[]>()
  for (const rec of records) {
    const label = bucketFor(Math.max(0, now - rec.lastAccess))
    if (!label) continue
    const arr = byLabel.get(label)
    if (arr) arr.push(rec.id)
    else byLabel.set(label, [rec.id])
  }

  const out: GroupingInstructions = {}
  for (const label of LAST_ACCESS_ORDER) {
    const ids = byLabel.get(label)
    if (ids?.length) out[label] = ids
  }
  return out
}

/** Human-readable summary used in the popup before organizing. */
export function describeBuckets(instructions: GroupingInstructions): string {
  const n = Object.keys(instructions).length
  if (!n) return "Nothing to organize"
  return `${n} time ${n === 1 ? "group" : "groups"}`
}
