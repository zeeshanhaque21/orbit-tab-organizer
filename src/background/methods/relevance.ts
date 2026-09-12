/**
 * By Relevance - what relates to what you are looking at right now.
 *
 * Fully local and deterministic. Each tab is scored against the currently
 * active tab on four signals (same site, same built-in category, title word
 * overlap, shared URL path prefix) and then bucketed. This is a ranking
 * problem rather than a classification problem, so it needs no model and works
 * offline.
 */
import { hostOf, pathOf, displayTitle } from "../../shared/format"
import type { GroupingInstructions, TabRecord } from "../../shared/types"
import { classifyLocal } from "../ai/lexicon"

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "were",
  "you", "your", "our", "not", "but", "all", "any", "can", "has", "have",
  "how", "its", "new", "now", "out", "use", "via", "who", "why", "will",
  "com", "www", "http", "https", "html", "home", "page", "site", "docs",
  "search", "login", "sign", "index", "about", "help", "view", "list",
])

export function tokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w)
  }
  return out
}

/** Jaccard similarity of two token sets, 0..1. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export interface RelevanceScore {
  id: number
  score: number
  /** which signals fired, for the UI tooltip */
  reasons: string[]
}

/** The first two path segments, used as a coarse "same section" signal. */
function pathKey(url: string): string {
  const p = pathOf(url)
  if (!p || p === "/") return ""
  return p.split("/").filter(Boolean).slice(0, 2).join("/")
}

/** Scores every record against a reference tab. */
export function scoreRelevance(records: TabRecord[], reference: TabRecord): RelevanceScore[] {
  const refHost = hostOf(reference.url)
  const refCat = classifyLocal(reference.url, displayTitle(reference))?.category ?? ""
  const refTokens = tokens(displayTitle(reference))
  const refPath = pathKey(reference.url)

  return records.map((rec) => {
    const reasons: string[] = []
    let score = 0

    if (rec.id === reference.id) return { id: rec.id, score: 100, reasons: ["current tab"] }

    const host = hostOf(rec.url)
    if (host && host === refHost) {
      score += 5
      reasons.push("same site")
    }

    const cat = classifyLocal(rec.url, displayTitle(rec))?.category ?? ""
    if (cat && refCat && cat === refCat) {
      score += 4
      reasons.push("same category")
    }

    const overlap = jaccard(tokens(displayTitle(rec)), refTokens)
    if (overlap > 0.15) {
      score += Math.round(overlap * 6)
      reasons.push("similar title")
    }

    const pk = pathKey(rec.url)
    if (pk && refPath && pk === refPath) {
      score += 2
      reasons.push("same section")
    }

    return { id: rec.id, score, reasons }
  })
}

export const RELEVANCE_LABELS = {
  now: "Current tab",
  high: "Highly relevant",
  related: "Related",
  background: "Background",
  unrelated: "Unrelated",
} as const

/**
 * Buckets records by relevance to `activeTabId`.
 * Falls back to By Last Access-style ordering when there is no active tab.
 */
export function groupByRelevance(
  records: TabRecord[],
  activeTabId: number | null,
): GroupingInstructions {
  const reference = records.find((r) => r.id === activeTabId) ?? null
  if (!reference) {
    // nothing to be relevant to; put everything in one honest bucket
    return records.length ? { [RELEVANCE_LABELS.unrelated]: records.map((r) => r.id) } : {}
  }

  const scored = scoreRelevance(records, reference)
  const out: GroupingInstructions = {}

  const push = (label: string, id: number) => {
    ;(out[label] ??= []).push(id)
  }

  // keep the anchor tab first; everything else is ranked against it
  push(RELEVANCE_LABELS.now, reference.id)

  for (const s of scored) {
    if (s.id === reference.id) continue
    if (s.score >= 7) push(RELEVANCE_LABELS.high, s.id)
    else if (s.score >= 4) push(RELEVANCE_LABELS.related, s.id)
    else if (s.score >= 1) push(RELEVANCE_LABELS.background, s.id)
    else push(RELEVANCE_LABELS.unrelated, s.id)
  }

  return out
}
