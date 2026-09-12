/**
 * Undo.
 *
 * A snapshot records the whole shape of the affected windows before a pass:
 * which groups existed, which tabs were in them, and the tab order. Undo
 * rebuilds that shape exactly, including reopening any tab the pass closed.
 */
import { displayTitle } from "../shared/format"
import type { GroupingMethod, GroupingScope, TabId, UndoSnapshot, WindowId } from "../shared/types"
import { listGroups, tabsInWindow, ungroupTabs } from "./groups"
import { getSettings } from "./store"

/** Captures the current arrangement of the given windows. */
export async function captureSnapshot(
  windowIds: WindowId[],
  method: GroupingMethod,
  scope: GroupingScope,
): Promise<UndoSnapshot> {
  const groups: UndoSnapshot["groups"] = []
  const previous: UndoSnapshot["previous"] = []

  for (const windowId of windowIds) {
    for (const g of await listGroups(windowId)) {
      groups.push({
        id: g.id,
        windowId,
        title: g.title ?? "",
        color: g.color as UndoSnapshot["groups"][number]["color"],
        collapsed: !!g.collapsed,
      })
    }

    const tabs = await tabsInWindow(windowId)
    tabs.forEach((t, index) => {
      if (t.id == null) return
      previous.push({
        tabId: t.id,
        windowId,
        index,
        groupId: t.groupId ?? -1,
        pinned: !!t.pinned,
      })
    })
  }

  return {
    createdAt: Date.now(),
    method,
    scope,
    windowIds,
    groups,
    previous,
    closed: [],
    createdGroupIds: [],
  }
}

/** Records tabs the pass closed so undo can bring them back. */
export function recordClosed(
  snapshot: UndoSnapshot,
  closed: Array<{ url: string; title: string; windowId: WindowId; index: number; pinned: boolean; customTitle?: string }>,
): UndoSnapshot {
  return { ...snapshot, closed: [...snapshot.closed, ...closed] }
}

export interface UndoResult {
  ok: boolean
  restoredTabs: number
  reopenedTabs: number
  error?: string
}

/**
 * Restores the arrangement captured in the snapshot.
 *
 * Order of operations matters: reopen closed tabs first so their target groups
 * exist again, then clear every group, then rebuild the recorded groups, then
 * restore the tab order.
 */
