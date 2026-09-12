/**
 * The built-in category lexicon.
 *
 * This is what lets "By Category" work with no API key and no network. Rules are
 * evaluated in order and the first match wins, so specific sites are listed
 * before broad ones. A rule matches on hostname substring first, then on title
 * keywords, then on full-URL substrings.
 */
import type { GroupColor } from "../../shared/types"

export interface CategoryRule {
  category: string
  color: GroupColor
  /** substrings tested against the hostname (lowercased) */
  domains?: string[]
  /** substrings tested against the tab title (lowercased) */
  keywords?: string[]
  /** substrings tested against the whole URL (lowercased) */
  urlKeywords?: string[]
}

/**
 * Folds the fine-grained rules above into fewer, broader groups.
 *
 * The rules are deliberately specific — "Banking", "Payments", "Crypto",
 * "Investing" each match precisely — but as *display* categories that is far too
 * granular. A tab manager that emits fifteen groups for sixteen tabs has not
 * organized anything; the user is left reading the same pile with more headers.
 * The instruction given to the model says the same thing:
 *
 *   "Use between 3 and 12 categories. Prefer fewer, broader categories over
 *    many narrow ones."
 *
 * Measured before this existed: sixteen tabs produced fifteen groups, one of them
 * titled after a bare hostname. Folding the labels to twelve produced seven broad
 * groups from the same input. Keeping the precise matching and widening only the
 * label gets both properties.
 */
export const CATEGORY_CONSOLIDATION: Record<string, string> = {
  // development
  "Code & Repos": "Development",
  "Dev Docs": "Development",
  "Q&A & Forums": "Development",
  "CI & Cloud": "Development",
  "AI Tools": "Development",
  "localhost & Dev": "Development",
  // work
  "Docs & Office": "Work",
  "Email & Chat": "Work",
  "Project Mgmt": "Work",
  Analytics: "Work",
  "Marketing & CRM": "Work",
  Jobs: "Work",
  Design: "Work",
  // learning
  Learning: "Research",
  Reference: "Research",
  Books: "Research",
  // money — .gov sits here because tax, fees and licences are the reason
  // people have those tabs open, and it keeps them beside their bank
  Banking: "Finance",
  Payments: "Finance",
  Crypto: "Finance",
  Investing: "Finance",
  Government: "Finance",
  // media
  "Video & Streaming": "Media",
  "Music & Audio": "Media",
  // news and sport travel together
  Sports: "News",
  // the rest of the household
  Utilities: "Home",
  "Real Estate": "Home",
  Food: "Home",
}

/** Maps a matched rule category to the label actually shown to the user. */
export function displayCategory(category: string): string {
  return CATEGORY_CONSOLIDATION[category] ?? category
}

/**
 * One canonical colour per *displayed* category.
 *
 * Rules carry their own colour, but several rules now fold into one label — if
 * we kept the rule colour, "Development" would come out purple for GitHub and
 * orange for localhost, and the same group would change colour depending on
 * which tab happened to be classified first. Deriving the colour from the
 * display label keeps a group visually stable.
 */
const DISPLAY_COLORS: Record<string, GroupColor> = {
  Development: "purple",
  Work: "blue",
  Research: "cyan",
  Finance: "green",
  Media: "red",
  News: "yellow",
  Home: "orange",
  Social: "pink",
  Shopping: "green",
  Travel: "cyan",
  Health: "red",
  Gaming: "purple",
}

/** The colour a displayed category should render with. */
export function displayColor(category: string): GroupColor | undefined {
  return DISPLAY_COLORS[category]
}

