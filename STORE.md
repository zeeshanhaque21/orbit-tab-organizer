# Publishing to the Chrome Web Store

## Status

**Not submitted.** Everything that can be prepared without a human is prepared;
the submission itself cannot be automated. See "Why this is manual" below.

Ready in this repository:

- `orbit-extension.zip` — the uploadable package (`npm run package`), 90.9 KB
- `_verify/store/*.png` — three screenshots at exactly 1280×800
  (`npm run store:shots`)
- `PRIVACY.md` — the privacy policy the store requires
- The listing copy and permission justifications below

## Why this is manual

Publishing needs a signed-in human at
<https://chrome.google.com/webstore/devconsole>:

1. **A developer account with a one-time US$5 registration fee**, paid by card,
   plus 2FA on the Google account. There is no way to do this on someone's
   behalf, and no API for it.
2. **A new item must be created in the dashboard.** The Chrome Web Store API can
   upload and publish *updates* to an existing item using OAuth credentials, but
   the first version has to be created through the web UI. That is the step that
   cannot be scripted.
3. **Review by Google.** Typically a few days; longer for extensions that request
   host permissions, which this one does (`optional_host_permissions`).
4. **Interactive declarations** — the data-usage form, permission justifications
   and a single-purpose statement, all answered in the dashboard.

If you later want automated releases, the path is: publish v1.0.0 by hand, then
use the Web Store API with a refresh token to push subsequent versions.

## Listing copy

**Name** (max 45 characters):

```
Orbit - AI Tab Organizer
```

**Summary** (max 132 characters):

```
Group tabs by what they're about, by how recently you used them, or by your own rules. Offline. No account.
```

**Category:** Productivity

**Language:** English

**Description:**

```
Orbit groups your tabs for you, then gets out of the way.

SIX WAYS TO ORGANIZE

• By Category — groups tabs by what they are actually about (Development,
  Shopping, Research, News) rather than by which site they came from. Works
  offline with a built-in classifier; point it at your own AI endpoint for
  sharper results.
• By Last Access — sixteen time buckets, from "just now" to "older than 2 days".
• By Frequency — ranks tabs by how likely you are to want them next, weighted
  by recency.
• By Relevance — ranks every tab against the one you are reading.
• By Topics — you define the categories, by domain, path or keyword.
• By Memory — learns where you file each site from your own moves.

BUILT TO BE TRUSTED WITH YOUR TABS

• Undo restores the exact arrangement from before a pass, including reopening
  tabs that were closed.
• Duplicate cleaning strips tracking parameters before comparing.
• Everything is local by default. No account, no sign-in, no telemetry, and no
  network unless you configure an AI provider yourself.
• Five of the six methods are fully deterministic and work with the network off.

THE HUB

A single view of everything open: windows are spaces, groups are planets, tabs
are stars. Drag a tab between groups, marquee-select and move in bulk, teleport a
tab to another window, or flick it to the recycle bin.

Also included: saved groups, an organization score, combine-windows, keyboard
shortcuts, and a right-click menu.

90 KB. Plain TypeScript. No framework, no tracking, no paid tier.
```

## Permission justifications

The dashboard asks for each of these individually. Paste-ready:

| Permission | Justification |
|---|---|
| `tabs` | Read the URL and title of open tabs so they can be grouped, and move or close them when the user asks. |
| `tabGroups` | Create, name, colour and collapse Chrome tab groups — this is the extension's core function. |
| `storage` | Persist the user's settings, saved groups, topic sets and the per-tab records used for grouping. All local. |
| `contextMenus` | Add the right-click menu entries the user invokes. |
| `scripting` | Apply a user-chosen tab name to the page title, and re-apply it after a reload. |
| `activeTab` | Act on the current tab when the user triggers a keyboard command. |
| Host access (optional) | Only requested when the user configures a custom AI endpoint, and only for that one origin. Never requested at install time. |

## Data usage disclosures

Answer the dashboard's privacy form as follows:

- **Does this item collect or use user data?** Yes — but only to provide the
  feature. The accurate framing: tab URLs and titles are processed locally, and
  transmitted to a third-party endpoint **only** if the user configures one.
- **Data types:** "Web history" (tab URLs/titles) and "Authentication
  information" (the API key the user enters). Neither is sent to the developer.
- **Sold to third parties?** No.
- **Used for purposes unrelated to the item's single purpose?** No.
- **Used to determine creditworthiness or for lending?** No.
- **Remote code:** No. All code is contained in the package.

`PRIVACY.md` is the policy to link.

## Assets

| Asset | Requirement | Status |
|---|---|---|
| Store icon | 128×128 PNG | `public/icons/icon128.png` |
| Screenshots | 1–5, exactly 1280×800 or 640×400 | 3 ready in `_verify/store/` |
| Small promo tile | 440×280, optional | Not made |

## Checklist

1. Register as a Chrome Web Store developer (US$5, one-time) and enable 2FA.
2. `npm run verify` — confirm the tree is green before uploading.
3. `npm run package` — produces `orbit-extension.zip`.
4. Create a new item in the dashboard and upload the zip.
5. Paste the listing copy above.
6. Upload `_verify/store/hub.png` (and the other two if you want five total).
7. Link the privacy policy — use the `PRIVACY.md` URL on GitHub.
8. Fill in the permission justifications and the data-usage form.
9. Choose visibility and regions.
10. Submit for review.

### A note on the name

The extension is listed as **Orbit - AI Tab Organizer**. Keep the distinctive
first word — store review rejects names that could be confused with an existing
listing, and "AI Tab Organizer" on its own is generic enough to collide.
