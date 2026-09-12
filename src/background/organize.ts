/**
 * The organizer.
 *
 * One pass is: snapshot the windows, work out the groups, flatten what was
 * there, write the new groups, then apply the collapse state and ordering.
 * The snapshot is kept so the whole pass can be reversed.
 */
import { CATEGORY_RULES } from "./ai/lexicon"
import { STORAGE } from "../shared/constants"
import { isRestrictedUrl } from "../shared/format"
import type {
  GroupColor,
  GroupId,
  GroupingInstructions,
  GroupingMethod,
  GroupingScope,
  OrganizeResult,
  PlannedGroup,
  Settings,
  TabId,
  TabRecord,
  UndoSnapshot,
  WindowId,
} from "../shared/types"
import { applyFocusActive, applyPlan, colorFor, listGroups, reorderGroupsByTitle, ungroupAll } from "./groups"
import { allRecords, hydrateTabs, persistNow, reconcileTabs } from "./tabs"
import { getMemory, getSettings, getTopicSets, getUndo, read, setUndo, write } from "./store"
import { applyCustomTitle, applyUndo, captureSnapshot } from "./undo"
import { bucketLastAccess } from "./methods/lastAccess"
import { groupByTopics, topicColors } from "./methods/topics"
import { tierFrequency } from "./methods/frequency"
import { classifyByCategory } from "./methods/category"
import { groupByRelevance } from "./methods/relevance"
import { groupByMemory } from "./methods/memory"
import { tidyLabel } from "./methods/util"

/** category -> colour, taken from the lexicon so the palette stays consistent */
const LEXICON_COLORS = new Map<string, GroupColor>(
  CATEGORY_RULES.map((r) => [r.category, r.color]),
)

export interface OrganizeOptions {
  method?: GroupingMethod
  scope?: GroupingScope
  /** explicit window; falls back to the last focused one */
  windowId?: WindowId
  /** Auto-Organize skips the snapshot so it cannot clobber a manual undo point */
  skipUndo?: boolean
}

interface MethodOutcome {
  instructions: GroupingInstructions
  source: "ai" | "local" | "mixed"
  aiMs?: number
  error?: string
}

/* ------------------------------------------------------------------ */
/* Window resolution                                                   */
/* ------------------------------------------------------------------ */

async function lastFocusedWindowId(): Promise<WindowId | null> {
  try {
    const w = await chrome.windows.getLastFocused({ populate: false })
    return w.id ?? null
  } catch {
    return null
  }
}

