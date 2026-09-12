/**
 * Service worker entry point.
 *
 * Chrome can terminate this worker at any moment, so every event listener is
 * registered synchronously at the top level. Handlers call `ensureReady()`
 * first, which hydrates the tab tracker exactly once per worker lifetime.
 */
import { DEFAULT_SETTINGS, STARTER_TOPIC_SETS, STORAGE } from "../shared/constants"
import { displayTitle, isRestrictedUrl } from "../shared/format"
import type {
  GroupColor,
  HubState,
  Message,
  MessageResponse,
  Settings,
  TabId,
  TopicSet,
} from "../shared/types"
import { testProvider } from "./ai/provider"
import { cleanDuplicates, previewDuplicates } from "./duplicates"
import { collapseAll, listGroups, moveTabs, reorderGroupsByTitle, ungroupAll, updateGroup } from "./groups"
import { forget, learn, memoryStats } from "./methods/memory"
import { organize, ungroupEverything, undoLast } from "./organize"
import { clearRecycle, closeTabs, listRecycle, restoreRecycle } from "./recycle"
import { createSaved, deleteSaved, listSaved, openSaved, updateSaved } from "./savedGroups"
import {
  getMemory,
  getSettings,
  getTopicSets,
  getUndo,
  installSettingsListener,
  read,
  remove,
  setMemory,
  setSettings,
  setTopicSets,
  wipeAllData,
  write,
} from "./store"
import {
  allRecords,
  hydrateTabs,
  observeAttached,
  observeCreated,
  observeMoved,
  observeRemoved,
  observeReplaced,
  observeUpdated,
  persistNow,
  recordOf,
  reconcileTabs,
  resetSessionCounters,
  resetTracker,
  touch,
} from "./tabs"
import { applyCustomTitle, captureSnapshot } from "./undo"

/* ------------------------------------------------------------------ */
/* Readiness                                                           */
/* ------------------------------------------------------------------ */

let readyPromise: Promise<void> | null = null

function ensureReady(): Promise<void> {
  readyPromise ??= (async () => {
    installSettingsListener()
    await hydrateTabs()
  })()
  return readyPromise
}

/** True while our own grouping pass is writing, so we do not learn from it. */
let organizing = false

void ensureReady()

/* ------------------------------------------------------------------ */
/* Install / update                                                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await ensureReady()
    if (details.reason === "install") {
      const existing = await getTopicSets()
      if (!existing.length) await setTopicSets(STARTER_TOPIC_SETS)
      await setSettings({})
    } else if (details.reason === "update") {
      const version = chrome.runtime.getManifest().version
      await write(STORAGE.meta, { whatsNewVersion: version, updatedAt: Date.now() })
      // a first-login tour must not replay after an upgrade
      await setSettings({ tourDone: true })
    }
    await installContextMenus()
  })()
})

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    resetTracker()
    await ensureReady()
    // resetTracker clears memory, but ensureReady re-hydrates from storage, so
    // the persisted per-session counters have to be zeroed explicitly. This is
    // the browser-startup boundary; an MV3 worker wake is a different event and
    // must NOT reset them.
    resetSessionCounters()
    await installContextMenus()
  })()
})

/* ------------------------------------------------------------------ */
/* Tab events                                                          */
/* ------------------------------------------------------------------ */

chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    await ensureReady()
    observeCreated(tab)
  })()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void (async () => {
    await ensureReady()
    observeUpdated(tabId, changeInfo, tab)

    // a user-set name has to be re-applied after every navigation
    if (changeInfo.status === "complete") {
      const settings = await getSettings()
      const custom = settings.customTabTitles[String(tabId)]
      if (custom) void applyCustomTitle(tabId, custom)

      if (settings.autoMode && !organizing && !isRestrictedUrl(tab.url)) {
        scheduleAuto(settings)
      }
    }

    // learn from a manual move into a group
    if (changeInfo.groupId !== undefined && !organizing) {
      void learnFromGroup(tabId, changeInfo.groupId)
    }
  })()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await ensureReady()
    observeRemoved(tabId)
  })()
})

chrome.tabs.onActivated.addListener((info) => {
  void (async () => {
    await ensureReady()
    touch(info.tabId)
    const settings = await getSettings()
    // By Last Access is cheap and time-sensitive, so it re-runs on activation
    if (settings.autoMode && !organizing && settings.autoMethod === "last_access") {
      scheduleAuto(settings, 600)
    }
  })()
})

