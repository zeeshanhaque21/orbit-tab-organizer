/**
 * Orbit Settings page.
 *
 * Eight sections, built with the shared DOM toolkit. Every control writes
 * through to `chrome.storage.local` the moment it changes (via the
 * `SET_SETTINGS` message), so there is no global Save button and no way to lose
 * a change by closing the tab.
 *
 * The page never renders stored data with `innerHTML`: everything user-supplied
 * goes through `textContent` / the `text` prop, which keeps it injection-safe.
 */
import { clear, favicon, h, icon, on, $, $$, type IconName } from "./shared/dom"
import { modal, promptModal, send, toast } from "./shared/ui"
import {
  AI_PRESETS,
  COLOR_HEX,
  DEFAULT_SETTINGS,
  GROUP_COLORS,
  LIMITS,
  STARTER_TOPIC_SETS,
  STORAGE,
} from "./shared/constants"
import { absoluteTime, debounce, displayTitle, hostOf, plural, timeAgo } from "./shared/format"
import type {
  AiProviderId,
  AiSettings,
  DuplicateBinMode,
  DuplicateMatchMode,
  GroupColor,
  GroupingDefaultState,
  GroupingMethod,
  GroupingScope,
  RecycleEntry,
  SavedGroup,
  Settings,
  Topic,
  TopicMatchMode,
  TopicSet,
} from "./shared/types"

/* ------------------------------------------------------------------ */
/* Static copy                                                         */
/* ------------------------------------------------------------------ */

type SectionId =
  | "organizing"
  | "duplicates"
  | "ai"
  | "topics"
  | "saved"
  | "recycle"
  | "shortcuts"
  | "data"

const SECTIONS: Array<{ id: SectionId; label: string; icon: IconName }> = [
  { id: "organizing", label: "Organizing", icon: "settings" },
  { id: "duplicates", label: "Duplicates", icon: "copy" },
  { id: "ai", label: "AI provider", icon: "sparkles" },
  { id: "topics", label: "My Topics", icon: "layers" },
  { id: "saved", label: "Saved groups", icon: "folder" },
  { id: "recycle", label: "Recycle bin", icon: "archive" },
  { id: "shortcuts", label: "Shortcuts", icon: "zap" },
  { id: "data", label: "Data", icon: "shield" },
]

interface MethodInfo {
  value: GroupingMethod
  label: string
  desc: string
  badge?: string
}

const METHODS: MethodInfo[] = [
  {
    value: "category",
    label: "By Category",
    desc: "Groups tabs by what they are about - Research, Shopping, Finance, Work. Uses your AI provider when one is configured, and the built-in classifier otherwise.",
    badge: "AI or offline",
  },
  {
    value: "last_access",
    label: "By Last Access",
    desc: "Sorts tabs into fixed time buckets, from \u201cjust now\u201d to \u201colder than 2 days\u201d. Fully offline, deterministic, and never touches the network.",
    badge: "Offline",
  },
  {
    value: "frequency",
    label: "By Frequency",
    desc: "Ranks tabs by how often you come back to them and sorts them into A-D buckets, where A is the tab you are most likely to want next.",
    badge: "AI or offline",
  },
  {
    value: "relevance",
    label: "By Relevance",
    desc: "Groups tabs by how closely they relate to whatever you are working on right now, so the current task sits together.",
    badge: "AI",
  },
  {
    value: "topics",
    label: "By Topics",
    desc: "Groups tabs using your own topic sets - the domains, URL paths and keywords you define on the My Topics section.",
    badge: "Offline",
  },
  {
    value: "memory",
    label: "By Memory",
    desc: "Reapplies the groupings you have used before, so tabs keep landing where you filed them last time.",
    badge: "AI",
  },
]

const SCOPES: Array<{ value: GroupingScope; label: string; desc: string }> = [
  {
    value: "current_window",
    label: "Current window only",
    desc: "Organizes the window you are looking at and leaves every other window untouched.",
  },
  {
    value: "all_windows",
    label: "All windows",
    desc: "Collects tabs from every window into a single organized window. The other windows are emptied as their tabs move across.",
  },
]

const DEFAULT_STATES: Array<{ value: GroupingDefaultState; label: string }> = [
  { value: "collapsed", label: "Collapsed" },
  { value: "expanded", label: "Expanded" },
  // Focus Active: keep the active tab's group open, collapse the rest
  { value: "active-only", label: "Focus Active" },
  { value: "unchanged", label: "Unchanged" },
]

const MATCH_MODES: Array<{ value: DuplicateMatchMode; label: string; desc: string }> = [
  {
    value: "url",
    label: "Same URL",
    desc: "Two tabs are duplicates only when their addresses match. Tracking parameters, fragments and parameter order are ignored first. Safest: a page open at two different anchors is kept.",
  },
  {
    value: "title_url",
    label: "Same title and URL",
    desc: "Requires both the title and the address to match. Catches pages that redirect to slightly different URLs but leaves more tabs behind, since a retitled tab is never treated as a duplicate.",
  },
]

const BIN_MODES: Array<{ value: DuplicateBinMode; label: string; desc: string }> = [
  {
    value: "recycle",
    label: "Move to the recycle bin",
    desc: "Closed duplicates stay recoverable from the Recycle bin section until you clear it.",
  },
  {
    value: "permanent",
    label: "Remove permanently",
    desc: "Closed duplicates are gone immediately and cannot be restored.",
  },
]

const TOPIC_MATCH_MODES: Array<{ value: TopicMatchMode; label: string; desc: string }> = [
  {
    value: "domain",
    label: "Domain",
    desc: "Matches the site name, subdomains included. \u201cgithub.com\u201d catches every github.com page.",
  },
  {
    value: "path",
    label: "URL path",
    desc: "Matches the part of the address after the domain. \u201c/pull/\u201d catches pull requests on any site.",
  },
  {
    value: "keyword",
    label: "Keyword",
    desc: "Matches anywhere in the address or the tab title. \u201cinvoice\u201d catches any tab mentioning it.",
  },
]

const TOPIC_MODE_EXAMPLES: Record<TopicMatchMode, string> = {
  domain: "Example: github.com  ·  docs.python.org  ·  localhost",
  path: "Example: /pull/  ·  /issues  ·  /docs/",
  keyword: "Example: invoice  ·  quarterly report  ·  roadmap",
}

const COMMANDS: Array<{ name: string; label: string }> = [
  { name: "orbit_toggle_collapse", label: "Toggle collapse / expand tab groups" },
  { name: "orbit_open_hub", label: "Open Orbit Hub" },
  { name: "orbit_rename_tab", label: "Rename the current tab" },
  { name: "orbit_search_tab", label: "Search open tabs" },
]

/** The keys the manifest suggests, used until Chrome reports what it bound. */
const COMMAND_DEFAULTS: Record<string, string> = {
  orbit_toggle_collapse: "CmdOrCtrl+Shift+K",
  orbit_open_hub: "CmdOrCtrl+Shift+L",
  orbit_rename_tab: "CmdOrCtrl+Shift+E",
  orbit_search_tab: "CmdOrCtrl+Shift+S",
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface UiState {
  settings: Settings
  topicSets: TopicSet[]
  savedGroups: SavedGroup[]
  recycle: RecycleEntry[]
  commands: chrome.commands.Command[]
  expandedTopics: Set<string>
  recycleSelected: Set<string>
  savedQuery: string
  loadWarnings: string[]
}

const state: UiState = {
  settings: DEFAULT_SETTINGS,
  topicSets: [],
  savedGroups: [],
  recycle: [],
  commands: [],
  expandedTopics: new Set<string>(),
  recycleSelected: new Set<string>(),
  savedQuery: "",
  loadWarnings: [],
}

const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent)

let saveTimer: ReturnType<typeof setTimeout> | undefined

/* ------------------------------------------------------------------ */
/* Settings plumbing                                                   */
/* ------------------------------------------------------------------ */