export async function applyUndo(snapshot: UndoSnapshot): Promise<UndoResult> {
  const settings = await getSettings()
  let reopened = 0

  try {
    /*
     * A consolidating pass (`scope: all_windows`) moves every tab into one
     * window, which closes the windows it emptied. Those ids are gone by the
     * time undo runs, so recreating a tab "into" one silently fails and the
     * window is never restored. Map each vanished window to a fresh one first.
     */
    const liveWindows = new Set<number>()
    try {
      for (const w of await chrome.windows.getAll({ populate: false })) {
        if (w.id != null) liveWindows.add(w.id)
      }
    } catch {
      // cannot enumerate; assume everything still exists and let the
      // individual creates fail loudly rather than inventing windows
      for (const id of snapshot.windowIds) liveWindows.add(id)
    }

    const windowRemap = new Map<number, number>()
    // `chrome.windows.create` always seeds the new window with a blank tab.
    // Those seeds are not part of the snapshot, so unless they are removed the
    // undo finishes with extra tabs (merging 3 windows and undoing gave 16 tabs
    // back as 18). Collect them and close them once the real tabs have landed.
    const seedTabs: TabId[] = []
    for (const id of snapshot.windowIds) {
      if (liveWindows.has(id)) continue
      try {
        const w = await chrome.windows.create({ focused: false })
        if (w.id != null) {
          windowRemap.set(id, w.id)
          for (const t of w.tabs ?? []) if (t.id != null) seedTabs.push(t.id)
        }
      } catch {
        /* fall through: the tabs will land in the current window */
      }
    }
    const targetWindow = (id: number): number | undefined => windowRemap.get(id) ?? id

    /* 1. reopen anything the pass closed */
    for (const c of snapshot.closed) {
      try {
        const tab = await chrome.tabs.create({
          url: c.url,
          windowId: targetWindow(c.windowId),
          active: false,
          index: Math.min(c.index, 9999),
        })
        if (tab.id != null) {
          if (c.pinned) await chrome.tabs.update(tab.id, { pinned: true })
          if (c.customTitle) await applyCustomTitle(tab.id, c.customTitle)
          reopened++
        }
      } catch {
        // the window may be gone; skip this one
      }
    }

    /* 2. flatten every group in the affected windows */
    // resolve through the remap: for a window that was closed and recreated the
    // tabs live under the new id, and the old one yields nothing
    for (const windowId of snapshot.windowIds) {
      const tabs = await tabsInWindow(targetWindow(windowId) ?? windowId)
      const grouped = tabs
        .filter((t) => t.id != null && t.groupId !== undefined && t.groupId !== -1)
        .filter((t) => (settings.protectPinned ? !t.pinned : true))
        .map((t) => t.id!)
      if (grouped.length) await ungroupTabs(grouped)
    }

    /* 3. rebuild the recorded groups and put their tabs back */
    const live = new Map<TabId, chrome.tabs.Tab>()
    for (const windowId of snapshot.windowIds) {
      for (const t of await tabsInWindow(targetWindow(windowId) ?? windowId)) {
        if (t.id != null) live.set(t.id, t)
      }
    }

    const byOriginalGroup = new Map<number, TabId[]>()
    for (const p of snapshot.previous) {
      if (p.groupId === -1) continue
      if (!live.has(p.tabId)) continue
      const arr = byOriginalGroup.get(p.groupId)
      if (arr) arr.push(p.tabId)
      else byOriginalGroup.set(p.groupId, [p.tabId])
    }

    for (const g of snapshot.groups) {
      const ids = (byOriginalGroup.get(g.id) ?? []).filter((id) => live.has(id))
      if (!ids.length) continue
      try {
        /*
         * Resolve through the remap, and make sure the members are actually in
         * that window first. After a merge every tab sits in the destination
         * window, so grouping against the original id would either fail outright
         * (the window is gone) or land the group in the wrong window. Chrome
         * also refuses to create a group whose window does not hold its tabs.
         */
        const windowId = targetWindow(g.windowId)
        if (windowId === undefined) continue
        const misplaced = ids.filter((id) => live.get(id)?.windowId !== windowId)
        if (misplaced.length) {
          await chrome.tabs.move(misplaced, { windowId, index: -1 })
        }
        const groupId = await chrome.tabs.group({
          tabIds: ids,
          createProperties: { windowId },
        })
        await chrome.tabGroups.update(groupId, {
          title: g.title,
          color: g.color,
          collapsed: g.collapsed,
        })
      } catch {
        // group could not be rebuilt; the tabs stay ungrouped, which is safe
      }
    }

    /* 4. restore tab order, back to front so indices stay valid */
    const ordered = [...snapshot.previous]
      .filter((p) => live.has(p.tabId))
      .sort((a, b) => b.index - a.index)
    for (const p of ordered) {
      try {
        await chrome.tabs.move(p.tabId, {
          windowId: targetWindow(p.windowId) ?? p.windowId,
          index: p.index,
        })
      } catch {
        /* index may be past the end now; harmless */
      }
    }

    /* 5. drop the blank tab each recreated window came with */
    for (const seed of seedTabs) {
      try {
        // only if the window now holds real tabs, or the window would vanish
        const tab = await chrome.tabs.get(seed)
        const siblings = await tabsInWindow(tab.windowId)
        if (siblings.filter((t) => t.id !== seed).length > 0) {
          await chrome.tabs.remove(seed)
        }
      } catch {
        /* already gone */
      }
    }

    return { ok: true, restoredTabs: snapshot.previous.length, reopenedTabs: reopened }
  } catch (e) {
    return {
      ok: false,
      restoredTabs: 0,
      reopenedTabs: reopened,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/** Applies a user-chosen name to a tab by rewriting the page title. */
export async function applyCustomTitle(tabId: TabId, title: string): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (t: string) => {
        document.title = t
      },
      args: [title],
    })
    return true
  } catch {
    return false
  }
}

/** Human summary for the undo button tooltip. */
export function describeSnapshot(s: UndoSnapshot | null): string {
  if (!s) return "Nothing to undo yet"
  const when = new Date(s.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
  return `Undo the ${s.method.replace("_", " ")} pass from ${when} (${s.previous.length} tabs)`
}

export { displayTitle }
