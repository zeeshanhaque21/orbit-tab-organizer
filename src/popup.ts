/**
 * The popup: pick a method, organize, undo, and the quick tools.
 */
import { h, icon, favicon, $, clear, type IconName } from "./shared/dom"
import { displayTitle, hostOf, plural, timeAgo } from "./shared/format"
import { modal, promptModal, send, toast } from "./shared/ui"
import { STORAGE } from "./shared/constants"
import type {
  GroupingMethod,
  GroupingScope,
  OrganizeResult,
  Settings,
  TabRecord,
} from "./shared/types"

interface MethodMeta {
  id: GroupingMethod
  name: string
  blurb: string
  icon: IconName
  /** true when the method never needs a network call */
  offline: boolean
}

const METHODS: MethodMeta[] = [
  {
    id: "category",
    name: "By Category",
    blurb: "Groups by what tabs are about - Shopping, Research, Work.",
    icon: "sparkles",
    offline: false,
  },
  {
    id: "last_access",
    name: "By Last Access",
    blurb: "Groups by when you last visited - last hour, today, last week.",
    icon: "clock",
    offline: true,
  },
  {
    id: "frequency",
    name: "By Frequency",
    blurb: "Predicts what you are likely to open next from your habits.",
    icon: "zap",
    offline: true,
  },
  {
    id: "relevance",
    name: "By Relevance",
    blurb: "Puts tabs related to the one you are reading first.",
    icon: "eye",
    offline: true,
  },
  {
    id: "topics",
    name: "By Topics",
    blurb: "Files tabs into categories you define yourself.",
    icon: "layers",
    offline: true,
  },
  {
    id: "memory",
    name: "By Memory",
    blurb: "Replays where you have filed tabs from each site before.",
    icon: "lightbulb",
    offline: true,
  },
]

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const app = $("#app")!
let settings: Settings
let windowId: number | null = null
let lastResult: OrganizeResult | null = null
let mode: "main" | "search" | "rename" = "main"
let searchQuery = ""
let searchHits: TabRecord[] = []
let providerInfo: { provider: string; model: string; unlimited: boolean } | null = null
let canUndo = false

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function iconButton(name: IconName, title: string, onClick: () => void): HTMLElement {
  return h("button", {
    class: "btn btn-icon",
    title,
    "aria-label": title,
    on: { click: onClick },
  }, icon(name, 16))
}

/** Highlights every case-insensitive occurrence of `q` inside `text`. */
function highlight(text: string, q: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  if (!q) {
    frag.appendChild(document.createTextNode(text))
    return frag
  }
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  let i = 0
  for (;;) {
    const at = lower.indexOf(needle, i)
    if (at === -1) {
      frag.appendChild(document.createTextNode(text.slice(i)))
      break
    }
    if (at > i) frag.appendChild(document.createTextNode(text.slice(i, at)))
    const mark = h("mark")
    mark.textContent = text.slice(at, at + needle.length)
    frag.appendChild(mark)
    i = at + needle.length
  }
  return frag
}

function methodLabel(id: GroupingMethod): string {
  return METHODS.find((m) => m.id === id)?.name ?? id
}

/* ------------------------------------------------------------------ */
/* Header                                                             */
/* ------------------------------------------------------------------ */

function renderHeader(): HTMLElement {
  return h(
    "div",
    { class: "head" },
    h(
      "div",
      { class: "brand" },
      h("div", { class: "brand-mark" }, icon("orbit", 15)),
      h(
        "div",
        { class: "brand-text" },
        h("span", { class: "brand-name", text: "Orbit" }),
        h("span", { class: "brand-sub", text: "AI tab organizer" }),
      ),
    ),
    h(
      "div",
      { class: "head-actions" },
      iconButton("search", "Search tabs (Cmd/Ctrl+Shift+S)", () => {
        mode = mode === "search" ? "main" : "search"
        searchQuery = ""
        searchHits = []
        render()
      }),
      iconButton("grid", "Open Orbit Hub (Cmd/Ctrl+Shift+L)", () => {
        void chrome.tabs.create({ url: chrome.runtime.getURL("hub.html") })
      }),
      iconButton("settings", "Settings", () => {
        void chrome.runtime.openOptionsPage()
      }),
    ),
  )
}

