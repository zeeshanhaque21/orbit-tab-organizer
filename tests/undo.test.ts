import { beforeEach, describe, expect, it } from "vitest"
import { installFakeChrome, type FakeChrome } from "./chromeFake"
import { captureSnapshot, applyUndo } from "../src/background/undo"
import { ungroupAll } from "../src/background/groups"

let fake: FakeChrome

/** Lays out a deliberate arrangement: two named groups plus loose tabs. */
function arrange() {
  fake.addTab("https://a.example/1")
  fake.addTab("https://b.example/2")
  fake.addTab("https://c.example/3")
  fake.addTab("https://d.example/4")
  fake.addTab("https://e.example/5")
  fake.addTab("https://f.example/6")
  const ids = fake.tabs.map((t) => t.id)
  fake.addGroup("Alpha", "blue", ids.slice(0, 3))
  fake.addGroup("Beta", "red", ids.slice(3, 5))
}

beforeEach(() => {
  fake = installFakeChrome()
})

describe("captureSnapshot", () => {
  it("records the groups and every tab position", async () => {
    arrange()
    const snap = await captureSnapshot([1], "category", "current_window")
    expect(snap.groups.map((g) => g.title).sort()).toEqual(["Alpha", "Beta"])
    expect(snap.groups.find((g) => g.title === "Alpha")?.color).toBe("blue")
    expect(snap.previous).toHaveLength(6)
    expect(snap.previous.every((p) => typeof p.groupId === "number")).toBe(true)
  })

  it("records the tab order as it stands", async () => {
    arrange()
    const snap = await captureSnapshot([1], "category", "current_window")
    const indices = snap.previous.map((p) => p.index)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })
})

