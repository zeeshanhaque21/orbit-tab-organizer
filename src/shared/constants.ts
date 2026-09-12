/**
 * Shared constants: storage keys, the exact last-access buckets the real
 * extension uses, Chrome tab-group colours, limits and defaults.
 */
import type { GroupColor, Settings, TopicSet, AiSettings } from "./types"

/** Chrome's nine tab-group colours, in the order the browser exposes them. */
export const GROUP_COLORS: GroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]

/** Hex equivalents, for our own UI (Chrome does not expose the palette). */
export const COLOR_HEX: Record<GroupColor, string> = {
  grey: "#8c8c8c",
  blue: "#4a8bf5",
  red: "#e5484d",
  yellow: "#e2b53e",
  green: "#3fb950",
  pink: "#e8558f",
  purple: "#8b5cf6",
  cyan: "#22b8cf",
  orange: "#f0883e",
}

/**
 * Access timestamps kept per tab. The frequency score weights recent
 * activations heavily, so the tail beyond this contributes almost nothing —
 * capping it bounds memory without changing the ranking.
 */
export const ACCESS_HISTORY_LIMIT = 15

/** A single exclusive time bucket for By Last Access. */
export interface TimeBucket {
  label: string
  /** inclusive lower bound, measured as "ms ago" */
  minAgoMs: number
  /** exclusive upper bound */
  maxAgoMs: number
}

/**
 * The By Last Access buckets, newest first. A tab belongs to the FIRST bucket
 * whose range contains it, so ranges must never overlap.
 */
export const LAST_ACCESS_BUCKETS: TimeBucket[] = [
  { label: "just now", minAgoMs: 0, maxAgoMs: 60_000 },
  { label: "last 5 minutes", minAgoMs: 60_000, maxAgoMs: 5 * 60_000 },
  { label: "last 15 minutes", minAgoMs: 5 * 60_000, maxAgoMs: 15 * 60_000 },
  { label: "last 30 minutes", minAgoMs: 15 * 60_000, maxAgoMs: 30 * 60_000 },
  { label: "last 45 minutes", minAgoMs: 30 * 60_000, maxAgoMs: 45 * 60_000 },
  { label: "last hour", minAgoMs: 45 * 60_000, maxAgoMs: 60 * 60_000 },
  { label: "last 2 hours", minAgoMs: 60 * 60_000, maxAgoMs: 2 * 3600_000 },
  { label: "last 3 hours", minAgoMs: 2 * 3600_000, maxAgoMs: 3 * 3600_000 },
  { label: "last 4 hours", minAgoMs: 3 * 3600_000, maxAgoMs: 4 * 3600_000 },
  { label: "last 5 hours", minAgoMs: 4 * 3600_000, maxAgoMs: 5 * 3600_000 },
  { label: "last 6 hours", minAgoMs: 5 * 3600_000, maxAgoMs: 6 * 3600_000 },
  { label: "last 12 hours", minAgoMs: 6 * 3600_000, maxAgoMs: 12 * 3600_000 },
  { label: "last 24 hours", minAgoMs: 12 * 3600_000, maxAgoMs: 24 * 3600_000 },
  { label: "yesterday", minAgoMs: 24 * 3600_000, maxAgoMs: 48 * 3600_000 },
  { label: "2 days ago", minAgoMs: 48 * 3600_000, maxAgoMs: 72 * 3600_000 },
  { label: "older than 2 days", minAgoMs: 72 * 3600_000, maxAgoMs: Infinity },
]

/**
 * Display order for the groups produced by By Last Access.
 * Oldest first, so the tabs you used most recently sit nearest the bottom and
 * are closest to where your attention already is.
 */
export const LAST_ACCESS_ORDER: string[] = [...LAST_ACCESS_BUCKETS]
  .reverse()
  .map((b) => b.label)

/** The four probability tiers used by By Frequency / Prediction. */
export const FREQUENCY_TIERS = ["A", "B", "C", "D"] as const
export type FrequencyTier = (typeof FREQUENCY_TIERS)[number]