async function allWindowIds(): Promise<WindowId[]> {
  try {
    const ws = await chrome.windows.getAll({ populate: false })
    return ws.map((w) => w.id).filter((id): id is number => id != null)
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* Method dispatch                                                     */
/* ------------------------------------------------------------------ */

async function runMethod(
  method: GroupingMethod,
  records: TabRecord[],
  windowId: WindowId | null,
): Promise<MethodOutcome> {
  const settings = await getSettings()

  switch (method) {
    case "last_access":
      return { instructions: bucketLastAccess(records), source: "local" }

    case "frequency": {
      // deterministic local tiers; no network needed for a ranking problem
      return { instructions: tierFrequency(records), source: "local" }
    }

    case "relevance": {
      let activeTabId: number | null = null
      try {
        const [active] = await chrome.tabs.query({ active: true, windowId: windowId ?? undefined })
        activeTabId = active?.id ?? null
      } catch {
        /* no active tab; the method degrades to a single bucket */
      }
      return { instructions: groupByRelevance(records, activeTabId), source: "local" }
    }

    case "memory": {
      const memory = await getMemory()
      const { groups } = groupByMemory(records, memory)
      return { instructions: groups, source: "local" }
    }

    case "topics": {
      const sets = await getTopicSets()
      const active = sets.find((s) => s.id === settings.activeTopicSetId) ?? sets[0] ?? null
      if (!active) {
        // no topic set configured - fall back to the built-in classifier
        const res = await classifyByCategory(records, settings)
        return {
          instructions: res.groups,
          source: res.source,
          aiMs: res.aiMs,
          error: res.error ?? "No topic set is active, used By Category instead",
        }
      }
      return { instructions: groupByTopics(records, active), source: "local" }
    }

    case "category":
    default: {
      const res = await classifyByCategory(records, settings)
      return { instructions: res.groups, source: res.source, aiMs: res.aiMs, error: res.error }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Plan building                                                       */
/* ------------------------------------------------------------------ */

function buildPlan(
  instructions: GroupingInstructions,
  records: TabRecord[],
  windowId: WindowId,
  colors: Map<string, GroupColor>,
): PlannedGroup[] {
  const inWindow = new Map<number, TabRecord>()
  for (const r of records) if (r.windowId === windowId) inWindow.set(r.id, r)

  const plan: PlannedGroup[] = []
  for (const [rawName, ids] of Object.entries(instructions)) {
    const title = tidyLabel(rawName)
    const present = ids.filter((id) => inWindow.has(id))
    if (!present.length) continue
    plan.push({
      title,
      color: colors.get(title) ?? colorFor(title),
      tabs: present,
    })
  }
  return plan
}

/* ------------------------------------------------------------------ */
/* The pass                                                            */
/* ------------------------------------------------------------------ */

export async function organize(opts: OrganizeOptions = {}): Promise<OrganizeResult> {
  await hydrateTabs()
  // a tab opened while the worker was asleep is not in the tracker yet, and
  // would otherwise be left out of the pass entirely
  await reconcileTabs()
  const settings = await getSettings()
  const method = opts.method ?? settings.method
  const scope: GroupingScope = opts.scope ?? settings.scope

  const focused = opts.windowId ?? (await lastFocusedWindowId())
  const targets: WindowId[] =
    scope === "all_windows" ? await allWindowIds() : focused != null ? [focused] : []

  if (!targets.length) {
    return { ok: false, method, groups: 0, tabsGrouped: 0, closed: 0, error: "No window to organize" }
  }

  // when consolidating, every tab lands in the focused window
  const destination = focused ?? targets[0]

  const all = allRecords()
  const candidates = all.filter(
    (r) =>
      targets.includes(r.windowId) &&
      !isRestrictedUrl(r.url) &&
      (!settings.protectPinned || !r.pinned),
  )

  if (candidates.length < 2) {
    return {
      ok: false,
      method,
      groups: 0,
      tabsGrouped: 0,
      closed: 0,
      error: "Nothing to organize",
    }
  }

  // 1. snapshot before anything moves
  let snapshot: UndoSnapshot | null = null
  if (!opts.skipUndo) {
    try {
      snapshot = await captureSnapshot(targets, method, scope)
    } catch {
      snapshot = null
    }
  }

  // 2. consolidate windows first, so the grouping pass sees one window
  if (scope === "all_windows") {
    const toMove = candidates
      .filter((r) => r.windowId !== destination)
      .map((r) => r.id)
    if (toMove.length) {
      try {
        await chrome.tabs.move(toMove, { windowId: destination, index: -1 })
        for (const r of candidates) r.windowId = destination
      } catch {
        // if the move fails we still organize what is already in place
      }
    }
  }

  const scoped = candidates.filter((r) => r.windowId === destination)

  // 3a. Locked incremental pass.
  // Only By Category, only a repeat run, and only when the user has not asked to
  // consolidate. Everything already grouped is left exactly as it is.
  if (method === "category" && settings.lockGroups && scope !== "all_windows") {
    const meta = await read<{ lastOrganizationMethod?: string }>(STORAGE.meta, {})
    if (meta?.lastOrganizationMethod === "category") {
      const inc = await planCategoryIncremental(destination)
      if (inc) {
        const collapsedState =
          settings.groupingDefaultState === "collapsed"
            ? true
            : settings.groupingDefaultState === "expanded"
              ? false
              : null

        let merged = 0
        for (const m of inc.merge) {
          try {
            await chrome.tabs.group({ tabIds: m.ids, groupId: m.groupId })
            merged += m.ids.length
          } catch {
            /* the group may have been removed between the read and the write */
          }
        }

        const colors = new Map<string, GroupColor>()
        for (const [name, c] of LEXICON_COLORS) colors.set(name, c)
        const plan = buildPlan(inc.fresh, scoped, destination, colors)
        const created = plan.length ? await applyPlan(plan, destination, { collapsed: collapsedState }) : []

        if (settings.orderGroupsByTitle) await reorderGroupsByTitle(destination)
        // Focus Active applies on this path too - the locked incremental pass is
        // still a pass, and skipping it here made the setting silently do
        // nothing whenever lockGroups was on.
        if (settings.groupingDefaultState === "active-only") {
          await applyFocusActive(destination)
        }
        if (snapshot) {
          snapshot.createdGroupIds = created
          await setUndo(snapshot)
        }
        await persistNow()

        const tabsGrouped = merged + plan.reduce((n, g) => n + g.tabs.length, 0)
        return {
          ok: tabsGrouped > 0,
          method,
          groups: created.length,
          tabsGrouped,
          closed: 0,
          fallback: inc.source === "ai" ? undefined : "local",
          error: inc.error,
          aiMs: inc.aiMs,
        }
      }
      // nothing new to file - fall through to a full pass rather than no-op
    }
  }

  // 3. work out the groups
  const outcome = await runMethod(method, scoped, destination)

  // 4. colours: topics and the lexicon carry their own, everything else hashes
  const colors = new Map<string, GroupColor>()
  if (method === "topics") {
    const sets = await getTopicSets()
    const active = sets.find((s) => s.id === settings.activeTopicSetId) ?? sets[0] ?? null
    for (const [name, c] of Object.entries(topicColors(active))) colors.set(name, c as GroupColor)
  } else {
    for (const [name, c] of LEXICON_COLORS) colors.set(name, c)
  }

  // 5. flatten, then write
  try {
    for (const w of targets) {
      await ungroupAll(w)
    }
  } catch {
    /* a window may have closed mid-pass */
  }

  const collapsed =
    settings.groupingDefaultState === "collapsed"
      ? true
      : settings.groupingDefaultState === "expanded"
        ? false
        : null

  const plan = buildPlan(outcome.instructions, scoped, destination, colors)
  let created: GroupId[] = []
  if (plan.length) {
    created = await applyPlan(plan, destination, { collapsed })
  }

  // "Focus Active" needs the active tab, so it runs after the groups exist
  if (settings.groupingDefaultState === "active-only") {
    await applyFocusActive(destination)
  }

  if (settings.orderGroupsByTitle) {
    await reorderGroupsByTitle(destination)
  }

  // 6. keep the snapshot so the pass can be reversed
  if (snapshot) {
    snapshot.createdGroupIds = created
    // NOTE: snapshot.groups must stay exactly as captured BEFORE the pass.
    // Undo rebuilds those groups from their recorded ids, and the pass has
    // already destroyed them, so overwriting this with the new groups would
    // leave undo with nothing to reconstruct.
    await setUndo(snapshot)
  }

  await persistNow()

  // remember which method ran, so a repeat By Category pass can take the locked
  // incremental path instead of tearing the arrangement down
  try {
    await write(STORAGE.meta, { ...(await read<Record<string, unknown>>(STORAGE.meta, {})), lastOrganizationMethod: method })
  } catch {
    /* bookkeeping only; never fail a pass over it */
  }

  const tabsGrouped = plan.reduce((n, g) => n + g.tabs.length, 0)
  return {
    ok: plan.length > 0,
    method,
    groups: created.length,
    tabsGrouped,
    closed: 0,
    fallback: outcome.source === "ai" ? undefined : "local",
    error: outcome.error,
    aiMs: outcome.aiMs,
  }
}

/**
 * By Category with `lockGroups`, on a repeat run.
 *
 * Only taken when the previous pass was also By Category. It is the difference
 * between "organize" meaning *file my new tabs* and *throw away what I
 * arranged*: the full pass ungroups every window first, which is exactly what
 * this avoids.
 *
 * Returns null when there is nothing new to file, so the caller can fall back to
 * a normal pass rather than reporting a no-op as a success.
 */
async function planCategoryIncremental(windowId: WindowId): Promise<{
  merge: Array<{ groupId: GroupId; ids: TabId[] }>
  fresh: GroupingInstructions
  source: "ai" | "local" | "mixed"
  aiMs?: number
  error?: string
} | null> {
  const live = await chrome.tabs.query({ windowId, windowType: "normal" })
  const ungrouped = live.filter(
    (t) => t.id != null && typeof t.url === "string" && t.groupId === -1 && !isRestrictedUrl(t.url),
  )
  if (!ungrouped.length) return null

  const existing = await chrome.tabGroups.query({ windowId })
  const byTitle = new Map<string, GroupId>()
  for (const g of existing) {
    const t = (g.title ?? "").trim()
    if (t) byTitle.set(t.toLowerCase(), g.id)
  }

  const records = ungrouped.map(
    (t) =>
      ({
        id: t.id as TabId,
        url: String(t.url),
        title: String(t.title ?? ""),
      }) as TabRecord,
  )

  const res = await classifyByCategory(records, await getSettings())

  const merge: Array<{ groupId: GroupId; ids: TabId[] }> = []
  const fresh: GroupingInstructions = {}
  for (const [name, ids] of Object.entries(res.groups)) {
    if (!ids.length) continue
    const gid = byTitle.get(name.trim().toLowerCase())
    if (gid != null) merge.push({ groupId: gid, ids })
    else fresh[name] = ids
  }

  if (!merge.length && !Object.keys(fresh).length) return null
  return { merge, fresh, source: res.source, aiMs: res.aiMs, error: res.error }
}

/* ------------------------------------------------------------------ */
/* Other bulk actions                                                  */
/* ------------------------------------------------------------------ */

export async function ungroupEverything(windowId?: WindowId): Promise<number> {
  const settings = await getSettings()
  const targets = windowId != null ? [windowId] : await allWindowIds()
  let n = 0
  for (const w of targets) {
    const groups = await listGroups(w)
    if (settings.protectPinned) {
      // leave groups that hold a pinned tab alone
      const tabs = await chrome.tabs.query({ windowId: w }).catch(() => [])
      const pinnedGroups = new Set(tabs.filter((t) => t.pinned).map((t) => t.groupId))
      for (const g of groups) {
        if (pinnedGroups.has(g.id)) continue
      }
    }
    n += (await ungroupAll(w)).length
  }
  await persistNow()
  return n
}

export async function undoLast(): Promise<{ ok: boolean; message: string }> {
  const snapshot = await getUndo()
  if (!snapshot) return { ok: false, message: "Nothing to undo yet" }

  const res = await applyUndo(snapshot)
  if (!res.ok) return { ok: false, message: res.error ?? "Undo failed" }

  await setUndo(null)
  await hydrateTabs()
  await persistNow()
  return {
    ok: true,
    message:
      res.reopenedTabs > 0
        ? `Restored, reopened ${res.reopenedTabs} tab${res.reopenedTabs === 1 ? "" : "s"}`
        : "Restored to before the last organize",
  }
}

/** Re-applies a custom tab name after the page navigates. */
export async function reapplyCustomTitle(tabId: number): Promise<void> {
  const { customTabTitles } = await getSettings()
  const title = customTabTitles[String(tabId)]
  if (!title) return
  await applyCustomTitle(tabId, title)
}
