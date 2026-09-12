/**
 * A small in-memory model of the Chrome tabs/tabGroups API.
 *
 * The default mock in setup.ts returns empty arrays, which is enough for the
 * pure-logic tests but useless for anything that has to round-trip real state.
 * This one actually models tabs, groups and windows so the organize -> undo
 * cycle can be exercised end to end.
 */

export interface FakeTab {
  id: number
  windowId: number
  url: string
  title: string
  groupId: number
  pinned: boolean
  active: boolean
  index: number
  favIconUrl: string
  audible: boolean
  discarded: boolean
}

export interface FakeGroup {
  id: number
  windowId: number
  title: string
  color: string
  collapsed: boolean
}

export interface FakeChrome {
  tabs: FakeTab[]
  groups: FakeGroup[]
  windows: Set<number>
  addTab(url: string, opts?: { windowId?: number; pinned?: boolean }): FakeTab
  addGroup(title: string, color: string, tabIds: number[]): FakeGroup
  addWindow(id?: number): number
  /** Drops groups that no longer hold any tab, as Chrome does. */
  pruneGroups(): void
  /** Tabs of one window, in strip order. */
  inWindow(windowId: number): FakeTab[]
  snapshot(): { tabs: Array<{ id: number; groupId: number; index: number }>; groups: Array<{ title: string; color: string }> }
}

