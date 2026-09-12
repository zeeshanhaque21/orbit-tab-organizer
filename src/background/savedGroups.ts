/**
 * Saved groups: snapshot a set of tabs, then reopen it later as a real
 * Chrome tab group, in the current window or a fresh one.
 */
import { LIMITS } from "../shared/constants"
import { displayTitle } from "../shared/format"
import type { GroupColor, SavedGroup, SavedTab, TabId } from "../shared/types"
import { getSavedGroups, setSavedGroups } from "./store"
import { colorFor } from "./groups"

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `sg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

export async function listSaved(): Promise<SavedGroup[]> {
  const list = await getSavedGroups()
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
}

/** Captures the given tabs into a new saved group. */
export async function createSaved(
  name: string,
  tabIds: TabId[],
  color?: GroupColor,
): Promise<{ ok: boolean; group?: SavedGroup; error?: string }> {
  const all = await getSavedGroups()
  if (all.length >= LIMITS.savedGroups) {
    return { ok: false, error: `Saved group limit reached (${LIMITS.savedGroups})` }
  }

  let tabs: chrome.tabs.Tab[] = []
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return { ok: false, error: "Could not read tabs" }
  }

  const wanted = new Set(tabIds)
  const picked = tabs.filter((t) => t.id != null && wanted.has(t.id))
  if (!picked.length) return { ok: false, error: "No tabs selected" }

  const savedTabs: SavedTab[] = picked
    .filter((t) => t.url && !t.url.startsWith("chrome://"))
    .map((t) => ({
      url: t.url!,
      title: displayTitle({ title: t.title, url: t.url }),
      pinned: !!t.pinned,
    }))

  if (!savedTabs.length) return { ok: false, error: "Those tabs cannot be saved" }

  const group: SavedGroup = {
    id: newId(),
    name: name.trim() || `Group ${all.length + 1}`,
    color: color ?? colorFor(name || String(all.length)),
    tabs: savedTabs,
    createdAt: Date.now(),
    sourceWindow: picked[0]?.windowId != null ? `Window ${picked[0].windowId}` : undefined,
  }

  await setSavedGroups([group, ...all])
  return { ok: true, group }
}

export async function updateSaved(id: string, patch: Partial<SavedGroup>): Promise<boolean> {
  const all = await getSavedGroups()
  const idx = all.findIndex((g) => g.id === id)
  if (idx === -1) return false
  const next = [...all]
  next[idx] = { ...next[idx], ...patch, id }
  await setSavedGroups(next)
  return true
}

export async function deleteSaved(id: string): Promise<boolean> {
  const all = await getSavedGroups()
  const next = all.filter((g) => g.id !== id)
  if (next.length === all.length) return false
  await setSavedGroups(next)
  return true
}

/** Reopens a saved group. Returns how many tabs were created. */
export async function openSaved(
  id: string,
  newWindow: boolean,
): Promise<{ ok: boolean; opened: number; error?: string }> {
  const all = await getSavedGroups()
  const group = all.find((g) => g.id === id)
  if (!group) return { ok: false, opened: 0, error: "Saved group not found" }
  if (!group.tabs.length) return { ok: false, opened: 0, error: "This group has no tabs to open" }

  try {
    let windowId: number | undefined
    if (newWindow) {
      const w = await chrome.windows.create({ focused: true })
      windowId = w.id
    }

    const created: number[] = []
    for (const t of group.tabs) {
      try {
        const tab = await chrome.tabs.create({
          url: t.url,
          active: false,
          ...(windowId != null ? { windowId } : {}),
        })
        if (tab.id != null) {
          created.push(tab.id)
          if (t.pinned) await chrome.tabs.update(tab.id, { pinned: true })
        }
      } catch {
        // skip urls that can no longer be opened
      }
    }

    if (created.length) {
      const groupId = await chrome.tabs.group({
        tabIds: created,
        createProperties: windowId != null ? { windowId } : {},
      })
      await chrome.tabGroups.update(groupId, { title: group.name, color: group.color })
    }

    return { ok: true, opened: created.length }
  } catch (e) {
    return { ok: false, opened: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Suggests a name for a new group based on what the tabs have in common. */
export function suggestName(tabs: Array<{ title?: string; url?: string }>): string {
  if (!tabs.length) return "New group"
  const hosts = tabs
    .map((t) => {
      try {
        return new URL(t.url ?? "").hostname.replace(/^www\./, "")
      } catch {
        return ""
      }
    })
    .filter(Boolean)
  if (!hosts.length) return "New group"
  const first = hosts[0].split(".").slice(-2).join(".")
  const same = hosts.every((h) => h.endsWith(first))
  return same ? first : "Mixed tabs"
}
