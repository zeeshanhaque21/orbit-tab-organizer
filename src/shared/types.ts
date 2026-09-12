/**
 * Core domain types, shared by the service worker and every UI surface.
 *
 * `TabRecord` carries exactly what the grouping algorithms need per tab: the
 * URL and title to classify, when it was last used, and a bounded history of
 * activations to score recency from.
 */

export type TabId = number
export type WindowId = number
export type GroupId = number

/** A tracked tab. */
export interface TabRecord {
  id: TabId
  windowId: WindowId
  url: string
  title: string
  /** epoch ms of the last activation */
  lastAccess: number
  /** epoch ms of each activation, oldest first, capped at ACCESS_HISTORY_LIMIT */
  accessHistory: number[]
  /** epoch ms the tab was first observed */
  firstSeen: number
  /**
   * How many times you have switched back to this tab since the browser
   * started. Session-scoped: it survives a service-worker restart but is zeroed
   * on browser startup, so "this session" means a browsing session rather than
   * however often the worker happened to be evicted.
   */
  sessionSwitches: number
  /** Chrome tab group id, -1 when ungrouped */
  groupId: GroupId
  pinned: boolean
  active: boolean
  audible: boolean
  discarded: boolean
  favIconUrl: string
  /** user-supplied name; survives navigation and is re-applied after a reload */
  customTitle?: string
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

export type GroupingMethod =
  | "category"
  | "last_access"
  | "frequency"
  | "relevance"
  | "topics"
  | "memory"

/** Where the tabs come from, and therefore where the groups land. */
export type GroupingScope = "current_window" | "all_windows"

/** What to do with the collapse state of the groups we create. */
/**
 * What to do with group collapse state after a pass.
 * - `collapsed` / `expanded`: all groups.
 * - `active-only` ("Focus Active"): only the group holding the active tab stays
 *   open, the rest collapse. The reference ships this as a third option.
 * - `unchanged`: leave whatever Chrome already had.
 */
export type GroupingDefaultState = "collapsed" | "expanded" | "active-only" | "unchanged"

/** Result of a grouping pass: group label -> tab ids. */
export type GroupingInstructions = Record<string, TabId[]>

/** A group as planned, before it is written to Chrome. */
export interface PlannedGroup {
  title: string
  color: GroupColor
  tabs: TabId[]
}

export type GroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange"

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export type DuplicateMatchMode = "url" | "title_url"
export type DuplicateBinMode = "recycle" | "permanent"
export type AiProviderId = "local" | "openai" | "anthropic" | "gemini" | "custom"

export interface AiSettings {
  provider: AiProviderId
  /** base URL for openai-compatible / custom providers */
  baseUrl: string
  model: string
  apiKey: string
  /** temperature for classification calls */
  temperature: number
  /** max tabs sent in a single request */
  batchSize: number
}

export interface Settings {
  /** currently selected grouping method */
  method: GroupingMethod
  scope: GroupingScope
  /** Auto-Organize: group every new tab the moment it loads */
  autoMode: boolean
  /** which method Auto-Organize uses */
  autoMethod: GroupingMethod
  groupingDefaultState: GroupingDefaultState
  /** reorder groups so their titles read alphabetically */
  orderGroupsByTitle: boolean
  duplicateMatchMode: DuplicateMatchMode
  duplicateBinMode: DuplicateBinMode
  dontShowDuplicateCleanNotice: boolean
  /**
   * By Category only. When true, a repeat run keeps the groups that already
   * exist and only files the newly ungrouped tabs, reusing existing titles
   * rather than tearing everything down and regrouping.
   */
  lockGroups: boolean
  /** keep pinned tabs out of every grouping pass */
  protectPinned: boolean
  /** active topic set id, or null */
  activeTopicSetId: string | null
  ai: AiSettings
  /** one-time onboarding tour completed */
  tourDone: boolean
  /** version the "what's new" notice was last dismissed for */
  whatsNewSeenVersion: string | null
  hubSidebarCollapsed: boolean
  /** custom window/tab titles, keyed by tab id, mirrored into TabRecord */
  customTabTitles: Record<string, string>
}

/* ------------------------------------------------------------------ */
/* My Topics                                                           */
/* ------------------------------------------------------------------ */

/** How a topic decides which tabs belong to it. */
export type TopicMatchMode = "domain" | "path" | "keyword"

export interface Topic {
  id: string
  name: string
  color: GroupColor
  matchMode: TopicMatchMode
  /** one pattern per line; interpreted according to matchMode */
  patterns: string[]
}

export interface TopicSet {
  id: string
  name: string
  topics: Topic[]
  createdAt: number
}

/* ------------------------------------------------------------------ */
/* Saved groups                                                        */
/* ------------------------------------------------------------------ */

export interface SavedTab {
  url: string
  title: string
  pinned: boolean
  customTitle?: string
}

export interface SavedGroup {
  id: string
  name: string
  color: GroupColor
  tabs: SavedTab[]
  createdAt: number
  /** window title it was captured from, for display only */
  sourceWindow?: string
}

/* ------------------------------------------------------------------ */
/* Undo + recycle bin                                                  */
/* ------------------------------------------------------------------ */

/** Everything needed to put the browser back exactly as it was. */
export interface UndoSnapshot {
  createdAt: number
  method: GroupingMethod
  scope: GroupingScope
  /** the windows this pass touched */
  windowIds: WindowId[]
  /** every group that existed beforehand, so it can be rebuilt */
  groups: Array<{
    id: GroupId
    windowId: WindowId
    title: string
    color: GroupColor
    collapsed: boolean
  }>
  /** group assignments before the pass, for every tab we touched */
  previous: Array<{
    tabId: TabId
    windowId: WindowId
    index: number
    groupId: GroupId
    pinned: boolean
  }>
  /** tabs we closed, so undo can recreate them */
  closed: Array<{
    url: string
    title: string
    windowId: WindowId
    index: number
    pinned: boolean
    customTitle?: string
  }>
  /** groups we created, so undo can remove them */
  createdGroupIds: GroupId[]
}

export interface RecycleEntry {
  id: string
  url: string
  title: string
  favIconUrl: string
  windowId: WindowId
  closedAt: number
  /** 'duplicate' | 'manual' */
  reason: string
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export interface HubState {
  windows: Array<{
    id: WindowId
    focused: boolean
    tabCount: number
  }>
  groups: Array<{
    id: GroupId
    windowId: WindowId
    title: string
    color: GroupColor
    collapsed: boolean
  }>
  tabs: TabRecord[]
  /** true when an undo snapshot exists, so the popup can gate its Undo button */
  canUndo: boolean
}

export interface OrganizeResult {
  ok: boolean
  method: GroupingMethod
  groups: number
  tabsGrouped: number
  closed: number
  /** set when the AI provider was unreachable and we fell back */
  fallback?: "local" | "last_access" | "none"
  error?: string
  /** ms spent on the AI call, when one happened */
  aiMs?: number
}

export type Message =
  | { type: "ORGANIZE"; method?: GroupingMethod; scope?: GroupingScope; windowId?: WindowId }
  | { type: "UNDO" }
  | { type: "CLEAN_DUPLICATES"; windowId?: WindowId }
  | { type: "UNGROUP_ALL"; windowId?: WindowId }
  | { type: "TOGGLE_COLLAPSE"; collapsed: boolean; windowId?: WindowId }
  | { type: "REORDER_GROUPS"; windowId?: WindowId }
  | { type: "GET_SETTINGS" }
  | { type: "SET_SETTINGS"; patch: Partial<Settings> }
  | { type: "GET_HUB_STATE" }
  | { type: "GET_TOKEN_STATE" }
  | { type: "MERGE_WINDOWS" }
  | { type: "GET_WHATS_NEW" }
  | { type: "DISMISS_WHATS_NEW" }
  | { type: "SEARCH_TABS"; query: string }
  | { type: "RENAME_TAB"; tabId: TabId; title: string }
  | { type: "MOVE_TABS"; tabIds: TabId[]; targetGroupId: GroupId | null; targetWindowId?: WindowId }
  | { type: "CREATE_GROUP"; windowId: WindowId; title: string; tabIds: TabId[] }
  | { type: "UPDATE_GROUP"; groupId: GroupId; title?: string; color?: GroupColor }
  | { type: "DELETE_GROUP"; groupId: GroupId; closeTabs: boolean }
  | { type: "OPEN_TAB"; tabId: TabId }
  | { type: "CLOSE_TABS"; tabIds: TabId[] }
  | { type: "RECYCLE_LIST" }
  | { type: "RECYCLE_RESTORE"; ids: string[] }
  | { type: "RECYCLE_CLEAR" }
  | { type: "SAVED_GROUPS_LIST" }
  | { type: "SAVED_GROUPS_CREATE"; name: string; tabIds: TabId[] }
  | { type: "SAVED_GROUPS_UPDATE"; id: string; patch: Partial<SavedGroup> }
  | { type: "SAVED_GROUPS_DELETE"; id: string }
  | { type: "SAVED_GROUPS_OPEN"; id: string; newWindow: boolean }
  | { type: "TOPIC_SETS_LIST" }
  | { type: "TOPIC_SETS_SAVE"; set: TopicSet }
  | { type: "TOPIC_SETS_DELETE"; id: string }
  | { type: "TEST_PROVIDER" }
  | { type: "GET_TAB_PREVIEWS" }

export interface MessageResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

/** Chrome message envelope: every request gets `{ ok, data | error }`. */
export type Sendable = <T = unknown>(msg: Message) => Promise<MessageResponse<T>>
