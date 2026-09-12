# Feature reference

What Orbit does, in enough detail to check it. Everything listed here is
implemented and covered by the suites described in `README.md`.

## Organization methods

| Method | Kind | Notes |
|---|---|---|
| By Category | lexicon + optional AI | Groups by meaning — Research, Shopping, Finance, Work. `localhost`, `127.0.0.1` and `*.local` get their own bucket. |
| By Last Access | local, deterministic | Fixed exclusive time buckets. No AI, no network. |
| By Frequency | local | A/B/C/D probability tiers from recency-weighted access history. |
| By Relevance | local | Ranks every tab against the active one and buckets by score. |
| By Topics | user-defined | You create topic sets and topics; domain / path / keyword matching; per-topic colours. |
| By Memory | local | Learns where you file each site from your own manual moves. |

**Scope** — *this window*, or *all windows* which consolidates everything into a
single organized window.

**Mode** — on-demand **Organize Now**, or **Auto-Organize** which files each new
tab as it loads.

**Focus Active** (`groupingDefaultState: "active-only"`) — after a pass, only the
group holding the active tab stays open; the rest collapse. Applies on both the
full pass and the locked incremental pass.

**Lock groups** (`lockGroups`, default on) — By Category only. On a repeat run it
keeps the groups already on screen and files *only* the newly ungrouped tabs,
matching them into existing groups by title rather than rebuilding. With it off,
every pass ungroups the window and regroups from scratch. Exposed as a switch in
the popup.

## Last-access buckets

```
just now · last 5 minutes · last 15 minutes · last 30 minutes · last 45 minutes
last hour · last 2 hours · last 3 hours · last 4 hours · last 5 hours
last 6 hours · last 12 hours · last 24 hours · yesterday · 2 days ago
older than 2 days
```

Sixteen buckets. Ranges are half-open and non-overlapping, so every elapsed value
falls in exactly one; empty buckets are dropped from the result.

## Undo

`tabsUndoSnapshot` records the whole arrangement before a pass: which groups
existed, which tabs were in them, and the tab order. Undo restores it exactly —
recreates closed tabs, moves pinned and unpinned tabs back, re-groups what was
grouped, and restores colours and collapse state.

The snapshot's `groups` array must stay exactly as captured *before* the pass.
Overwriting it with the post-pass groups leaves undo with nothing to reconstruct.

## Duplicate cleaning

Two match modes — `duplicateMatchMode` (`url` or `title_url`) — with tracking
parameters stripped. The survivor is chosen active → pinned → most recent.
`duplicateBinMode` sends the rest to the recycle bin or removes them permanently.

## Saved groups

Full create / read / rename / delete, plus reopen in this or a new window, and
search. Capped at 100 for storage sanity.

## Hub

The observer view. Spaces are windows, planets are groups sized by tab count,
stars are tabs in orbit.

- Drag a star onto a planet to attach it; drag out to detach.
- Action docks — teleport a tab to another window, or flick it to the recycle bin.
- Marquee multi-select, then bulk-move across windows and groups.
- Hover preview: title, URL, visit count and last-used time. **No screenshot is
  captured** — see "Deliberate limits".
- Group management: rename, recolour, collapse, reorder.
- Recycle bin with restore.
- Collapsible sidebar (`orbit_hub_sidebar_collapsed_v1`).
- Search highlights matches in place; when nothing local matches it offers a web
  search rather than stopping.
- Routes out to Saved groups and Settings, so it is not a dead end.

### Panels

- **Organization Score** — a tab counts as organized if it is **pinned, in a tab
  group, or renamed**. That is the whole rule. Shows the percentage, raw counts,
  a bar, an explainer, and a this-window / all-windows scope toggle. Only tabs the
  extension can act on are counted, so the score can reach 100%; with nothing in
  scope it shows `—`.
- **Tab Usage** — how recently the open tabs were last used, summarised as used
  this hour / today / not today.
- **Most accessed** — ranked by how many times you switched back to each tab this
  session. Session-scoped: it survives a service-worker wake but is zeroed on
  browser startup.

### Combine windows

Pulls every tab from every window into the focused one, from the Hub toolbar and
the popup. Distinct from organizing with `scope: "all_windows"`: no classifier
runs, no group is touched, and the tabs keep their relative order. Confirms
first, and Undo restores the original windows.

## Popup

Method picker with an in-place explanation for every row, scope toggle, Organize
Now, Undo, Auto-Organize switch, duplicate clean, search, rename tab, a status
footer, the "what's new" version notice, and the first-run tour.

## Settings

`method` · `scope` · `autoMode` · `autoMethod` · `groupingDefaultState` ·
`orderGroupsByTitle` · `lockGroups` · `protectPinned` · `duplicateMatchMode` ·
`duplicateBinMode` · `dontShowDuplicateCleanNotice` · `activeTopicSetId` ·
`customTabTitles` · `whatsNewSeenVersion` · `ai` (provider, baseUrl, model,
apiKey, temperature, batchSize)

Persisted in `chrome.storage.local`; export/import as JSON.

## Deliberate limits

Things this extension does **not** do, listed so the feature set is not
overstated:

| Not done | Why |
|---|---|
| **Accounts, cloud sync, settings roaming** | Would require a backend and a login. Settings are local and export/import as JSON instead. |
| **Metering, token counts, plan tiers, usage caps** | Nothing is metered and there is no paid tier, so there is nothing to count or cap. |
| **Tab screenshot thumbnails** | Capturing every tab needs broad page access and a permission prompt covering all sites. The hover preview shows the title, URL, visit count and last-used time instead, and says plainly that no capture happens. |
| **Rating prompts and promotional banners** | Nagware. Interrupting a tab manager to ask for stars makes it worse, not better. |
| **Remote analytics or telemetry** | None is sent. |
| **`identity` permission** | Only needed for a sign-in that does not exist. Dropped so the manifest asks for less. |

## Permissions

`tabGroups`, `tabs`, `storage`, `contextMenus`, `scripting`, `activeTab`, plus
the provider origins By Category may call. `<all_urls>` is under
`optional_host_permissions` and is only requested if you configure a custom
endpoint, at the moment you enter that URL.
