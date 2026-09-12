import type { TabRecord } from "../src/shared/types"

let nextId = 1000

/** Builds a TabRecord with sensible defaults; override whatever matters. */
export function rec(partial: Partial<TabRecord> & { url: string }): TabRecord {
  const id = partial.id ?? nextId++
  const now = partial.lastAccess ?? Date.now()
  const base: TabRecord = {
    id,
    windowId: 1,
    url: partial.url,
    title: partial.url,
    lastAccess: now,
    accessHistory: [],
    firstSeen: now,
    sessionSwitches: 0,
    groupId: -1,
    pinned: false,
    active: false,
    audible: false,
    discarded: false,
    favIconUrl: "",
  }
  return { ...base, ...partial, id }
}

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