/** Mirrors the service worker's deep merge so the UI never drifts. */
function mergeLocal(base: Settings, patch: Partial<Settings> | undefined): Settings {
  if (!patch) return { ...base, ai: { ...base.ai } }
  return {
    ...base,
    ...patch,
    ai: { ...base.ai, ...(patch.ai ?? {}) },
    customTabTitles: { ...base.customTabTitles, ...(patch.customTabTitles ?? {}) },
  }
}

/** Applies a patch to the local copy immediately, then persists it. */
function change(patch: Partial<Settings>, rerender?: () => void): void {
  state.settings = mergeLocal(state.settings, patch)
  void persist(patch)
  rerender?.()
}

async function persist(patch: Partial<Settings>): Promise<void> {
  const res = await send<Settings>({ type: "SET_SETTINGS", patch })
  if (!res.ok) {
    flashSaved(false, res.error ?? "Could not save")
    toast(res.error ?? "Could not save settings", "err")
    // Re-read so the UI stops showing a value the worker never stored.
    const fresh = await send<Settings>({ type: "GET_SETTINGS" })
    if (fresh.ok && fresh.data) state.settings = mergeLocal(DEFAULT_SETTINGS, fresh.data)
    return
  }
  if (res.data) state.settings = mergeLocal(DEFAULT_SETTINGS, res.data)
  flashSaved(true)
}

function flashSaved(ok: boolean, message?: string): void {
  const el = $("#save-status")
  if (!el) return
  el.classList.toggle("err", !ok)
  clear(el)
  el.appendChild(icon(ok ? "check" : "x", 12))
  el.appendChild(h("span", { text: message ?? "Saved" }))
  el.classList.add("show")
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => el.classList.remove("show"), ok ? 1500 : 4000)
}

/** Debounced writer for a text field, reading the latest state at flush time. */
function textSaver(build: (value: string) => Partial<Settings>, ms = 450): (value: string) => void {
  return debounce((value: string) => change(build(value)), ms)
}

function aiPatch(build: (ai: AiSettings) => Partial<AiSettings>): Partial<Settings> {
  return { ai: { ...state.settings.ai, ...build(state.settings.ai) } }
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/* ------------------------------------------------------------------ */
/* Small builders                                                      */
/* ------------------------------------------------------------------ */

function section(id: SectionId, title: string, sub: string, ...children: unknown[]): HTMLElement {
  return h(
    "section",
    { class: "opt-section", id: `sec-${id}`, dataset: { section: id } },
    h(
      "div",
      { class: "section-head" },
      h("h2", { class: "section-title", text: title }),
      h("p", { class: "section-sub", text: sub }),
    ),
    ...children,
  )
}

function card(...children: unknown[]): HTMLElement {
  return h("div", { class: "card card-pad" }, ...children)
}

function optRow(o: {
  title: string
  desc: string
  badge?: string
  selected: boolean
  onSelect: () => void
}): HTMLElement {
  return h(
    "button",
    {
      class: ["opt-row", o.selected ? "sel" : ""],
      type: "button",
      role: "radio",
      "aria-checked": o.selected ? "true" : "false",
      on: { click: () => o.onSelect() },
    },
    h("span", { class: "opt-mark" }, o.selected ? icon("check", 11) : null),
    h(
      "span",
      { class: "opt-text" },
      h(
        "span",
        { class: "opt-title" },
        h("span", { text: o.title }),
        o.badge ? h("span", { class: "badge", text: o.badge }) : null,
      ),
      h("span", { class: "opt-desc", text: o.desc }),
    ),
  )
}

function switchControl(checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  const input = h("input", {
    type: "checkbox",
    checked,
    on: { change: (e: Event) => onChange((e.target as HTMLInputElement).checked) },
  })
  return h("label", { class: "switch" }, input, h("span", { class: "track" }), h("span", { class: "thumb" }))
}

function settingRow(title: string, desc: string, control: Node, wide = false): HTMLElement {
  return h(
    "div",
    { class: "setting-row" },
    h(
      "div",
      { class: "setting-text" },
      h("div", { class: "setting-title", text: title }),
      desc ? h("div", { class: "hint", text: desc }) : null,
    ),
    h("div", { class: ["setting-control", wide ? "wide" : ""] }, control),
  )
}

function field(label: string, control: Node, hint?: string): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h("label", { class: "label", text: label }),
    control,
    hint ? h("div", { class: "hint", text: hint }) : null,
  )
}

function segmented<T extends string>(
  opts: Array<{ value: T; label: string }>,
  current: T,
  onPick: (value: T) => void,
): HTMLElement {
  return h(
    "div",
    { class: "segmented", role: "group" },
    opts.map((o) =>
      h("button", {
        type: "button",
        text: o.label,
        "aria-pressed": o.value === current ? "true" : "false",
        on: { click: () => onPick(o.value) },
      }),
    ),
  )
}

function methodSelect(current: GroupingMethod, onPick: (m: GroupingMethod) => void): HTMLElement {
  return h(
    "select",
    {
      class: "select",
      on: { change: (e: Event) => onPick((e.target as HTMLSelectElement).value as GroupingMethod) },
    },
    METHODS.map((m) =>
      h("option", { value: m.value, text: m.label, selected: m.value === current }),
    ),
  )
}

function emptyState(iconName: IconName, title: string, hint: string): HTMLElement {
  return h(
    "div",
    { class: "empty" },
    icon(iconName, 26),
    h("div", { class: "empty-title", text: title }),
    h("div", { class: "hint", text: hint }),
  )
}

function banner(kind: "note" | "warn", ...content: unknown[]): HTMLElement {
  return h("div", { class: kind === "note" ? "note-box" : "warn-box" }, icon("info", 14), h("div", { class: "grow" }, ...content))
}

function groupDot(color: GroupColor): HTMLElement {
  return h("span", { class: "group-dot", style: { background: COLOR_HEX[color] } })
}

/* ------------------------------------------------------------------ */
/* 1. Organizing                                                       */
/* ------------------------------------------------------------------ */

function renderOrganizing(): HTMLElement {
  const s = state.settings
  const rerender = () => replaceSection("organizing", renderOrganizing())

  const methods = h(
    "div",
    { class: "opt-list", role: "radiogroup", "aria-label": "Default grouping method" },
    METHODS.map((m) =>
      optRow({
        title: m.label,
        desc: m.desc,
        badge: m.badge,
        selected: s.method === m.value,
        onSelect: () => {
          if (state.settings.method === m.value) return
          change({ method: m.value }, rerender)
        },
      }),
    ),
  )

  const scopes = h(
    "div",
    { class: "opt-list", role: "radiogroup", "aria-label": "Organizing scope" },
    SCOPES.map((sc) =>
      optRow({
        title: sc.label,
        desc: sc.desc,
        selected: s.scope === sc.value,
        onSelect: () => {
          if (state.settings.scope === sc.value) return
          change({ scope: sc.value }, rerender)
        },
      }),
    ),
  )

  const autoToggle = switchControl(s.autoMode, (v) => change({ autoMode: v }, rerender))

  const autoCard = card(
    h("h3", { class: "card-title", text: "Auto-Organize" }),
    settingRow(
      "Group every new tab on the fly",
      "When this is on, Orbit files each new tab into a group the moment it loads. When it is off, nothing moves until you run Organize Now.",
      autoToggle,
    ),
    settingRow(
      "Method used by Auto-Organize",
      "Independent of the default method above, so manual runs and automatic runs can behave differently.",
      methodSelect(s.autoMethod, (m) => change({ autoMethod: m }, rerender)),
      true,
    ),
  )

  const groupingCard = card(
    h("h3", { class: "card-title", text: "Grouping" }),
    settingRow(
      "State of new groups",
      "What to do with the collapse state of the groups Orbit creates.",
      segmented(DEFAULT_STATES, s.groupingDefaultState, (v) =>
        change({ groupingDefaultState: v }, rerender),
      ),
    ),
    settingRow(
      "Order groups by title",
      "Sorts the groups alphabetically after organizing, instead of leaving them in the order they were produced.",
      switchControl(s.orderGroupsByTitle, (v) => change({ orderGroupsByTitle: v })),
    ),
    settingRow(
      "Protect pinned tabs",
      "Pinned tabs stay exactly where they are and are left out of every grouping pass.",
      switchControl(s.protectPinned, (v) => change({ protectPinned: v })),
    ),
  )

  return section(
    "organizing",
    "Organizing",
    "Choose how Orbit sorts your tabs, where it looks for them, and how much it is allowed to move.",
    card(h("h3", { class: "card-title", text: "Default method" }), methods),
    card(h("h3", { class: "card-title", text: "Scope" }), scopes),
    autoCard,
    groupingCard,
  )
}

