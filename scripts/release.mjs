/**
 * Publish a new version to the Chrome Web Store.
 *
 * ## What this can and cannot do
 *
 * The Web Store API (v2) has no create method. Every path is
 * `/v2/publishers/*\/items/*`, so it can only operate on an item that already
 * exists — verified against the official REST reference, not assumed. The first
 * version has to be created by hand in the Developer Dashboard. After that, this
 * script handles every subsequent release.
 *
 * ## Setup (once)
 *
 *   1. Google Cloud Console -> enable the "Chrome Web Store API".
 *   2. Create a service account; no IAM roles are needed on it.
 *   3. Create a JSON key for it and keep the file somewhere outside this repo.
 *   4. In the Developer Dashboard, under Account, add the service account's
 *      email. Only one service account can be linked per publisher.
 *   5. Note the publisher ID and the item ID from the dashboard.
 *
 * ## Use
 *
 *   export CWS_SERVICE_ACCOUNT_JSON=/path/to/key.json
 *   export CWS_PUBLISHER_ID=...
 *   export CWS_ITEM_ID=...
 *   npm run release            # upload and submit for review
 *   npm run release -- --upload-only
 *   npm run release -- --status
 *
 * Nothing is committed and no credential is read from the repository.
 */
import { readFileSync, existsSync } from "node:fs"
import { createSign } from "node:crypto"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ZIP = resolve(root, "orbit-extension.zip")

const SCOPE = "https://www.googleapis.com/auth/chromewebstore"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const API = "https://chromewebstore.googleapis.com"

const argv = process.argv.slice(2)
const uploadOnly = argv.includes("--upload-only")
const statusOnly = argv.includes("--status")

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

const keyPath = process.env.CWS_SERVICE_ACCOUNT_JSON
const publisherId = process.env.CWS_PUBLISHER_ID
const itemId = process.env.CWS_ITEM_ID

function missing() {
  const gaps = []
  if (!keyPath) gaps.push("CWS_SERVICE_ACCOUNT_JSON")
  if (!publisherId) gaps.push("CWS_PUBLISHER_ID")
  if (!itemId) gaps.push("CWS_ITEM_ID")
  return gaps
}

const gaps = missing()
if (gaps.length) {
  console.error(
    [
      "",
      `Not configured. Missing: ${gaps.join(", ")}`,
      "",
      "This script can only update an item that already exists in the store —",
      "the Web Store API has no create method. Publish v1.0.0 by hand first",
      "(see STORE.md), then set the three variables above.",
      "",
    ].join("\n"),
  )
  process.exit(2)
}

if (!existsSync(keyPath)) {
  console.error(`Service account key not found: ${keyPath}`)
  process.exit(2)
}

const sa = JSON.parse(readFileSync(keyPath, "utf8"))
if (!sa.client_email || !sa.private_key) {
  console.error("That file does not look like a service account JSON key.")
  process.exit(2)
}

/* ------------------------------------------------------------------ */
/* Access token, via a signed JWT                                      */
/* ------------------------------------------------------------------ */

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

async function accessToken() {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  )
  const signingInput = `${header}.${claims}`
  const signer = createSign("RSA-SHA256")
  signer.update(signingInput)
  const signature = b64url(signer.sign(sa.private_key))
  const assertion = `${signingInput}.${signature}`

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) {
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`)
  }
  return body.access_token
}

/* ------------------------------------------------------------------ */

const base = `${API}/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`

async function call(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { ok: res.ok, status: res.status, body }
}

async function main() {
  const token = await accessToken()
  console.error("[release] authenticated")

  const status = await call(`${base}:fetchStatus`, token)
  if (!status.ok) {
    console.error(`[release] could not read the item status (${status.status})`)
    console.error(JSON.stringify(status.body).slice(0, 500))
    process.exit(1)
  }
  const s = status.body
  console.error(
    `[release] item ${itemId}: state=${s.publishedItemRevisionStatus?.state ?? "?"} ` +
      `submitted=${s.submittedItemRevisionStatus?.state ?? "none"}`,
  )
  if (statusOnly) return

  if (!existsSync(ZIP)) {
    console.error(`[release] no package at ${ZIP} — run \`npm run package\` first`)
    process.exit(1)
  }
  const bytes = readFileSync(ZIP)
  console.error(`[release] uploading ${(bytes.length / 1024).toFixed(1)} KB`)

  const upload = await call(`${API}/upload/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}:upload`, token, {
    method: "POST",
    headers: { "content-type": "application/zip", "x-goog-api-version": "2" },
    body: bytes,
  })
  if (!upload.ok) {
    console.error(`[release] upload failed (${upload.status})`)
    console.error(JSON.stringify(upload.body).slice(0, 600))
    process.exit(1)
  }
  console.error(`[release] uploaded: ${upload.body?.uploadState ?? "ok"}`)

  if (uploadOnly) {
    console.error("[release] --upload-only, stopping before submission")
    return
  }

  const publish = await call(`${base}:publish`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
  })
  if (!publish.ok) {
    console.error(`[release] publish failed (${publish.status})`)
    console.error(JSON.stringify(publish.body).slice(0, 600))
    process.exit(1)
  }
  console.error("[release] submitted for review")
  console.error(
    "[release] review takes days, longer when host permissions are requested. " +
      "`npm run release -- --status` reports where it stands.",
  )
}

main().catch((e) => {
  console.error(`[release] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