chrome.tabs.onMoved.addListener((tabId, info) => {
  void (async () => {
    await ensureReady()
    observeMoved(tabId, info)
  })()
})

chrome.tabs.onAttached.addListener((tabId, info) => {
  void (async () => {
    await ensureReady()
    observeAttached(tabId, info)
  })()
})

chrome.tabs.onDetached.addListener((tabId) => {
  void (async () => {
    await ensureReady()
    observeRemoved(tabId)
  })()
})

chrome.tabs.onReplaced.addListener((added, removed) => {
  void (async () => {
    await ensureReady()
    observeReplaced(added, removed)
  })()
})

/* ------------------------------------------------------------------ */
/* Memory learning                                                     */
/* ------------------------------------------------------------------ */

/** Records that this site now belongs to this group title. */
async function learnFromGroup(tabId: TabId, groupId: number): Promise<void> {
  if (groupId === undefined || groupId === -1) return
  try {
    const rec = recordOf(tabId)
    if (!rec) return
    const group = await chrome.tabGroups.get(groupId)
    if (!group?.title) return
    const memory = await getMemory()
    const next = learn(memory, rec.url, group.title)
    if (next !== memory) await setMemory(next)
  } catch {
    /* group vanished between the event and the read */
  }
}

/** A group rename is a strong signal about where its tabs belong. */
chrome.tabGroups.onUpdated.addListener((group) => {
  void (async () => {
    if (organizing || !group.title) return
    await ensureReady()
    try {
      const tabs = await chrome.tabs.query({ groupId: group.id })
      const memory = await getMemory()
      let next = memory
      for (const t of tabs) {
        if (!t.url) continue
        next = learn(next, t.url, group.title)
      }
      if (next !== memory) await setMemory(next)
    } catch {
      /* nothing to learn */
    }
  })()
})

/* ------------------------------------------------------------------ */
/* Auto-organize                                                       */
/* ------------------------------------------------------------------ */

let autoTimer: ReturnType<typeof setTimeout> | undefined

function scheduleAuto(settings: Settings, delay = 1200): void {
  if (autoTimer) clearTimeout(autoTimer)
  autoTimer = setTimeout(() => {
    autoTimer = undefined
    void (async () => {
      if (organizing) return
      organizing = true
      try {
        await organize({ method: settings.autoMethod, scope: settings.scope, skipUndo: true })
      } catch {
        /* auto-organize is best-effort */
      } finally {
        organizing = false
      }
    })()
  }, delay)
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function focusedWindowId(): Promise<number | null> {
  try {
    const w = await chrome.windows.getLastFocused({ populate: false })
    return w.id ?? null
  } catch {
    return null
  }
}

async function openHub(hash = ""): Promise<void> {
  const url = chrome.runtime.getURL(`hub.html${hash}`)
  try {
    const existing = await chrome.tabs.query({ url: chrome.runtime.getURL("hub.html") })
    const hit = existing.find((t) => t.id != null)
    if (hit?.id != null) {
      await chrome.tabs.update(hit.id, { active: true })
      if (hit.windowId != null) await chrome.windows.update(hit.windowId, { focused: true })
      return
    }
  } catch {
    /* fall through to creating one */
  }
  await chrome.tabs.create({ url })
}

/**
 * Keyboard shortcuts that need a UI. The popup cannot receive arguments, so the
 * intent is parked in storage and the popup picks it up on open.
 */
async function openPopupWith(intent: "rename" | "search"): Promise<void> {
  await write(STORAGE.meta, { pendingIntent: intent, pendingAt: Date.now() })
  try {
    await chrome.action.openPopup()
    return
  } catch {
    /* openPopup needs Chrome 127+ and a user gesture */
  }
  await openHub(intent === "rename" ? "#rename" : "#search")
}

/**
 * The keyboard command dispatch.
 *
 * Exported for testing. Chrome handles extension accelerators at the browser UI
 * layer, so a synthesised key event from an automated browser never reaches
 * them - the *binding* can be asserted through chrome.commands.getAll(), and the
 * *behaviour* can be asserted by calling this directly. Returns a short
 * description of what it did.
 */
export async function handleCommand(command: string): Promise<string> {
  switch (command) {
    case "orbit_open_hub":
      await openHub()
      return "hub"

    case "orbit_toggle_collapse": {
      const win = await focusedWindowId()
      if (win == null) return "collapse:no-window"
      const groups = await listGroups(win)
      if (!groups.length) return "collapse:no-groups"
      // if anything is expanded, collapse everything; otherwise expand
      const target = groups.some((g) => !g.collapsed)
      const changed = await collapseAll(win, target)
      return `collapse:${target ? "collapsed" : "expanded"}:${changed}`
    }

    case "orbit_rename_tab":
      await openPopupWith("rename")
      return "rename"

    case "orbit_search_tab":
      await openPopupWith("search")
      return "search"

    default:
      return "unknown"
  }
}

chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    await ensureReady()
    await handleCommand(command)
  })()
})

