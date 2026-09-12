/**
 * The tab tracker.
 *
 * Keeps a live record per tab: url, title, last access and a bounded access
 * history. The service worker can be killed at any moment, so the map is
 * rehydrated from storage on wake and reconciled against the real tab list.
 */
import { ACCESS_HISTORY_LIMIT, LIMITS, STORAGE } from "../shared/constants"
import { isRestrictedUrl } from "../shared/format"
import type { TabId, TabRecord } from "../shared/types"
import { getSettings, getTabRecords, setTabRecords } from "./store"

const records = new Map<TabId, TabRecord>()
let hydrated = false
let persistTimer: ReturnType<typeof setTimeout> | undefined

/* ------------------------------------------------------------------ */
/* Hydration                                                           */
/* ------------------------------------------------------------------ */

function blank(tab: chrome.tabs.Tab, now: number): TabRecord {
  return {
    id: tab.id!,
    windowId: tab.windowId,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    lastAccess: now,
    // seeing a tab is itself one activation, so a brand new tab is never
    // treated as "never used" by the frequency method
    accessHistory: [now],
    firstSeen: now,
    // one activation so far, by the same reasoning
    sessionSwitches: 1,
    groupId: tab.groupId ?? -1,
    pinned: !!tab.pinned,
    active: !!tab.active,
    audible: !!tab.audible,
    discarded: !!tab.discarded,
    favIconUrl: tab.favIconUrl ?? "",
  }
}

/** Loads persisted records and reconciles them with the browser's real state. */
export async function hydrateTabs(): Promise<void> {
  if (hydrated) return
  hydrated = true

  const now = Date.now()
  const stored = await getTabRecords()
  let tabs: chrome.tabs.Tab[] = []
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return
  }

  const live = new Set<TabId>()
  for (const tab of tabs) {
    if (tab.id == null) continue
    live.add(tab.id)
    const prev = stored[String(tab.id)]
    if (prev) {
      // keep the history we accumulated; refresh everything else
      records.set(tab.id, {
        ...prev,
        url: tab.url ?? prev.url,
        title: tab.title || prev.title,
        windowId: tab.windowId,
        groupId: tab.groupId ?? -1,
        pinned: !!tab.pinned,
        active: !!tab.active,
        audible: !!tab.audible,
        discarded: !!tab.discarded,
        favIconUrl: tab.favIconUrl || prev.favIconUrl,
      })
    } else {
      records.set(tab.id, blank(tab, now))
    }
  }

  // drop anything that no longer exists
  for (const id of [...records.keys()]) if (!live.has(id)) records.delete(id)

  // re-apply any custom titles that survived a restart
  const { customTabTitles } = await getSettings()
  for (const [idStr, title] of Object.entries(customTabTitles)) {
    const rec = records.get(Number(idStr))
    if (rec) rec.customTitle = title
  }

  schedulePersist()
}

/**
 * Adds any tab the tracker has never seen.
 *
 * An MV3 service worker sleeps constantly. A tab opened while it was asleep
 * fires no `onCreated` that we hear, so it would never be tracked - and
 * therefore never grouped, never de-duplicated, never searchable. Any operation
 * that reasons over the whole tab set calls this first.
 *
 * Cheap: one query, and it only writes for tabs that are genuinely new.
 */
export async function reconcileTabs(): Promise<number> {
  let tabs: chrome.tabs.Tab[] = []
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return 0
  }

  const now = Date.now()
  const live = new Set<TabId>()
  let added = 0

  for (const tab of tabs) {
    if (tab.id == null) continue
    live.add(tab.id)

    const existing = records.get(tab.id)
    if (tab.id !== undefined && existing) {
      // Refresh the fields that go stale when a tab MOVES. Skipping known ids
      // entirely left `windowId` pointing at the window a tab used to be in, so
      // the Hub drew it under the wrong window (and counted it there). Measured:
      // 15 tabs reported in a window that held 12.
      existing.windowId = tab.windowId
      existing.groupId = tab.groupId ?? -1
      existing.pinned = !!tab.pinned
      existing.active = !!tab.active
      existing.audible = !!tab.audible
      existing.discarded = !!tab.discarded
      if (tab.url) existing.url = tab.url
      if (tab.title) existing.title = tab.title
      continue
    }

    records.set(tab.id, blank(tab, now))
    added++
  }

  // and drop anything that has since closed
  for (const id of [...records.keys()]) if (!live.has(id)) records.delete(id)

  if (added) schedulePersist()
  return added
}

/* ------------------------------------------------------------------ */
/* Accessors                                                           */
/* ------------------------------------------------------------------ */

export function allRecords(): TabRecord[] {
  return [...records.values()]
}

