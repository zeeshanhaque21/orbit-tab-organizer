/**
 * Batched By-Category classification.
 *
 * These run `classifyByCategory` against a real HTTP server, so what is asserted
 * is the actual request stream: how many batches go out, how big each one is, and
 * what the later batches are told about the earlier ones. Nothing is stubbed
 * except the remote end.
 */
import { afterEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { classifyByCategory } from "../src/background/methods/category"
import { DEFAULT_SETTINGS, LIMITS } from "../src/shared/constants"
import type { Settings } from "../src/shared/types"
import { rec } from "./helpers"

let server: Server | undefined
/** One entry per request the extension made. */
const seen: Array<{ system: string; ids: string[] }> = []
/** Fail the first N requests, to exercise partial-failure handling. */
let failFirst = 0

async function start(): Promise<string> {
  seen.length = 0
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages: Array<{ content: string }>
      }
      const system = body.messages[0].content
      const tabs = JSON.parse(body.messages[1].content) as Array<{ id: string }>
      seen.push({ system, ids: tabs.map((t) => t.id) })

      if (seen.length <= failFirst) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "boom" } }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ Development: tabs.map((t) => t.id) }) } }],
        }),
      )
    })
  })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r))
  const addr = server!.address()
  const port = typeof addr === "object" && addr ? addr.port : 0
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = undefined
  failFirst = 0
})

function settingsFor(base: string, over: Partial<Settings["ai"]> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ai: {
      ...DEFAULT_SETTINGS.ai,
      provider: "custom",
      baseUrl: base,
      apiKey: "test-key",
      model: "test-model",
      ...over,
    },
  }
}

const tabsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => rec({ url: `https://example.com/page/${i}` }))

const placed = (groups: Record<string, number[]>) => Object.values(groups).flat()

/* ------------------------------------------------------------------ */

describe("classifyByCategory batching", () => {
  it("splits a large set into batches of aiBatch and sends every one", async () => {
    const base = await start()
    const out = await classifyByCategory(tabsOf(250), settingsFor(base))

    expect(seen.map((s) => s.ids.length)).toEqual([100, 100, 50])
    expect(out.source).toBe("ai")
  })

  it("places every tab exactly once across the batches", async () => {
    const base = await start()
    const out = await classifyByCategory(tabsOf(250), settingsFor(base))

    const ids = placed(out.groups)
    expect(ids).toHaveLength(250)
    expect(new Set(ids).size).toBe(250)
  })

  it("sends a single batch when the set already fits", async () => {
    const base = await start()
    await classifyByCategory(tabsOf(40), settingsFor(base))

    expect(seen).toHaveLength(1)
    expect(seen[0].ids).toHaveLength(40)
  })

  it("honours an explicit smaller batchSize", async () => {
    const base = await start()
    await classifyByCategory(tabsOf(100), settingsFor(base, { batchSize: 40 }))

    expect(seen.map((s) => s.ids.length)).toEqual([40, 40, 20])
  })

  it("caps the total at aiMaxTabs so a pathological window cannot run forever", async () => {
    const base = await start()
    const out = await classifyByCategory(tabsOf(LIMITS.aiMaxTabs + 300), settingsFor(base))

    expect(seen).toHaveLength(LIMITS.aiMaxTabs / LIMITS.aiBatch)
    expect(seen.flatMap((s) => s.ids)).toHaveLength(LIMITS.aiMaxTabs)
    // the tabs past the cap still get grouped, by the lexicon
    expect(placed(out.groups)).toHaveLength(LIMITS.aiMaxTabs + 300)
  })
})

describe("cross-batch category naming", () => {
  it("tells later batches which names earlier ones already used", async () => {
    const base = await start()
    await classifyByCategory(tabsOf(250), settingsFor(base))

    // the first batch has nothing to be consistent with
    expect(seen[0].system).not.toContain("Earlier batches already used")
    // later ones are told, so the same idea does not come back under two names
    expect(seen[1].system).toContain("Earlier batches already used")
    expect(seen[1].system).toContain("Development")
    expect(seen[2].system).toContain("Development")
  })

  it("does not add the hint when there is only one batch", async () => {
    const base = await start()
    await classifyByCategory(tabsOf(20), settingsFor(base))

    expect(seen[0].system).not.toContain("Earlier batches already used")
  })
})

describe("partial batch failure", () => {
  it("keeps the batches that succeeded and reports the failure", async () => {
    const base = await start()
    failFirst = 1
    const out = await classifyByCategory(tabsOf(250), settingsFor(base))

    expect(seen).toHaveLength(3)
    expect(out.source).toBe("mixed")
    expect(out.error).toContain("1/3")
    // nothing is lost: the failed batch falls back to the lexicon
    expect(placed(out.groups)).toHaveLength(250)
  })

  it("falls back to the lexicon entirely when every batch fails", async () => {
    const base = await start()
    failFirst = 99
    const out = await classifyByCategory(tabsOf(250), settingsFor(base))

    expect(out.source).toBe("local")
    expect(placed(out.groups)).toHaveLength(250)
  })

  it("never throws, whatever the endpoint does", async () => {
    const base = await start()
    failFirst = 99
    await expect(classifyByCategory(tabsOf(120), settingsFor(base))).resolves.toBeTruthy()
  })
})