/* ------------------------------------------------------------------ */
/* Context menus                                                       */
/* ------------------------------------------------------------------ */

async function installContextMenus(): Promise<void> {
  // Chrome accepts "tab" as a context even though the typings omit it
  const CTX = ["page", "tab"] as unknown as chrome.contextMenus.ContextType[]
  try {
    await chrome.contextMenus.removeAll()
    chrome.contextMenus.create({
      id: "orbit-organize",
      title: "Organize this window",
      contexts: CTX,
    })
    chrome.contextMenus.create({
      id: "orbit-clean",
      title: "Clean duplicate tabs",
      contexts: CTX,
    })
    chrome.contextMenus.create({ id: "orbit-sep-1", type: "separator", contexts: CTX })
    chrome.contextMenus.create({
      id: "orbit-rename",
      title: "Rename this tab",
      contexts: CTX,
    })
    chrome.contextMenus.create({
      id: "orbit-save",
      title: "Save tab to a group",
      contexts: CTX,
    })
    chrome.contextMenus.create({ id: "orbit-sep-2", type: "separator", contexts: CTX })
    chrome.contextMenus.create({
      id: "orbit-hub",
      title: "Open Orbit Hub",
      contexts: CTX,
    })
    chrome.contextMenus.create({
      id: "orbit-bin",
      title: "Send tab to the recycle bin",
      contexts: CTX,
    })
  } catch {
    /* menus already exist or the API is unavailable */
  }
}

/**
 * The context menu dispatch.
 *
 * Exported so it can be tested: Chrome's native context menu is browser UI and
 * cannot be driven from an automated browser, but the mapping from menu id to
 * action can be. Returns a short description of what it did.
 */
export async function handleContextMenuAction(
  menuItemId: string | number,
  tab: chrome.tabs.Tab | undefined,
): Promise<string> {
  const settings = await getSettings()
  switch (menuItemId) {
    case "orbit-organize": {
      organizing = true
      try {
        await organize({ windowId: tab?.windowId })
        return "organized"
      } finally {
        organizing = false
      }
    }
    case "orbit-clean": {
      const res = await cleanDuplicates(tab?.windowId)
      return `cleaned:${res.closed}`
    }
    case "orbit-rename":
      await openPopupWith("rename")
      return "rename"
    case "orbit-save": {
      if (tab?.id == null) return "save:no-tab"
      await createSaved(displayTitle({ title: tab.title, url: tab.url }).slice(0, 40), [tab.id])
      return "saved"
    }
    case "orbit-hub":
      await openHub()
      return "hub"
    case "orbit-bin": {
      if (tab?.id == null) return "bin:no-tab"
      await closeTabs([tab.id], {
        reason: "manual",
        toBin: true,
        protectPinned: settings.protectPinned,
      })
      return "binned"
    }
    default:
      return "unknown"
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    await ensureReady()
    await handleContextMenuAction(info.menuItemId, tab)
  })()
})

/* ------------------------------------------------------------------ */
/* Message router                                                      */
/* ------------------------------------------------------------------ */

function ok<T>(data?: T): MessageResponse<T> {
  return { ok: true, data }
}

function fail(error: unknown): MessageResponse<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