/* ------------------------------------------------------------------ */
/* 2. Duplicate cleaning                                               */
/* ------------------------------------------------------------------ */

function renderDuplicates(): HTMLElement {
  const s = state.settings
  const rerender = () => replaceSection("duplicates", renderDuplicates())

  const matchRows = h(
    "div",
    { class: "opt-list", role: "radiogroup", "aria-label": "Duplicate match mode" },
    MATCH_MODES.map((m) =>
      optRow({
        title: m.label,
        desc: m.desc,
        selected: s.duplicateMatchMode === m.value,
        onSelect: () => {
          if (state.settings.duplicateMatchMode === m.value) return
          change({ duplicateMatchMode: m.value }, rerender)
        },
      }),
    ),
  )

  const binRows = h(
    "div",
    { class: "opt-list", role: "radiogroup", "aria-label": "Where closed duplicates go" },
    BIN_MODES.map((m) =>
      optRow({
        title: m.label,
        desc: m.desc,
        selected: s.duplicateBinMode === m.value,
        onSelect: () => {
          if (state.settings.duplicateBinMode === m.value) return
          change({ duplicateBinMode: m.value }, rerender)
        },
      }),
    ),
  )

  const cleanBtn = h(
    "button",
    { class: "btn btn-primary", type: "button", on: { click: () => void cleanDuplicates(cleanBtn) } },
    icon("wand", 15),
    h("span", { text: "Clean duplicates now" }),
  )

  const children: unknown[] = [
    card(h("h3", { class: "card-title", text: "Match mode" }), matchRows),
    card(
      h("h3", { class: "card-title", text: "Where closed duplicates go" }),
      binRows,
      s.duplicateBinMode === "permanent"
        ? banner(
            "warn",
            h(
              "span",
              null,
              h("strong", { text: "Permanent removal is on. " }),
              "Duplicates closed from now on are deleted for good and cannot be restored from the recycle bin.",
            ),
          )
        : null,
    ),
    card(
      h("h3", { class: "card-title", text: "Cleaning" }),
      settingRow(
        "Hide the result notice",
        "Skip the summary Orbit shows after a duplicate clean.",
        switchControl(s.dontShowDuplicateCleanNotice, (v) =>
          change({ dontShowDuplicateCleanNotice: v }),
        ),
      ),
      h("div", { class: "divider" }),
      h(
        "div",
        { class: "row between wrap" },
        h(
          "div",
          { class: "setting-text" },
          h("div", { class: "setting-title", text: "Run a clean on the current window" }),
          h("div", {
            class: "hint",
            text: "Closes the duplicate tabs it finds and reports how many were removed.",
          }),
        ),
        cleanBtn,
      ),
    ),
  ]

  return section(
    "duplicates",
    "Duplicate cleaning",
    "Decide what counts as a duplicate and what happens to the copies Orbit closes.",
    ...children,
  )
}

async function cleanDuplicates(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true
  const res = await send<{ removed?: number; closed?: number; count?: number; found?: number }>({
    type: "CLEAN_DUPLICATES",
  })
  btn.disabled = false

  if (!res.ok) {
    toast(res.error ?? "Could not clean duplicates", "err")
    return
  }
  const d = res.data ?? {}
  const n = d.removed ?? d.closed ?? d.count ?? d.found
  if (n === 0) toast("No duplicate tabs found.", "info")
  else if (n === undefined) toast("Duplicates cleaned", "ok")
  else toast(`Duplicates cleaned - removed ${plural(n, "tab")}`, "ok")
}

/* ------------------------------------------------------------------ */
/* 3. AI provider                                                      */
/* ------------------------------------------------------------------ */

function renderAi(): HTMLElement {
  const ai = state.settings.ai
  const preset = ai.provider === "custom" ? null : AI_PRESETS[ai.provider]
  const rerender = () => replaceSection("ai", renderAi())

  const providerSelect = h(
    "select",
    {
      class: "select",
      on: {
        change: (e: Event) => {
          const next = (e.target as HTMLSelectElement).value as AiProviderId
          if (next === state.settings.ai.provider) return
          if (next === "custom") {
            change(aiPatch((cur) => ({ provider: "custom", baseUrl: cur.baseUrl, model: cur.model })), rerender)
            return
          }
          const p = AI_PRESETS[next]
          change(aiPatch(() => ({ provider: next, baseUrl: p.baseUrl, model: p.model })), rerender)
        },
      },
    },
    [
      ...(Object.keys(AI_PRESETS) as Array<Exclude<AiProviderId, "custom">>).map((id) =>
        h("option", {
          value: id,
          text: id === "local" ? `${AI_PRESETS[id].label} - recommended` : AI_PRESETS[id].label,
          selected: ai.provider === id,
        }),
      ),
      h("option", {
        value: "custom",
        text: "Custom / self-hosted endpoint",
        selected: ai.provider === "custom",
      }),
    ],
  )
  /* ---- API key with a show/hide toggle ---- */
  const saveKey = textSaver((v) => aiPatch(() => ({ apiKey: v })), 500)

  const keyInput = h("input", {
    class: "input",
    type: "password",
    value: ai.apiKey,
    placeholder: "Paste your key - it never leaves this browser",
    autocomplete: "off",
    spellcheck: false,
    on: {
      input: (e: Event) => saveKey((e.target as HTMLInputElement).value),
    },
  })
  const keyToggle = h(
    "button",
    {
      class: "btn btn-icon",
      type: "button",
      title: "Show API key",
      "aria-pressed": "false",
      on: {
        click: () => {
          const show = keyInput.type === "password"
          keyInput.type = show ? "text" : "password"
          keyToggle.title = show ? "Hide API key" : "Show API key"
          keyToggle.setAttribute("aria-pressed", show ? "true" : "false")
        },
      },
    },
    icon("eye", 15),
  )

  /* ---- temperature ---- */
  const saveTemp = debounce((v: number) => change(aiPatch(() => ({ temperature: v }))), 350)
  const tempValue = h("span", { class: "range-value", text: ai.temperature.toFixed(1) })
  const tempInput = h("input", {
    class: "range",
    type: "range",
    min: "0",
    max: "1",
    step: "0.1",
    value: String(ai.temperature),
    "aria-label": "Temperature",
    on: {
      input: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value)
        tempValue.textContent = v.toFixed(1)
        saveTemp(v)
      },
    },
  })

  /* ---- test connection ---- */
  const result = h("div", { class: "hint" })
  const testLabel = h("span", { text: "Test connection" })
  const testBtn = h(
    "button",
    { class: "btn", type: "button", on: { click: () => void testProvider(testBtn, testLabel, result) } },
    icon("zap", 15),
    testLabel,
  )

  const fields: unknown[] = []
  if (ai.provider !== "local") {
    const saveBaseUrl = textSaver((v) => aiPatch(() => ({ baseUrl: v.trim() })))
    const saveModel = textSaver((v) => aiPatch(() => ({ model: v.trim() })))
    fields.push(
      field(
        "Base URL",
        h("input", {
          class: "input",
          type: "url",
          value: ai.baseUrl,
          placeholder: "https://api.example.com/v1",
          spellcheck: false,
          on: {
            input: (e: Event) => saveBaseUrl((e.target as HTMLInputElement).value),
            // ask for host access once the user has finished typing, so the
            // first Test connection or organize does not fail on a missing grant
            change: (e: Event) => void ensureHostAccess((e.target as HTMLInputElement).value),
          },
        }),
        "The OpenAI-compatible endpoint Orbit should call.",
      ),
      field(
        "Model",
        h("input", {
          class: "input",
          value: ai.model,
          placeholder: "gpt-4o-mini",
          spellcheck: false,
          on: { input: (e: Event) => saveModel((e.target as HTMLInputElement).value) },
        }),
        "Exactly the model id your endpoint expects.",
      ),
      field("API key", h("div", { class: "row" }, h("div", { class: "grow" }, keyInput), keyToggle)),
    )
  }

  /*
   * The Chrome Web Store requires a prominent, in-product disclosure of what
   * user data is handled and why, shown in the product rather than only in the
   * privacy policy ("Supplying user data", question 10). Whenever a provider
   * other than the built-in engine is selected, the tabs being organized leave
   * the device, so this says so at the point the choice is made.
   */
  const dataNotice =
    ai.provider === "local"
      ? null
      : banner(
          "note",
          h(
            "span",
            null,
            h("strong", { text: "What leaves your device: " }),
            "By Category sends the URL and title of the tabs it is organizing to the endpoint you chose here, using your key. Nothing else is sent, and nothing is ever sent to us. Switch to the built-in engine and no network request is made at all.",
          ),
        )

  const providerCard = card(
    h("h3", { class: "card-title", text: "Provider" }),
    field("AI provider", providerSelect, preset?.docs),
    dataNotice,
    ai.provider === "custom"
      ? banner(
          "note",
          h(
            "span",
            null,
            h("strong", { text: "Custom endpoint. " }),
            "Point Orbit at any OpenAI-compatible server - Ollama, LM Studio, vLLM or your own gateway.",
          ),
        )
      : null,
    fields.length ? h("div", { class: "stack" }, fields) : null,
    h(
      "div",
      { class: "stack-sm" },
      field(
        "Temperature",
        h("div", { class: "range-row" }, tempInput, tempValue),
        "Lower is steadier and better for classification. Raise it only if you want more varied group names.",
      ),
    ),
    h("div", { class: "divider" }),
    h(
      "div",
      { class: "row between wrap" },
      h(
        "div",
        { class: "setting-text" },
        h("div", {
          class: "setting-title",
          text: ai.provider === "local" ? "Check the built-in engine" : "Check your credentials",
        }),
        h("div", {
          class: "hint",
          text:
            ai.provider === "local"
              ? "Confirms the offline classifier responds, with no network call."
              : "Sends one tiny request to the provider above and reports the round-trip time.",
        }),
      ),
      testBtn,
    ),
    result,
  )

  const privacyCard = card(
    h("h3", { class: "card-title", text: "Where your key lives" }),
    banner(
      "note",
      h(
        "span",
        null,
        h("strong", { text: "Bring your own key. " }),
        "The built-in engine is the default and needs no key at all. If you add one, it is stored only in ",
        h("code", { class: "mono", text: "chrome.storage.local" }),
        " on this device and is sent to nobody except the provider you pick. There is no Orbit account, no token meter and no telemetry.",
      ),
    ),
  )

  return section(
    "ai",
    "AI provider",
    "Orbit works fully offline out of the box. Connect a provider only if you want the AI methods to use your own model.",
    providerCard,
    privacyCard,
  )
}

