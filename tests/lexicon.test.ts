import { describe, expect, it } from "vitest"
import {
  CATEGORY_CONSOLIDATION,
  CATEGORY_RULES,
  classifyLocal,
  displayCategory,
  displayColor,
} from "../src/background/ai/lexicon"

describe("classifyLocal", () => {
  it("classifies well-known developer sites", () => {
    expect(classifyLocal("https://github.com/org/repo", "repo")?.category).toBe("Development")
    expect(classifyLocal("https://developer.mozilla.org/en-US/", "MDN")?.category).toBe(
      "Development",
    )
    expect(classifyLocal("https://stackoverflow.com/q/1", "How?")?.category).toBe("Development")
  })

  it("classifies commerce and finance", () => {
    expect(classifyLocal("https://www.amazon.com/dp/B0", "Sony")?.category).toBe("Shopping")
    expect(classifyLocal("https://www.chase.com/", "Chase")?.category).toBe("Finance")
    expect(classifyLocal("https://www.coinbase.com/", "Coinbase")?.category).toBe("Finance")
  })

  it("classifies media and social", () => {
    expect(classifyLocal("https://www.youtube.com/watch?v=1", "Video")?.category).toBe("Media")
    expect(classifyLocal("https://www.reddit.com/r/x", "r/x")?.category).toBe("Social")
    expect(classifyLocal("https://www.nytimes.com/", "NYT")?.category).toBe("News")
  })

  it("classifies email and docs separately from generic google", () => {
    expect(classifyLocal("https://mail.google.com/mail/u/0", "Inbox")?.category).toBe("Work")
    expect(classifyLocal("https://docs.google.com/document/d/1", "Doc")?.category).toBe("Work")
    expect(classifyLocal("https://workspace.google.com/", "Google Workspace")?.category).toBe("Work")
  })

  it("keeps civic and tax pages beside the rest of the money tabs", () => {
    expect(classifyLocal("https://www.irs.gov/", "IRS")?.category).toBe("Finance")
    expect(classifyLocal("https://www.chase.com/", "Chase")?.category).toBe("Finance")
  })

  it("gives localhost its own category", () => {
    expect(classifyLocal("http://localhost:3000/app", "My app")?.category).toBe("Development")
    expect(classifyLocal("http://127.0.0.1:8080/", "Dev")?.category).toBe("Development")
  })

  it("detects a search results page ahead of the engine's own category", () => {
    expect(classifyLocal("https://www.google.com/search?q=orbit", "orbit - Google")?.category).toBe(
      "Search Results",
    )
    expect(classifyLocal("https://duckduckgo.com/?q=orbit", "orbit")?.category).toBe(
      "Search Results",
    )
  })

  it("does not mistake a search engine's homepage for a results page", () => {
    expect(classifyLocal("https://www.google.com/", "Google")?.category).not.toBe("Search Results")
  })

  it("matches on the title when the domain is unknown", () => {
    const hit = classifyLocal("https://unknown-host-xyz.com/a", "Best running shoes - add to cart")
    expect(hit?.category).toBe("Shopping")
  })

  it("matches on the port when neither domain nor title helps", () => {
    const hit = classifyLocal("http://192.168.1.5:5173/", "App")
    expect(hit?.category).toBe("Development")
  })

  it("infers from the hostname's own words for sites not listed by name", () => {
    expect(classifyLocal("https://www.shopify.com/admin", "Store")?.category).toBe("Shopping")
  })

  it("files Hacker News and Lobsters under News, not Social", () => {
    expect(classifyLocal("https://news.ycombinator.com/", "Hacker News")?.category).toBe("News")
    expect(classifyLocal("https://lobste.rs/", "Lobsters")?.category).toBe("News")
  })

  it("does not let the Social 'feed' keyword swallow a news headline", () => {
    const hit = classifyLocal("https://somewhere-unknown-9911.com/", "Breaking news feed")
    expect(hit?.category).toBe("News")
  })

  it("returns null when nothing matches", () => {
    expect(classifyLocal("https://zzyzx-unlisted-9911.com/p", "Nothing here")).toBeNull()
  })

  it("always returns a colour from the palette", () => {
    const palette = new Set([
      "grey",
      "blue",
      "red",
      "yellow",
      "green",
      "pink",
      "purple",
      "cyan",
      "orange",
    ])
    for (const rule of CATEGORY_RULES) {
      expect(palette.has(rule.color)).toBe(true)
    }
  })

  it("survives a malformed url", () => {
    expect(() => classifyLocal("", "")).not.toThrow()
    expect(() => classifyLocal("::::", "x")).not.toThrow()
  })
})

describe("category consolidation", () => {
  it("folds the fine-grained rules into a small set of display labels", () => {
    const displayed = new Set(CATEGORY_RULES.map((r) => displayCategory(r.category)))
    // the model prompt asks for 3-12 categories; we must stay in that band
    expect(displayed.size).toBeLessThanOrEqual(12)
    expect(displayed.size).toBeGreaterThanOrEqual(3)
  })

  it("leaves already-broad categories untouched", () => {
    expect(displayCategory("Shopping")).toBe("Shopping")
    expect(displayCategory("News")).toBe("News")
    expect(displayCategory("Social")).toBe("Social")
  })

  it("maps every consolidated label to a single canonical colour", () => {
    // same label must never render in two different colours
    const seen = new Map<string, string>()
    for (const rule of CATEGORY_RULES) {
      const label = displayCategory(rule.category)
      const color = displayColor(label) ?? rule.color
      const prior = seen.get(label)
      if (prior) expect(color).toBe(prior)
      else seen.set(label, color)
    }
  })

  it("has no dead entries in the consolidation map", () => {
    const names = new Set(CATEGORY_RULES.map((r) => r.category))
    for (const key of Object.keys(CATEGORY_CONSOLIDATION)) {
      expect(names.has(key)).toBe(true)
    }
  })
})

describe("CATEGORY_RULES", () => {
  it("has no duplicate category names", () => {
    const names = CATEGORY_RULES.map((r) => r.category)
    expect(new Set(names).size).toBe(names.length)
  })

  it("gives every rule at least one matcher", () => {
    for (const r of CATEGORY_RULES) {
      const total =
        (r.domains?.length ?? 0) + (r.keywords?.length ?? 0) + (r.urlKeywords?.length ?? 0)
      expect(total).toBeGreaterThan(0)
    }
  })

  it("covers a broad set of categories", () => {
    expect(CATEGORY_RULES.length).toBeGreaterThanOrEqual(30)
  })
})