export function recordOf(id: TabId): TabRecord | undefined {
  return records.get(id)
}

export function recordCount(): number {
  return records.size
}

/* ------------------------------------------------------------------ */
/* Tracking                                                            */
/* ------------------------------------------------------------------ */

export function touch(tabId: TabId, at = Date.now()): void {
  const rec = records.get(tabId)
  if (!rec) return
  rec.lastAccess = at
  rec.accessHistory.push(at)
  // "Most / Least Accessed" is ranked on this, so it counts every switch back
  // rather than relying on the capped history.
  rec.sessionSwitches = (rec.sessionSwitches ?? 0) + 1
  // keep only the most recent N activations
  if (rec.accessHistory.length > ACCESS_HISTORY_LIMIT) {
    rec.accessHistory.splice(0, rec.accessHistory.length - ACCESS_HISTORY_LIMIT)
  }
  schedulePersist()
}

/**
 * Zeroes the per-session counters.
 *
 * Called on browser startup, not on worker wake. "Session" means a browser
 * session, and an MV3 service worker restarts far more often than that — so
 * resetting here rather than in the ready path is what makes the counter mean
 * what it says.
 */
export function resetSessionCounters(): void {
  for (const rec of records.values()) rec.sessionSwitches = 0
  schedulePersist()
}

export function observeCreated(tab: chrome.tabs.Tab): void {
  if (tab.id == null) return
  if (records.size >= LIMITS.tabRecords) {
    // drop the least recently used record rather than growing forever
    let oldest: TabId | null = null
    let oldestAt = Infinity
    for (const r of records.values()) {
      if (r.lastAccess < oldestAt) {
        oldestAt = r.lastAccess
        oldest = r.id
      }
    }
    if (oldest != null) records.delete(oldest)
  }
  records.set(tab.id, blank(tab, Date.now()))
  schedulePersist()
}

export function observeUpdated(
  tabId: TabId,
  change: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): void {
  let rec = records.get(tabId)
  if (!rec) {
    if (tab.id == null) return
    rec = blank(tab, Date.now())
    records.set(tabId, rec)
  }
  if (change.url) rec.url = change.url
  if (change.title) rec.title = change.title
  if (tab.url) rec.url = tab.url
  if (tab.favIconUrl) rec.favIconUrl = tab.favIconUrl
  if (change.audible !== undefined) rec.audible = change.audible
  if (change.discarded !== undefined) rec.discarded = change.discarded
  if (tab.groupId !== undefined) rec.groupId = tab.groupId
  if (tab.pinned !== undefined) rec.pinned = tab.pinned
  rec.windowId = tab.windowId
  rec.active = !!tab.active
  schedulePersist()
}

export function observeRemoved(tabId: TabId): void {
  records.delete(tabId)
  schedulePersist()
}

export function observeMoved(tabId: TabId, info: chrome.tabs.TabMoveInfo): void {
  const rec = records.get(tabId)
  if (rec) {
    rec.windowId = info.windowId
    schedulePersist()
  }
}

export function observeAttached(tabId: TabId, info: chrome.tabs.TabAttachInfo): void {
  const rec = records.get(tabId)
  if (rec) {
    rec.windowId = info.newWindowId
    schedulePersist()
  }
}

export function observeReplaced(added: TabId, removed: TabId): void {
  const old = records.get(removed)
  records.delete(removed)
  if (old) {
    records.set(added, { ...old, id: added, lastAccess: Date.now() })
  }
  schedulePersist()
}

export function setGroupId(tabId: TabId, groupId: number): void {
  const rec = records.get(tabId)
  if (rec) rec.groupId = groupId
}

export function setCustomTitle(tabId: TabId, title: string | undefined): void {
  const rec = records.get(tabId)
  if (rec) {
    if (title) rec.customTitle = title
    else delete rec.customTitle
  }
}

/* ------------------------------------------------------------------ */
/* Persistence (debounced)                                             */
/* ------------------------------------------------------------------ */

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    void persistNow()
  }, 800)
}

export async function persistNow(): Promise<void> {
  const obj: Record<string, TabRecord> = {}
  for (const [id, rec] of records) obj[String(id)] = rec
  try {
    await setTabRecords(obj)
  } catch {
    // storage can be full or the worker may be shutting down; nothing to do
  }
}

/** Drops records for tabs that are no longer open. Used after bulk closes. */
export function pruneAgainst(liveIds: Iterable<TabId>): void {
  const live = new Set(liveIds)
  for (const id of [...records.keys()]) if (!live.has(id)) records.delete(id)
}

export function resetTracker(): void {
  records.clear()
  hydrated = false
}

export const TRACKER_KEY = STORAGE.tabRecords
