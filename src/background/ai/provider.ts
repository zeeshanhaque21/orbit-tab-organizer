/**
 * The AI transport.
 *
 * There is no bundled backend. This talks to whichever endpoint the user
 * configures, with their own key, and never to us. The built-in engine
 * (`provider: "local"`) needs no network at all and is the default.
 */
import type { AiSettings, AiProviderId } from "../../shared/types"

export interface AiMessage {
  system: string
  user: string
}

export interface AiResult {
  text: string
  ms: number
}

export const DEFAULT_TIMEOUT_MS = 45_000

/** True when this configuration can actually make a call. */
export function providerAvailable(ai: AiSettings): boolean {
  if (ai.provider === "local") return true
  if (!ai.apiKey.trim()) return false
  if (ai.provider === "custom" && !ai.baseUrl.trim()) return false
  return true
}

export function providerLabel(id: AiProviderId): string {
  switch (id) {
    case "local":
      return "Built-in engine"
    case "openai":
      return "OpenAI"
    case "anthropic":
      return "Anthropic"
    case "gemini":
      return "Google Gemini"
    case "custom":
      return "Custom endpoint"
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      // surface the provider's own message, it is usually the useful part
      let detail = text.slice(0, 400)
      try {
        const j = JSON.parse(text) as { error?: { message?: string }; message?: string }
        detail = j.error?.message ?? j.message ?? detail
      } catch {
        /* keep raw text */
      }
      throw new Error(`${res.status} ${res.statusText}: ${detail}`)
    }
    return JSON.parse(text)
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    // A bare "Failed to fetch" is almost always either a missing host grant for
    // a self-hosted endpoint, or the endpoint simply not running.
    if (e instanceof TypeError) {
      const host = (() => {
        try {
          return new URL(url).origin
        } catch {
          return url
        }
      })()
      throw new Error(
        `Could not reach ${host}. Check the endpoint is running, and that Orbit has permission to access it.`,
      )
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
}

function textFromOpenAi(j: unknown): string {
  return (j as OpenAiResponse).choices?.[0]?.message?.content ?? ""
}

function textFromAnthropic(j: unknown): string {
  const parts = (j as AnthropicResponse).content ?? []
  return parts
    .filter((p) => p.type === "text" || typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("")
}

function textFromGemini(j: unknown): string {
  const parts = (j as GeminiResponse).candidates?.[0]?.content?.parts ?? []
  return parts.map((p) => p.text ?? "").join("")
}

/**
 * Pulls the first JSON object out of a model response, tolerating code fences
 * and surrounding prose. This is the one place model output is trusted, so it
 * stays deliberately narrow.
 */
export function extractJson(raw: string): unknown {
  let s = raw.trim()

  // strip a ```json ... ``` fence
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()

  try {
    return JSON.parse(s)
  } catch {
    /* fall through to brace scanning */
  }

  // scan for the first balanced {...} or [...]
  const start = s.search(/[[{]/)
  if (start === -1) throw new Error("Model did not return JSON")

  const open = s[start]
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let inStr = false
  let esc = false

  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (esc) {
      esc = false
      continue
    }
    if (c === "\\") {
      esc = true
      continue
    }
    if (c === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) {
        const slice = s.slice(start, i + 1)
        try {
          return JSON.parse(slice)
        } catch {
          throw new Error("Model returned malformed JSON")
        }
      }
    }
  }
  throw new Error("Model returned unbalanced JSON")
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

/** Calls the configured provider. Throws with a readable message on failure. */
export async function callAi(
  ai: AiSettings,
  msg: AiMessage,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<AiResult> {
  if (!providerAvailable(ai)) {
    throw new Error(
      ai.provider === "custom"
        ? "Set a base URL and API key in Settings first"
        : "Add an API key in Settings first",
    )
  }

  const t0 = performance.now()
  let text = ""

  switch (ai.provider) {
    case "openai":
    case "custom": {
      const base = ai.provider === "custom" ? ai.baseUrl : ai.baseUrl || "https://api.openai.com/v1"
      const j = await post(
        joinUrl(base, "chat/completions"),
        { authorization: `Bearer ${ai.apiKey}` },
        {
          model: ai.model,
          temperature: ai.temperature,
          messages: [
            { role: "system", content: msg.system },
            { role: "user", content: msg.user },
          ],
          response_format: { type: "json_object" },
        },
        timeoutMs,
      )
      text = textFromOpenAi(j)
      break
    }

    case "anthropic": {
      const base = ai.baseUrl || "https://api.anthropic.com/v1"
      const j = await post(
        joinUrl(base, "messages"),
        {
          "x-api-key": ai.apiKey,
          "anthropic-version": "2023-06-01",
          // required for calls made straight from an extension page
          "anthropic-dangerous-direct-browser-access": "true",
        },
        {
          model: ai.model,
          max_tokens: 4096,
          temperature: ai.temperature,
          system: msg.system,
          messages: [{ role: "user", content: msg.user }],
        },
        timeoutMs,
      )
      text = textFromAnthropic(j)
      break
    }

    case "gemini": {
      const base = ai.baseUrl || "https://generativelanguage.googleapis.com/v1beta"
      const url = `${joinUrl(base, `models/${ai.model}:generateContent`)}?key=${encodeURIComponent(ai.apiKey)}`
      const j = await post(
        url,
        {},
        {
          systemInstruction: { parts: [{ text: msg.system }] },
          contents: [{ role: "user", parts: [{ text: msg.user }] }],
          generationConfig: {
            temperature: ai.temperature,
            responseMimeType: "application/json",
          },
        },
        timeoutMs,
      )
      text = textFromGemini(j)
      break
    }

    case "local":
      throw new Error("The built-in engine does not make network calls")
  }

  if (!text.trim()) throw new Error("Provider returned an empty response")
  return { text, ms: Math.round(performance.now() - t0) }
}

/** Cheap round-trip used by the Settings page to validate a configuration. */
export async function testProvider(
  ai: AiSettings,
): Promise<{ ok: boolean; ms?: number; error?: string }> {
  if (ai.provider === "local") return { ok: true, ms: 0 }
  try {
    const r = await callAi(
      ai,
      {
        system: 'Reply with exactly {"ok":true} and nothing else.',
        user: "ping",
      },
      20_000,
    )
    return { ok: true, ms: r.ms }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
