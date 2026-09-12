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

## Why the first version is manual

Publishing needs a signed-in human at
<https://chrome.google.com/webstore/devconsole>:

1. **A developer account with a one-time US$5 registration fee**, paid by card,
   plus 2FA on the Google account. There is no API for this.
2. **A new item must be created in the dashboard.** This is the hard blocker, and
   it is worth stating precisely because it is easy to assume otherwise:

   The Chrome Web Store API **v2** exposes exactly five methods —
   `media.upload` ("upload a new package to an **existing item**"),
   `publishers.items.fetchStatus`, `publishers.items.publish`,
   `publishers.items.cancelSubmission`, and
   `publishers.items.setPublishedDeployPercentage`. Every path is
   `/v2/publishers/*/items/*`, so all of them require an item id that already
   exists. **There is no create or insert method.** Checked against the official
   REST reference rather than recalled.
3. **Review by Google.** Typically a few days; longer for extensions that request
   host permissions, which this one does (`optional_host_permissions`).
4. **Interactive declarations** — the data-usage form, permission justifications
   and a single-purpose statement, all answered in the dashboard.

## Every release after the first

Once v1.0.0 exists, `npm run release` handles the rest — upload and submit for
review in one command, using a service account so nothing is interactive.

One-time setup:

1. In the [Google Cloud Console](https://console.cloud.google.com), enable the
   **Chrome Web Store API**.
2. Create a **service account**. It needs no IAM roles.
3. Create a **JSON key** for it and store the file outside this repository.
4. In the Developer Dashboard, under **Account**, add the service account's
   email. Only one service account can be linked per publisher.
5. Note the **publisher ID** and the **item ID** from the dashboard.

Then:

```bash
export CWS_SERVICE_ACCOUNT_JSON=/path/to/key.json
export CWS_PUBLISHER_ID=...
export CWS_ITEM_ID=...

npm run release -- --status       # where does the item stand?
npm run release -- --upload-only  # upload without submitting
npm run release                   # upload and submit for review
```

No credential is read from the repository, and the script refuses to run with a
clear message if any of the three variables is missing.

That setup also makes CI-based releases possible, if you ever want them: the
service account is a plain JSON key, so it can live in an Actions secret.

## Listing copy

**Name** (max 45 characters):

```
Orbit - AI Tab Organizer
```

**Summary** (max 132 characters):

```
Group tabs by what they're about, by how recently you used them, or by your own rules. Offline. No account.
```

**Description** (plain text, up to 16,000 characters — this is about 3,900):

```
Orbit groups your tabs for you, then gets out of the way.

Open thirty tabs and the tab bar stops being a list and becomes a wall. Orbit reads what those tabs are about and sorts them into named, coloured Chrome tab groups — so the thing you are looking for is where you expect it to be.

SIX WAYS TO ORGANIZE

By Category
Groups tabs by what they are actually about — Development, Shopping, Research, News, Finance — rather than by which site they came from. github.com, stackoverflow.com and developer.mozilla.org all belong together, and Orbit knows that. It works offline out of the box using a built-in classifier, and if you have your own AI endpoint you can point it there for sharper results.

By Last Access
Sixteen time buckets, from "just now" through "older than 2 days". A quick way to see what you have abandoned.

By Frequency
Ranks tabs by how likely you are to want them next, weighting recent activity over raw visit counts.

By Relevance
Ranks every tab against the one you are currently reading.

By Topics
You define the categories, by domain, path or keyword. "Anything under /pull/ is Code Review." It ships with starter sets so it does something useful on first run.

By Memory
Learns where you file each site from your own manual moves.

EVERYTHING ELSE

• Undo restores the exact arrangement from before a pass — reopening tabs that were closed, restoring group names, colours and order.
• Duplicate cleaning strips tracking parameters before comparing, so the same page opened twice is recognised. Send duplicates to a recycle bin or close them outright.
• Auto-Organize files each new tab as it loads.
• Saved groups let you snapshot a set of tabs and reopen them later.
• Keyboard shortcuts for the things you do most.
• A right-click menu on any tab.

THE HUB

One view of everything open. Windows are spaces, groups are planets, tabs are stars in orbit. Drag a tab from one group to another, marquee-select and move a batch, teleport a tab to a different window, or flick one to the recycle bin. Search highlights matches in place.

PRIVATE BY DEFAULT

• No account. No sign-in. No telemetry, no analytics, no crash reporting.
• Nothing is sent anywhere unless you configure an AI endpoint yourself — and then only the tabs being organized, sent directly to your provider with your own key.
• Five of the six methods, plus duplicate cleaning and search, work completely offline with the network switched off.
• Everything is stored locally in your browser. Uninstall and it is gone. You can erase it any time from Settings, and export or import your settings as JSON.

SMALL AND FAST

About 90 KB. Plain TypeScript, no framework, no component library. It does not slow your browser down.

WHAT ORBIT DOES NOT DO

• No screenshot capture, so it never needs access to your pages' contents.
• No access to any site you have not explicitly pointed it at. Broad host access is optional and only requested if you configure a custom AI endpoint.
• No rating prompts, no promotional banners, no nagging.
• No paid tier. Every feature is available to everyone.
```

**Category:** the dashboard defaults to *Tools*. *Productivity* is the closer fit for a tab manager if it is offered in the list — either is acceptable, so use whichever the dropdown presents.

**Language:** English (United States)

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
11. **After it is live**, do the service-account setup above so every future
    version is `npm run release`.

### A note on the name

The extension is listed as **Orbit - AI Tab Organizer**. Keep the distinctive
first word — store review rejects names that could be confused with an existing
listing, and "AI Tab Organizer" on its own is generic enough to collide.