/**
 * Self-hosted and custom endpoints live outside the hosts the manifest already
 * declares, so they need the optional host permission before a fetch from the
 * service worker will succeed. Must be called from a click handler, which is
 * what Chrome requires before it will show a prompt.
 *
 * Returns false only when the user actively declined.
 */
async function ensureHostAccess(baseUrl: string): Promise<boolean> {
  let pattern: string
  try {
    pattern = `${new URL(baseUrl).origin}/*`
  } catch {
    // not a usable URL - let the request itself report the real problem
    return true
  }
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return true
    return await chrome.permissions.request({ origins: [pattern] })
  } catch {
    // the permissions API is unavailable here; the fetch will explain why
    return true
  }
}

async function testProvider(
  btn: HTMLButtonElement,
  label: HTMLElement,
  result: HTMLElement,
): Promise<void> {
  btn.disabled = true
  label.textContent = "Testing..."
  result.textContent = ""
  result.className = "hint"

  // A custom endpoint needs host access first, otherwise the request fails with
  // an opaque network error that looks like the endpoint is broken.
  const current = await send<Settings>({ type: "GET_SETTINGS" })
  const baseUrl = current.data?.ai.baseUrl ?? ""
  if (current.data?.ai.provider === "custom" && baseUrl) {
    const granted = await ensureHostAccess(baseUrl)
    if (!granted) {
      btn.disabled = false
      label.textContent = "Test connection"
      result.textContent = `Orbit needs permission to reach ${baseUrl}.`
      result.className = "hint err-text"
      toast("Host access was declined", "warn")
      return
    }
  }

  const res = await send<{
    ok?: boolean
    ms?: number
    latencyMs?: number
    model?: string
    error?: string
    message?: string
  }>({
    type: "TEST_PROVIDER",
  })

  btn.disabled = false
  label.textContent = "Test connection"

  // `res.ok` only means the message reached the worker. The provider's own
  // verdict is `res.data.ok`, and conflating the two reports success for every
  // failure - a dead endpoint, a bad key, a missing permission.
  const outcome = res.data
  const providerOk = res.ok && outcome?.ok === true

  if (providerOk) {
    const d = outcome ?? {}
    const ms = typeof d.ms === "number" ? d.ms : typeof d.latencyMs === "number" ? d.latencyMs : undefined
    const detail = d.model ? ` - ${d.model}` : ""
    result.textContent =
      ms !== undefined ? `Connected in ${ms} ms${detail}` : (d.message ?? `Connection succeeded${detail}`)
    result.className = "hint ok-text"
    toast("Provider reachable", "ok")
    return
  }

  const reason = outcome?.error ?? res.error ?? "Connection failed"
  result.textContent = reason
  result.className = "hint err-text"
  toast("Could not reach the provider", "err")
}

/* ------------------------------------------------------------------ */
/* 4. My Topics                                                        */
/* ------------------------------------------------------------------ */

async function saveSet(next: TopicSet): Promise<boolean> {
  const res = await send({ type: "TOPIC_SETS_SAVE", set: next })
  if (!res.ok) {
    toast(res.error ?? "Could not save the topic set", "err")
    return false
  }
  const i = state.topicSets.findIndex((s) => s.id === next.id)
  if (i >= 0) state.topicSets[i] = next
  else state.topicSets.push(next)
  return true
}

function renderTopics(): HTMLElement {
  const rerender = () => replaceSection("topics", renderTopics())
  const activeId = state.settings.activeTopicSetId

  const legend = card(
    h("h3", { class: "card-title", text: "How matching works" }),
    h(
      "div",
      { class: "stack-sm" },
      TOPIC_MATCH_MODES.map((m) =>
        h(
          "div",
          { class: "row", style: { alignItems: "flex-start", gap: "9px" } },
          h("span", { class: "badge", text: m.label }),
          h("span", { class: "hint", text: m.desc }),
        ),
      ),
    ),
  )

  const loadStarters = h(
    "button",
    {
      class: "btn",
      type: "button",
      on: { click: () => void loadStarterSets(loadStarters) },
    },
    icon("sparkles", 15),
    h("span", { text: "Load starter sets" }),
  )

  const newSet = h(
    "button",
    { class: "btn btn-primary", type: "button", on: { click: () => void createSet() } },
    icon("plus", 15),
    h("span", { text: "New topic set" }),
  )

  const list = state.topicSets.length
    ? h(
        "div",
        { class: "stack" },
        state.topicSets.map((set) => topicSetCard(set, activeId === set.id, rerender)),
      )
    : emptyState(
        "layers",
        "No topic sets yet",
        "Create one, or load the starter sets to get a working By Topics method in one click.",
      )

  return section(
    "topics",
    "My Topics",
    "Topic sets are your own grouping rules. Pick the active set here, then choose By Topics as the organizing method.",
    h(
      "div",
      { class: "row between wrap" },
      h("div", { class: "hint", text: activeId ? `Active set: ${topicSetName(activeId)}` : "No set is active." }),
      h("div", { class: "row" }, loadStarters, newSet),
    ),
    legend,
    list,
  )
}

