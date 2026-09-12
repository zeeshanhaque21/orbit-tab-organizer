/**
 * Transport tests.
 *
 * These exercise the real `callAi` implementation against a real HTTP server, so
 * the things that actually break in the wild are covered: header names, body
 * shapes, response parsing, and error surfacing. Nothing here is stubbed except
 * the remote end.
 */
import { afterEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { callAi, testProvider } from "../src/background/ai/provider"
import type { AiSettings } from "../src/shared/types"

interface Captured {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

let server: Server | undefined
const captured: Captured[] = []
let responder: (path: string) => { status: number; json?: unknown; text?: string } = () => ({
  status: 200,
  json: {},
})

async function start(handler?: typeof responder): Promise<string> {
  captured.length = 0
  responder = handler ?? (() => ({ status: 200, json: {} }))
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      let body: unknown = raw
      try {
        body = JSON.parse(raw)
      } catch {
        /* keep raw */
      }
      captured.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body })

      const out = responder(req.url ?? "")
      res.writeHead(out.status, { "content-type": "application/json" })
      res.end(out.text ?? JSON.stringify(out.json ?? {}))
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
})

const cfg = (over: Partial<AiSettings>): AiSettings => ({
  provider: "openai",
  baseUrl: "",
  model: "test-model",
  apiKey: "sk-secret",
  temperature: 0.1,
  batchSize: 100,
  ...over,
})

const msg = { system: "SYS", user: '{"id":"1"}' }

/* ------------------------------------------------------------------ */

describe("openai-compatible transport", () => {
  it("posts to /chat/completions with a bearer token and the right body", async () => {
    const base = await start(() => ({
      status: 200,
      json: { choices: [{ message: { content: '{"Shopping":["1"]}' } }] },
    }))

    const res = await callAi(cfg({ provider: "openai", baseUrl: base }), msg)

    expect(captured).toHaveLength(1)
    const req = captured[0]
    expect(req.method).toBe("POST")
    expect(req.url).toBe("/chat/completions")
    expect(req.headers.authorization).toBe("Bearer sk-secret")
    expect(req.headers["content-type"]).toBe("application/json")

    const body = req.body as Record<string, unknown>
    expect(body.model).toBe("test-model")
    expect(body.temperature).toBe(0.1)
    expect(body.response_format).toEqual({ type: "json_object" })
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: '{"id":"1"}' },
    ])

    expect(JSON.parse(res.text)).toEqual({ Shopping: ["1"] })
    expect(res.ms).toBeGreaterThanOrEqual(0)
  })

  it("tolerates a trailing slash on the base url", async () => {
    const base = await start(() => ({
      status: 200,
      json: { choices: [{ message: { content: "{}" } }] },
    }))
    await callAi(cfg({ provider: "openai", baseUrl: base + "/" }), msg)
    expect(captured[0].url).toBe("/chat/completions")
  })

  it("treats a custom endpoint as openai-compatible", async () => {
    const base = await start(() => ({
      status: 200,
      json: { choices: [{ message: { content: '{"a":[1]}' } }] },
    }))
    const res = await callAi(cfg({ provider: "custom", baseUrl: base }), msg)
    expect(captured[0].url).toBe("/chat/completions")
    expect(JSON.parse(res.text)).toEqual({ a: [1] })
  })
})

describe("anthropic transport", () => {
  it("posts to /messages with the required browser-direct headers", async () => {
    const base = await start(() => ({
      status: 200,
      json: { content: [{ type: "text", text: '{"Work":["2"]}' }] },
    }))

    const res = await callAi(cfg({ provider: "anthropic", baseUrl: base, model: "claude-x" }), msg)

    const req = captured[0]
    expect(req.url).toBe("/messages")
    expect(req.headers["x-api-key"]).toBe("sk-secret")
    expect(req.headers["anthropic-version"]).toBe("2023-06-01")
    // without this header Anthropic rejects calls made from a page
    expect(req.headers["anthropic-dangerous-direct-browser-access"]).toBe("true")
    // Anthropic takes the system prompt as a top-level field, not a message
    expect(req.headers.authorization).toBeUndefined()

    const body = req.body as Record<string, unknown>
    expect(body.system).toBe("SYS")
    expect(body.max_tokens).toBe(4096)
    expect(body.messages).toEqual([{ role: "user", content: '{"id":"1"}' }])

    expect(JSON.parse(res.text)).toEqual({ Work: ["2"] })
  })

  it("joins multiple text blocks in the response", async () => {
    const base = await start(() => ({
      status: 200,
      json: {
        content: [
          { type: "text", text: '{"a":' },
          { type: "text", text: "[1]}" },
        ],
      },
    }))
    const res = await callAi(cfg({ provider: "anthropic", baseUrl: base }), msg)
    expect(res.text).toBe('{"a":[1]}')
  })
})