export const FREQUENCY_TIER_LABELS: Record<FrequencyTier, string> = {
  A: "A - Likely next",
  B: "B - Probably next",
  C: "C - Occasional",
  D: "D - Unlikely",
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export const STORAGE = {
  settings: "settings",
  tabRecords: "tabRecords",
  undo: "tabsUndoSnapshot",
  recycle: "recycleBin",
  savedGroups: "savedGroups",
  topicSets: "topicSets",
  /** learned tabId -> group title pairs, powering the Memory method */
  memory: "memoryLabels",
  meta: "meta",
} as const

/** Hard caps so nothing grows without bound. */
export const LIMITS = {
  recycleEntries: 300,
  savedGroups: 100,
  topicSets: 40,
  topicsPerSet: 40,
  /** tabs per AI request; larger sets are split into several batches */
  aiBatch: 100,
  /** ceiling on tabs sent to the model in one pass, across all batches */
  aiMaxTabs: 500,
  /** tabs held in the live record map */
  tabRecords: 3000,
} as const

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export const AI_PRESETS: Record<
  Exclude<AiSettings["provider"], "custom">,
  { label: string; baseUrl: string; model: string; docs: string; keyLabel: string }
> = {
  local: {
    label: "Built-in engine (offline)",
    baseUrl: "",
    model: "orbit-local-v1",
    docs: "No key, no network. A built-in classifier handles every method.",
    keyLabel: "",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    docs: "Works with any OpenAI-compatible endpoint, including Groq and OpenRouter.",
    keyLabel: "API key",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-haiku-latest",
    docs: "Messages API with the browser-direct header.",
    keyLabel: "API key",
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.0-flash",
    docs: "Uses the key as a query parameter, as Google requires.",
    keyLabel: "API key",
  },
}

export const DEFAULT_AI: AiSettings = {
  provider: "local",
  baseUrl: "",
  model: "orbit-local-v1",
  apiKey: "",
  temperature: 0.1,
  batchSize: LIMITS.aiBatch,
}

export const DEFAULT_SETTINGS: Settings = {
  method: "category",
  scope: "current_window",
  autoMode: false,
  autoMethod: "category",
  groupingDefaultState: "unchanged",
  orderGroupsByTitle: false,
  duplicateMatchMode: "url",
  duplicateBinMode: "recycle",
  dontShowDuplicateCleanNotice: false,
  lockGroups: true,
  protectPinned: true,
  activeTopicSetId: null,
  ai: { ...DEFAULT_AI },
  tourDone: false,
  whatsNewSeenVersion: null,
  hubSidebarCollapsed: false,
  customTabTitles: {},
}

/* ------------------------------------------------------------------ */
/* Starter topic sets                                                  */
/* ------------------------------------------------------------------ */

/**
 * Ships ready-to-use topic sets so "By Topics" does something useful on first
 * run. An empty topic editor with no example is a dead end: the method cannot
 * file anything until the user has invented a taxonomy from scratch.
 */
export const STARTER_TOPIC_SETS: TopicSet[] = [
  {
    id: "starter-dev",
    name: "Software development",
    createdAt: 0,
    topics: [
      {
        id: "t-repo",
        name: "Repos & code",
        color: "purple",
        matchMode: "domain",
        patterns: [
          "github.com",
          "gitlab.com",
          "bitbucket.org",
          "codeberg.org",
          "sourcegraph.com",
          "localhost",
          "127.0.0.1",
        ],
      },
      {
        id: "t-docs",
        name: "Docs & reference",
        color: "blue",
        matchMode: "domain",
        patterns: [
          "developer.mozilla.org",
          "developer.chrome.com",
          "docs.python.org",
          "nodejs.org",
          "react.dev",
          "stackoverflow.com",
          "stackexchange.com",
          "dev.to",
          "npmjs.com",
        ],
      },
      {
        id: "t-ci",
        name: "CI & ops",
        color: "orange",
        matchMode: "domain",
        patterns: [
          "vercel.com",
          "netlify.com",
          "railway.app",
          "render.com",
          "fly.io",
          "sentry.io",
          "grafana.com",
          "datadoghq.com",
        ],
      },
      {
        id: "t-ai",
        name: "AI tools",
        color: "cyan",
        matchMode: "domain",
        patterns: [
          "chatgpt.com",
          "chat.openai.com",
          "claude.ai",
          "gemini.google.com",
          "perplexity.ai",
          "huggingface.co",
          "openrouter.ai",
        ],
      },
    ],
  },
  {
    id: "starter-life",
    name: "Personal",
    createdAt: 0,
    topics: [
      {
        id: "t-shop",
        name: "Shopping",
        color: "yellow",
        matchMode: "domain",
        patterns: [
          "amazon.",
          "ebay.",
          "etsy.com",
          "aliexpress.",
          "target.com",
          "walmart.com",
          "shopify.com",
        ],
      },
      {
        id: "t-finance",
        name: "Finance",
        color: "green",
        matchMode: "domain",
        patterns: [
          "chase.com",
          "bankofamerica.com",
          "paypal.com",
          "stripe.com",
          "coinbase.com",
          "fidelity.com",
          "schwab.com",
        ],
      },
      {
        id: "t-social",
        name: "Social",
        color: "pink",
        matchMode: "domain",
        patterns: [
          "x.com",
          "twitter.com",
          "reddit.com",
          "linkedin.com",
          "facebook.com",
          "instagram.com",
          "news.ycombinator.com",
        ],
      },
      {
        id: "t-media",
        name: "Video & music",
        color: "red",
        matchMode: "domain",
        patterns: [
          "youtube.com",
          "youtu.be",
          "netflix.com",
          "twitch.tv",
          "spotify.com",
          "soundcloud.com",
        ],
      },
      {
        id: "t-news",
        name: "News",
        color: "grey",
        matchMode: "domain",
        patterns: [
          "nytimes.com",
          "bbc.com",
          "bbc.co.uk",
          "cnn.com",
          "theguardian.com",
          "reuters.com",
          "washingtonpost.com",
          "wsj.com",
        ],
      },
    ],
  },
]