function topicSetName(id: string): string {
  return state.topicSets.find((s) => s.id === id)?.name ?? id
}

function topicSetCard(set: TopicSet, active: boolean, rerender: () => void): HTMLElement {
  const activate = h(
    "button",
    {
      class: "btn btn-icon",
      type: "button",
      title: active ? "This set is active" : "Use this set",
      "aria-pressed": active ? "true" : "false",
      on: {
        click: () => {
          if (state.settings.activeTopicSetId === set.id) return
          change({ activeTopicSetId: set.id }, rerender)
          toast(`Active topic set: ${set.name}`, "ok")
        },
      },
    },
    icon(active ? "check" : "orbit", 16),
  )

  const rename = h(
    "button",
    {
      class: "btn btn-icon",
      type: "button",
      title: "Rename set",
      on: {
        click: () =>
          void (async () => {
            const name = await promptModal({
              title: "Rename topic set",
              label: "Set name",
              value: set.name,
              confirmText: "Rename",
            })
            if (!name || name === set.name) return
            if (await saveSet({ ...set, name })) {
              toast("Topic set renamed", "ok")
              rerender()
            }
          })(),
      },
    },
    icon("save", 15),
  )

  const remove = h(
    "button",
    {
      class: "btn btn-icon",
      type: "button",
      title: "Delete set",
      on: {
        click: () =>
          void (async () => {
            const ok = await modal({
              title: "Delete this topic set?",
              body: `"${set.name}" and its ${plural(set.topics.length, "topic")} will be removed. This cannot be undone.`,
              confirmText: "Delete set",
              danger: true,
            })
            if (!ok) return
            const res = await send({ type: "TOPIC_SETS_DELETE", id: set.id })
            if (!res.ok) {
              toast(res.error ?? "Could not delete the set", "err")
              return
            }
            state.topicSets = state.topicSets.filter((s) => s.id !== set.id)
            if (state.settings.activeTopicSetId === set.id) {
              change({ activeTopicSetId: null })
            }
            toast("Topic set deleted", "ok")
            rerender()
          })(),
      },
    },
    icon("trash", 15),
  )

  const atCap = set.topics.length >= LIMITS.topicsPerSet
  const addTopic = h(
    "button",
    {
      class: "btn btn-sm",
      type: "button",
      disabled: atCap,
      title: atCap ? `A set can hold at most ${LIMITS.topicsPerSet} topics` : "Add a topic",
      on: { click: () => void addTopicToSet(set, rerender) },
    },
    icon("plus", 14),
    h("span", { text: "Add topic" }),
  )

  return h(
    "div",
    { class: "card set-card" },
    h(
      "div",
      { class: "set-head" },
      activate,
      h(
        "div",
        { class: "grow" },
        h("div", { class: "set-name truncate", text: set.name }),
        h("div", {
          class: "hint",
          text: `${plural(set.topics.length, "topic")}${set.createdAt ? ` - created ${timeAgo(set.createdAt)}` : ""}`,
        }),
      ),
      active ? h("span", { class: "chip chip-active", text: "Active" }) : null,
      rename,
      remove,
    ),
    h(
      "div",
      { class: "set-body" },
      set.topics.length
        ? h("div", { class: "stack-sm" }, set.topics.map((t) => topicRow(set, t, rerender)))
        : h("div", { class: "hint", text: "No topics in this set yet." }),
      h("div", { class: "row" }, addTopic),
    ),
  )
}

function topicRow(set: TopicSet, topic: Topic, rerender: () => void): HTMLElement {
  const expanded = state.expandedTopics.has(topic.id)

  const toggle = h(
    "button",
    {
      class: "btn btn-icon",
      type: "button",
      title: expanded ? "Close editor" : "Edit topic",
      on: {
        click: () => {
          if (expanded) state.expandedTopics.delete(topic.id)
          else state.expandedTopics.add(topic.id)
          rerender()
        },
      },
    },
    icon(expanded ? "chevron-down" : "chevron-right", 15),
  )

  const remove = h(
    "button",
    {
      class: "btn btn-icon",
      type: "button",
      title: "Delete topic",
      on: {
        click: () =>
          void (async () => {
            const next: TopicSet = { ...set, topics: set.topics.filter((t) => t.id !== topic.id) }
            if (await saveSet(next)) {
              state.expandedTopics.delete(topic.id)
              toast("Topic deleted", "ok")
              rerender()
            }
          })(),
      },
    },
    icon("trash", 15),
  )

  const modeLabel = TOPIC_MATCH_MODES.find((m) => m.value === topic.matchMode)?.label ?? topic.matchMode

  return h(
    "div",
    { class: "topic-row" },
    h(
      "div",
      { class: "topic-head" },
      groupDot(topic.color),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "topic-name truncate", text: topic.name }),
        h("div", {
          class: "hint truncate",
          text: `${modeLabel} - ${plural(topic.patterns.length, "pattern")}`,
        }),
      ),
      toggle,
      remove,
    ),
    expanded ? topicEditor(set, topic, rerender) : null,
  )
}

function topicEditor(set: TopicSet, topic: Topic, rerender: () => void): HTMLElement {
  let color: GroupColor = topic.color
  let mode: TopicMatchMode = topic.matchMode

  const nameInput = h("input", { class: "input", value: topic.name, spellcheck: false })

  const swatches = h(
    "div",
    { class: "swatches", role: "radiogroup", "aria-label": "Topic colour" },
    GROUP_COLORS.map((c) =>
      h("button", {
        class: ["swatch", c === color ? "sel" : ""],
        type: "button",
        title: c,
        "aria-label": c,
        "aria-pressed": c === color ? "true" : "false",
        dataset: { color: c },
        style: { background: COLOR_HEX[c] },
        on: {
          click: () => {
            color = c
            for (const el of $$(".swatch", swatches)) {
              const on_ = el.dataset.color === c
              el.classList.toggle("sel", on_)
              el.setAttribute("aria-pressed", on_ ? "true" : "false")
            }
          },
        },
      }),
    ),
  )

  const example = h("div", { class: "hint", text: TOPIC_MODE_EXAMPLES[mode] })

  const modeSelect = h(
    "select",
    {
      class: "select",
      on: {
        change: (e: Event) => {
          mode = (e.target as HTMLSelectElement).value as TopicMatchMode
          example.textContent = TOPIC_MODE_EXAMPLES[mode]
        },
      },
    },
    TOPIC_MATCH_MODES.map((m) =>
      h("option", { value: m.value, text: m.label, selected: m.value === mode }),
    ),
  )

  const patterns = h("textarea", {
    class: "textarea",
    spellcheck: false,
    placeholder: "One pattern per line",
    value: topic.patterns.join("\n"),
    rows: 4,
  })

  const cancel = h("button", {
    class: "btn",
    type: "button",
    text: "Cancel",
    on: {
      click: () => {
        state.expandedTopics.delete(topic.id)
        rerender()
      },
    },
  })

  const save = h(
    "button",
    {
      class: "btn btn-primary",
      type: "button",
      on: {
        click: () =>
          void (async () => {
            const nextTopic: Topic = {
              ...topic,
              name: nameInput.value.trim() || "Untitled topic",
              color,
              matchMode: mode,
              patterns: patterns.value
                .split("\n")
                .map((p) => p.trim())
                .filter(Boolean),
            }
            const next: TopicSet = {
              ...set,
              topics: set.topics.map((t) => (t.id === topic.id ? nextTopic : t)),
            }
            if (await saveSet(next)) {
              state.expandedTopics.delete(topic.id)
              toast("Topic saved", "ok")
              rerender()
            }
          })(),
      },
    },
    icon("check", 15),
    h("span", { text: "Save topic" }),
  )

  return h(
    "div",
    { class: "topic-edit" },
    h(
      "div",
      { class: "grid-2" },
      field("Topic name", nameInput),
      field("Match mode", modeSelect, TOPIC_MODE_EXAMPLES[mode]),
    ),
    field("Colour", swatches),
    field("Patterns", patterns, "One per line. Blank lines are ignored."),
    h("div", { class: "row", style: { justifyContent: "flex-end" } }, cancel, save),
  )
}

