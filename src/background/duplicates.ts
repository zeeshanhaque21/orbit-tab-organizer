/**
 * Duplicate detection and cleaning.
 *
 * Two match modes: `url` compares a normalised URL (fragment and tracking
 * parameters stripped, query sorted), `title_url` additionally requires the
 * titles to match, which is stricter and safer.
 *
 * The survivor of each duplicate set is chosen in this order: the active tab,
 * then a pinned tab, then the most recently accessed. Pinned tabs are never
 * closed when `protectPinned` is on.
 */
import { normalizeUrl } from "../shared/format"
import type { DuplicateMatchMode, TabRecord, TabId, WindowId } from "../shared/types"
import { allRecords, hydrateTabs, persistNow, reconcileTabs } from "./tabs"
import { getSettings } from "./store"
import { closeTabs } from "./recycle"

export interface DuplicateSet {
  key: string
  /** the tab we keep */
  keep: TabId
  /** the tabs we would close */
  remove: TabId[]
}

/** Groups records into duplicate sets. Order within a set is by preference. */
export function findDuplicates(
  records: TabRecord[],
  mode: DuplicateMatchMode,
  opts: { protectPinned?: boolean; windowIds?: WindowId[] } = {},
): DuplicateSet[] {
  const pool = opts.windowIds
    ? records.filter((r) => opts.windowIds!.includes(r.windowId))
    : records

  const buckets = new Map<string, TabRecord[]>()
  for (const rec of pool) {
    if (!rec.url || rec.url.startsWith("chrome") || rec.url.startsWith("about:")) continue
    const norm = normalizeUrl(rec.url)
    if (!norm) continue
    const key = mode === "title_url" ? `${norm}\u0000${(rec.title || "").trim()}` : norm
    const arr = buckets.get(key)
    if (arr) arr.push(rec)
    else buckets.set(key, [rec])
  }

  const out: DuplicateSet[] = []
  for (const [key, group] of buckets) {
    if (group.length < 2) continue

    // pick the survivor: active > pinned > most recent
    const ranked = [...group].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.lastAccess - a.lastAccess
    })
    const keep = ranked[0]
    const remove = ranked
      .slice(1)
      .filter((r) => !(opts.protectPinned && r.pinned))
      .filter((r) => !r.active)
      .map((r) => r.id)

    if (remove.length) out.push({ key, keep: keep.id, remove })
  }
  return out
}

export interface CleanResult {
  ok: boolean
  found: number
  closed: number
  binned: number
  error?: string
}

/** Detects and removes duplicate tabs according to the current settings. */
export async function cleanDuplicates(windowId?: WindowId): Promise<CleanResult> {
  await hydrateTabs()
  // catch tabs opened while the worker was asleep, otherwise they are invisible
  await reconcileTabs()
  const settings = await getSettings()

  const windowIds = windowId != null ? [windowId] : undefined
  const sets = findDuplicates(allRecords(), settings.duplicateMatchMode, {
    protectPinned: settings.protectPinned,
    windowIds,
  })

  if (!sets.length) {
    return { ok: true, found: 0, closed: 0, binned: 0 }
  }

  const removeIds = sets.flatMap((s) => s.remove)
  const res = await closeTabs(removeIds, {
    reason: "duplicate",
    toBin: settings.duplicateBinMode === "recycle",
    protectPinned: settings.protectPinned,
  })

  await persistNow()
  return { ok: true, found: sets.length, closed: res.closed, binned: res.binned }
}

/** Read-only preview used by the popup before committing. */
export async function previewDuplicates(windowId?: WindowId): Promise<{
  sets: number
  removable: number
  sample: Array<{ title: string; url: string; count: number }>
}> {
  await hydrateTabs()
  await reconcileTabs()
  const settings = await getSettings()
  const sets = findDuplicates(allRecords(), settings.duplicateMatchMode, {
    protectPinned: settings.protectPinned,
    windowIds: windowId != null ? [windowId] : undefined,
  })
  return {
    sets: sets.length,
    removable: sets.reduce((n, s) => n + s.remove.length, 0),
    sample: sets.slice(0, 5).map((s) => ({
      title: s.key.split("\u0000")[1] ?? "",
      url: s.key.split("\u0000")[0],
      count: s.remove.length + 1,
    })),
  }
}
