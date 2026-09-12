/**
 * By Memory - learns where you put things.
 *
 * Whenever you move a tab into a group yourself, the site-to-group-title pair
 * is remembered. "By Memory" then replays those decisions for new tabs from the
 * same site, falling back to the built-in category lexicon for anything it has
 * never seen. Nothing leaves the machine.
 */
import { hostOf, displayTitle, siteLabel } from "../../shared/format"
import type { GroupingInstructions, TabRecord } from "../../shared/types"
import type { MemoryMap } from "../store"
import { classifyLocal } from "../ai/lexicon"
import { tidyLabel } from "./util"

/** Group titles we never want to learn from, because we produced them. */
const IGNORE_TITLES = new Set(["", "Other", "Misc"])

/** Records one observation: this site now belongs to this group title. */
export function learn(memory: MemoryMap, url: string, groupTitle: string): MemoryMap {
  const site = siteLabel(url)
  const title = tidyLabel(groupTitle)
  if (!site || IGNORE_TITLES.has(title)) return memory
  if (memory[site] === title) return memory
  return { ...memory, [site]: title }
}

/** Applies a batch of observations, returning a new map. */
export function learnAll(
  memory: MemoryMap,
  observations: Array<{ url: string; groupTitle: string }>,
): MemoryMap {
  let next = memory
  for (const o of observations) next = learn(next, o.url, o.groupTitle)
  return next
}

/** Forget a single site. */
export function forget(memory: MemoryMap, site: string): MemoryMap {
  if (!(site in memory)) return memory
  const next = { ...memory }
  delete next[site]
  return next
}

export interface MemoryGroup {
  label: string
  ids: number[]
  /** true when this came from a remembered choice rather than the lexicon */
  learned: boolean
}

/**
 * Groups records by remembered site labels, then by built-in category for
 * anything unseen. Learned groups are returned first so they lead the tab strip.
 */
export function groupByMemory(
  records: TabRecord[],
  memory: MemoryMap,
): { groups: GroupingInstructions; learnedSites: number } {
  const learnedMap = new Map<string, number[]>()
  const fallbackMap = new Map<string, number[]>()
  let learnedSites = 0

  for (const rec of records) {
    const site = siteLabel(rec.url)
    const remembered = site ? memory[site] : undefined

    if (remembered) {
      learnedSites++
      const arr = learnedMap.get(remembered)
      if (arr) arr.push(rec.id)
      else learnedMap.set(remembered, [rec.id])
      continue
    }

    const hit = classifyLocal(rec.url, displayTitle(rec))
    const label = hit ? hit.category : tidyLabel(hostOf(rec.url) || "Misc")
    const arr = fallbackMap.get(label)
    if (arr) arr.push(rec.id)
    else fallbackMap.set(label, [rec.id])
  }

  // learned groups lead, ordered by how many tabs they hold
  const out: GroupingInstructions = {}
  const learned = [...learnedMap.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [label, ids] of learned) out[label] = ids
  for (const [label, ids] of fallbackMap) {
    // never collide with a learned label
    const key = label in out ? `${label} (suggested)` : label
    out[key] = ids
  }

  return { groups: out, learnedSites }
}

/** How much the method has learned, for the settings page. */
export function memoryStats(memory: MemoryMap): { sites: number; groups: number } {
  const groups = new Set(Object.values(memory))
  return { sites: Object.keys(memory).length, groups: groups.size }
}
