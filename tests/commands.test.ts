/**
 * Command and context-menu dispatch.
 *
 * Chrome handles extension accelerators and the native context menu at the
 * browser UI layer, so neither can be triggered from an automated browser. The
 * *bindings* are asserted in `scripts/commands-e2e.mjs` via
 * `chrome.commands.getAll()`; the *behaviour* behind each binding is asserted
 * here by calling the dispatch directly.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { installFakeChrome, type FakeChrome } from "./chromeFake"
import { handleCommand, handleContextMenuAction } from "../src/background/index"
import { resetTracker, allRecords, reconcileTabs, hydrateTabs } from "../src/background/tabs"
import { findDuplicates } from "../src/background/duplicates"

let fake: FakeChrome

/** Two named groups plus a loose tab, enough for the collapse command. */
function arrange() {
  for (let i = 0; i < 4; i++) fake.addTab(`https://site${i}.example/p`)
  const ids = fake.tabs.map((t) => t.id)
  fake.addGroup("Alpha", "blue", ids.slice(0, 2))
  fake.addGroup("Beta", "red", ids.slice(2, 3))
  // index.ts hydrates the tracker at import time, before any of these tabs
  // existed, so force a re-read
  resetTracker()
}

beforeEach(async () => {
  fake = installFakeChrome()
  // the in-memory storage is shared across tests in this file, so a recycle
  // entry from one test would leak into the next
  await chrome.storage.local.clear()
  resetTracker()
})

describe("reconcileTabs", () => {
  it("picks up tabs opened while the worker was asleep", async () => {
    // simulate: tracker hydrated when there was nothing, then tabs appeared
    resetTracker()
    await hydrateTabs()
    expect(allRecords()).toHaveLength(0)

    fake.addTab("https://late.example/a")
    fake.addTab("https://late.example/b")

    const added = await reconcileTabs()
    expect(added).toBe(2)
    expect(allRecords()).toHaveLength(2)
  })

  it("is idempotent", async () => {
    resetTracker()
    fake.addTab("https://once.example/a")
    expect(await reconcileTabs()).toBe(1)
    expect(await reconcileTabs()).toBe(0)
    expect(allRecords()).toHaveLength(1)
  })

  it("drops records for tabs that have closed", async () => {
    resetTracker()
    const tab = fake.addTab("https://gone.example/a")
    fake.addTab("https://kept.example/b")
    await reconcileTabs()
    expect(allRecords()).toHaveLength(2)

    await chrome.tabs.remove([tab.id])
    await reconcileTabs()
    expect(allRecords()).toHaveLength(1)
    expect(allRecords()[0].url).toBe("https://kept.example/b")
  })

  it("makes untracked duplicates visible to detection", async () => {
    // the real failure this guards: two identical tabs opened while the worker
    // slept were invisible to duplicate cleaning and survived every pass
    resetTracker()
    await hydrateTabs()
    fake.addTab("https://dupe.example/x")
    fake.addTab("https://dupe.example/x")
    expect(findDuplicates(allRecords(), "url")).toHaveLength(0)

    await reconcileTabs()
    expect(findDuplicates(allRecords(), "url")).toHaveLength(1)
  })
})