export const CATEGORY_RULES: CategoryRule[] = [
  /* ---- development ---- */
  {
    category: "localhost & Dev",
    color: "orange",
    domains: ["localhost", "127.0.0.1", "0.0.0.0", "192.168.", "10.0.", "*.local"],
    urlKeywords: [":3000", ":5173", ":8000", ":8080", ":4000", ":5000", ":9000"],
  },
  {
    category: "Code & Repos",
    color: "purple",
    domains: [
      "github.com",
      "gitlab.com",
      "bitbucket.org",
      "codeberg.org",
      "gitea.",
      "sourcegraph.com",
      "grep.app",
      "gitpod.io",
      "codesandbox.io",
      "stackblitz.com",
      "replit.com",
      "codepen.io",
      "jsfiddle.net",
    ],
    keywords: ["pull request", "issue #", "commit", "repository", "merge request"],
  },
  {
    category: "Dev Docs",
    color: "blue",
    domains: [
      "developer.mozilla.org",
      "developer.chrome.com",
      "devdocs.io",
      "docs.python.org",
      "nodejs.org",
      "react.dev",
      "vuejs.org",
      "svelte.dev",
      "angular.io",
      "nextjs.org",
      "typescriptlang.org",
      "rust-lang.org",
      "go.dev",
      "docs.rs",
      "pkg.go.dev",
      "npmjs.com",
      "pypi.org",
      "crates.io",
      "readthedocs.io",
      "dev.to",
      "hashnode.dev",
      "css-tricks.com",
      "smashingmagazine.com",
    ],
    keywords: ["documentation", "api reference", "changelog", "release notes"],
  },
  {
    category: "Q&A & Forums",
    color: "cyan",
    domains: [
      "stackoverflow.com",
      "stackexchange.com",
      "superuser.com",
      "serverfault.com",
      "askubuntu.com",
      "quora.com",
      "discourse.",
      "community.",
      "discord.com",
      "forum.",
    ],
    keywords: ["how to", "answered", "question"],
  },
  {
    category: "CI & Cloud",
    color: "orange",
    domains: [
      "vercel.com",
      "netlify.app",
      "netlify.com",
      "railway.app",
      "render.com",
      "fly.io",
      "heroku.com",
      "aws.amazon.com",
      "console.cloud.google.com",
      "portal.azure.com",
      "cloudflare.com",
      "dash.cloudflare.com",
      "digitalocean.com",
      "linode.com",
      "supabase.com",
      "firebase.google.com",
      "planetscale.com",
      "neon.tech",
      "mongodb.com",
      "redis.com",
      "sentry.io",
      "grafana.com",
      "datadoghq.com",
      "newrelic.com",
      "statuspage.io",
      "circleci.com",
      "travis-ci.com",
      "github.com/actions",
    ],
    keywords: ["deployment", "build failed", "pipeline", "dashboard"],
  },
  {
    category: "AI Tools",
    color: "purple",
    domains: [
      "chatgpt.com",
      "chat.openai.com",
      "openai.com",
      "claude.ai",
      "anthropic.com",
      "gemini.google.com",
      "aistudio.google.com",
      "perplexity.ai",
      "huggingface.co",
      "openrouter.ai",
      "together.ai",
      "groq.com",
      "mistral.ai",
      "cohere.com",
      "replicate.com",
      "midjourney.com",
      "runwayml.com",
      "elevenlabs.io",
      "character.ai",
      "poe.com",
      "lmarena.ai",
      "ollama.com",
    ],
    keywords: ["prompt", "llm", "artificial intelligence", "chat with"],
  },
  {
    category: "Design",
    color: "pink",
    domains: [
      "figma.com",
      "sketch.com",
      "canva.com",
      "dribbble.com",
      "behance.net",
      "pinterest.",
      "unsplash.com",
      "pexels.com",
      "framer.com",
      "webflow.com",
      "adobe.com",
      "photopea.com",
      "coolors.co",
      "fonts.google.com",
      "lucide.dev",
      "heroicons.com",
      "iconify.design",
    ],
    keywords: ["mockup", "design system", "wireframe", "palette"],
  },

  /* ---- work ---- */
  {
    category: "Docs & Office",
    color: "blue",
    domains: [
      "docs.google.com",
      "workspace.google.com",
      "sheets.google.com",
      "slides.google.com",
      "drive.google.com",
      "office.com",
      "sharepoint.com",
      "onedrive.live.com",
      "notion.so",
      "coda.io",
      "airtable.com",
      "quip.com",
      "etherpad.",
      "hackmd.io",
      "dropbox.com/paper",
    ],
    keywords: ["spreadsheet", "presentation", "document"],
  },
  {
    category: "Email & Chat",
    color: "cyan",
    domains: [
      "mail.google.com",
      "gmail.com",
      "outlook.live.com",
      "outlook.office.com",
      "mail.yahoo.com",
      "protonmail.com",
      "proton.me",
      "fastmail.com",
      "zoho.com/mail",
      "slack.com",
      "app.slack.com",
      "teams.microsoft.com",
      "discord.com/channels",
      "web.whatsapp.com",
      "telegram.org",
      "web.telegram.org",
      "messenger.com",
      "signal.org",
    ],
    keywords: ["inbox", "unread", "compose", "thread"],
  },
  {
    category: "Project Mgmt",
    color: "green",
    domains: [
      "linear.app",
      "jira.atlassian.com",
      "atlassian.net",
      "trello.com",
      "asana.com",
      "clickup.com",
      "monday.com",
      "basecamp.com",
      "height.app",
      "shortcut.com",
      "wrike.com",
      "smartsheet.com",
    ],
    keywords: ["backlog", "sprint", "board", "kanban", "task"],
  },
  {
    category: "Analytics",
    color: "orange",
    domains: [
      "analytics.google.com",
      "mixpanel.com",
      "amplitude.com",
      "posthog.com",
      "plausible.io",
      "matomo.org",
      "hotjar.com",
      "fullstory.com",
      "tableau.com",
      "looker.com",
      "metabase.",
      "mode.com",
    ],
    keywords: ["funnel", "cohort", "metrics", "report"],
  },
  {
    category: "Marketing & CRM",
    color: "yellow",
    domains: [
      "mailchimp.com",
      "hubspot.com",
      "salesforce.com",
      "zendesk.com",
      "intercom.com",
      "marketo.com",
      "klaviyo.com",
      "sendgrid.com",
      "constantcontact.com",
      "buffer.com",
      "hootsuite.com",
    ],
    keywords: ["campaign", "newsletter", "lead", "subscriber"],
  },
  {
    category: "Jobs",
    color: "green",
    domains: [
      "linkedin.com/jobs",
      "indeed.com",
      "glassdoor.com",
      "wellfound.com",
      "angel.co",
      "lever.co",
      "greenhouse.io",
      "workday.com",
      "ziprecruiter.com",
      "monster.com",
      "dice.com",
      "hired.com",
    ],
    keywords: ["job", "hiring", "apply", "recruiter", "salary", "interview"],
  },

  /* ---- learning ---- */
  {
    category: "Learning",
    color: "blue",
    domains: [
      "coursera.org",
      "udemy.com",
      "edx.org",
      "khanacademy.org",
      "udacity.com",
      "pluralsight.com",
      "skillshare.com",
      "brilliant.org",
      "duolingo.com",
      "datacamp.com",
      "educative.io",
      "frontendmasters.com",
      "codecademy.com",
      "leetcode.com",
      "hackerrank.com",
      "codewars.com",
      "exercism.org",
    ],
    keywords: ["course", "lesson", "tutorial", "certificate", "quiz", "curriculum"],
  },
  {
    category: "Research",
    color: "purple",
    domains: [
      "arxiv.org",
      "scholar.google.com",
      "pubmed.ncbi.nlm.nih.gov",
      "jstor.org",
      "researchgate.net",
      "semanticscholar.org",
      "nature.com",
      "sciencedirect.com",
      "springer.com",
      "ieee.org",
      "acm.org",
      "biorxiv.org",
      "ssrn.com",
      "paperswithcode.com",
    ],
    keywords: ["abstract", "citation", "doi", "preprint", "literature review"],
  },
  {
    category: "Reference",
    color: "grey",
    domains: [
      "wikipedia.org",
      "wiktionary.org",
      "britannica.com",
      "merriam-webster.com",
      "dictionary.com",
      "thesaurus.com",
      "wolframalpha.com",
      "quora.com",
      "wikihow.com",
    ],
    keywords: ["definition", "meaning", "encyclopedia"],
  },
  {
    category: "Books",
    color: "yellow",
    domains: [
      "goodreads.com",
      "openlibrary.org",
      "gutenberg.org",
      "archive.org",
      "annas-archive.org",
      "libgen.",
      "standardebooks.org",
      "audible.com",
      "storygraph.com",
    ],
    keywords: ["book", "novel", "author", "chapter", "isbn"],
  },

  /* ---- money ---- */
  {
    category: "Banking",
    color: "green",
    domains: [
      "chase.com",
      "bankofamerica.com",
      "wellsfargo.com",
      "citi.com",
      "capitalone.com",
      "usbank.com",
      "pnc.com",
      "tdbank.com",
      "schwab.com",
      "fidelity.com",
      "vanguard.com",
      "etrade.com",
      "merrilledge.com",
      "monzo.com",
      "revolut.com",
      "barclays.co.uk",
      "hsbc.com",
      "lloydsbank.com",
      "ing.com",
    ],
    keywords: ["balance", "statement", "account", "transfer", "routing number"],
  },
  {
    category: "Payments",
    color: "cyan",
    domains: [
      "paypal.com",
      "stripe.com",
      "squareup.com",
      "wise.com",
      "venmo.com",
      "cash.app",
      "klarna.com",
      "affirm.com",
      "afterpay.com",
      "adyen.com",
      "braintree.",
    ],
    keywords: ["payment", "invoice", "checkout", "refund"],
  },
  {
    category: "Crypto",
    color: "orange",
    domains: [
      "coinbase.com",
      "binance.com",
      "kraken.com",
      "crypto.com",
      "kucoin.com",
      "gemini.com",
      "bitfinex.com",
      "opensea.io",
      "etherscan.io",
      "bscscan.com",
      "debank.com",
      "coingecko.com",
      "coinmarketcap.com",
      "uniswap.org",
      "metamask.io",
    ],
    keywords: ["wallet", "token", "gas fee", "blockchain", "nft"],
  },
  {
    category: "Investing",
    color: "green",
    domains: [
      "tradingview.com",
      "yahoo.com/finance",
      "finance.yahoo.com",
      "marketwatch.com",
      "bloomberg.com",
      "morningstar.com",
      "seekingalpha.com",
      "investopedia.com",
      "robinhood.com",
      "webull.com",
      "interactivebrokers.com",
      "nasdaq.com",
      "sec.gov",
    ],
    keywords: ["stock", "ticker", "earnings", "portfolio", "dividend", "etf"],
  },

  /* ---- shopping ---- */
  {
    category: "Shopping",
    color: "yellow",
    domains: [
      "amazon.",
      "ebay.",
      "etsy.com",
      "aliexpress.",
      "alibaba.com",
      "walmart.com",
      "target.com",
      "bestbuy.com",
      "homedepot.com",
      "lowes.com",
      "costco.com",
      "ikea.com",
      "wayfair.com",
      "shein.com",
      "temu.com",
      "asos.com",
      "zara.com",
      "hm.com",
      "uniqlo.com",
      "nike.com",
      "adidas.com",
      "shopify.com",
      "wish.com",
      "newegg.com",
      "bhphotovideo.com",
      "argos.co.uk",
      "johnlewis.com",
      "mercadolibre.",
      "flipkart.com",
      "rakuten.",
    ],
    keywords: ["add to cart", "buy now", "checkout", "free shipping", "order", "price"],
  },
  {
    category: "Travel",
    color: "cyan",
    domains: [
      "booking.com",
      "airbnb.",
      "expedia.com",
      "hotels.com",
      "kayak.com",
      "skyscanner.",
      "tripadvisor.",
      "agoda.com",
      "trivago.",
      "priceline.com",
      "united.com",
      "delta.com",
      "aa.com",
      "southwest.com",
      "ryanair.com",
      "easyjet.com",
      "trainline.com",
      "amtrak.com",
      "uber.com",
      "lyft.com",
      "trip.com",
      "google.com/travel",
      "google.com/maps",
      "maps.google.com",
      "openstreetmap.org",
    ],
    keywords: ["flight", "hotel", "itinerary", "boarding pass", "booking", "directions"],
  },
  {
    category: "Food",
    color: "red",
    domains: [
      "doordash.com",
      "ubereats.com",
      "grubhub.com",
      "deliveroo.",
      "just-eat.",
      "instacart.com",
      "opentable.com",
      "yelp.com",
      "allrecipes.com",
      "bbcgoodfood.com",
      "seriouseats.com",
      "food52.com",
      "epicurious.com",
      "hellofresh.com",
      "starbucks.com",
      "dominos.com",
      "mcdonalds.com",
    ],
    keywords: ["recipe", "restaurant", "menu", "delivery", "ingredients", "reservation"],
  },

  /* ---- media ---- */
  {
    category: "Video & Streaming",
    color: "red",
    domains: [
      "youtube.com",
      "youtu.be",
      "netflix.com",
      "hulu.com",
      "disneyplus.com",
      "max.com",
      "hbomax.com",
      "primevideo.com",
      "peacocktv.com",
      "paramountplus.com",
      "twitch.tv",
      "vimeo.com",
      "dailymotion.com",
      "bilibili.com",
      "crunchyroll.com",
      "kick.com",
      "rumble.com",
    ],
    keywords: ["watch", "episode", "season", "trailer", "livestream"],
  },
  {
    category: "Music & Audio",
    color: "pink",
    domains: [
      "open.spotify.com",
      "spotify.com",
      "music.apple.com",
      "soundcloud.com",
      "bandcamp.com",
      "music.youtube.com",
      "pandora.com",
      "deezer.com",
      "tidal.com",
      "last.fm",
      "audius.co",
      "mixcloud.com",
    ],
    keywords: ["playlist", "album", "song", "artist", "podcast"],
  },
  {
    category: "Social",
    color: "pink",
    domains: [
      "x.com",
      "twitter.com",
      "reddit.com",
      "linkedin.com",
      "facebook.com",
      "instagram.com",
      "threads.net",
      "tiktok.com",
      "tumblr.com",
      "mastodon.",
      "bsky.app",
      "m.facebook.com",
      "vk.com",
      "weibo.com",
      "xiaohongshu.com",
    ],
    keywords: ["followers", "your feed", "home feed", "posted", "likes", "repost"],
  },
  {
    category: "News",
    color: "grey",
    domains: [
      "nytimes.com",
      "bbc.com",
      "bbc.co.uk",
      "cnn.com",
      "theguardian.com",
      "reuters.com",
      "apnews.com",
      "washingtonpost.com",
      "wsj.com",
      "bloomberg.com",
      "ft.com",
      "economist.com",
      "npr.org",
      "politico.com",
      "theatlantic.com",
      "vox.com",
      "axios.com",
      "aljazeera.com",
      "foxnews.com",
      "nbcnews.com",
      "cbsnews.com",
      "abcnews.go.com",
      "usatoday.com",
      "latimes.com",
      "techcrunch.com",
      "theverge.com",
      "arstechnica.com",
      "wired.com",
      "engadget.com",
      "hackernews.",
      "news.ycombinator.com",
      "lobste.rs",
    ],
    keywords: ["breaking", "headline", "report says", "opinion", "editorial"],
  },
  {
    category: "Sports",
    color: "green",
    domains: [
      "espn.com",
      "skysports.com",
      "bleacherreport.com",
      "si.com",
      "cbssports.com",
      "foxsports.com",
      "nba.com",
      "nfl.com",
      "mlb.com",
      "nhl.com",
      "fifa.com",
      "uefa.com",
      "premierleague.com",
      "flashscore.com",
      "sofascore.com",
    ],
    keywords: ["score", "match", "fixture", "standings", "highlights", "vs"],
  },
  {
    category: "Gaming",
    color: "purple",
    domains: [
      "store.steampowered.com",
      "steamcommunity.com",
      "epicgames.com",
      "playstation.com",
      "xbox.com",
      "nintendo.com",
      "battle.net",
      "roblox.com",
      "itch.io",
      "nexusmods.com",
      "op.gg",
      "leagueoflegends.com",
      "ign.com",
      "gamespot.com",
      "pcgamer.com",
      "fextralife.com",
    ],
    keywords: ["game", "mod", "loot", "patch notes", "walkthrough"],
  },

  /* ---- personal ---- */
  {
    category: "Health",
    color: "green",
    domains: [
      "mychart.",
      "webmd.com",
      "mayoclinic.org",
      "healthline.com",
      "nhs.uk",
      "cdc.gov",
      "who.int",
      "fitbit.com",
      "strava.com",
      "myfitnesspal.com",
      "garmin.com",
      "headspace.com",
      "calm.com",
      "whoop.com",
      "peloton.com",
      "zwift.com",
    ],
    keywords: ["symptoms", "appointment", "workout", "calories", "medication", "prescription"],
  },
  {
    category: "Government",
    color: "grey",
    domains: [
      ".gov",
      ".gov.uk",
      "irs.gov",
      "ssa.gov",
      "uscis.gov",
      "dmv.",
      "canada.ca",
      "europa.eu",
      "gov.uk",
      "auspost.com.au",
    ],
    keywords: ["tax", "form", "renew", "application", "permit", "license"],
  },
  {
    category: "Real Estate",
    color: "orange",
    domains: [
      "zillow.com",
      "redfin.com",
      "realtor.com",
      "rightmove.co.uk",
      "zoopla.co.uk",
      "idealista.com",
      "immobilienscout24.de",
      "trulia.com",
      "apartments.com",
      "hotpads.com",
    ],
    keywords: ["for rent", "for sale", "listing", "bedroom", "mortgage"],
  },
  {
    category: "Utilities",
    color: "cyan",
    domains: [
      "github.com/settings",
      "accounts.google.com",
      "myaccount.google.com",
      "appleid.apple.com",
      "account.microsoft.com",
      "1password.com",
      "lastpass.com",
      "bitwarden.com",
      "dashlane.com",
      "speedtest.net",
      "fast.com",
      "weather.com",
      "accuweather.com",
      "wunderground.com",
      "timeanddate.com",
      "translate.google.com",
      "deepl.com",
      "wetransfer.com",
      "smallpdf.com",
      "ilovepdf.com",
      "cloudconvert.com",
    ],
    keywords: ["settings", "two-factor", "password", "weather forecast", "translate", "convert"],
  },
]

