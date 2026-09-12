/**
 * The recycle bin.
 *
 * Tabs closed by duplicate cleaning (and by the Hub's delete drop zone) land
 * here first, so nothing is lost to a misclick. Entries are capped and pruned
 * oldest-first.
 */
import { LIMITS } from "../shared/constants"
import type { RecycleEntry, TabId, WindowId } from "../shared/types"
import { getRecycle, setRecycle } from "./store"
import { recordOf } from "./tabs"

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/** Builds an entry from a live tab, falling back to the tracker's record. */
export function entryFromTab(tab: chrome.tabs.Tab, reason: string): RecycleEntry | null {
  if (tab.id == null) return null
  const rec = recordOf(tab.id)
  const url = tab.url ?? rec?.url ?? ""
  if (!url) return null
  return {
    id: newId(),
    url,
    title: tab.title ?? rec?.title ?? url,
    favIconUrl: tab.favIconUrl ?? rec?.favIconUrl ?? "",
    windowId: tab.windowId,
    closedAt: Date.now(),
    reason,
  }
}

export async function addToRecycle(entries: RecycleEntry[]): Promise<void> {
  if (!entries.length) return
  const current = await getRecycle()
  // newest first, capped
  const next = [...entries, ...current].slice(0, LIMITS.recycleEntries)
  await setRecycle(next)
}

export async function listRecycle(): Promise<RecycleEntry[]> {
  const list = await getRecycle()
  return [...list].sort((a, b) => b.closedAt - a.closedAt)
}

/** Reopens the given entries in the window they came from, when it still exists. */
export async function restoreRecycle(ids: string[]): Promise<number> {
  const list = await getRecycle()
  const wanted = new Set(ids)
  const toRestore = list.filter((e) => wanted.has(e.id))
  if (!toRestore.length) return 0

  let openWindows = new Set<WindowId>()
  try {
    const ws = await chrome.windows.getAll({ populate: false })
    openWindows = new Set(ws.map((w) => w.id).filter((id): id is number => id != null))
  } catch {
    /* no window info; tabs.open will pick a window */
  }

  let restored = 0
  // oldest first so the original order is roughly preserved
  for (const e of [...toRestore].sort((a, b) => a.closedAt - b.closedAt)) {
    try {
      await chrome.tabs.create({
        url: e.url,
        active: false,
        ...(openWindows.has(e.windowId) ? { windowId: e.windowId } : {}),
      })
      restored++
    } catch {
      /* the url may no longer be openable */
    }
  }

  const remaining = list.filter((e) => !wanted.has(e.id))
  await setRecycle(remaining)
  return restored
}

export async function clearRecycle(): Promise<void> {
  await setRecycle([])
}

export async function recycleCount(): Promise<number> {
  return (await getRecycle()).length
}

/**
 * Closes tabs, optionally parking them in the recycle bin first.
 * Pinned tabs are skipped when `protectPinned` is set.
 */
export async function closeTabs(
  tabIds: TabId[],
  opts: { reason: string; toBin: boolean; protectPinned?: boolean },
): Promise<{ closed: number; binned: number }> {
  if (!tabIds.length) return { closed: 0, binned: 0 }

  let tabs: chrome.tabs.Tab[] = []
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return { closed: 0, binned: 0 }
  }

  const targets = tabs.filter((t) => t.id != null && tabIds.includes(t.id))
  const allowed = opts.protectPinned ? targets.filter((t) => !t.pinned) : targets
  if (!allowed.length) return { closed: 0, binned: 0 }

  let binned = 0
  if (opts.toBin) {
    const entries = allowed
      .map((t) => entryFromTab(t, opts.reason))
      .filter((e): e is RecycleEntry => e !== null)
    await addToRecycle(entries)
    binned = entries.length
  }

  const ids = allowed.map((t) => t.id!)
  try {
    await chrome.tabs.remove(ids)
  } catch {
    // remove them one at a time so one failure does not block the rest
    let closed = 0
    for (const id of ids) {
      try {
        await chrome.tabs.remove(id)
        closed++
      } catch {
        /* already gone */
      }
    }
    return { closed, binned }
  }
  return { closed: ids.length, binned }
}
