/**
 * URL and time helpers shared by the service worker and the UIs.
 */

/** True for pages we can never group, rename or read. */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://") ||
    url.startsWith("chrome-untrusted://") ||
    url.startsWith("view-source:") ||
    url === "chrome://newtab/" ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com")
  )
}

/** Hostname without the `www.` prefix, or a readable label for special pages. */
export function hostOf(url: string): string {
  if (!url) return ""
  try {
    const u = new URL(url)
    if (u.protocol === "file:") return "Local files"
    if (u.protocol === "chrome:") return "Chrome"
    if (u.protocol === "chrome-extension:") return "Extensions"
    const h = u.hostname.replace(/^www\./, "")
    if (!h) return u.protocol.replace(":", "")
    return h
  } catch {
    return ""
  }
}

/** A single word used to group tabs that share a site. */
export function siteLabel(url: string): string {
  const host = hostOf(url)
  if (!host) return "Other"
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return "localhost"
  const parts = host.split(".")
  if (parts.length <= 2) return host
  // keep the registrable-ish part: docs.google.com -> google.com
  return parts.slice(-2).join(".")
}

/** The full path plus query, used by path-style topic matching. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return ""
  }
}

/**
 * Strips the fragment and common tracking parameters so duplicate detection
 * does not treat the same page as two tabs.
 */
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
  "ref",
]

export function normalizeUrl(raw: string): string {
  if (!raw) return ""
  try {
    const u = new URL(raw)
    u.hash = ""
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p)
    // sort the remaining params so ?a=1&b=2 matches ?b=2&a=1
    u.searchParams.sort()
    let s = u.toString()
    // a bare trailing slash is the same page
    if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "")
    return s
  } catch {
    return raw.split("#")[0]
  }
}

/** Best-effort title for a tab, preferring the user's own name. */
export function displayTitle(t: { title?: string; customTitle?: string; url?: string }): string {
  if (t.customTitle?.trim()) return t.customTitle.trim()
  if (t.title?.trim()) return t.title.trim()
  const h = hostOf(t.url ?? "")
  return h || "Untitled"
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Compact relative time, e.g. "3m ago", "5h ago", "2d ago". */
export function timeAgo(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts)
  if (d < 45_000) return "just now"
  if (d < HOUR) return `${Math.round(d / MIN)}m ago`
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`
  if (d < 7 * DAY) return `${Math.round(d / DAY)}d ago`
  if (d < 30 * DAY) return `${Math.round(d / (7 * DAY))}w ago`
  return `${Math.round(d / (30 * DAY))}mo ago`
}

/** Absolute, unambiguous timestamp for tooltips. */
export function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Trailing-edge debounce. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...a: A) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}