/* ------------------------------------------------------------------ */
/* Main view                                                           */
/* ------------------------------------------------------------------ */

function renderMethodList(): HTMLElement {
  const list = h("div", { class: "methods", role: "radiogroup", "aria-label": "Grouping method" })
  for (const m of METHODS) {
    const checked = settings.method === m.id
    const node = h(
      "button",
      {
        class: "method",
        role: "radio",
        "aria-checked": String(checked),
        title: m.blurb,
        on: {
          click: () => {
            void (async () => {
              settings = (await send<Settings>({ type: "SET_SETTINGS", patch: { method: m.id } }))
                .data ?? settings
              render()
            })()
          },
        },
      },
      h("span", { class: "method-ic" }, icon(m.icon, 14)),
      h(
        "span",
        { class: "method-body" },
        h(
          "span",
          { class: "method-name" },
          m.name,
          m.offline ? h("span", { class: "badge", text: "offline" }) : null,
        ),
        h("span", { class: "method-blurb", text: m.blurb }),
      ),
      checked ? h("span", { style: { color: "var(--accent)", marginTop: "3px" } }, icon("check", 15)) : null,
    )
    list.appendChild(node)
  }
  return list
}

function renderScope(): HTMLElement {
  const make = (id: GroupingScope, label: string) =>
    h("button", {
      text: label,
      "aria-pressed": String(settings.scope === id),
      on: {
        click: () => {
          void (async () => {
            settings = (await send<Settings>({ type: "SET_SETTINGS", patch: { scope: id } })).data ?? settings
            render()
          })()
        },
      },
    })

  return h(
    "div",
    { class: "col gap-6" },
    h(
      "div",
      { class: "segmented", role: "group", "aria-label": "Scope" },
      make("current_window", "This window"),
      make("all_windows", "All windows"),
    ),
    h("div", {
      class: "scope-note",
      text:
        settings.scope === "all_windows"
          ? "Every open window is considered, and everything ends up in one organized window."
          : "Only this window is organized. Other windows are left exactly as they are.",
    }),
  )
}

function renderResult(): HTMLElement | null {
  if (!lastResult) return null
  const r = lastResult

  if (!r.ok) {
    return h(
      "div",
      { class: "result warn" },
      icon("info", 14),
      h("span", { text: r.error ?? "Nothing to organize" }),
    )
  }

  const bits: string[] = [
    `${plural(r.groups, "group")}`,
    `${plural(r.tabsGrouped, "tab")}`,
  ]
  if (r.aiMs) bits.push(`${r.aiMs}ms`)
  if (r.fallback === "local" && r.method === "category") bits.push("built-in engine")

  return h(
    "div",
    { class: "result ok" },
    icon("check", 14),
    h("span", { text: `Organized by ${methodLabel(r.method).replace("By ", "")} - ${bits.join(" · ")}` }),
  )
}

function renderOrganize(): HTMLElement {
  const btn = h(
    "button",
    {
      class: "btn btn-primary organize",
      on: {
        click: () => {
          void runOrganize(btn)
        },
      },
    },
    icon("wand", 17),
    h("span", { text: "Organize Now" }),
  )

  const undoBtn = h(
    "button",
    {
      class: "btn",
      title: canUndo ? "Undo the last organize" : "Nothing to undo yet",
      disabled: !canUndo,
      on: {
        click: () => {
          void (async () => {
            const res = await send({ type: "UNDO" })
            if (res.ok) {
              const data = res.data as { message?: string } | undefined
              toast(data?.message ?? "Restored", "ok")
              canUndo = false
            } else {
              toast(res.error ?? "Undo failed", "err")
            }
            render()
          })()
        },
      },
    },
    icon("undo", 15),
    h("span", { text: "Undo" }),
  )

  return h(
    "div",
    { class: "col gap-10" },
    h("div", { class: "organize-row" }, btn, undoBtn),
    renderResult(),
  )
}

