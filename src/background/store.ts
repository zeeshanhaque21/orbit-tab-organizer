/**
 * Settings and persisted state.
 *
 * Settings are cached in memory because the service worker wakes on every tab
 * event; the cache is invalidated by the storage change listener so multiple
 * windows stay in sync.
 */
import { DEFAULT_SETTINGS, STORAGE } from "../shared/constants"
import type { RecycleEntry, SavedGroup, Settings, TabRecord, TopicSet, UndoSnapshot } from "../shared/types"

let settingsCache: Settings | null = null

/** Deep-merges stored settings over the defaults so new keys appear on upgrade. */
function merge(base: Settings, patch: Partial<Settings> | undefined): Settings {
  if (!patch) return { ...base, ai: { ...base.ai } }
  return {
    ...base,
    ...patch,
    ai: { ...base.ai, ...(patch.ai ?? {}) },
    customTabTitles: { ...base.customTabTitles, ...(patch.customTabTitles ?? {}) },
  }
}

export async function getSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache
  const raw = await chrome.storage.local.get(STORAGE.settings)
  settingsCache = merge(DEFAULT_SETTINGS, raw[STORAGE.settings] as Partial<Settings> | undefined)
  return settingsCache
}

/** Synchronous read of the cache; only valid after `getSettings()` has run once. */
export function settingsSync(): Settings {
  return settingsCache ?? DEFAULT_SETTINGS
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = merge(await getSettings(), patch)
  settingsCache = next
  await chrome.storage.local.set({ [STORAGE.settings]: next })
  return next
}

export async function read<T>(key: string, fallback: T): Promise<T> {
  const raw = await chrome.storage.local.get(key)
  const v = raw[key]
  return (v === undefined ? fallback : v) as T
}

export async function write(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value })
}

export async function remove(key: string): Promise<void> {
  await chrome.storage.local.remove(key)
}

/* ---------- typed accessors for the bigger collections ---------- */

export const getTabRecords = () => read<Record<string, TabRecord>>(STORAGE.tabRecords, {})
export const setTabRecords = (v: Record<string, TabRecord>) => write(STORAGE.tabRecords, v)

export const getUndo = () => read<UndoSnapshot | null>(STORAGE.undo, null)
export const setUndo = (v: UndoSnapshot | null) => write(STORAGE.undo, v)

export const getRecycle = () => read<RecycleEntry[]>(STORAGE.recycle, [])
export const setRecycle = (v: RecycleEntry[]) => write(STORAGE.recycle, v)

export const getSavedGroups = () => read<SavedGroup[]>(STORAGE.savedGroups, [])
export const setSavedGroups = (v: SavedGroup[]) => write(STORAGE.savedGroups, v)

export const getTopicSets = () => read<TopicSet[]>(STORAGE.topicSets, [])
export const setTopicSets = (v: TopicSet[]) => write(STORAGE.topicSets, v)

/** tabId -> the group title the user last put that tab in. Powers Memory. */
export type MemoryMap = Record<string, string>
export const getMemory = () => read<MemoryMap>(STORAGE.memory, {})
export const setMemory = (v: MemoryMap) => write(STORAGE.memory, v)

/* ---------- cache invalidation ---------- */

export function installSettingsListener(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return
    if (STORAGE.settings in changes) {
      const next = changes[STORAGE.settings].newValue as Partial<Settings> | undefined
      settingsCache = merge(DEFAULT_SETTINGS, next)
    }
  })
}

export function resetSettingsCache(): void {
  settingsCache = null
}

/* ---------- reset / wipe ---------- */

export async function wipeAllData(keepSettings = true): Promise<void> {
  const keys: string[] = [
    STORAGE.tabRecords,
    STORAGE.undo,
    STORAGE.recycle,
    STORAGE.savedGroups,
    STORAGE.topicSets,
    STORAGE.memory,
  ]
  if (!keepSettings) keys.push(STORAGE.settings)
  await chrome.storage.local.remove(keys)
  if (!keepSettings) settingsCache = null
}