async function addTopicToSet(set: TopicSet, rerender: () => void): Promise<void> {
  if (set.topics.length >= LIMITS.topicsPerSet) {
    toast(`A set can hold at most ${LIMITS.topicsPerSet} topics`, "warn")
    return
  }
  const topic: Topic = {
    id: uid(),
    name: "New topic",
    color: GROUP_COLORS[1],
    matchMode: "domain",
    patterns: [],
  }
  const next: TopicSet = { ...set, topics: [...set.topics, topic] }
  if (await saveSet(next)) {
    state.expandedTopics.add(topic.id)
    rerender()
  }
}

async function createSet(): Promise<void> {
  if (state.topicSets.length >= LIMITS.topicSets) {
    toast(`You can keep at most ${LIMITS.topicSets} topic sets`, "warn")
    return
  }
  const name = await promptModal({
    title: "New topic set",
    label: "Set name",
    placeholder: "e.g. Research",
    confirmText: "Create",
  })
  if (!name) return
  const set: TopicSet = { id: uid(), name, topics: [], createdAt: Date.now() }
  if (await saveSet(set)) {
    toast(`Created "${name}"`, "ok")
    replaceSection("topics", renderTopics())
  }
}

async function loadStarterSets(btn: HTMLButtonElement): Promise<void> {
  const existing = new Set(state.topicSets.map((s) => s.id))
  const toAdd = STARTER_TOPIC_SETS.filter((s) => !existing.has(s.id))
  if (!toAdd.length) {
    toast("The starter topic sets are already loaded", "info")
    return
  }
  btn.disabled = true
  let added = 0
  for (const s of toAdd) {
    if (await saveSet({ ...s, createdAt: Date.now() })) added++
  }
  btn.disabled = false
  toast(`Added ${plural(added, "topic set")}`, "ok")
  replaceSection("topics", renderTopics())
}

/* ------------------------------------------------------------------ */
/* 5. Saved groups                                                     */
/* ------------------------------------------------------------------ */

function renderSaved(): HTMLElement {
  const list = h("div", { class: "stack" })
  renderSavedList(list)

  const search = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search your saved groups...",
    value: state.savedQuery,
    spellcheck: false,
    on: {
      input: (e: Event) => {
        state.savedQuery = (e.target as HTMLInputElement).value
        renderSavedList(list)
      },
    },
  })

  return section(
    "saved",
    "Saved groups",
    "Groups you have stashed away. Open one back into the browser, or tidy the list.",
    h("div", { class: "row" }, h("div", { class: "grow", style: { maxWidth: "360px" } }, search)),
    list,
  )
}

function renderSavedList(container: HTMLElement): void {
  clear(container)
  const q = state.savedQuery.trim().toLowerCase()
  const groups = q
    ? state.savedGroups.filter(
        (g) =>
          g.name.toLowerCase().includes(q) ||
          g.tabs.some(
            (t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q),
          ),
      )
    : state.savedGroups

  if (!state.savedGroups.length) {
    container.appendChild(
      emptyState(
        "folder",
        "No saved groups yet",
        "Save a group from the Orbit Hub and it will show up here.",
      ),
    )
    return
  }

  if (!groups.length) {
    container.appendChild(
      emptyState("search", "No matches", `Nothing matched "${state.savedQuery.trim()}".`),
    )
    return
  }

  for (const g of groups) container.appendChild(savedGroupRow(g))
}

function savedGroupRow(g: SavedGroup): HTMLElement {
  const preview = g.tabs
    .slice(0, 3)
    .map((t) => hostOf(t.url) || displayTitle(t))
    .filter(Boolean)
    .join("  -  ")

  const open = h(
    "button",
    {
      class: "btn btn-sm",
      type: "button",
      on: { click: () => void openSavedGroup(g, false) },
    },
    icon("arrow-right", 14),
    h("span", { text: "Open" }),
  )

  const openNew = h(
    "button",
    {
      class: "btn btn-icon",
      type: "button",
      title: "Open in a new window",
      on: { click: () => void openSavedGroup(g, true) },
    },
    icon("external-link", 15),
  )

  const rename = h(
    "button",
    {
      class: "btn btn-icon",
      type: "button",
      title: "Rename group",
      on: {
        click: () =>
          void (async () => {
            const name = await promptModal({
              title: "Rename saved group",
              label: "Group name",
              value: g.name,
              confirmText: "Rename",
            })
            if (!name || name === g.name) return
            const res = await send({ type: "SAVED_GROUPS_UPDATE", id: g.id, patch: { name } })
            if (!res.ok) {
              toast(res.error ?? "Could not rename the group", "err")
              return
            }
            state.savedGroups = state.savedGroups.map((x) => (x.id === g.id ? { ...x, name } : x))
            toast("Group renamed", "ok")
            replaceSection("saved", renderSaved())
          })(),
      },
    },
    icon("save", 15),
  )

  const remove = h(
    "button",
    {
      class: "btn btn-icon",
      type: "button",
      title: "Delete group",
      on: {
        click: () =>
          void (async () => {
            const ok = await modal({
              title: "Delete this saved group?",
              body: `"${g.name}" and its ${plural(g.tabs.length, "tab")} will be forgotten. The tabs stay open in your browser.`,
              confirmText: "Delete group",
              danger: true,
            })
            if (!ok) return
            const res = await send({ type: "SAVED_GROUPS_DELETE", id: g.id })
            if (!res.ok) {
              toast(res.error ?? "Could not delete the group", "err")
              return
            }
            state.savedGroups = state.savedGroups.filter((x) => x.id !== g.id)
            toast("Saved group deleted", "ok")
            replaceSection("saved", renderSaved())
          })(),
      },
    },
    icon("trash", 15),
  )

  return h(
    "div",
    { class: "card list-row" },
    groupDot(g.color),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "list-title truncate", text: g.name }),
      h("div", {
        class: "hint truncate",
        text: `${plural(g.tabs.length, "tab")} - saved ${timeAgo(g.createdAt)}${g.sourceWindow ? ` - from ${g.sourceWindow}` : ""}`,
        title: absoluteTime(g.createdAt),
      }),
      preview ? h("div", { class: "hint truncate faint", text: preview }) : null,
    ),
    h("div", { class: "list-actions" }, open, openNew, rename, remove),
  )
}

async function openSavedGroup(g: SavedGroup, newWindow: boolean): Promise<void> {
  const res = await send({ type: "SAVED_GROUPS_OPEN", id: g.id, newWindow })
  if (!res.ok) {
    toast(res.error ?? "Could not open the group", "err")
    return
  }
  toast(`Opened ${plural(g.tabs.length, "tab")}${newWindow ? " in a new window" : ""}`, "ok")
}

/* ------------------------------------------------------------------ */
/* 6. Recycle bin                                                      */
/* ------------------------------------------------------------------ */

