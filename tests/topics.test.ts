import { describe, expect, it } from "vitest"
import { groupByTopics, matchTopic, previewTopicSet } from "../src/background/methods/topics"
import type { TopicSet } from "../src/shared/types"
import { rec } from "./helpers"

const set: TopicSet = {
  id: "s1",
  name: "Test",
  createdAt: 0,
  topics: [
    {
      id: "t1",
      name: "Code",
      color: "purple",
      matchMode: "domain",
      patterns: ["github.com", "gitlab.com"],
    },
    {
      id: "t2",
      name: "Reviews",
      color: "green",
      matchMode: "path",
      patterns: ["/pull/"],
    },
    {
      id: "t3",
      name: "Kubernetes",
      color: "cyan",
      matchMode: "keyword",
      patterns: ["kubernetes"],
    },
  ],
}

describe("matchTopic", () => {
  it("matches a domain substring", () => {
    const r = [rec({ url: "https://github.com/org/repo" })]
    expect(matchTopic(set.topics[0], r)).toHaveLength(1)
  })

  it("does not match a domain that merely contains the pattern elsewhere in the url", () => {
    // the pattern must be in the hostname, not the path
    const r = [rec({ url: "https://example.com/github.com" })]
    expect(matchTopic(set.topics[0], r)).toEqual([])
  })

  it("matches a path fragment", () => {
    const r = [
      rec({ url: "https://github.com/org/repo/pull/42" }),
      rec({ url: "https://github.com/org/repo/issues/1" }),
    ]
    const hits = matchTopic(set.topics[1], r)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toBe(r[0].id)
  })

  it("matches a keyword against the title or the url", () => {
    const byTitle = rec({ url: "https://example.com/a", title: "Kubernetes basics" })
    const byUrl = rec({ url: "https://example.com/kubernetes", title: "Docs" })
    const other = rec({ url: "https://example.com/b", title: "Something else" })
    expect(matchTopic(set.topics[2], [byTitle, byUrl, other])).toHaveLength(2)
  })

  it("returns nothing for a topic with no patterns", () => {
    const empty = { ...set.topics[0], patterns: ["", "  "] }
    expect(matchTopic(empty, [rec({ url: "https://github.com/x" })])).toEqual([])
  })
})

describe("groupByTopics", () => {
  it("routes tabs into their topics", () => {
    const records = [
      rec({ url: "https://github.com/org/repo" }),
      // a /pull/ path on a domain the Code topic does not claim, so it reaches
      // the Reviews topic rather than being taken by Code first
      rec({ url: "https://reviews.example.com/pull/9" }),
      rec({ url: "https://example.com", title: "Kubernetes deep dive" }),
      rec({ url: "https://other.com" }),
    ]
    const out = groupByTopics(records, set)
    expect(Object.keys(out)).toEqual(["Code", "Reviews", "Kubernetes", "Other"])
    expect(out["Code"]).toHaveLength(1)
    expect(out["Reviews"]).toHaveLength(1)
    expect(out["Other"]).toHaveLength(1)
  })

  it("never claims the same tab twice, first topic wins", () => {
    // this url is both a github domain and a /pull/ path
    const records = [rec({ url: "https://github.com/org/repo/pull/9" })]
    const out = groupByTopics(records, set)
    expect(out["Code"]).toEqual([records[0].id])
    expect(out["Reviews"]).toBeUndefined()
  })

  it("omits the Other bucket when asked to", () => {
    const records = [rec({ url: "https://github.com/x" }), rec({ url: "https://unmatched.com" })]
    const out = groupByTopics(records, set, { includeOther: false })
    expect(out["Other"]).toBeUndefined()
  })

  it("returns nothing when there is no active set", () => {
    expect(groupByTopics([rec({ url: "https://a.com" })], null)).toEqual({})
  })

  it("accounts for every tab across the buckets", () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      rec({ url: `https://site${i}.com`, title: i % 2 ? "kubernetes" : "plain" }),
    )
    const out = groupByTopics(records, set)
    expect(Object.values(out).flat()).toHaveLength(12)
  })
})

describe("previewTopicSet", () => {
  it("counts hits per topic plus the remainder", () => {
    const records = [
      rec({ url: "https://github.com/a" }),
      rec({ url: "https://gitlab.com/b" }),
      rec({ url: "https://nowhere.com" }),
    ]
    const rows = previewTopicSet(records, set)
    expect(rows.find((r) => r.name === "Code")?.count).toBe(2)
    expect(rows.find((r) => r.name === "Other")?.count).toBe(1)
  })
})