function renderTools(): HTMLElement {
  const tool = (
    ic: IconName,
    label: string,
    onClick: () => void,
    opts: { wide?: boolean; title?: string } = {},
  ) =>
    h(
      "button",
      {
        class: `tool${opts.wide ? " tool-wide" : ""}`,
        title: opts.title ?? label,
        on: { click: onClick },
      },
      icon(ic, 15),
      h("span", { text: label }),
    )

  return h(
    "div",
    { class: "tools" },
    tool("copy", "Clean duplicates", () => void runCleanDuplicates()),
    tool(
      "merge",
      "Combine windows",
      () => {
        void (async () => {
          const wins = await chrome.windows.getAll({ populate: false })
          if (wins.length <= 1) {
            toast("There is only one window open.", "warn")
            return
          }
          const yes = await modal({
            title: "Combine windows",
            body: `Move every tab from all ${wins.length} windows into this one. Undo will put them back.`,
            confirmText: "Combine",
          })
          if (!yes) return
          const res = await send({ type: "MERGE_WINDOWS" })
          toast(res.ok ? "Windows combined" : (res.error ?? "Failed"), res.ok ? "ok" : "err")
          if (res.ok) render()
        })()
      },
      { title: "Pull every tab from every window into this one" },
    ),
    tool("save", "Rename tab", () => {
      mode = "rename"
      render()
    }),
    tool("x", "Ungroup all", () => {
      void (async () => {
        const yes = await modal({
          title: "Ungroup every tab?",
          body: "All tab groups in this window will be removed. The tabs themselves stay open.",
          confirmText: "Ungroup",
          danger: true,
        })
        if (!yes) return
        const res = await send({ type: "UNGROUP_ALL", windowId: windowId ?? undefined })
        toast(res.ok ? "Groups removed" : (res.error ?? "Failed"), res.ok ? "ok" : "err")
        render()
      })()
    }),
    tool(
      "archive",
      "Collapse groups",
      () => {
        void (async () => {
          const collapsed = !settings.hubSidebarCollapsed
          await send({ type: "TOGGLE_COLLAPSE", collapsed, windowId: windowId ?? undefined })
          toast(collapsed ? "Groups collapsed" : "Groups expanded", "ok")
        })()
      },
      { title: "Collapse or expand every group in this window" },
    ),
    tool("list", "Order by name", () => {
      void (async () => {
        await send({ type: "REORDER_GROUPS", windowId: windowId ?? undefined })
        toast("Groups reordered", "ok")
      })()
    }),
  )
}

function renderAuto(): HTMLElement {
  const on = settings.autoMode
  const input = h("input", {
    type: "checkbox",
    checked: on,
    "aria-label": "Auto-organize new tabs",
    on: {
      change: () => {
        void (async () => {
          const checked = input.checked
          settings =
            (await send<Settings>({ type: "SET_SETTINGS", patch: { autoMode: checked } })).data ??
            settings
          toast(checked ? "Auto-Organize on" : "Auto-Organize off", "ok")
          render()
        })()
      },
    },
  })

  const methodSel = h(
    "select",
    {
      class: "select",
      on: {
        change: () => {
          void (async () => {
            settings =
              (
                await send<Settings>({
                  type: "SET_SETTINGS",
                  patch: { autoMethod: methodSel.value as GroupingMethod },
                })
              ).data ?? settings
          })()
        },
      },
    },
    METHODS.map((m) =>
      h("option", { value: m.id, text: m.name, selected: settings.autoMethod === m.id }),
    ),
  )

  return h(
    "div",
    { class: `auto${on ? " on" : ""}` },
    h(
      "div",
      { class: "auto-body" },
      h("div", { class: "auto-title", text: "Auto-Organize" }),
      h("div", {
        class: "auto-sub",
        text: on
          ? "New tabs are grouped the moment they load."
          : "Group new tabs automatically as you open them.",
      }),
      on ? h("div", { style: { marginTop: "7px" } }, methodSel) : null,
    ),
    h("label", { class: "switch" }, input, h("span", { class: "track" }), h("span", { class: "thumb" })),
  )
}

/**
 * By Category only: a repeat run keeps the groups you already have and just
 * files the newly ungrouped tabs. The setting is read by the organizer, so
 * without a switch here the behaviour would be unreachable from the UI.
 */