describe("handleCommand", () => {
  it("collapses every group when something is expanded", async () => {
    arrange()
    expect(fake.groups.every((g) => !g.collapsed)).toBe(true)

    const result = await handleCommand("orbit_toggle_collapse")
    expect(result).toContain("collapsed")
    expect(fake.groups.every((g) => g.collapsed)).toBe(true)
  })

  it("expands again on a second press", async () => {
    arrange()
    await handleCommand("orbit_toggle_collapse")
    expect(fake.groups.every((g) => g.collapsed)).toBe(true)

    const result = await handleCommand("orbit_toggle_collapse")
    expect(result).toContain("expanded")
    expect(fake.groups.every((g) => !g.collapsed)).toBe(true)
  })

  it("reports cleanly when there is nothing to collapse", async () => {
    fake.addTab("https://only.example/")
    const result = await handleCommand("orbit_toggle_collapse")
    expect(result).toBe("collapse:no-groups")
  })

  it("parks a rename intent and opens something", async () => {
    const result = await handleCommand("orbit_rename_tab")
    expect(result).toBe("rename")
    const stored = await chrome.storage.local.get("meta")
    expect((stored.meta as { pendingIntent?: string })?.pendingIntent).toBe("rename")
  })

  it("parks a search intent", async () => {
    const result = await handleCommand("orbit_search_tab")
    expect(result).toBe("search")
    const stored = await chrome.storage.local.get("meta")
    expect((stored.meta as { pendingIntent?: string })?.pendingIntent).toBe("search")
  })

  it("returns 'hub' for the hub command", async () => {
    expect(await handleCommand("orbit_open_hub")).toBe("hub")
  })

  it("ignores an unknown command rather than throwing", async () => {
    expect(await handleCommand("orbit_nonexistent")).toBe("unknown")
  })

  it("matches every command the manifest declares", async () => {
    // the four names must line up with public/manifest.json, or the shortcut
    // is registered and silently does nothing
    const { readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8"),
    ) as { commands: Record<string, unknown> }
    const declared = Object.keys(manifest.commands).sort()
    expect(declared).toEqual([
      "orbit_open_hub",
      "orbit_rename_tab",
      "orbit_search_tab",
      "orbit_toggle_collapse",
    ])
    for (const name of declared) {
      const result = await handleCommand(name)
      expect(result).not.toBe("unknown")
    }
  })
})

describe("handleContextMenuAction", () => {
  it("organizes the window for the organize item", async () => {
    arrange()
    const result = await handleContextMenuAction("orbit-organize", undefined)
    expect(result).toBe("organized")
  })

  it("reports the number of duplicates cleaned", async () => {
    fake.addTab("https://dupe.example/x")
    fake.addTab("https://dupe.example/x")
    resetTracker()
    const result = await handleContextMenuAction("orbit-clean", undefined)
    expect(result).toMatch(/^cleaned:\d+$/)
    expect(Number(result.split(":")[1])).toBeGreaterThanOrEqual(1)
  })

  it("parks a rename intent", async () => {
    expect(await handleContextMenuAction("orbit-rename", undefined)).toBe("rename")
  })

  it("saves a tab into a saved group", async () => {
    const tab = fake.addTab("https://save.example/page")
    const result = await handleContextMenuAction("orbit-save", {
      id: tab.id,
      url: tab.url,
      title: "Save me",
    } as chrome.tabs.Tab)
    expect(result).toBe("saved")

    const stored = await chrome.storage.local.get("savedGroups")
    const groups = (stored.savedGroups ?? []) as Array<{ tabs: unknown[] }>
    expect(groups).toHaveLength(1)
    expect(groups[0].tabs).toHaveLength(1)
  })

  it("refuses to save when there is no tab", async () => {
    expect(await handleContextMenuAction("orbit-save", undefined)).toBe("save:no-tab")
  })

  it("opens the hub", async () => {
    expect(await handleContextMenuAction("orbit-hub", undefined)).toBe("hub")
  })

  it("bins a tab and removes it", async () => {
    const tab = fake.addTab("https://bin.example/page")
    const result = await handleContextMenuAction("orbit-bin", {
      id: tab.id,
      url: tab.url,
      title: "Bin me",
    } as chrome.tabs.Tab)

    expect(result).toBe("binned")
    expect(fake.tabs.some((t) => t.id === tab.id)).toBe(false)

    const stored = await chrome.storage.local.get("recycleBin")
    expect((stored.recycleBin ?? []) as unknown[]).toHaveLength(1)
  })

  it("refuses to bin when there is no tab", async () => {
    expect(await handleContextMenuAction("orbit-bin", undefined)).toBe("bin:no-tab")
  })

  it("ignores an unknown menu item", async () => {
    expect(await handleContextMenuAction("orbit-nope", undefined)).toBe("unknown")
  })

  it("handles every id that installContextMenus creates", async () => {
    // these are the ids create() is called with; a typo here means a menu entry
    // that silently does nothing
    const ids = [
      "orbit-organize",
      "orbit-clean",
      "orbit-rename",
      "orbit-save",
      "orbit-hub",
      "orbit-bin",
    ]
    for (const id of ids) {
      const result = await handleContextMenuAction(id, undefined)
      expect(result).not.toBe("unknown")
    }
  })
})
