/**
 * Shared helpers for the grouping methods: validating model output and merging
 * a local pass with an AI pass.
 */
import type { GroupingInstructions } from "../../shared/types"

/**
 * Turns arbitrary model output into safe grouping instructions.
 *
 * Ids that are not real tabs are dropped, a tab is never placed twice, and
 * category names are normalised. Returns null when nothing usable survives.
 */
export function normalizeInstructions(
  raw: unknown,
  validIds: Set<number>,
  maxGroups = 24,
): GroupingInstructions | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null

  const out: GroupingInstructions = {}
  const seen = new Set<number>()
  let groups = 0

  for (const [rawName, rawIds] of Object.entries(raw as Record<string, unknown>)) {
    if (groups >= maxGroups) break
    if (!Array.isArray(rawIds)) continue

    const name = String(rawName).trim().slice(0, 60)
    if (!name) continue

    const ids: number[] = []
    for (const v of rawIds) {
      const id = typeof v === "number" ? v : Number(v)
      if (!Number.isFinite(id) || !validIds.has(id) || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    if (ids.length) {
      out[name] = ids
      groups++
    }
  }

  return Object.keys(out).length ? out : null
}

/** Tab ids that no group claimed. */
export function unplacedIds(
  instructions: GroupingInstructions | null,
  validIds: Set<number>,
): number[] {
  const placed = new Set<number>()
  for (const ids of Object.values(instructions ?? {})) for (const id of ids) placed.add(id)
  return [...validIds].filter((id) => !placed.has(id))
}

/**
 * Primary wins; anything primary missed is filled from secondary. Group order
 * follows primary so the AI's own ordering is preserved.
 */
export function mergeInstructions(
  primary: GroupingInstructions | null,
  secondary: GroupingInstructions | null,
  validIds: Set<number>,
): GroupingInstructions {
  const out: GroupingInstructions = {}
  const placed = new Set<number>()

  const take = (src: GroupingInstructions | null, respectExisting: boolean) => {
    for (const [name, ids] of Object.entries(src ?? {})) {
      const keep = ids.filter((id) => {
        if (!validIds.has(id)) return false
        if (respectExisting && placed.has(id)) return false
        return true
      })
      if (!keep.length) continue
      for (const id of keep) placed.add(id)
      out[name] = (out[name] ?? []).concat(keep)
    }
  }

  take(primary, true)
  take(secondary, true)
  return out
}

/** Splits an array into chunks of at most `size`. */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0 || arr.length <= size) return [arr]
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Trims a label to something that reads well on a tab group. */
export function tidyLabel(s: string): string {
  const t = s.trim().replace(/\s+/g, " ").slice(0, 40)
  return t || "Misc"
}