describe("gemini transport", () => {
  it("puts the key in the query string and posts a generateContent body", async () => {
    const base = await start(() => ({
      status: 200,
      json: { candidates: [{ content: { parts: [{ text: '{"News":["3"]}' }] } }] },
    }))

    const res = await callAi(cfg({ provider: "gemini", baseUrl: base, model: "gemini-x" }), msg)

    const req = captured[0]
    expect(req.url).toBe("/models/gemini-x:generateContent?key=sk-secret")
    // Gemini authenticates by query param, not header
    expect(req.headers.authorization).toBeUndefined()
    expect(req.headers["x-api-key"]).toBeUndefined()

    const body = req.body as Record<string, unknown>
    expect(body.systemInstruction).toEqual({ parts: [{ text: "SYS" }] })
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: '{"id":"1"}' }] }])
    expect((body.generationConfig as Record<string, unknown>).responseMimeType).toBe(
      "application/json",
    )

    expect(JSON.parse(res.text)).toEqual({ News: ["3"] })
  })

  it("url-encodes the key", async () => {
    const base = await start(() => ({
      status: 200,
      json: { candidates: [{ content: { parts: [{ text: "{}" }] } }] },
    }))
    await callAi(cfg({ provider: "gemini", baseUrl: base, apiKey: "a b/c+d" }), msg)
    expect(captured[0].url).toContain("key=a%20b%2Fc%2Bd")
  })
})

/* ------------------------------------------------------------------ */

describe("error handling", () => {
  it("surfaces the provider's own error message", async () => {
    const base = await start(() => ({
      status: 401,
      json: { error: { message: "Incorrect API key provided" } },
    }))
    await expect(callAi(cfg({ baseUrl: base }), msg)).rejects.toThrow(/Incorrect API key provided/)
  })

  it("includes the status code", async () => {
    const base = await start(() => ({ status: 429, text: "slow down" }))
    await expect(callAi(cfg({ baseUrl: base }), msg)).rejects.toThrow(/429/)
  })

  it("falls back to the raw body when the error is not JSON", async () => {
    const base = await start(() => ({ status: 500, text: "<html>gateway blew up</html>" }))
    await expect(callAi(cfg({ baseUrl: base }), msg)).rejects.toThrow(/gateway blew up/)
  })

  it("rejects an empty completion", async () => {
    const base = await start(() => ({
      status: 200,
      json: { choices: [{ message: { content: "   " } }] },
    }))
    await expect(callAi(cfg({ baseUrl: base }), msg)).rejects.toThrow(/empty response/i)
  })

  it("times out rather than hanging forever", async () => {
    const base = await start()
    // swap in a server that never answers
    await new Promise<void>((r) => server!.close(() => r()))
    server = createServer(() => {
      /* intentionally never responds */
    })
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r))
    const addr = server!.address()
    const port = typeof addr === "object" && addr ? addr.port : 0

    await expect(
      callAi(cfg({ baseUrl: `http://127.0.0.1:${port}` }), msg, 400),
    ).rejects.toThrow(/timed out/i)
    void base
  })

  it("explains an unreachable endpoint instead of leaking 'Failed to fetch'", async () => {
    // port 1 is reserved and refuses immediately
    await expect(callAi(cfg({ baseUrl: "http://127.0.0.1:1" }), msg, 5000)).rejects.toThrow(
      /Could not reach .*127\.0\.0\.1:1/,
    )
  })

  it("refuses to call out without a key", async () => {
    await expect(callAi(cfg({ provider: "openai", apiKey: "" }), msg)).rejects.toThrow(
      /API key/i,
    )
  })

  it("refuses a custom endpoint with no base url", async () => {
    await expect(
      callAi(cfg({ provider: "custom", baseUrl: "", apiKey: "k" }), msg),
    ).rejects.toThrow(/base URL/i)
  })

  it("refuses to make a network call for the built-in engine", async () => {
    await expect(callAi(cfg({ provider: "local" }), msg)).rejects.toThrow(/built-in engine/i)
  })
})

describe("testProvider", () => {
  it("reports ok with a latency for a working endpoint", async () => {
    const base = await start(() => ({
      status: 200,
      json: { choices: [{ message: { content: '{"ok":true}' } }] },
    }))
    const res = await testProvider(cfg({ baseUrl: base }))
    expect(res.ok).toBe(true)
    expect(res.ms).toBeGreaterThanOrEqual(0)
  })

  it("reports the error for a broken endpoint", async () => {
    const base = await start(() => ({ status: 403, json: { error: { message: "nope" } } }))
    const res = await testProvider(cfg({ baseUrl: base }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/nope/)
  })

  it("is a no-op for the built-in engine", async () => {
    const res = await testProvider(cfg({ provider: "local" }))
    expect(res).toEqual({ ok: true, ms: 0 })
  })
})