function renderLockGroups(): HTMLElement {
  const on = settings.lockGroups
  const input = h("input", {
    type: "checkbox",
    checked: on,
    "aria-label": "Keep existing groups when organizing by category",
    on: {
      change: () => {
        void (async () => {
          const checked = input.checked
          settings =
            (await send<Settings>({ type: "SET_SETTINGS", patch: { lockGroups: checked } })).data ??
            settings
          toast(
            checked ? "Existing groups will be kept" : "Existing groups will be rebuilt",
            "ok",
          )
          render()
        })()
      },
    },
  })

  return h(
    "div",
    { class: `auto${on ? " on" : ""}` },
    h(
      "div",
      { class: "auto-body" },
      h("div", { class: "auto-title", text: "Lock groups" }),
      h("div", {
        class: "auto-sub",
        text: on
          ? "By Category keeps the groups you already have and only files new tabs."
          : "By Category rebuilds every group on each run.",
      }),
    ),
    h("label", { class: "switch" }, input, h("span", { class: "track" }), h("span", { class: "thumb" })),
  )
}

function renderFooter(tabCount: number): HTMLElement {
  const ai = providerInfo
  const local = ai?.provider === "local"
  const ready = ai?.unlimited ?? false

  return h(
    "div",
    { class: "foot" },
    h("span", { text: plural(tabCount, "tab") }),
    h("span", { style: { marginLeft: "auto" } }),
    h(
      "span",
      { class: `pill ${ready ? "ok" : "warn"}`, title: local ? "No key needed. Everything runs on this machine." : `Using ${ai?.model ?? "your provider"}` },
      h("span", { class: "dot" }),
      local ? "Built-in engine" : ready ? (ai?.model ?? "AI ready") : "No API key",
    ),
    h("span", { class: "pill", title: "Version", text: `v${chrome.runtime.getManifest().version}` }),
  )
}

/* ------------------------------------------------------------------ */
/* Search / rename modes                                               */
/* ------------------------------------------------------------------ */

function renderSearchMode(): HTMLElement {
  const input = h("input", {
    placeholder: "Search every tab, in every window…",
    value: searchQuery,
    spellcheck: false,
    "aria-label": "Search tabs",
  })

  const results = h("div", { class: "results" })

  const run = async (q: string) => {
    searchQuery = q
    if (!q.trim()) {
      searchHits = []
    } else {
      const res = await send<{ results: TabRecord[] }>({ type: "SEARCH_TABS", query: q })
      searchHits = res.data?.results ?? []
    }
    paint()
  }

  const paint = () => {
    clear(results)
    if (!searchQuery.trim()) {
      results.appendChild(
        h(
          "div",
          { class: "empty" },
          icon("search", 26),
          h("div", { class: "empty-title", text: "Search all your tabs" }),
          h("div", { class: "small", text: "Matches are highlighted. Press Enter to open the first result." }),
        ),
      )
      return
    }
    if (!searchHits.length) {
      results.appendChild(
        h(
          "div",
          { class: "empty" },
          icon("info", 24),
          h("div", { class: "empty-title", text: "No tabs matched" }),
          h("div", { class: "small", text: `Nothing matches "${searchQuery}".` }),
        ),
      )
      return
    }

    for (const t of searchHits) {
      const title = displayTitle(t)
      const titleNode = h("div", { class: "hit-title" })
      titleNode.appendChild(highlight(title, searchQuery))

      const urlNode = h("div", { class: "hit-url" })
      urlNode.appendChild(highlight(hostOf(t.url) + (t.url.includes("?") ? t.url.slice(t.url.indexOf("?")) : ""), searchQuery))

      results.appendChild(
        h(
          "button",
          {
            class: "hit",
            on: {
              click: () => {
                void send({ type: "OPEN_TAB", tabId: t.id })
                window.close()
              },
            },
          },
          favicon(t.url, t.favIconUrl, 17),
          h("div", { class: "hit-body" }, titleNode, urlNode),
          t.pinned ? icon("pin", 13) : null,
          h("span", { class: "small faint nowrap", text: timeAgo(t.lastAccess) }),
        ),
      )
    }
  }

  input.addEventListener("input", () => void run(input.value))
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && searchHits[0]) {
      void send({ type: "OPEN_TAB", tabId: searchHits[0].id })
      window.close()
    }
    if (e.key === "Escape") {
      mode = "main"
      render()
    }
  })

  setTimeout(() => input.focus(), 20)
  void run(searchQuery)
  paint()

  return h(
    "div",
    { class: "section" },
    h("div", { class: "mode-input" }, icon("search", 15), input),
    results,
  )
}