async function buildHubState(): Promise<HubState> {
  // Reconcile before reporting. A tab closed while the worker was asleep fires no
  // `onRemoved` we hear, so its record lingers and the Hub would draw a tab that
  // no longer exists - measured: the Hub reported 15 tabs in a window where
  // Chrome had 12. The organizer already reconciled; the surface that *displays*
  // the tabs did not.
  try {
    await hydrateTabs()
    await reconcileTabs()
  } catch {
    /* report whatever we have rather than failing the whole surface */
  }

  const records = allRecords()
  let windows: HubState["windows"] = []
  let groups: HubState["groups"] = []

  try {
    const ws = await chrome.windows.getAll({ populate: false })
    const focused = (await chrome.windows.getLastFocused({ populate: false })).id
    windows = ws
      .filter((w) => w.id != null)
      .map((w) => ({
        id: w.id!,
        focused: w.id === focused,
        tabCount: records.filter((r) => r.windowId === w.id).length,
      }))

    const gs = await listGroups()
    groups = gs.map((g) => ({
      id: g.id,
      windowId: g.windowId,
      title: g.title ?? "",
      color: g.color as GroupColor,
      collapsed: !!g.collapsed,
    }))
  } catch {
    /* running outside a real browser window; return tabs only */
  }

  return { windows, groups, tabs: records, canUndo: (await getUndo()) !== null }
}

