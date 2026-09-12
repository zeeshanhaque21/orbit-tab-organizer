/**
 * By Category - the flagship method.
 *
 * Runs the built-in lexicon first, which is instant and free. When an AI
 * provider is configured, the tabs are also sent to it and its answer takes
 * precedence; anything the model misses is filled in from the lexicon pass.
 * If the AI call fails for any reason the lexicon result is still returned, so
 * the method never comes back empty.
 */
import { LIMITS } from "../../shared/constants"
import { displayTitle } from "../../shared/format"
import type { GroupingInstructions, Settings, TabRecord } from "../../shared/types"
import { callAi, extractJson, providerAvailable } from "../ai/provider"
import { classifyLocal } from "../ai/lexicon"
import { chunk, mergeInstructions, normalizeInstructions, tidyLabel, unplacedIds } from "./util"

export const CATEGORY_SYSTEM_PROMPT = `You group browser tabs into categories.

You receive a JSON array of tabs:
  id - the tab id, as a string
  u  - the page URL
  t  - the page title

Return ONLY a JSON object mapping a category name to an array of tab ids.

Rules:
- Use between 3 and 12 categories. Prefer fewer, broader categories over many narrow ones.
- Category names are 1-3 words in Title Case and describe the user's intent,
  for example "Shopping", "Research", "Work", "Finance", "News", "Social".
- Group by meaning, not by site. amazon.com and ebay.com both belong in "Shopping".
- localhost, 127.0.0.1 and *.local pages belong in "localhost & Dev".
- Every tab id must appear exactly once across all categories.
- Use only ids present in the input. Never invent an id.
- Output raw JSON only. No markdown, no code fences, no commentary.

Example input:
[{"id":"1","u":"https://www.amazon.com/dp/B0","t":"Sony WH-1000XM5"},{"id":"2","u":"https://news.ycombinator.com","t":"Hacker News"}]

Example output:
{"Shopping":["1"],"Tech News":["2"]}`

export interface ClassifyResult {
  groups: GroupingInstructions
  source: "ai" | "local" | "mixed"
  aiMs?: number
  error?: string
}

/** Pure lexicon pass: every record gets a category, falling back to its site. */
export function classifyWithLexicon(records: TabRecord[]): GroupingInstructions {
  const out: GroupingInstructions = {}
  const unmatched: TabRecord[] = []

  for (const rec of records) {
    const hit = classifyLocal(rec.url, displayTitle(rec))
    if (hit) {
      ;(out[hit.category] ??= []).push(rec.id)
    } else {
      unmatched.push(rec)
    }
  }

  // Leftovers. A host with several tabs is a real cluster worth naming; a host
  // with exactly one tab is not a category, it is just an unclassified tab.
  // Naming groups after singleton hostnames is what made one earlier build emit
  // fifteen groups for sixteen tabs.
  if (unmatched.length) {
    const byHost = new Map<string, TabRecord[]>()
    for (const rec of unmatched) {
      const host = fallbackLabel(rec)
      const bucket = byHost.get(host)
      if (bucket) bucket.push(rec)
      else byHost.set(host, [rec])
    }
    for (const [host, recs] of byHost) {
      const name = recs.length > 1 ? host : "Other"
      for (const rec of recs) (out[name] ??= []).push(rec.id)
    }
  }

  return out
}

/**
 * Site-based fallback label for a tab the lexicon does not recognise.
 *
 * Returns "Other" when there is no usable host, so unparseable records fold into
 * the same bucket as singleton unknowns rather than producing a second,
 * near-identical label.
 */
function fallbackLabel(rec: TabRecord): string {
  try {
    const host = new URL(rec.url).hostname.replace(/^www\./, "")
    if (!host) return "Other"
    const parts = host.split(".")
    const base = parts.length > 2 ? parts.slice(-2).join(".") : host
    return tidyLabel(base)
  } catch {
    return "Other"
  }
}

/**
 * Full classification. Never throws: on any AI failure it degrades to the
 * lexicon result and reports the error alongside it.
 */
export async function classifyByCategory(
  records: TabRecord[],
  settings: Settings,
): Promise<ClassifyResult> {
  const local = classifyWithLexicon(records)
  const validIds = new Set(records.map((r) => r.id))

  if (!records.length) return { groups: {}, source: "local" }

  const ai = settings.ai
  if (ai.provider === "local" || !providerAvailable(ai)) {
    return { groups: local, source: "local" }
  }

  /*
   * Split the tabs into batches of `aiBatch` and send every one, rather than
   * sending a single request and letting the tail fall to the lexicon.
   *
   * A single capped request meant a 300-tab window got model attention for only
   * its first 120 tabs; the other 180 were grouped by the built-in rules. Sending
   * all of them costs more round trips but keeps the whole set on the same
   * footing. `aiMaxTabs` still bounds the work, because each batch is a full
   * round trip and an unbounded loop would run for minutes on a pathological
   * window.
   */
  const batchSize = Math.max(1, Math.min(ai.batchSize || LIMITS.aiBatch, LIMITS.aiBatch))
  const ordered = [...records].sort((a, b) => b.lastAccess - a.lastAccess)
  const sent = ordered.slice(0, LIMITS.aiMaxTabs)
  const batches = chunk(sent, batchSize)

  const parsed: GroupingInstructions = {}
  /*
   * Category names chosen by earlier batches. Batching makes the model see a
   * different slice each time, so without this the same kind of content comes
   * back as "Development" from one batch and "Tech" from the next — two groups
   * for one idea. Feeding the names forward keeps the label set coherent.
   */
  const chosen: string[] = []
  let aiMs = 0
  let failed = 0
  let lastError: string | undefined

  for (let i = 0; i < batches.length; i++) {
    const payload = batches[i].map((r) => ({
      id: String(r.id),
      u: r.url,
      t: displayTitle(r).slice(0, 160),
    }))
    const system =
      chosen.length && i > 0
        ? `${CATEGORY_SYSTEM_PROMPT}\n\nThis is batch ${i + 1} of ${batches.length}. Earlier batches already used these category names — reuse them where they fit, and only invent a new one if nothing fits: ${chosen.slice(0, 12).join(", ")}`
        : CATEGORY_SYSTEM_PROMPT

    try {
      const res = await callAi(ai, { system, user: JSON.stringify(payload) })
      aiMs += res.ms
      const part = normalizeInstructions(extractJson(res.text), validIds)
      if (part) {
        for (const [name, ids] of Object.entries(part)) {
          parsed[name] = (parsed[name] ?? []).concat(ids)
          if (!chosen.includes(name)) chosen.push(name)
        }
      }
    } catch (e) {
      failed++
      lastError = e instanceof Error ? e.message : String(e)
    }
  }

  // every batch failed: the lexicon answer is all we have
  if (failed === batches.length) {
    return { groups: local, source: "local", error: lastError }
  }

  // everything the model skipped still gets a home from the lexicon pass
  const merged = mergeInstructions(parsed, local, validIds)
  const leftover = unplacedIds(merged, validIds)
  if (leftover.length) merged["Misc"] = (merged["Misc"] ?? []).concat(leftover)

  const aiPlaced = Object.values(parsed).reduce((n, ids) => n + ids.length, 0)
  return {
    groups: merged,
    source: failed === 0 && aiPlaced >= sent.length ? "ai" : "mixed",
    aiMs,
    ...(failed ? { error: `${failed}/${batches.length} batches failed: ${lastError}` } : {}),
  }
}