/**
 * Asks for host access without ever hanging.
 *
 * `chrome.permissions.request` can be left unsettled indefinitely — Chrome will
 * not always show a prompt from a popup. Awaiting it directly meant the rename
 * button silently did nothing, with no toast and no state change. Racing it
 * against a timer guarantees the caller gets an answer it can act on.
 */
async function requestHostAccess(
  origins: string[],
  ms = 4000,
): Promise<"granted" | "denied" | "pending"> {
  try {
    if (await chrome.permissions.contains({ origins })) return "granted"
  } catch {
    // the permissions API is unavailable; let the action attempt and report
    return "granted"
  }

  try {
    const request = chrome.permissions.request({ origins })
    return await Promise.race([
      request.then((granted) => (granted ? "granted" : "denied") as "granted" | "denied"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
    ])
  } catch {
    return "denied"
  }
}

function renderRenameMode(): HTMLElement {
  const input = h("input", {
    placeholder: "New name for the active tab…",
    spellcheck: false,
    "aria-label": "New tab name",
  })

  const save = async () => {
    const title = input.value.trim()
    if (!title) {
      toast("Enter a name first", "warn")
      return
    }
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (active?.id == null) {
      toast("No active tab", "err")
      return
    }

    // Renaming rewrites the page's title, which needs host access. The manifest
    // declares it as optional, so ask here while we still have a user gesture.
    const access = await requestHostAccess(["<all_urls>"])
    if (access !== "granted") {
      if (access === "pending") {
        // Chrome declined to prompt from a popup. Send them somewhere the grant
        // can actually be given rather than leaving the button inert.
        toast("Chrome did not show a prompt. Grant site access in Settings.", "warn", 4200)
        void chrome.runtime.openOptionsPage()
      } else {
        toast("Orbit needs site access to rename pages", "warn", 3600)
      }
      return
    }

    const res = await send({ type: "RENAME_TAB", tabId: active.id, title })
    if (res.ok) {
      toast("Tab renamed", "ok")
      mode = "main"
      render()
    } else {
      toast(res.error ?? "Could not rename", "err")
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void save()
    if (e.key === "Escape") {
      mode = "main"
      render()
    }
  })

  void (async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (active?.title && !input.value) input.value = active.title.slice(0, 60)
  })()

  setTimeout(() => {
    input.focus()
    input.select()
  }, 20)

  return h(
    "div",
    { class: "section" },
    h("div", { class: "mode-input" }, icon("save", 15), input),
    h("div", {
      class: "hint",
      text: "The name is applied to the page title and re-applied every time that tab reloads.",
    }),
    h(
      "div",
      { class: "row gap-6" },
      h("button", { class: "btn btn-primary grow", text: "Rename tab", on: { click: () => void save() } }),
      h("button", {
        class: "btn",
        text: "Cancel",
        on: {
          click: () => {
            mode = "main"
            render()
          },
        },
      }),
    ),
  )
}

/* ------------------------------------------------------------------ */
/* Banners                                                            */
/* ------------------------------------------------------------------ */

/** A version the user has not acknowledged yet, or null. Set at boot. */
let whatsNew: string | null = null

function renderBanner(): HTMLElement | null {
  // the version notice is transient and actionable, so it leads
  if (whatsNew) {
    return h(
      "div",
      { class: "banner" },
      icon("rocket", 15),
      h(
        "div",
        { class: "banner-body" },
        h("div", { class: "banner-title", text: `Updated to ${whatsNew}` }),
        h("div", {
          text: "Orbit picked up changes since you last looked. Open the Hub to see them, or dismiss this.",
        }),
      ),
      h("button", {
        class: "btn btn-sm",
        text: "Dismiss",
        on: { click: () => void dismissWhatsNew() },
      }),
    )
  }

  if (settings.method === "category" && settings.ai.provider === "local") {
    return h(
      "div",
      { class: "banner" },
      icon("sparkles", 15),
      h(
        "div",
        { class: "banner-body" },
        h("div", { class: "banner-title", text: "Running on the built-in engine" }),
        h("div", {
          text: "By Category works offline with a built-in classifier. Add an API key in Settings for sharper semantic grouping.",
        }),
      ),
      h("button", {
        class: "btn btn-sm",
        text: "Settings",
        on: { click: () => void chrome.runtime.openOptionsPage() },
      }),
    )
  }
  return null
}