chrome.runtime.onMessage.addListener(
  (msg: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
    void (async () => {
      await ensureReady()
      try {
        switch (msg.type) {
          case "ORGANIZE": {
            organizing = true
            try {
              sendResponse(ok(await organize(msg)))
            } finally {
              organizing = false
            }
            return
          }

          case "UNDO": {
            organizing = true
            try {
              const res = await undoLast()
              sendResponse(res.ok ? ok(res) : { ok: false, error: res.message })
            } finally {
              organizing = false
            }
            return
          }

          case "CLEAN_DUPLICATES":
            sendResponse(ok(await cleanDuplicates(msg.windowId)))
            return

          case "UNGROUP_ALL": {
            organizing = true
            try {
              sendResponse(ok({ groups: await ungroupEverything(msg.windowId) }))
            } finally {
              organizing = false
            }
            return
          }

          case "TOGGLE_COLLAPSE": {
            const win = msg.windowId ?? (await focusedWindowId())
            if (win == null) {
              sendResponse(ok({ changed: 0 }))
              return
            }
            sendResponse(ok({ changed: await collapseAll(win, msg.collapsed) }))
            return
          }

          case "REORDER_GROUPS": {
            const win = msg.windowId ?? (await focusedWindowId())
            if (win == null) {
              sendResponse(ok({ changed: false }))
              return
            }
            sendResponse(ok({ changed: await reorderGroupsByTitle(win) }))
            return
          }

          case "GET_SETTINGS":
            sendResponse(ok(await getSettings()))
            return

          case "SET_SETTINGS": {
            const next = await setSettings(msg.patch)
            sendResponse(ok(next))
            return
          }

          case "GET_HUB_STATE":
            sendResponse(ok(await buildHubState()))
            return

          case "GET_TOKEN_STATE": {
            // no metering exists here; report the provider instead so the
            // popup can show the same affordance honestly
            const settings = await getSettings()
            sendResponse(
              ok({
                provider: settings.ai.provider,
                model: settings.ai.model,
                unlimited: settings.ai.provider === "local" || !!settings.ai.apiKey,
              }),
            )
            return
          }

          case "MERGE_WINDOWS": {
            /*
             * Pull every tab from every window into one, leaving the tabs where
             * they are in the strip. This is deliberately NOT the same as
             * organizing with `scope: all_windows`: it changes no groups, runs
             * no classifier, and touches no network. It just merges.
             */
            const windows = await chrome.windows.getAll({ populate: false })
            const ids = windows.map((w) => w.id).filter((id): id is number => id != null)
            if (ids.length <= 1) {
              sendResponse(fail("There is only one window open."))
              return
            }

            // keep the focused window, so the user's view does not jump
            const destination = windows.find((w) => w.focused)?.id ?? ids[0]

            // snapshot first, so Undo can put the windows back
            let snapshot: Awaited<ReturnType<typeof captureSnapshot>> | null = null
            try {
              const s = await getSettings()
              snapshot = await captureSnapshot(ids, s.method, "all_windows")
            } catch {
              snapshot = null
            }

            const all = await chrome.tabs.query({})
            let moved = 0
            for (const w of windows) {
              if (w.id === destination) continue
              const moving = all
                .filter((t) => t.windowId === w.id && t.id != null)
                .sort((a, b) => a.index - b.index)
                .map((t) => t.id as number)
              if (!moving.length) continue
              try {
                await chrome.tabs.move(moving, { windowId: destination, index: -1 })
                moved += moving.length
              } catch {
                // the window may have closed mid-pass; keep going
              }
            }

            if (snapshot) await write(STORAGE.undo, snapshot)
            await hydrateTabs()
            sendResponse(ok({ moved, windowId: destination, windows: ids.length }))
            return
          }

          case "GET_WHATS_NEW": {
            // Set on update. The popup shows a notice until the user has seen
            // this version.
            const meta = await read<{ whatsNewVersion?: string }>(STORAGE.meta, {})
            const settings = await getSettings()
            const version = meta?.whatsNewVersion ?? null
            const pending = version && version !== settings.whatsNewSeenVersion ? version : null
            sendResponse(ok({ version: pending, current: chrome.runtime.getManifest().version }))
            return
          }

          case "DISMISS_WHATS_NEW": {
            const meta = await read<{ whatsNewVersion?: string }>(STORAGE.meta, {})
            await setSettings({ whatsNewSeenVersion: meta?.whatsNewVersion ?? null })
            sendResponse(ok({ dismissed: true }))
            return
          }

          case "SEARCH_TABS": {
            const q = msg.query.trim().toLowerCase()
            if (!q) {
              sendResponse(ok({ results: [] }))
              return
            }
            const results = allRecords()
              .filter(
                (r) =>
                  r.url.toLowerCase().includes(q) ||
                  r.title.toLowerCase().includes(q) ||
                  (r.customTitle ?? "").toLowerCase().includes(q),
              )
              .sort((a, b) => {
                // title matches rank above url-only matches
                const at = displayTitle(a).toLowerCase().includes(q) ? 0 : 1
                const bt = displayTitle(b).toLowerCase().includes(q) ? 0 : 1
                return at - bt || b.lastAccess - a.lastAccess
              })
              .slice(0, 60)
            sendResponse(ok({ results }))
            return
          }

          case "RENAME_TAB": {
            const title = msg.title.trim()
            const settings = await getSettings()
            const customTabTitles = { ...settings.customTabTitles }

            if (!title) {
              // clearing a name always succeeds: there is nothing to apply
              delete customTabTitles[String(msg.tabId)]
              await setSettings({ customTabTitles })
              sendResponse(ok({ renamed: false }))
              return
            }

            const applied = await applyCustomTitle(msg.tabId, title)
            if (!applied) {
              // Do NOT persist a name that could not be applied. Storing it
              // would leave the tab half-renamed: the user is told it failed,
              // yet the name silently reappears on every future navigation
              // once host access is granted.
              sendResponse(
                fail("Could not rename this page. Orbit needs permission to run on this site."),
              )
              return
            }

            customTabTitles[String(msg.tabId)] = title
            await setSettings({ customTabTitles })
            sendResponse(ok({ renamed: true }))
            return
          }

          case "MOVE_TABS": {
            const res = await moveTabs(msg.tabIds, msg.targetGroupId, msg.targetWindowId)
            await persistNow()
            sendResponse(res.error ? fail(res.error) : ok(res))
            return
          }

          case "CREATE_GROUP": {
            const ids = msg.tabIds.filter((id) => !recordOf(id)?.pinned)
            if (!ids.length) {
              sendResponse(fail("No groupable tabs selected"))
              return
            }
            const groupId = await chrome.tabs.group({
              tabIds: ids,
              createProperties: { windowId: msg.windowId },
            })
            if (msg.title) await chrome.tabGroups.update(groupId, { title: msg.title })
            sendResponse(ok({ groupId }))
            return
          }

          case "UPDATE_GROUP": {
            const changed = await updateGroup(msg.groupId, {
              title: msg.title,
              color: msg.color,
            })
            sendResponse(changed ? ok({ changed }) : fail("Could not update that group"))
            return
          }

          case "DELETE_GROUP": {
            const tabs = await chrome.tabs.query({ groupId: msg.groupId }).catch(() => [])
            const ids = tabs.map((t) => t.id).filter((id): id is number => id != null)
            if (msg.closeTabs && ids.length) {
              const settings = await getSettings()
              await closeTabs(ids, {
                reason: "manual",
                toBin: settings.duplicateBinMode === "recycle",
                protectPinned: settings.protectPinned,
              })
            } else if (ids.length) {
              await ungroupAll()
              await chrome.tabs.ungroup(ids).catch(() => undefined)
            }
            sendResponse(ok({ closed: msg.closeTabs ? ids.length : 0 }))
            return
          }

          case "OPEN_TAB": {
            const tab = await chrome.tabs.get(msg.tabId).catch(() => null)
            if (!tab) {
              sendResponse(fail("That tab is no longer open"))
              return
            }
            await chrome.tabs.update(msg.tabId, { active: true })
            if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true })
            sendResponse(ok({ opened: true }))
            return
          }

          case "CLOSE_TABS": {
            const settings = await getSettings()
            const res = await closeTabs(msg.tabIds, {
              reason: "manual",
              toBin: settings.duplicateBinMode === "recycle",
              protectPinned: settings.protectPinned,
            })
            sendResponse(ok(res))
            return
          }

          case "RECYCLE_LIST":
            sendResponse(ok(await listRecycle()))
            return

          case "RECYCLE_RESTORE":
            sendResponse(ok({ restored: await restoreRecycle(msg.ids) }))
            return

          case "RECYCLE_CLEAR":
            await clearRecycle()
            sendResponse(ok({ cleared: true }))
            return

          case "SAVED_GROUPS_LIST":
            sendResponse(ok(await listSaved()))
            return

          case "SAVED_GROUPS_CREATE":
            sendResponse(ok(await createSaved(msg.name, msg.tabIds)))
            return

          case "SAVED_GROUPS_UPDATE":
            sendResponse(ok({ updated: await updateSaved(msg.id, msg.patch) }))
            return

          case "SAVED_GROUPS_DELETE":
            sendResponse(ok({ deleted: await deleteSaved(msg.id) }))
            return

          case "SAVED_GROUPS_OPEN":
            sendResponse(ok(await openSaved(msg.id, msg.newWindow)))
            return

          case "TOPIC_SETS_LIST":
            sendResponse(ok(await getTopicSets()))
            return

          case "TOPIC_SETS_SAVE": {
            const sets = await getTopicSets()
            const idx = sets.findIndex((s) => s.id === msg.set.id)
            const next: TopicSet[] =
              idx === -1
                ? [...sets, msg.set]
                : sets.map((s) => (s.id === msg.set.id ? msg.set : s))
            await setTopicSets(next)
            const settings = await getSettings()
            if (!settings.activeTopicSetId) await setSettings({ activeTopicSetId: msg.set.id })
            sendResponse(ok({ saved: true }))
            return
          }

          case "TOPIC_SETS_DELETE": {
            const sets = await getTopicSets()
            const next = sets.filter((s) => s.id !== msg.id)
            await setTopicSets(next)
            const settings = await getSettings()
            if (settings.activeTopicSetId === msg.id) {
              await setSettings({ activeTopicSetId: next[0]?.id ?? null })
            }
            sendResponse(ok({ deleted: true }))
            return
          }

          case "TEST_PROVIDER": {
            const settings = await getSettings()
            sendResponse(ok(await testProvider(settings.ai)))
            return
          }

          case "GET_TAB_PREVIEWS": {
            // no screenshot API exists; report which tabs can be previewed
            const records = allRecords()
            sendResponse(
              ok({
                previews: records.map((r) => ({
                  id: r.id,
                  available: !isRestrictedUrl(r.url) && !r.discarded,
                  favIconUrl: r.favIconUrl,
                  title: displayTitle(r),
                  url: r.url,
                })),
              }),
            )
            return
          }

          default:
            sendResponse(fail(`Unknown message: ${(msg as { type: string }).type}`))
        }
      } catch (e) {
        sendResponse(fail(e))
      }
    })()

    // keep the channel open for the async work above
    return true
  },
)

/* ------------------------------------------------------------------ */
/* Extras used by the popup / options                                  */
/* ------------------------------------------------------------------ */

/** Exposed for the options page's data panel. */
export async function dataSummary(): Promise<{
  tabs: number
  groups: number
  saved: number
  topicSets: number
  recycle: number
  memory: ReturnType<typeof memoryStats>
  canUndo: boolean
}> {
  await ensureReady()
  return {
    tabs: allRecords().length,
    groups: (await listGroups()).length,
    saved: (await listSaved()).length,
    topicSets: (await getTopicSets()).length,
    recycle: (await listRecycle()).length,
    memory: memoryStats(await getMemory()),
    canUndo: (await getUndo()) !== null,
  }
}

export { previewDuplicates, organize, undoLast, ungroupEverything, wipeAllData, remove, read }