function renderRecycle(): HTMLElement {
  const entries = state.recycle
  const selected = state.recycleSelected
  const countLabel = h("span", {
    class: "hint",
    text: selected.size ? `${selected.size} selected` : "",
  })

  const selectAll = h("input", {
    class: "check",
    type: "checkbox",
    checked: entries.length > 0 && selected.size === entries.length,
    "aria-label": "Select all",
    on: {
      change: (e: Event) => {
        const on_ = (e.target as HTMLInputElement).checked
        selected.clear()
        if (on_) for (const entry of entries) selected.add(entry.id)
        for (const cb of $$("input[data-recycle-id]", body)) {
          ;(cb as HTMLInputElement).checked = on_
        }
        countLabel.textContent = selected.size ? `${selected.size} selected` : ""
        restoreBtn.disabled = selected.size === 0
      },
    },
  })

  const restoreBtn = h(
    "button",
    {
      class: "btn",
      type: "button",
      disabled: selected.size === 0,
      on: { click: () => void restoreSelected() },
    },
    icon("undo", 15),
    h("span", { text: "Restore selected" }),
  )

  const clearBtn = h(
    "button",
    {
      class: "btn btn-danger",
      type: "button",
      disabled: entries.length === 0,
      on: {
        click: () =>
          void (async () => {
            const ok = await modal({
              title: "Empty the recycle bin?",
              body: `All ${plural(entries.length, "closed tab")} will be removed from the bin. They cannot be recovered afterwards.`,
              confirmText: "Empty bin",
              danger: true,
            })
            if (!ok) return
            const res = await send({ type: "RECYCLE_CLEAR" })
            if (!res.ok) {
              toast(res.error ?? "Could not empty the bin", "err")
              return
            }
            state.recycle = []
            state.recycleSelected.clear()
            toast("Recycle bin emptied", "ok")
            replaceSection("recycle", renderRecycle())
          })(),
      },
    },
    icon("trash", 15),
    h("span", { text: "Clear all" }),
  )

  const body = h("div", { class: "stack" })

  if (!entries.length) {
    body.appendChild(
      emptyState(
        "archive",
        "The recycle bin is empty",
        "Tabs closed by duplicate cleaning land here, ready to be restored.",
      ),
    )
  } else {
    for (const entry of entries) body.appendChild(recycleRow(entry, selected, countLabel, restoreBtn))
  }

  return section(
    "recycle",
    "Recycle bin",
    "Closed duplicates wait here so you can put them back. Restore what you want, then clear the rest.",
    entries.length
      ? h(
          "div",
          { class: "toolbar" },
          h("label", { class: "row", style: { cursor: "pointer" } }, selectAll, h("span", { class: "hint", text: "Select all" })),
          countLabel,
          h("div", { class: "grow" }),
          restoreBtn,
          clearBtn,
        )
      : null,
    body,
  )
}

function recycleRow(
  entry: RecycleEntry,
  selected: Set<string>,
  countLabel: HTMLElement,
  restoreBtn: HTMLButtonElement,
): HTMLElement {
  const checkbox = h("input", {
    class: "check",
    type: "checkbox",
    checked: selected.has(entry.id),
    dataset: { recycleId: entry.id },
    "aria-label": `Select ${displayTitle(entry)}`,
    on: {
      change: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) selected.add(entry.id)
        else selected.delete(entry.id)
        countLabel.textContent = selected.size ? `${selected.size} selected` : ""
        restoreBtn.disabled = selected.size === 0
      },
    },
  })

  return h(
    "div",
    { class: "card list-row" },
    checkbox,
    favicon(entry.url, entry.favIconUrl, 18),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "list-title truncate", text: displayTitle(entry), title: entry.title }),
      h("div", {
        class: "hint truncate",
        text: `${hostOf(entry.url) || entry.url} - closed ${timeAgo(entry.closedAt)}`,
        title: absoluteTime(entry.closedAt),
      }),
    ),
    h("span", { class: "badge", text: entry.reason }),
  )
}

async function restoreSelected(): Promise<void> {
  const ids = Array.from(state.recycleSelected)
  if (!ids.length) return
  const res = await send({ type: "RECYCLE_RESTORE", ids })
  if (!res.ok) {
    toast(res.error ?? "Could not restore those tabs", "err")
    return
  }
  state.recycle = state.recycle.filter((e) => !state.recycleSelected.has(e.id))
  state.recycleSelected.clear()
  toast(`Restored ${plural(ids.length, "tab")}`, "ok")
  replaceSection("recycle", renderRecycle())
}

/* ------------------------------------------------------------------ */
/* 7. Keyboard shortcuts                                               */
/* ------------------------------------------------------------------ */

function getCommands(): Promise<chrome.commands.Command[]> {
  return new Promise((resolve) => {
    try {
      if (!chrome.commands?.getAll) {
        resolve([])
        return
      }
      chrome.commands.getAll((cmds) => resolve(cmds ?? []))
    } catch {
      resolve([])
    }
  })
}

/** Renders either the bound shortcut or the manifest's suggested default. */
function prettyKey(shortcut: string, name: string): string {
  const raw = (shortcut || COMMAND_DEFAULTS[name] || "").replace(
    "CmdOrCtrl",
    isMac ? "Command" : "Ctrl",
  )
  if (!raw) return "Not set"
  if (!isMac) return raw
  return raw
    .replace(/Command/gi, "\u2318")
    .replace(/Shift/gi, "\u21e7")
    .replace(/Alt|Option/gi, "\u2325")
    .replace(/Ctrl|Control/gi, "\u2303")
    .replace(/\+/g, "")
}

function renderShortcuts(): HTMLElement {
  const bound = new Map(state.commands.map((c) => [c.name, c.shortcut ?? ""]))

  const rows = COMMANDS.map((c) =>
    h(
      "tr",
      null,
      h("td", { text: c.label }),
      h(
        "td",
        null,
        h("span", { class: "kbd", text: prettyKey(bound.get(c.name) ?? "", c.name) }),
      ),
    ),
  )

  const anyBound = COMMANDS.some((c) => (bound.get(c.name) ?? "").length > 0)

  return section(
    "shortcuts",
    "Keyboard shortcuts",
    "These are Chrome-level commands, so they work from any tab - even when the Orbit popup is closed.",
    card(
      h(
        "table",
        { class: "kbd-table" },
        h(
          "thead",
          null,
          h("tr", null, h("th", { text: "Action" }), h("th", { text: "Keys" })),
        ),
        h("tbody", null, rows),
      ),
      h("div", { class: "divider" }),
      h("div", {
        class: "hint",
        text: anyBound
          ? "Chrome currently has these bound. Rebind them in Chrome."
          : "These are the suggested keys. Chrome assigns them on install — confirm or change them in Chrome.",
      }),
      // The reference offers this as a "Change in Chrome" button. A URL printed
      // as text is not clickable, so this makes the instruction actionable.
      h(
        "button",
        {
          class: "btn btn-sm",
          type: "button",
          style: { marginTop: "8px" },
          on: {
            click: () => {
              void chrome.tabs.create({ url: "chrome://extensions/shortcuts" })
            },
          },
        },
        icon("zap", 13),
        h("span", { text: "Change in Chrome" }),
      ),
    ),
  )
}

/* ------------------------------------------------------------------ */
/* 8. Data                                                             */
/* ------------------------------------------------------------------ */