describe("applyUndo", () => {
  it("rebuilds the groups that existed before the pass", async () => {
    arrange()
    const before = fake.snapshot()
    const snap = await captureSnapshot([1], "category", "current_window")

    // simulate an organize pass: flatten everything, then write new groups
    await ungroupAll(1)
    const ids = fake.tabs.map((t) => t.id)
    fake.addGroup("Shopping", "yellow", ids.slice(0, 4))
    fake.addGroup("News", "grey", ids.slice(4))
    expect(fake.snapshot().groups.map((g) => g.title)).toEqual(["News", "Shopping"])

    const res = await applyUndo(snap)
    expect(res.ok).toBe(true)
    expect(fake.snapshot().groups).toEqual(before.groups)
  })

  it("restores group colours and collapse state", async () => {
    arrange()
    const snap = await captureSnapshot([1], "category", "current_window")
    await ungroupAll(1)
    fake.addGroup("Something", "green", [fake.tabs[0].id])

    await applyUndo(snap)
    const alpha = fake.groups.find((g) => g.title === "Alpha")
    const beta = fake.groups.find((g) => g.title === "Beta")
    expect(alpha?.color).toBe("blue")
    expect(beta?.color).toBe("red")
    expect(alpha?.collapsed).toBe(false)
  })

  it("puts each tab back into the group it came from", async () => {
    arrange()
    const alphaIds = fake.groups.find((g) => g.title === "Alpha")!
    const betaIds = fake.groups.find((g) => g.title === "Beta")!
    const alphaMembers = fake.tabs.filter((t) => t.groupId === alphaIds.id).map((t) => t.id).sort()
    const betaMembers = fake.tabs.filter((t) => t.groupId === betaIds.id).map((t) => t.id).sort()

    const snap = await captureSnapshot([1], "category", "current_window")
    await ungroupAll(1)
    await applyUndo(snap)

    const alphaAfter = fake.groups.find((g) => g.title === "Alpha")!
    const betaAfter = fake.groups.find((g) => g.title === "Beta")!
    expect(fake.tabs.filter((t) => t.groupId === alphaAfter.id).map((t) => t.id).sort()).toEqual(alphaMembers)
    expect(fake.tabs.filter((t) => t.groupId === betaAfter.id).map((t) => t.id).sort()).toEqual(betaMembers)
  })

  it("leaves previously ungrouped tabs ungrouped", async () => {
    arrange()
    const looseId = fake.tabs[5].id // the sixth tab was never grouped
    const snap = await captureSnapshot([1], "category", "current_window")
    await ungroupAll(1)
    fake.addGroup("Everything", "purple", fake.tabs.map((t) => t.id))

    await applyUndo(snap)
    expect(fake.tabs.find((t) => t.id === looseId)?.groupId).toBe(-1)
  })

  it("reopens a tab the pass closed", async () => {
    arrange()
    const snap = await captureSnapshot([1], "category", "current_window")
    snap.closed = [
      { url: "https://closed.example/x", title: "Closed", windowId: 1, index: 0, pinned: false },
    ]
    await ungroupAll(1)
    await chrome.tabs.remove([fake.tabs[0].id])

    const res = await applyUndo(snap)
    expect(res.reopenedTabs).toBe(1)
    expect(fake.tabs.some((t) => t.url === "https://closed.example/x")).toBe(true)
  })

  it("does not touch groups that were never part of the snapshot", async () => {
    arrange()
    const snap = await captureSnapshot([1], "category", "current_window")
    await ungroupAll(1)
    await applyUndo(snap)
    // the only groups present should be the two we captured
    expect(fake.groups.filter((g) => g.title).map((g) => g.title).sort()).toEqual(["Alpha", "Beta"])
  })

  /*
   * "Combine windows" moves every tab from every window into the focused one,
   * which closes the emptied windows. Undo has to rebuild those windows from
   * scratch - and the groups that lived in them along with it. Counting tabs is
   * not enough to catch a regression here: the tabs come back either way, but
   * they come back ungrouped if the group is rebuilt against a window id that
   * no longer exists.
   */
  describe("after a window merge", () => {
    /** Two windows: #1 with a group, #2 with a group and a loose tab. */
    function twoWindows() {
      fake.addWindow(2)
      fake.addTab("https://a.example/1", { windowId: 1 })
      fake.addTab("https://a.example/2", { windowId: 1 })
      fake.addTab("https://b.example/3", { windowId: 2 })
      fake.addTab("https://b.example/4", { windowId: 2 })
      fake.addTab("https://b.example/5", { windowId: 2 })
      const w1 = fake.tabs.filter((t) => t.windowId === 1).map((t) => t.id)
      const w2 = fake.tabs.filter((t) => t.windowId === 2).map((t) => t.id)
      fake.addGroup("Alpha", "blue", w1)
      fake.addGroup("Beta", "red", w2.slice(0, 2))
      return { w1, w2 }
    }

    /** Reproduces what MERGE_WINDOWS does to the browser. */
    async function merge() {
      const destination = 1
      for (const w of [...fake.windows]) {
        if (w === destination) continue
        const moving = fake.inWindow(w).map((t) => t.id)
        if (moving.length) await chrome.tabs.move(moving, { windowId: destination, index: -1 })
        await chrome.windows.remove(w)
      }
    }

    it("restores the groups that lived in the merged-away window", async () => {
      twoWindows()
      const before = fake.snapshot()
      const snap = await captureSnapshot([1, 2], "category", "all_windows")

      await merge()
      expect(fake.windows.size).toBe(1)

      const res = await applyUndo(snap)
      expect(res.ok).toBe(true)
      expect(fake.windows.size).toBe(2)
      expect(fake.snapshot().groups).toEqual(before.groups)
    })

    it("puts every tab back in the window it came from", async () => {
      const { w1, w2 } = twoWindows()
      const snap = await captureSnapshot([1, 2], "category", "all_windows")
      await merge()
      await applyUndo(snap)

      // window ids are reassigned, so compare by membership rather than by id
      const wins = [...fake.windows].map((w) => fake.inWindow(w).map((t) => t.id).sort())
      expect(wins).toHaveLength(2)
      expect(wins).toContainEqual([...w1].sort())
      expect(wins).toContainEqual([...w2].sort())
    })

    it("leaves no blank seed tab behind in the recreated window", async () => {
      twoWindows()
      const before = fake.snapshot()
      const snap = await captureSnapshot([1, 2], "category", "all_windows")
      await merge()
      await applyUndo(snap)

      expect(fake.tabs).toHaveLength(before.tabs.length)
      expect(fake.tabs.filter((t) => t.url === "about:blank")).toHaveLength(0)
    })
  })
})
