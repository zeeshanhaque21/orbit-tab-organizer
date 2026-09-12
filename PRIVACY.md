# Privacy policy

**Orbit does not collect anything about you.** There is no analytics, no
telemetry, no crash reporting, and no account. Nothing is sent to the developer
of this extension, because there is no server to send it to.

Last updated: 12 September 2026

## What is stored, and where

Everything Orbit knows lives in your own browser, in `chrome.storage.local`:

| Stored | Why |
|---|---|
| Your settings | So they survive a restart |
| A record per open tab (URL, title, last-used time, a short history of activations) | To group tabs and rank them by recency and frequency |
| Saved groups, topic sets, the recycle bin | Features you explicitly created |
| Your AI provider settings, **including the API key you entered** | So the extension can call the endpoint you configured |

This data never leaves your device except as described in the next section. It is
removed when you uninstall the extension, and you can erase it at any time from
**Settings → Data**.

## When data leaves your device

Only one feature talks to the network: **By Category** when you have configured an
AI provider. If — and only if — you set one up, the tabs being organized are sent
to **the endpoint you chose**, using **your** key:

- A tab's URL and title, truncated, for the tabs in the current pass.
- No browsing history, no other tabs, no identifiers, nothing about you.

That request goes directly from your browser to your provider. It does not pass
through any server operated by this project. What that provider does with the
data is governed by **their** privacy policy, not this one — so choose an endpoint
you already trust, or use the built-in offline engine, which sends nothing at all.

If you do not configure a provider, Orbit makes no network requests whatsoever.
Five of the six organization methods, duplicate cleaning and search are fully
offline and always have been.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `tabs` | Read tab URLs and titles so they can be grouped, and move or close them when you ask |
| `tabGroups` | Create, name, colour and collapse Chrome tab groups |
| `storage` | Keep your settings and the tab records described above |
| `contextMenus` | Add the right-click menu entries |
| `scripting` | Apply a custom tab name to the page title, and re-apply it on reload |
| `activeTab` | Act on the current tab when you invoke a command |
| Host access to your AI provider | Only requested if you configure a custom endpoint, and only for that one origin |

**Not requested:** no `identity`, no page-content or screenshot capture, no
`<all_urls>` at install time, and no access to any site you have not explicitly
pointed the extension at.

## Children

This extension is a general-purpose developer and productivity tool. It is not
directed at children and collects no data from anyone.

## Changes

Any change to this policy will be committed to this repository, where the full
history is public.

## Contact

Open an issue at
<https://github.com/zeeshanhaque21/orbit-tab-organizer/issues>.