/** Records that the current version's notice has been seen, so it stops showing. */
async function dismissWhatsNew(): Promise<void> {
  whatsNew = null
  await send({ type: "DISMISS_WHATS_NEW" })
  render()
}

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */

async function runOrganize(btn: HTMLButtonElement): Promise<void> {
  const original = btn.innerHTML
  btn.disabled = true
  clear(btn)
  btn.appendChild(icon("refresh", 16))
  btn.appendChild(h("span", { text: "Organizing…" }))
  btn.querySelector(".ic")?.classList.add("spin")

  const res = await send<OrganizeResult>({
    type: "ORGANIZE",
    method: settings.method,
    scope: settings.scope,
    windowId: windowId ?? undefined,
  })

  btn.disabled = false
  btn.innerHTML = original

  if (res.ok && res.data) {
    lastResult = res.data
    canUndo = res.data.ok
    if (res.data.error) toast(res.data.error, "warn", 3600)
    else toast(`Organized into ${plural(res.data.groups, "group")}`, "ok")
  } else {
    lastResult = {
      ok: false,
      method: settings.method,
      groups: 0,
      tabsGrouped: 0,
      closed: 0,
      error: res.error ?? "Failed to organize",
    }
    toast(res.error ?? "Failed to organize", "err")
  }
  render()
}

async function runCleanDuplicates(): Promise<void> {
  const res = await send<{ found: number; closed: number; binned: number }>({
    type: "CLEAN_DUPLICATES",
    windowId: windowId ?? undefined,
  })
  if (!res.ok || !res.data) {
    toast(res.error ?? "Failed", "err")
    return
  }
  const { closed, binned } = res.data
  if (closed === 0) {
    // This is the nag the setting exists to silence. It was stored, surfaced in
    // Settings, and never read - so the toggle did nothing.
    if (!settings.dontShowDuplicateCleanNotice) {
      toast("No duplicate tabs found.", "info")
    }
    return
  }
  // The outcome of a destructive action is always reported. Silencing it would
  // mean tabs disappeared with no explanation.
  toast(
    binned > 0
      ? `${closed} duplicates cleaned and moved to the recycle bin.`
      : `${closed} duplicates cleaned and closed.`,
    "ok",
  )
  render()
}

/* ------------------------------------------------------------------ */
/* First-run tour                                                      */
/* ------------------------------------------------------------------ */

const TOUR = [
  {
    title: "Pick how Orbit thinks",
    body: "Six organization methods. Hover any of them to see exactly what it does before you commit.",
  },
  {
    title: "Choose your scope",
    body: "Organize just this window, or pull every window into one tidy workspace.",
  },
  {
    title: "Organize, then relax",
    body: "Everything is reversible. Undo restores the exact layout from before the last pass. Turn on Auto-Organize and new tabs get filed as they load.",
  },
]

