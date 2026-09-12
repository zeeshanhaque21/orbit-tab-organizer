/**
 * By Topics - fully local. Routes tabs into the user's own categories.
 *
 * Each topic carries a match mode:
 *   domain  - the pattern is a substring of the hostname      ("github.com")
 *   path    - the pattern is a substring of pathname + query  ("/pull/")
 *   keyword - the pattern appears in the title or the URL     ("kubernetes")
 */
import { hostOf, pathOf, displayTitle } from "../../shared/format"
import type { GroupingInstructions, TabRecord, Topic, TopicSet } from "../../shared/types"

/** Everything the given topic matches, in tab-id order. */
export function matchTopic(topic: Topic, records: TabRecord[]): number[] {
  const out: number[] = []
  const patterns = topic.patterns.map((p) => p.trim().toLowerCase()).filter(Boolean)
  if (!patterns.length) return out

  for (const rec of records) {
    const host = hostOf(rec.url).toLowerCase()
    const path = pathOf(rec.url).toLowerCase()
    const title = displayTitle(rec).toLowerCase()
    const url = rec.url.toLowerCase()

    const hit = patterns.some((p) => {
      switch (topic.matchMode) {
        case "domain":
          return host.includes(p) || (p.startsWith("*.") && host.endsWith(p.slice(1)))
        case "path":
          return path.includes(p)
        case "keyword":
          return title.includes(p) || url.includes(p)
      }
    })
    if (hit) out.push(rec.id)
  }
  return out
}

/**
 * Groups records by topic. Order follows the topic set, and anything unmatched
 * collects in a trailing "Other" group so no tab is silently dropped.
 */
export function groupByTopics(
  records: TabRecord[],
  set: TopicSet | null | undefined,
  options: { includeOther?: boolean } = {},
): GroupingInstructions {
  const out: GroupingInstructions = {}
  if (!set || !set.topics.length) return out

  const claimed = new Set<number>()
  for (const topic of set.topics) {
    const ids = matchTopic(topic, records).filter((id) => !claimed.has(id))
    if (!ids.length) continue
    for (const id of ids) claimed.add(id)
    out[topic.name] = ids
  }

  if (options.includeOther !== false) {
    const rest = records.filter((r) => !claimed.has(r.id)).map((r) => r.id)
    if (rest.length) out["Other"] = rest
  }

  return out
}

/** Colour per topic name, so groups inherit the colours the user chose. */
export function topicColors(set: TopicSet | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of set?.topics ?? []) out[t.name] = t.color
  return out
}

/** A quick preview used by the options page: how many tabs each topic catches. */
export function previewTopicSet(
  records: TabRecord[],
  set: TopicSet,
): Array<{ name: string; count: number }> {
  const claimed = new Set<number>()
  const rows = set.topics.map((t) => {
    const ids = matchTopic(t, records).filter((id) => !claimed.has(id))
    for (const id of ids) claimed.add(id)
    return { name: t.name, count: ids.length }
  })
  const other = records.filter((r) => !claimed.has(r.id)).length
  if (other) rows.push({ name: "Other", count: other })
  return rows
}
