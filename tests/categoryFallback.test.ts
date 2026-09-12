import { describe, expect, it } from "vitest"
import { classifyWithLexicon } from "../src/background/methods/category"
import { rec } from "./helpers"

/** Total tabs placed across all groups, for the "loses no tab" property. */
function placed(groups: Record<string, number[]>): number {
  return Object.values(groups).reduce((n, ids) => n + ids.length, 0)
}

describe("classifyWithLexicon", () => {
  it("puts known sites into consolidated labels", () => {
    const out = classifyWithLexicon([
      rec({ url: "https://github.com/a/b" }),
      rec({ url: "https://www.chase.com/" }),
      rec({ url: "https://www.youtube.com/watch?v=1" }),
    ])
    expect(Object.keys(out).sort()).toEqual(["Development", "Finance", "Media"])
  })

  it("never emits a group named after a lone unknown hostname", () => {
    const out = classifyWithLexicon([
      rec({ url: "https://zzyzx-unlisted-9911.com/p" }),
      rec({ url: "https://qqww-unlisted-8822.com/p" }),
    ])
    // two different singleton hosts must collapse into one bucket, not two groups
    expect(Object.keys(out)).toEqual(["Other"])
    expect(out.Other).toHaveLength(2)
  })

  it("still names a host that has several tabs", () => {
    const out = classifyWithLexicon([
      rec({ url: "https://zzyzx-unlisted-9911.com/a" }),
      rec({ url: "https://zzyzx-unlisted-9911.com/b" }),
      rec({ url: "https://zzyzx-unlisted-9911.com/c" }),
    ])
    const keys = Object.keys(out)
    expect(keys).toHaveLength(1)
    expect(keys[0]).not.toBe("Other")
    expect(out[keys[0]]).toHaveLength(3)
  })

  it("keeps the group count small for a mixed set", () => {
    const urls = [
      "https://github.com/a/b",
      "https://developer.mozilla.org/x",
      "https://stackoverflow.com/q/1",
      "http://localhost:5173/",
      "https://www.chase.com/",
      "https://www.coinbase.com/",
      "https://www.youtube.com/watch?v=1",
      "https://open.spotify.com/",
      "https://news.ycombinator.com/",
      "https://www.nytimes.com/",
      "https://arxiv.org/abs/1",
      "https://www.amazon.com/dp/B0",
      "https://www.etsy.com/",
      "https://docs.google.com/document/d/1",
      "https://workspace.google.com/",
      "https://www.irs.gov/",
    ]
    const out = classifyWithLexicon(urls.map((url) => rec({ url })))
    // the prompt given to the model asks for 3-12 categories
    expect(Object.keys(out).length).toBeLessThanOrEqual(12)
    expect(placed(out)).toBe(urls.length)
  })

  it("places every tab exactly once", () => {
    const urls = [
      "https://github.com/a/b",
      "https://zzyzx-unlisted-9911.com/a",
      "https://qqww-unlisted-8822.com/b",
      "::::not a url",
      "https://www.nytimes.com/",
    ]
    const out = classifyWithLexicon(urls.map((url) => rec({ url })))
    const ids = Object.values(out).flat()
    expect(ids).toHaveLength(urls.length)
    expect(new Set(ids).size).toBe(urls.length)
  })

  it("returns nothing for an empty input", () => {
    expect(classifyWithLexicon([])).toEqual({})
  })
})