function renderData(): HTMLElement {
  const includeKey = h("input", { class: "check", type: "checkbox" })

  const exportBtn = h(
    "button",
    { class: "btn", type: "button", on: { click: () => exportSettings(includeKey.checked) } },
    icon("save", 15),
    h("span", { text: "Export settings" }),
  )

  const fileInput = h("input", {
    class: "hidden",
    type: "file",
    accept: ".json,application/json",
    on: {
      change: (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (file) void importSettings(file)
        ;(e.target as HTMLInputElement).value = ""
      },
    },
  })

  const importBtn = h(
    "button",
    { class: "btn", type: "button", on: { click: () => fileInput.click() } },
    icon("refresh", 15),
    h("span", { text: "Import settings" }),
  )

  const resetBtn = h(
    "button",
    {
      class: "btn btn-danger",
      type: "button",
      on: {
        click: () =>
          void (async () => {
            const ok = await modal({
              title: "Reset all settings?",
              body: "Every preference goes back to its default. Your saved groups, topic sets and recycle bin are kept, and so are your custom tab names.",
              confirmText: "Reset settings",
              danger: true,
            })
            if (!ok) return
            change({ ...DEFAULT_SETTINGS, customTabTitles: state.settings.customTabTitles })
            renderAll()
            toast("Settings reset to defaults", "ok")
          })(),
      },
    },
    icon("undo", 15),
    h("span", { text: "Reset all settings" }),
  )

  const wipeBtn = h(
    "button",
    {
      class: "btn btn-danger",
      type: "button",
      on: {
        click: () =>
          void (async () => {
            const ok = await modal({
              title: "Clear all stored data?",
              body: "Deletes the tab history, saved groups, topic sets and the recycle bin. Your settings and API key are kept.",
              confirmText: "Delete everything",
              danger: true,
            })
            if (!ok) return
            try {
              await chrome.storage.local.remove([
                STORAGE.tabRecords,
                STORAGE.undo,
                STORAGE.recycle,
                STORAGE.savedGroups,
                STORAGE.topicSets,
                STORAGE.memory,
              ])
            } catch (err) {
              toast(err instanceof Error ? err.message : "Could not clear the data", "err")
              return
            }
            state.topicSets = []
            state.savedGroups = []
            state.recycle = []
            state.recycleSelected.clear()
            renderAll()
            toast("Stored data cleared", "ok")
          })(),
      },
    },
    icon("trash", 15),
    h("span", { text: "Clear all stored data" }),
  )

  return section(
    "data",
    "Data",
    "Orbit keeps everything in this browser. Move your settings between machines, or start clean.",
    card(
      h("h3", { class: "card-title", text: "Export and import" }),
      h(
        "div",
        { class: "row between wrap" },
        h(
          "div",
          { class: "setting-text" },
          h("div", { class: "setting-title", text: "Settings as JSON" }),
          h("div", {
            class: "hint",
            text: "Exports your preferences as a JSON file. Topic sets and saved groups are not included. Import merges the file over your current settings.",
          }),
        ),
        h("div", { class: "row" }, importBtn, exportBtn, fileInput),
      ),
      h("div", { class: "divider" }),
      h(
        "label",
        { class: "row", style: { cursor: "pointer" } },
        includeKey,
        h(
          "div",
          { class: "setting-text" },
          h("div", { class: "setting-title", text: "Include the API key in the export" }),
          h("div", {
            class: "hint",
            text: "Off by default. Only turn this on if you are moving to a machine you trust.",
          }),
        ),
      ),
    ),
    card(
      h("h3", { class: "card-title", text: "Reset" }),
      h(
        "div",
        { class: "row between wrap" },
        h(
          "div",
          { class: "setting-text" },
          h("div", { class: "setting-title", text: "Reset all settings" }),
          h("div", {
            class: "hint",
            text: "Returns every preference to its default. Keeps your groups, topics and recycle bin.",
          }),
        ),
        resetBtn,
      ),
      h("div", { class: "divider" }),
      h(
        "div",
        { class: "row between wrap" },
        h(
          "div",
          { class: "setting-text" },
          h("div", { class: "setting-title", text: "Clear all stored data" }),
          h("div", {
            class: "hint",
            text: "Deletes tab history, saved groups, topic sets and the recycle bin. Settings are kept.",
          }),
        ),
        wipeBtn,
      ),
    ),
  )
}

function exportSettings(includeKey: boolean): void {
  const payload = {
    app: "orbit",
    // read from the manifest rather than repeated here, so an export can never
    // claim a version the build does not have
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    settings: {
      ...state.settings,
      ai: { ...state.settings.ai, apiKey: includeKey ? state.settings.ai.apiKey : "" },
    },
  }

  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = h("a", {
      href: url,
      download: `orbit-settings-${new Date().toISOString().slice(0, 10)}.json`,
    })
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    toast(includeKey ? "Settings exported (with API key)" : "Settings exported", "ok")
  } catch (err) {
    toast(err instanceof Error ? err.message : "Could not export settings", "err")
  }
}

async function importSettings(file: File): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    toast("That file is not valid JSON", "err")
    return
  }

  const raw =
    parsed && typeof parsed === "object" && "settings" in parsed
      ? (parsed as { settings: unknown }).settings
      : parsed

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    toast("That file does not contain Orbit settings", "err")
    return
  }

  const res = await send<Settings>({ type: "SET_SETTINGS", patch: raw as Partial<Settings> })
  if (!res.ok) {
    toast(res.error ?? "Could not import those settings", "err")
    return
  }
  if (res.data) state.settings = mergeLocal(DEFAULT_SETTINGS, res.data)
  renderAll()
  toast("Settings imported", "ok")
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function replaceSection(id: SectionId, el: HTMLElement): void {
  const existing = document.getElementById(`sec-${id}`)
  if (existing) existing.replaceWith(el)
  else document.getElementById("opt-main")?.appendChild(el)
}

function renderAll(): void {
  const main = document.getElementById("opt-main")
  if (!main) return
  clear(main)

  if (state.loadWarnings.length) {
    main.appendChild(
      banner(
        "warn",
        h(
          "span",
          null,
          h("strong", { text: "Some data could not be loaded. " }),
          state.loadWarnings.join(" "),
        ),
      ),
    )
  }

  main.appendChild(renderOrganizing())
  main.appendChild(renderDuplicates())
  main.appendChild(renderAi())
  main.appendChild(renderTopics())
  main.appendChild(renderSaved())
  main.appendChild(renderRecycle())
  main.appendChild(renderShortcuts())
  main.appendChild(renderData())
}

function buildNav(): HTMLElement {
  const nav = document.getElementById("opt-nav")
  if (!nav) return h("nav")
  clear(nav)

  nav.appendChild(
    h(
      "div",
      { class: "nav-list" },
      SECTIONS.map((s) =>
        h(
          "a",
          {
            class: "nav-item",
            href: `#sec-${s.id}`,
            dataset: { section: s.id },
            on: {
              click: (e: Event) => {
                e.preventDefault()
                document.getElementById(`sec-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
              },
            },
          },
          icon(s.icon, 15),
          h("span", { text: s.label }),
        ),
      ),
    ),
  )

  nav.appendChild(
    h("div", {
      class: "nav-foot",
      text: "Changes save as you make them. There is no Save button.",
    }),
  )

  return nav
}

function installScrollSpy(): void {
  const nav = document.getElementById("opt-nav")
  if (!nav) return

  let ticking = false
  const update = () => {
    ticking = false
    const y = window.scrollY + 120
    let current = SECTIONS[0].id
    for (const s of SECTIONS) {
      const el = document.getElementById(`sec-${s.id}`)
      if (el && el.offsetTop <= y) current = s.id
    }
    for (const a of $$(".nav-item", nav)) {
      a.classList.toggle("active", a.dataset.section === current)
    }
  }

  on(
    window,
    "scroll",
    () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(update)
    },
    { passive: true },
  )
  update()
}

function renderFatal(message: string): void {
  const main = document.getElementById("opt-main")
  if (!main) return
  clear(main)
  main.appendChild(
    h(
      "div",
      { class: "card card-pad" },
      emptyState(
        "info",
        "Orbit could not reach its background worker",
        `${message} Open this page from chrome://extensions, and make sure the Orbit extension is enabled.`,
      ),
    ),
  )
}

async function loadAll(): Promise<void> {
  const [settingsRes, topicsRes, savedRes, recycleRes, commands] = await Promise.all([
    send<Settings>({ type: "GET_SETTINGS" }),
    send<TopicSet[]>({ type: "TOPIC_SETS_LIST" }),
    send<SavedGroup[]>({ type: "SAVED_GROUPS_LIST" }),
    send<RecycleEntry[]>({ type: "RECYCLE_LIST" }),
    getCommands(),
  ])

  if (settingsRes.ok && settingsRes.data) {
    state.settings = mergeLocal(DEFAULT_SETTINGS, settingsRes.data)
  } else {
    state.loadWarnings.push(settingsRes.error ?? "Settings could not be read.")
  }

  const warn = (res: { ok: boolean; error?: string }, what: string) => {
    if (!res.ok) state.loadWarnings.push(res.error ?? `${what} could not be read.`)
  }

  if (topicsRes.ok && Array.isArray(topicsRes.data)) state.topicSets = topicsRes.data
  else warn(topicsRes, "Topic sets")

  if (savedRes.ok && Array.isArray(savedRes.data)) state.savedGroups = savedRes.data
  else warn(savedRes, "Saved groups")

  if (recycleRes.ok && Array.isArray(recycleRes.data)) state.recycle = recycleRes.data
  else warn(recycleRes, "The recycle bin")

  state.commands = commands
}

async function boot(): Promise<void> {
  const logo = document.getElementById("opt-logo")
  if (logo) logo.appendChild(icon("orbit", 18))

  const hasRuntime = typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id
  if (!hasRuntime) {
    renderFatal("chrome.runtime is unavailable in this context.")
    return
  }

  buildNav()
  await loadAll()
  renderAll()
  installScrollSpy()
}

void boot()
