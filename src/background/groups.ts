/**
 * Everything that writes to Chrome's tab-group API.
 *
 * Chrome quirks handled here:
 *  - a group must contain at least one tab, and all of them in one window
 *  - pinned tabs cannot be grouped, so they are filtered out
 *  - a group sits at the position of its leftmost tab, which is how reordering
 *    is implemented
 */
import { GROUP_COLORS } from "../shared/constants"
import type { GroupColor, GroupId, PlannedGroup, TabId, WindowId } from "../shared/types"

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listGroups(windowId?: WindowId): Promise<chrome.tabGroups.TabGroup[]> {
  try {
    return await chrome.tabGroups.query(windowId === undefined ? {} : { windowId })
  } catch {
    return []
  }
}

export async function groupOf(groupId: GroupId): Promise<chrome.tabGroups.TabGroup | null> {
  try {
    return await chrome.tabGroups.get(groupId)
  } catch {
    return null
  }
}

export async function tabsInWindow(windowId: WindowId): Promise<chrome.tabs.Tab[]> {
  try {
    return await chrome.tabs.query({ windowId })
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* Colour assignment                                                   */
/* ------------------------------------------------------------------ */

/** Stable hash so a category keeps the same colour across runs. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/** Honours a preferred colour, otherwise derives a stable one from the label. */
export function colorFor(label: string, preferred?: GroupColor): GroupColor {
  if (preferred) return preferred
  return GROUP_COLORS[hash(label) % GROUP_COLORS.length]
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export async function ungroupTabs(tabIds: TabId[]): Promise<void> {
  if (!tabIds.length) return
  try {
    await chrome.tabs.ungroup(tabIds)
  } catch {
    // a tab that is already ungrouped makes this throw; retry one by one
    for (const id of tabIds) {
      try {
        await chrome.tabs.ungroup(id)
      } catch {
        /* already ungrouped */
      }
    }
  }
}

/** Ungroups every tab in the given windows. Returns the groups that were removed. */
export async function ungroupAll(windowId?: WindowId): Promise<GroupId[]> {
  const groups = await listGroups(windowId)
  const ids = groups.map((g) => g.id)
  if (!ids.length) return []

  const tabs = await chrome.tabs.query(windowId === undefined ? {} : { windowId })
  const grouped = tabs.filter((t) => t.id != null && t.groupId !== undefined && t.groupId !== -1)
  if (grouped.length) {
    await ungroupTabs(grouped.map((t) => t.id!))
  }
  return ids
}

export interface ApplyOptions {
  /** null keeps each group's current collapse state */
  collapsed: boolean | null
  /** reuse an existing group with the same title instead of making a new one */
  reuseExisting?: boolean
}

/**
 * Writes a plan to Chrome. Tabs are filtered to `windowId` and to non-pinned
 * tabs, groups with no eligible tabs are skipped, and one failing group does
 * not abort the rest.
 */
export async function applyPlan(
  plan: PlannedGroup[],
  windowId: WindowId,
  opts: ApplyOptions,
): Promise<GroupId[]> {
  const tabs = await tabsInWindow(windowId)
  const eligible = new Set(
    tabs.filter((t) => t.id != null && !t.pinned).map((t) => t.id as TabId),
  )

  const created: GroupId[] = []
  for (const g of plan) {
    const ids = g.tabs.filter((id) => eligible.has(id))
    if (!ids.length) continue
    try {
      const groupId = await chrome.tabs.group({
        tabIds: ids,
        createProperties: { windowId },
      })
      const patch: chrome.tabGroups.UpdateProperties = {
        title: g.title,
        color: g.color,
      }
      if (opts.collapsed !== null) patch.collapsed = opts.collapsed
      await chrome.tabGroups.update(groupId, patch)
      created.push(groupId)
    } catch {
      // most likely the tabs moved or closed mid-pass; skip this group
    }
  }
  return created
}

export async function updateGroup(
  groupId: GroupId,
  patch: { title?: string; color?: GroupColor; collapsed?: boolean },
): Promise<boolean> {
  try {
    await chrome.tabGroups.update(groupId, patch as chrome.tabGroups.UpdateProperties)
    return true
  } catch {
    return false
  }
}

/**
 * "Focus Active": keep the group holding the active tab open, collapse the rest.
 *
 * The reference ships this as a third value for `grouping_default_state`. It
 * needs the active tab, so unlike collapsed/expanded it cannot be expressed as a
 * single boolean.
 */
export async function applyFocusActive(windowId: WindowId): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ windowId })
    const activeGroup = tabs.find((t) => t.active)?.groupId ?? -1
    for (const g of await listGroups(windowId)) {
      const shouldCollapse = g.id !== activeGroup
      if (g.collapsed !== shouldCollapse) {
        await updateGroup(g.id, { collapsed: shouldCollapse })
      }
    }
  } catch {
    /* a window may have closed mid-pass */
  }
}

export async function collapseAll(windowId: WindowId, collapsed: boolean): Promise<number> {
  const groups = await listGroups(windowId)
  let n = 0
  for (const g of groups) {
    if (await updateGroup(g.id, { collapsed })) n++
  }
  return n
}

/* ------------------------------------------------------------------ */
/* Moving tabs                                                         */
/* ------------------------------------------------------------------ */

/**
 * Moves tabs into a group (or out of one when `targetGroupId` is null),
 * optionally into a different window first.
 */
export async function moveTabs(
  tabIds: TabId[],
  targetGroupId: GroupId | null,
  targetWindowId?: WindowId,
): Promise<{ moved: number; error?: string }> {
  if (!tabIds.length) return { moved: 0 }

  let ids = tabIds
  try {
    if (targetWindowId !== undefined) {
      const tabs = await chrome.tabs.query({})
      const toMove = tabs
        .filter((t) => t.id != null && ids.includes(t.id) && t.windowId !== targetWindowId)
        .map((t) => t.id!)
      if (toMove.length) {
        await chrome.tabs.move(toMove, { windowId: targetWindowId, index: -1 })
      }
      ids = tabIds
    }

    if (targetGroupId === null) {
      await ungroupTabs(ids)
    } else {
      await chrome.tabs.group({ tabIds: ids, groupId: targetGroupId })
    }
    return { moved: ids.length }
  } catch (e) {
    return { moved: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Puts a window's groups into title order. Chrome places a group at its
 * leftmost tab, so moving each group's tabs to the end in the desired order
 * leaves the groups themselves in that order.
 */
export async function reorderGroupsByTitle(windowId: WindowId): Promise<boolean> {
  const groups = await listGroups(windowId)
  if (groups.length < 2) return false

  const sorted = [...groups].sort((a, b) =>
    (a.title || "").localeCompare(b.title || "", undefined, { numeric: true, sensitivity: "base" }),
  )

  const alreadyOrdered = groups.every((g, i) => g.id === sorted[i].id)
  if (alreadyOrdered) return false

  const tabs = await tabsInWindow(windowId)
  try {
    for (const g of sorted) {
      const ids = tabs.filter((t) => t.groupId === g.id && t.id != null).map((t) => t.id!)
      if (ids.length) await chrome.tabs.move(ids, { index: -1 })
    }
    return true
  } catch {
    return false
  }
}

/** Moves a single group's tabs to the end of the window. */
export async function sendGroupToEnd(windowId: WindowId, groupId: GroupId): Promise<boolean> {
  const tabs = await tabsInWindow(windowId)
  const ids = tabs.filter((t) => t.groupId === groupId && t.id != null).map((t) => t.id!)
  if (!ids.length) return false
  try {
    await chrome.tabs.move(ids, { index: -1 })
    return true
  } catch {
    return false
  }
}