export function installFakeChrome(): FakeChrome {
  const tabs: FakeTab[] = []
  const groups: FakeGroup[] = []
  const windows = new Set<number>([1])
  let nextTabId = 1
  let nextGroupId = 100
  let nextWindowId = 2
  let nextIndex = 0

  /** Tabs of a window in strip order. */
  const inWindow = (windowId: number): FakeTab[] =>
    tabs.filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index)

  /** Renumbers one window's tabs 0..n-1 so indices stay dense and ordered. */
  const reindex = (windowId: number): void => {
    inWindow(windowId).forEach((t, i) => {
      t.index = i
    })
  }

  const model: FakeChrome = {
    tabs,
    groups,
    windows,

    /**
     * Chrome deletes a group the moment its last tab leaves it. Without this the
     * fake accumulates ghosts and any "restore exactly" assertion fails.
     */
    pruneGroups() {
      for (let i = groups.length - 1; i >= 0; i--) {
        if (!tabs.some((t) => t.groupId === groups[i].id)) groups.splice(i, 1)
      }
    },

    addTab(url, opts = {}) {
      const windowId = opts.windowId ?? 1
      const tab: FakeTab = {
        id: nextTabId++,
        windowId,
        url,
        title: url,
        groupId: -1,
        pinned: !!opts.pinned,
        active: false,
        index: nextIndex++,
        favIconUrl: "",
        audible: false,
        discarded: false,
      }
      tabs.push(tab)
      reindex(windowId)
      return tab
    },

    addGroup(title, color, tabIds) {
      const ids = new Set(tabIds)
      const members = tabs.filter((t) => ids.has(t.id))
      const group: FakeGroup = {
        id: nextGroupId++,
        windowId: members[0]?.windowId ?? 1,
        title,
        color,
        collapsed: false,
      }
      groups.push(group)
      for (const t of members) t.groupId = group.id
      return group
    },

    addWindow(id) {
      const w = id ?? nextWindowId++
      windows.add(w)
      return w
    },

    inWindow,

    snapshot() {
      return {
        tabs: tabs.map((t) => ({ id: t.id, groupId: t.groupId, index: t.index })),
        groups: groups
          .filter((g) => g.id !== -1)
          .map((g) => ({ title: g.title, color: g.color }))
          .sort((a, b) => a.title.localeCompare(b.title)),
      }
    },
  }

  const c = globalThis as unknown as { chrome: Record<string, unknown> }
  const existing = (c.chrome ?? {}) as Record<string, unknown>
  const noop = () => undefined
  const listener = () => ({ addListener: noop, removeListener: noop, hasListener: () => false })

  /** Chrome rejects any reference to a window id that is not open. */
  const requireWindow = (id: number): number => {
    if (!windows.has(id)) throw new Error("No window with id: " + id)
    return id
  }

  // Merge over whatever setup.ts installed, so storage and the runtime stubs
  // survive. index.ts registers every listener at module load, so they all have
  // to exist before it can be imported.
  c.chrome = {
    ...existing,
    runtime: {
      ...(existing.runtime as object),
      id: "test",
      getManifest: () => ({ version: "1.0.0" }),
      getURL: (p: string) => `chrome-extension://test/${p}`,
      onMessage: listener(),
      onInstalled: listener(),
      onStartup: listener(),
    },
    windows: {
      getLastFocused: async () => ({ id: 1 }),
      getAll: async () => [...windows].map((id) => ({ id })),
      getCurrent: async () => ({ id: 1 }),
      update: async (id: number) => {
        requireWindow(id)
        return { id }
      },
      /**
       * Real Chrome always seeds a new window with one blank tab, and the id it
       * returns already carries that tab. `applyUndo` relies on this to clean up
       * the seeds, so the fake has to reproduce it or that path is never tested.
       */
      create: async (props: { focused?: boolean } = {}) => {
        const id = model.addWindow()
        const seed = model.addTab("about:blank", { windowId: id })
        if (props.focused) seed.active = true
        return { id, tabs: [seed] }
      },
      remove: async (id: number) => {
        requireWindow(id)
        windows.delete(id)
        for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i].windowId === id) tabs.splice(i, 1)
        model.pruneGroups()
      },
    },
    commands: { onCommand: listener() },
    contextMenus: { create: noop, removeAll: async () => undefined, onClicked: listener() },
    action: { openPopup: async () => undefined },
    scripting: { executeScript: async () => [] },
    tabs: {
      async query(q: Record<string, unknown> = {}) {
        return tabs.filter((t) => {
          if (q.windowId !== undefined && t.windowId !== q.windowId) return false
          if (q.groupId !== undefined && t.groupId !== q.groupId) return false
          if (q.active !== undefined && t.active !== q.active) return false
          return true
        })
      },
      async get(id: number) {
        const t = tabs.find((x) => x.id === id)
        if (!t) throw new Error("No tab with id " + id)
        return t
      },
      async create(props: { url?: string; windowId?: number; index?: number; active?: boolean }) {
        const windowId = props.windowId ?? 1
        requireWindow(windowId)
        const t = model.addTab(props.url ?? "about:blank", { windowId })
        t.active = !!props.active
        // honour the requested slot: undo recreates closed tabs at their old
        // index, and a fake that always appends would hide an ordering bug
        if (props.index !== undefined && props.index < inWindow(windowId).length - 1) {
          await chrome.tabs.move(t.id, { windowId, index: props.index })
        }
        return t
      },
      async update(id: number, props: { pinned?: boolean; active?: boolean }) {
        const t = tabs.find((x) => x.id === id)
        if (!t) throw new Error("No tab " + id)
        if (props.pinned !== undefined) t.pinned = props.pinned
        if (props.active !== undefined) t.active = props.active
        return t
      },
      async move(ids: number | number[], props: { windowId?: number; index?: number }) {
        const list = Array.isArray(ids) ? ids : [ids]
        const moving = list
          .map((id) => tabs.find((t) => t.id === id))
          .filter((t): t is FakeTab => !!t)
        if (!moving.length) return []

        const target = props.windowId ?? moving[0].windowId
        requireWindow(target)

        const ordered = [...moving].sort((a, b) => a.index - b.index)
        const sources = new Set(ordered.map((t) => t.windowId))
        // detach first so the moved tabs are not counted as destination members
        for (const t of ordered) t.windowId = -1

        const dest = inWindow(target)
        const at =
          props.index === undefined || props.index < 0
            ? dest.length
            : Math.max(0, Math.min(props.index, dest.length))
        const next = [...dest.slice(0, at), ...ordered, ...dest.slice(at)]
        next.forEach((t, i) => {
          t.index = i
          t.windowId = target
        })

        for (const w of sources) if (w !== target) reindex(w)
        return ordered
      },
      async group(opts: { tabIds: number | number[]; createProperties?: { windowId?: number } }) {
        const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds]
        const members = tabs.filter((t) => ids.includes(t.id))
        if (!members.length) throw new Error("No tabs to group")

        // Chrome only groups tabs that share a window, and only into a window
        // that exists. Both are real constraints that callers have to respect.
        const memberWindows = new Set(members.map((t) => t.windowId))
        if (memberWindows.size > 1) {
          throw new Error("Tabs must all be in the same window to be grouped")
        }
        const target = opts.createProperties?.windowId
        if (target !== undefined) {
          requireWindow(target)
          if (!memberWindows.has(target)) {
            throw new Error("Tabs are not in the group's window")
          }
        }

        // reuse an existing group when every member already shares one
        const existing = members[0].groupId
        if (existing !== -1 && members.every((t) => t.groupId === existing)) return existing
        const g: FakeGroup = {
          id: nextGroupId++,
          windowId: members[0].windowId,
          title: "",
          color: "grey",
          collapsed: false,
        }
        groups.push(g)
        for (const t of members) t.groupId = g.id
        return g.id
      },
      async ungroup(ids: number | number[]) {
        const list = Array.isArray(ids) ? ids : [ids]
        for (const t of tabs) if (list.includes(t.id)) t.groupId = -1
        model.pruneGroups()
      },
      async remove(ids: number | number[]) {
        const list = new Set(Array.isArray(ids) ? ids : [ids])
        const touched = new Set<number>()
        for (let i = tabs.length - 1; i >= 0; i--) {
          if (list.has(tabs[i].id)) {
            touched.add(tabs[i].windowId)
            tabs.splice(i, 1)
          }
        }
        for (const w of touched) reindex(w)
        model.pruneGroups()
      },
      // index.ts registers all of these at module load
      onCreated: listener(),
      onUpdated: listener(),
      onRemoved: listener(),
      onActivated: listener(),
      onMoved: listener(),
      onAttached: listener(),
      onDetached: listener(),
      onReplaced: listener(),
    },
    tabGroups: {
      async query(q: Record<string, unknown> = {}) {
        return groups.filter((g) => (q.windowId === undefined ? true : g.windowId === q.windowId))
      },
      async get(id: number) {
        return groups.find((g) => g.id === id) ?? null
      },
      async update(id: number, props: { title?: string; color?: string; collapsed?: boolean }) {
        const g = groups.find((x) => x.id === id)
        if (!g) throw new Error("No group " + id)
        if (props.title !== undefined) g.title = props.title
        if (props.color !== undefined) g.color = props.color
        if (props.collapsed !== undefined) g.collapsed = props.collapsed
        return g
      },
      onUpdated: listener(),
    },
  }

  return model
}
