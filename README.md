# Orbit — AI tab organizer

[![CI](https://github.com/zeeshanhaque21/orbit-tab-organizer/actions/workflows/ci.yml/badge.svg)](https://github.com/zeeshanhaque21/orbit-tab-organizer/actions/workflows/ci.yml)

A Manifest V3 Chrome extension that groups your tabs by meaning, by recency, or
by rules you define. No account, no sign-in, no telemetry, and no network
required unless you want the model-backed path.

Written in plain TypeScript and DOM. No framework, no component library.

---

## Install

```bash
npm install
npm run icons     # regenerate the icon set (already committed)
npm run build     # -> dist/
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → pick `dist/`.

No sign-in, no API key, no network required. It works offline out of the box.

> Chrome 137+ blocks `--load-extension` from the command line unless you pass
> `--disable-features=DisableLoadExtensionCommandLineSwitch`. That only affects
> automated testing, not loading unpacked through the UI.

---

## The six organization methods

| Method | How it works | Network |
|---|---|---|
| **By Category** | Built-in lexicon first, then your AI provider for anything semantic. Groups by meaning, not by site. | optional |
| **By Last Access** | Sixteen exclusive time buckets, `just now` through `older than 2 days`. | none |
| **By Frequency** | Recency-weighted activation scoring, split into A/B/C/D tiers. | none |
| **By Relevance** | Ranks every tab against the one you are reading and buckets by score. | none |
| **By Topics** | Routes tabs into categories you define, by domain, path or keyword. | none |
| **By Memory** | Learns where you file each site from your own manual moves. | none |

Five of the six are fully deterministic and offline. Only By Category benefits
from a model, and it degrades to the built-in classifier when one is not
configured or the call fails.

### Scope

**This window** organizes one window. **All windows** consolidates every window
into a single organized one.

---

## Everything else

- **Undo** — snapshots the whole arrangement before a pass and restores it
  exactly: reopens closed tabs, rebuilds groups with their titles and colours,
  restores tab order.
- **Auto-Organize** — files each new tab as it loads, using whichever method you
  pick.
- **Duplicate cleaning** — two match modes (normalised URL, or URL + title),
  tracking parameters stripped, survivor chosen by active → pinned → most
  recent. Sends to the recycle bin or closes permanently.
- **Recycle bin** — restores closed tabs, with a cap so it cannot grow forever.
- **Saved groups** — snapshot tabs, reopen them later in this or a new window.
- **Organization Score** — the Hub's headline metric: what share of your tabs
  count as organized. The rule is deliberately simple — a tab is organized if it
  is **pinned, in a tab group, or renamed**. Shows the percentage, the raw
  counts, a bar, an explainer, and a this-window / all-windows scope toggle.
  Only tabs the extension can actually act on are counted, so the score can
  reach 100%; with nothing in scope it reads `—` rather than a failing `0%`.
- **Combine windows** — one button in the Hub toolbar pulls every tab from every
  window into the focused one. Distinct from organizing with **All windows**: no
  classifier runs, no group is touched, and the tabs keep their relative order.
  It confirms first, and **Undo** restores the original windows.
- **Hub** — an observer view: spaces are windows, planets are groups, stars are
  tabs. Drag stars between planets, marquee-select and bulk-move, hover for a
  preview, rename/recolour/collapse/reorder groups, search with highlighting.
- **Rename tabs** — applies a name to the page title and re-applies it on every
  reload.
- **Keyboard shortcuts** — `⌘⇧K` toggle collapse, `⌘⇧L` open the Hub,
  `⌘⇧E` rename tab, `⌘⇧S` search tabs.
- **Context menus** — organize, clean duplicates, rename, save to a group, open
  the Hub, send to the recycle bin.

---

## AI: bring your own key

There is no bundled backend. Point By Category at whatever you already run:

- **OpenAI-compatible** — any base URL, including a local Ollama, LM Studio or
  vLLM server.
- **Anthropic** and **Gemini** — native request shapes, not a compatibility shim.
- **Built-in engine** — the default. A ~500-domain lexicon plus keyword rules
  powers By Category offline. The last-access, duplicate, topic and search paths
  never needed a model at all.

Keys live in `chrome.storage.local` and go only to the endpoint you chose.

**By Category batches.** A large window is split into batches of
`LIMITS.aiBatch` (100) and *every* batch is sent, rather than one capped request
with the tail left to the lexicon. Later batches are told which category names
earlier ones already used, so the same kind of content cannot come back as
"Development" from one batch and "Tech" from the next. `LIMITS.aiMaxTabs` (500)
bounds the total, because each batch is a full round trip. A batch that fails is
reported and its tabs fall back to the lexicon; if every batch fails the pass
reports `source: "local"` rather than erroring out.

Measured against a local 2B model (vLLM, 8192 ctx), 250 open tabs:

| | tabs given to the model | placed by the model | groups | wall clock |
|---|---|---|---|---|
| one capped request | 120 of 250 | **44** | 8.7 | 17s |
| batches of 100 | **250 of 250** | **139** | 11.7 | 36s |

---

## Permissions

The manifest asks for `tabGroups`, `tabs`, `storage`, `contextMenus`,
`scripting` and `activeTab`, plus the three provider origins it may call.

`<all_urls>` is listed under `optional_host_permissions` and is **only** requested
if you point By Category at a custom endpoint, at the moment you type that URL —
it is never granted up front.

Deliberately not asked for: no `identity`, no screenshot or page-capture access,
no `<all_urls>` at install time.

---

## Size

Measured, not estimated:

| | |
|---|---|
| Shipped (zip) | **90.9 KB** |
| JavaScript, uncompressed | **157.1 KB** |
| On disk, unpacked | 268 KB |

Plain DOM and a small shared toolkit, rather than a framework and a component
library.

---

## Layout

```
src/
  manifest.json          (in public/, copied verbatim to dist/)
  popup.ts               the toolbar popup
  hub.ts                 the universe view
  options.ts             settings
  background/
    index.ts             message router, commands, context menus
    organize.ts          the pass: plan, apply, snapshot
    groups.ts            tabGroups wrappers
    tabs.ts              the record tracker and reconciliation
    undo.ts              snapshot capture and restore
    duplicates.ts        matching and cleaning
    store.ts             settings and persisted state
    ai/
      provider.ts        the three provider shapes, one transport
      lexicon.ts         the offline classifier
    methods/             the six organization methods
  shared/                types, constants, DOM helpers, formatting
tests/                   241 unit tests
scripts/                 the e2e suites and build guards
public/                  manifest and icons
```

---

## Scripts

```bash
npm run verify        # typecheck + unit tests + build + build guards
npm test              # 241 unit tests over the pure logic
npm run e2e           # 71 functional checks against real Chrome
npm run e2e:popup     # 40 popup interaction checks
npm run e2e:hub       # 75 Hub interaction checks
npm run e2e:options   # 25 options page checks
npm run e2e:commands  # 6 command binding checks
npm run e2e:stress    # 33 scale and degenerate-case checks
npm run e2e:offline   # 23 checks with the network genuinely off
npm run e2e:ai        # 14 checks of the AI path through the built extension
npm run e2e:all       # all of the above
npm run check:profile # the two browser-profile lifecycle claims
npm run icons         # regenerate the icon set
npm run store:shots   # capture Chrome Web Store screenshots at 1280x800
npm run package       # zip dist/ into orbit-extension.zip
npm run verify:package # load the zip itself and check it works
npm run progress      # regenerate progress.html from the reports
```

`scripts/profile.mjs` owns the browser-profile lifecycle for every suite. Each
suite launches a persistent Chromium context, which writes a profile under the OS
temp dir; nothing removed them, so they accumulated until the volume filled — at
which point Chromium's renderer starts crashing (`Target crashed`) and Playwright
clicks time out for no visible reason. Both symptoms were seen before this
existed. `profileDir()` registers the directory for deletion on process exit
(including a throw or a kill), and `sweepStaleProfiles()` clears anything an
earlier crashed run left behind, with an age guard so it can never touch a suite
running right now.

**If a suite hangs or a click times out on a button that is plainly visible,
check the disk before theorising.** A full volume produces exactly this shape of
failure, and it is invisible from inside the test.

---

## Verification

Every number below comes from a suite that runs against a real browser and
asserts on real `chrome.*` state, not on what the UI claims.

CI runs the deterministic half on every push — typecheck, the 241 unit tests, the
build and the four guards, plus a packaged-artifact check. The browser suites are
run locally: they need a *headed* Chromium, because an unpacked MV3 extension
needs a real window, and the scale suite alone takes ten minutes.

| Suite | What it proves |
|---|---|
| **241 unit tests** (14 files) | Pure logic: bucket contiguity, duplicate detection, URL normalisation, topic precedence, frequency scoring, relevance, memory learning, lexicon coverage and label consolidation, the unknown-host fallback, AI batching (batch split, cross-batch naming, partial failure), snapshot/undo round-trip, JSON extraction from messy model output, command and context-menu dispatch, tab reconciliation, and Hub layout geometry at scale. |
| **AI transport tests** | The real `callAi` against a real HTTP server, for all three provider shapes. Asserts the actual headers and bodies — Anthropic's `anthropic-dangerous-direct-browser-access`, Gemini's query-param key and `systemInstruction`, OpenAI's `response_format` — plus response parsing, multi-block joins, provider error surfacing, and timeouts. |
| **71 core e2e checks** (`scripts/e2e.mjs`) | Drives the built extension in a real browser and asserts on real Chrome state. All six methods produce valid, uniquely-titled, correctly-labelled groups; undo restores the exact prior arrangement including colours; duplicates are detected and binned; recycle restores; search, group create/rename/recolour/collapse/move/delete, settings, topics, saved groups, auto-organize and ungroup all pass. |
| **40 popup checks** (`scripts/popup-e2e.mjs`) | The surface users touch most: the first-run tour shows, advances and records completion; method and scope clicks persist; Organize Now creates real groups and enables Undo; Undo restores; the ungroup confirm dialog appears and acts; search lists, highlights and shows an empty state; rename either refuses clearly or renames, never hangs, and stores nothing when it cannot apply; **Combine windows merges 3 windows into 1 without losing a tab**; the "what's new" notice appears once and stays dismissed; the duplicate-clean nag honours its switch; every method explains itself in place and no label promises a preview that does not exist. |
| **75 Hub interaction checks** (`scripts/hub-e2e.mjs`) | The observer, with real tabs: planets and stars render, **the Organization Score matches Chrome's own pinned-or-grouped rule, and the Tab Usage and Most-accessed panels render**, **every star has its own on-screen position**, **browser-internal pages are never drawn**, **the legend is not clipped and the drop docks do not look disabled**, hover previews appear and state plainly that no screenshot is captured, dragging a star onto a planet really changes that tab's `groupId` in Chrome, **the group popover renames, recolours and collapses through to Chrome**, marquee selects and reveals the toolbar, search highlights matches and dims the rest, Collapse all collapses every group, the sidebar flag survives a reload, **teleporting to another window really moves the tab**, **Combine windows merges 3 windows into 1, and the Hub's own Undo button — clicked, not messaged — puts the windows, the tabs and the groups from the merged-away window back**, dragging to the Recycle dock closes the tab and bins it, **the toolbar, the sidebar and the canvas all agree on the tab count — and agree again when there is nothing drawable, with the canvas saying why and the score showing "—" rather than a failing 0%**, the drop docks neither overlap nor sit off-screen, **the Hub routes out to Saved groups and Settings**, and a search with no local match offers a web search, and every star and planet is focusable and labelled. |
| **25 options checks** (`scripts/options-e2e.mjs`) | Every control on the settings page writes through to `chrome.storage` immediately, permanent-removal mode persists *and* warns, provider selection prefills URL and model, starter topic sets ship, the shortcuts table lists all four commands, the Focus Active grouping state is offered, and there is a button to rebind shortcuts in Chrome. |
| **6 command checks** (`scripts/commands-e2e.mjs`) | The four accelerators are registered with the right keys (`Command+Shift+K/L/E/S`). |
| **33 scale and edge checks** (`scripts/stress-e2e.mjs`) | 300 tabs organize into **12 groups** with zero tabs lost and no untitled groups; the Hub paints 300 stars at 300 distinct positions in ~0.5s with no page errors; duplicate cleaning removes exactly the excess copies. Degenerate cases hold: one tab, zero tabs, every tab pinned, a window closing mid-pass, and browser-internal pages never grouped. |
| **23 offline checks** (`scripts/offline-e2e.mjs`) | Every non-AI method works with the network switched off. Forces a genuine offline condition over CDP, **proves it is offline first**, then runs all six methods, duplicate cleaning and search. Also asserts a cloud key with no network still succeeds via the local fallback, in under a second rather than hanging. |
| **14 AI-path checks** (`scripts/ai-e2e.mjs`) | By Category against a stand-in model endpoint, driven through the built extension: the pass splits into batches of `aiBatch`, **every** batch is sent rather than only the first, later batches are told which names came earlier, the merged answer lands as real Chrome tab groups named by the model, no tab is lost, and a failing batch degrades to the local engine with the failure reported. |
| **2 profile-lifecycle checks** (`npm run check:profile`) | The two claims `scripts/profile.mjs` makes that no suite covers: a profile directory is still removed when the process **killed with SIGTERM**, and the startup sweep cannot delete a profile belonging to a suite running right now. |
| **7 packaged-artifact checks** (`npm run verify:package`) | Extracts `orbit-extension.zip` and loads *that* in Chromium. All three surfaces render with no module errors and the service worker starts. This is the check that catches a broken package — `dist/` can be perfectly healthy while the zip is not. |
| **Build guards** (`npm run lint:build`, `npm run lint:claims`) | Four checks, each of which would have caught a real bug: no async IIFE is left uninvoked; every critical user-facing string survives minification; **every setting declared in `DEFAULT_SETTINGS` is actually read somewhere**; and **no string promises a capability the source does not have** (the Hub's preview card once said "visit this tab to capture it" while nothing in `src/` captured anything). The last two are the systematic version of the "claim with nothing behind it" family — a behavioural test cannot catch those, because there is no behaviour to test, only a claim to check. |

### Bugs this suite caught

1. **Undo silently ungrouped everything.** `organize()` overwrote the snapshot's
   group list *after* the pass, leaving undo with nothing to reconstruct.
2. **Tab rename always failed.** It needs host access, declared as *optional* and
   never requested anywhere.
3. **Custom AI endpoints could never connect.** Self-hosted providers sit outside
   the hosts the manifest declares, so the service-worker fetch failed with an
   opaque network error. The options page now requests host access on the
   base-URL change and before Test connection, and the provider reports
   "Could not reach <origin>" naming the two likely causes.
4. **"Test connection" reported success for every failure.** It checked `res.ok`
   (did the message reach the worker) instead of `res.data.ok` (did the provider
   answer). A dead endpoint, a bad key, a missing permission — all rendered as
   "Connection succeeded". The worst class of bug in the file: it actively tells
   the user something false.
5. **The popup's Undo button was always enabled** — the same envelope-vs-payload
   mistake as #4.
6. **The popup's "Ungroup all" button did nothing at all.** A missing `()` on an
   async IIFE, so esbuild correctly emitted `()=>{}` as dead code.
7. **Tabs opened while the MV3 service worker was asleep were invisible.** A tab
   created during that window fires no `onCreated` we hear, so it never entered
   the tracker — never grouped, never de-duplicated, never searchable.
   `reconcileTabs()` now re-queries and merges at the top of every pass.
8. **The Hub silently collapsed large groups into a single point.** Star slots
   stopped after four orbit rings and left the remainder unplaced, so a 200-tab
   group rendered 134 distinct stars with 66 stacked on one spot.
9. **A refused rename still stored the title.** The handler persisted the custom
   name before checking it could be applied.
10. **Undo could not restore a window emptied by an all-windows pass.** Undo
    tried to recreate tabs "into" ids that no longer existed.
11. **The Hub universe was mouse-only.** Stars and planets were unlabelled SVG
    with no role and no tab stop.
12. **A rename could hang forever with no feedback.** `chrome.permissions.request`
    is not guaranteed to settle, so the button silently did nothing. Now raced
    against a timer.
13. **The "what's new" notice was half-implemented** — the version it gates was
    written on update and never read.
14. **`dontShowDuplicateCleanNotice` did nothing** — stored, surfaced as a
    toggle, never consulted.
15. **The Hub drew browser-internal pages as draggable stars**, offering drag,
    teleport and recycle actions that cannot work.
16. **Undo left extra tabs behind when it recreated a window.**
    `chrome.windows.create()` always seeds a blank tab, and those seeds were not
    being removed.
17. **The build guard cried wolf on prose.** It was not comment-aware, so a
    comment containing an apostrophe opened a phantom string.
18. **The popup promised a preview that did not exist.** The method list carried
    a "hover to preview" hint while every row already printed its own
    description.
19. **By Category produced 15 groups for 16 tabs.** The lexicon had 40
    fine-grained categories, so almost every tab became its own group, one of
    them named after a bare hostname. Fixed by splitting matching from labelling:
    rules stay precise, `displayCategory()` folds the 40 labels into 12, and
    `displayColor()` keeps one canonical colour per label.
20. **Every unknown hostname became its own group.** `fallbackLabel()` named a
    group after the bare host, which is the mechanism behind #19. A host with
    several tabs is a real cluster worth naming; a host with exactly one tab now
    goes to `Other`.
21. **Two misclassifications the same comparison exposed.**
    `news.ycombinator.com` and `lobste.rs` sat in `Social` rather than `News`,
    and `workspace.google.com` fell through to a generic bucket. Also tightened
    Social's keyword `"feed"` to `"your feed"`/`"home feed"`.
22. **Undo lost the groups from a merged-away window.** `applyUndo` rebuilt each
    recorded group against its *original* window id; two of the three steps
    resolved through the window remap and the third did not. Found by reviewing
    the function against its own contract — the asymmetry was the tell.
23. **The Hub's combine/undo checks had never actually run.** The confirm-button
    click was timing out, so the merge never happened and every downstream
    assertion passed vacuously against an unchanged browser. `isEnabled()` does
    not require visibility, so it was the wrong precondition to assert.
24. **The e2e suites leaked their browser profiles.** They accumulated run after
    run until the volume reached 100%, at which point Chromium's renderer started
    crashing and clicks timed out for no visible reason — which is what made #23
    look like a flake.
25. **The stress suite printed its result and then never exited.** It started a
    local HTTP server and never closed it; a listening socket keeps Node's event
    loop alive. Fixed with `server.unref()`.
26. **A failed AI call was reported on one code path and silently dropped on
    another.** The full pass returned `error: "…batches failed…"`, but the
    *incremental* path — taken on any repeat run while `lockGroups` is on, which
    is the default — returned only `fallback: "local"`. Found by driving a
    deliberately failing batch through the extension; the unit tests could not
    see it, because both paths were internally consistent.
27. **The Hub disagreed with itself about how many tabs were open.** With a
    window holding only internal pages, the toolbar and sidebar read "2 tabs"
    while the canvas read "0 tabs" — over a blank card with no explanation.
    `visibleTabs()` returned the *raw* record list despite its name, so three
    count sites fed by two different rules could never agree. Fixing it also
    corrected the Organization Score, which had been dividing by pages the
    extension can neither group nor rename.
28. **The hover preview promised a screenshot capture that no code performed.**
    The card read "No preview yet — visit this tab to capture it" while `src/`
    contained no capture API of any kind. The wording described a mechanism that
    did not exist, so the promise could never be kept.

The distribution matters more than the count. Seven came from the suites, five
from an independent reviewer given the brief to break it, several from auditing
the docs against what was actually wired up, and the rest from building and
rendering the thing. Bugs 13, 14, 18, 27 and 28 share a signature worth
remembering: **a claim with nothing behind it** — a flag written and never read,
a hint pointing at a feature that was never built, a label promising behaviour
the code never had. Tests cannot catch those, because there is no behaviour to
test, only a claim to check. When the same *kind* of defect keeps appearing, stop
fixing instances and write the check — which is what `lint:claims` is.

### Not verified

- **The granted-permission paths have no automated test.** Chrome's permission
  bubble is browser UI, not DOM, so it cannot be driven from Playwright. The
  correct refusal is asserted instead (`rename/refuses clearly without host
  access`).
- The four keyboard commands and the context menus are covered by unit tests
  that call their handlers directly, but not by a synthesised key event —
  Chrome handles accelerators above the renderer, so a synthesised key never
  reaches them. The test prints this as a note rather than faking a pass.
- The options page's own UI interactions are exercised indirectly through the
  message layer.

---

## Publishing

`npm run package` produces the uploadable zip, and `npm run store:shots`
captures the three screenshots the Chrome Web Store requires at 1280×800.

`STORE.md` holds the listing copy, the permission justifications and the
submission checklist. `PRIVACY.md` is the policy the store requires — the short
version is that nothing is collected, and the only network traffic is the AI
call you configure yourself.

The submission itself is manual: it needs a developer account with a one-time
fee and a signed-in human in the Web Store dashboard. There is no API for
creating a new item.

---

## Licence

MIT. See `LICENSE`.

This is an independent implementation: plain TypeScript and DOM, no framework,
and no code copied from any other tab organizer.