/** Categories that only make sense when the tab is a search result page. */
export const SEARCH_ENGINES = [
  "google.",
  "bing.com",
  "duckduckgo.com",
  "search.brave.com",
  "ecosia.org",
  "startpage.com",
  "kagi.com",
  "yandex.",
  "baidu.com",
]

/**
 * Turns a matched rule into the label/colour pair the UI actually renders.
 * Matching stays precise (rule.category); only the output is consolidated.
 */
function resolveRule(rule: CategoryRule): { category: string; color: GroupColor } {
  const label = displayCategory(rule.category)
  return { category: label, color: displayColor(label) ?? rule.color }
}

/**
 * Classifies a tab using the lexicon only. Returns null when nothing matches,
 * which lets the caller fall back to the site label.
 */
export function classifyLocal(
  url: string,
  title: string,
): { category: string; color: GroupColor } | null {
  const u = (url || "").toLowerCase()
  const t = (title || "").toLowerCase()

  let host = ""
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    /* keep host empty */
  }

  // search result pages get their own bucket, they are noise in every other one
  if (SEARCH_ENGINES.some((s) => host.includes(s)) && /[?&](q|query|p|search)=/.test(u)) {
    return { category: "Search Results", color: "grey" }
  }

  // pass 1: hostname
  for (const rule of CATEGORY_RULES) {
    if (rule.domains?.some((d) => host.includes(d))) {
      return resolveRule(rule)
    }
  }

  // pass 2: title keywords
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords?.some((k) => t.includes(k))) {
      return resolveRule(rule)
    }
  }

  // pass 3: url substrings (ports, paths)
  for (const rule of CATEGORY_RULES) {
    if (rule.urlKeywords?.some((k) => u.includes(k))) {
      return resolveRule(rule)
    }
  }

  // pass 4: the hostname's own words, against title keywords.
  // Catches sites we did not enumerate by name — "shopify.com" matches the
  // Shopping rule's "shop", "booking.com" matches Travel's "booking". Without
  // this, every unknown site became a group named after its bare hostname,
  // which is how sixteen tabs once produced fifteen groups.
  if (host) {
    for (const rule of CATEGORY_RULES) {
      if (rule.keywords?.some((k) => k.length >= 4 && host.includes(k))) {
        return resolveRule(rule)
      }
    }
  }

  return null
}
