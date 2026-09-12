import { describe, expect, it } from "vitest"
import { extractJson, providerAvailable, providerLabel } from "../src/background/ai/provider"
import type { AiSettings } from "../src/shared/types"

const base: AiSettings = {
  provider: "local",
  baseUrl: "",
  model: "m",
  apiKey: "",
  temperature: 0.1,
  batchSize: 100,
}

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"Shopping":["1"]}')).toEqual({ Shopping: ["1"] })
  })

  it("strips a ```json fence", () => {
    expect(extractJson('```json\n{"a":[1]}\n```')).toEqual({ a: [1] })
  })

  it("strips a bare ``` fence", () => {
    expect(extractJson('```\n{"a":[1]}\n```')).toEqual({ a: [1] })
  })

  it("ignores prose around the object", () => {
    expect(extractJson('Sure! Here you go:\n{"a":[1]}\nHope that helps.')).toEqual({ a: [1] })
  })

  it("handles an array at the root", () => {
    expect(extractJson("noise [1,2,3] more")).toEqual([1, 2, 3])
  })

  it("handles nested objects", () => {
    const input = '{"a":{"b":{"c":[1]}}}'
    expect(extractJson(input)).toEqual({ a: { b: { c: [1] } } })
  })

  it("is not confused by braces inside strings", () => {
    // a naive depth counter would close early on the "}" in the title
    const input = '{"News":["1"],"note":"a } brace { here"}'
    expect(extractJson(input)).toEqual({ News: ["1"], note: "a } brace { here" })
  })

  it("is not confused by escaped quotes inside strings", () => {
    const input = '{"a":"say \\"hi\\"","b":[1]}'
    expect(extractJson(input)).toEqual({ a: 'say "hi"', b: [1] })
  })

  it("tolerates leading whitespace and newlines", () => {
    expect(extractJson('\n\n  {"a":1}\n')).toEqual({ a: 1 })
  })

  it("throws when there is no JSON at all", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(/did not return JSON/i)
  })

  it("throws on unbalanced braces rather than guessing", () => {
    expect(() => extractJson('{"a":[1]')).toThrow(/unbalanced|malformed/i)
  })

  it("throws on malformed content inside a balanced object", () => {
    expect(() => extractJson("{a: 1}")).toThrow()
  })
})

describe("providerAvailable", () => {
  it("is always true for the built-in engine", () => {
    expect(providerAvailable({ ...base, provider: "local" })).toBe(true)
  })

  it("needs a key for hosted providers", () => {
    expect(providerAvailable({ ...base, provider: "openai" })).toBe(false)
    expect(providerAvailable({ ...base, provider: "openai", apiKey: "sk-x" })).toBe(true)
    expect(providerAvailable({ ...base, provider: "anthropic" })).toBe(false)
    expect(providerAvailable({ ...base, provider: "gemini" })).toBe(false)
  })

  it("treats a whitespace-only key as missing", () => {
    expect(providerAvailable({ ...base, provider: "openai", apiKey: "   " })).toBe(false)
  })

  it("needs both a url and a key for a custom endpoint", () => {
    expect(providerAvailable({ ...base, provider: "custom", apiKey: "k" })).toBe(false)
    expect(
      providerAvailable({ ...base, provider: "custom", apiKey: "k", baseUrl: "http://x/v1" }),
    ).toBe(true)
  })
})

describe("providerLabel", () => {
  it("names every provider", () => {
    for (const p of ["local", "openai", "anthropic", "gemini", "custom"] as const) {
      expect(providerLabel(p)).toBeTruthy()
    }
  })
})