async function showTour(): Promise<void> {
  let step = 0
  const body = h("div", { class: "col gap-14" })

  await new Promise<void>((resolve) => {
    const paint = () => {
      clear(body)
      const t = TOUR[step]
      body.appendChild(
        h(
          "div",
          { class: "tour-step" },
          h("div", { class: "tour-num", text: String(step + 1) }),
          h(
            "div",
            {},
            h("div", { style: { fontWeight: "650", marginBottom: "2px" }, text: t.title }),
            h("div", { class: "hint", text: t.body }),
          ),
        ),
      )
    }

    const dots = h(
      "div",
      { class: "tour-dots" },
      TOUR.map((_, i) => h("span", { class: `tour-dot${i === step ? " on" : ""}` })),
    )

    const next = h("button", { class: "btn btn-primary", text: "Next" })
    const backdrop = h(
      "div",
      { class: "modal-backdrop" },
      h(
        "div",
        { class: "modal" },
        h("div", { class: "modal-head" }, h("h2", { class: "modal-title", text: "Welcome to Orbit" })),
        h("div", { class: "modal-body" }, body),
        h(
          "div",
          { class: "modal-foot" },
          dots,
          h("button", {
            class: "btn btn-ghost",
            text: "Skip",
            on: {
              click: () => {
                backdrop.remove()
                resolve()
              },
            },
          }),
          next,
        ),
      ),
    )

    const advance = () => {
      if (step < TOUR.length - 1) {
        step++
        clear(dots)
        for (let i = 0; i < TOUR.length; i++) {
          dots.appendChild(h("span", { class: `tour-dot${i === step ? " on" : ""}` }))
        }
        next.textContent = step === TOUR.length - 1 ? "Start organizing" : "Next"
        paint()
      } else {
        backdrop.remove()
        resolve()
      }
    }
    next.addEventListener("click", advance)

    paint()
    document.body.appendChild(backdrop)
  })

  settings = (await send<Settings>({ type: "SET_SETTINGS", patch: { tourDone: true } })).data ?? settings
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render(): void {
  clear(app)

  if (!settings) {
    app.appendChild(h("div", { class: "section" }, h("div", { class: "hint", text: "Loading…" })))
    return
  }

  app.appendChild(renderHeader())

  if (mode === "search") {
    app.appendChild(renderSearchMode())
    return
  }
  if (mode === "rename") {
    app.appendChild(renderRenameMode())
    return
  }

  const banner = renderBanner()
  if (banner) app.appendChild(banner)

  app.appendChild(
    h(
      "div",
      { class: "section" },
      h(
        "div",
        { class: "section-label" },
        h("span", { class: "section-title", text: "Organize by" }),
        // No "hover to preview" hint here: each row already prints its own
        // description, so there is nothing a hover would reveal. The label was
        // promising behaviour that did not exist.
      ),
      renderMethodList(),
    ),
  )

  app.appendChild(
    h(
      "div",
      { class: "section" },
      h("div", { class: "section-label" }, h("span", { class: "section-title", text: "Scope" })),
      renderScope(),
    ),
  )

  app.appendChild(h("div", { class: "section" }, renderOrganize()))

  app.appendChild(
    h(
      "div",
      { class: "section" },
      h("div", { class: "section-label" }, h("span", { class: "section-title", text: "Tab toolbox" })),
      renderTools(),
    ),
  )

  app.appendChild(
    h(
      "div",
      { class: "section" },
      h("div", { class: "section-label" }, h("span", { class: "section-title", text: "Automation" })),
      renderAuto(),
      renderLockGroups(),
    ),
  )

  app.appendChild(renderFooter(tabCount))
}

let tabCount = 0

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    clear(app)
    app.appendChild(
      h(
        "div",
        { class: "empty" },
        icon("info", 26),
        h("div", { class: "empty-title", text: "Not running as an extension" }),
        h("div", { class: "small", text: "Load the built extension in chrome://extensions to use Orbit." }),
      ),
    )
    return
  }

  try {
    windowId = (await chrome.windows.getCurrent()).id ?? null
  } catch {
    windowId = null
  }

  const s = await send<Settings>({ type: "GET_SETTINGS" })
  settings = s.data ?? ({} as Settings)

  const tok = await send<{ provider: string; model: string; unlimited: boolean }>({
    type: "GET_TOKEN_STATE",
  })
  providerInfo = tok.data ?? null

  // a version the user has not acknowledged yet, if any
  const wn = await send<{ version: string | null }>({ type: "GET_WHATS_NEW" })
  whatsNew = wn.data?.version ?? null

  const tabs = await chrome.tabs.query(windowId != null ? { windowId } : {})
  tabCount = tabs.length

  // `res.ok` only says the message arrived. Whether undo is available is a
  // property of the state, not of the transport.
  const hub = await send<{ canUndo?: boolean }>({ type: "GET_HUB_STATE" })
  canUndo = hub.data?.canUndo === true

  // pick up an intent parked by a keyboard shortcut or the context menu
  const meta = await chrome.storage.local.get(STORAGE.meta)
  const intent = (meta[STORAGE.meta] as { pendingIntent?: string } | undefined)?.pendingIntent
  if (intent === "rename" || intent === "search") {
    mode = intent
    await chrome.storage.local.set({ [STORAGE.meta]: {} })
  }

  render()

  if (!settings.tourDone) void showTour()
}

void boot()
