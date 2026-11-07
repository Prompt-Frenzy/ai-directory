// Badge verification shared by the nightly verifier (verify-badges.mjs) and the
// fork-PR / issue review job (review-submissions.mjs). Extracted unchanged from
// verify-badges.mjs so there is one oracle, not two that drift (the 03/09/2026
// retrospective already counts three copies of this logic across repos).
//
// Fetches badge_url with plain HTTP and executes NO JavaScript: refusing to run
// JS is the anti-spoof property, not a limitation.
import { parseHTML } from "linkedom"
import { classifyHost } from "./host-class.mjs"

// Accept both apex and www forms. Docs canonicalize on www, but legacy
// badge HTML on submitter sites uses the apex form (original README shipped
// with that). Rejecting apex would break existing pastes.
export const TARGET_PREFIXES = [
  "https://www.promptfrenzy.com/directory",
  "https://promptfrenzy.com/directory",
]
const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const USER_AGENT =
  "Mozilla/5.0 (compatible; PromptFrenzyDirectoryBot/1.0; +https://www.promptfrenzy.com/directory)"

export async function fetchWithRedirects(url, depth = 0) {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (>${MAX_REDIRECTS})`)
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      signal: ctrl.signal,
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (!loc) throw new Error(`Redirect ${res.status} with no Location`)
      const next = new URL(loc, url).toString()
      return fetchWithRedirects(next, depth + 1)
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const text = await res.text()
    return { url: res.url || url, html: text }
  } finally {
    clearTimeout(timer)
  }
}

export function findBadgeAnchor(html) {
  const { document } = parseHTML(html)
  const anchors = document.querySelectorAll("a[href]")
  for (const a of anchors) {
    const href = a.getAttribute("href") || ""
    if (!TARGET_PREFIXES.some((p) => href.startsWith(p))) continue
    const rel = (a.getAttribute("rel") || "").toLowerCase()
    if (rel.includes("nofollow")) {
      return { found: true, error: "anchor has rel=nofollow" }
    }
    if (rel.includes("sponsored")) {
      return { found: true, error: "anchor has rel=sponsored" }
    }
    return { found: true, error: null, href }
  }
  return {
    found: false,
    error: `no anchor with href starting ${TARGET_PREFIXES[0]} or ${TARGET_PREFIXES[1]}`,
  }
}

// Strip leading "www." so example.com and www.example.com compare equal.
// Mirrors the same helper in promptfrenzy2's submit route — the API blocks
// mismatched hosts up front, but for git-native PRs (someone editing
// tools/*.yaml directly via the GitHub UI) the verifier is the only gate.
export function apexHost(urlStr) {
  return new URL(urlStr).host.toLowerCase().replace(/^www\./, "")
}

export async function verifyData(data) {
  if (data.seeded) {
    return { ok: true, skipped: true, reason: "seeded entry, no badge required" }
  }
  if (!data.badge_url) {
    return { ok: false, reason: "no badge_url" }
  }
  if (!data.url) {
    return { ok: false, reason: "no url" }
  }
  // Apex-domain guard: badge_url must live on the same host as url.
  // Without this, a submitter could paste the badge on a Reddit/Medium post
  // and submit a `url` they don't own — verifier would pass and a
  // misattributed listing would land in the directory.
  let urlHost, badgeHost
  try {
    urlHost = apexHost(data.url)
    badgeHost = apexHost(data.badge_url)
  } catch (e) {
    return { ok: false, reason: `invalid URL: ${e.message}` }
  }
  if (urlHost !== badgeHost) {
    return {
      ok: false,
      reason: `badge_url host (${badgeHost}) must match url host (${urlHost})`,
    }
  }
  // Host-quality gate. A valid badge on a raw-IP / embedded-IP / tunnel /
  // free-host / shortener host still doesn't earn a listing — those are not
  // durable product homes and we don't hand them an outbound link. early-stage
  // (PaaS subdomains) and established both pass here; the early-stage flag is
  // derived from `url` at render time on the directory site, not stored.
  const hostClass = classifyHost(data.url)
  if (hostClass.tier === "reject") {
    return { ok: false, reason: `host rejected — ${hostClass.reason}` }
  }
  let pageRes
  try {
    pageRes = await fetchWithRedirects(data.badge_url)
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${e.message}` }
  }
  const result = findBadgeAnchor(pageRes.html)
  if (!result.found || result.error) {
    return { ok: false, reason: result.error || "anchor not found" }
  }
  return { ok: true, anchor_href: result.href, fetched_url: pageRes.url }
}

export function updateVerificationBlock(data, result, now) {
  const v = data.verification || {}
  v.last_checked_at = now
  if (result.ok) {
    v.status = "verified"
    v.last_passed_at = now
    if (!v.first_verified_at) v.first_verified_at = now
    v.failure_count = 0
    v.failure_reason = null
    // Badge is back: the 30-day clock resets. Deleting (not nulling) keeps the
    // key out of the YAML so a re-failure gets a fresh stamp below.
    delete v.failed_at
  } else {
    v.failure_count = (v.failure_count || 0) + 1
    v.failure_reason = result.reason
    if (v.failure_count >= 3) {
      v.status = "failed"
      // Start the removal clock on the FIRST check that lands in failed and
      // leave it alone on later misses — the README promises "30 days in
      // failed", so the stamp must be the transition, not the latest check.
      if (!v.failed_at) v.failed_at = now
    } else {
      v.status = "pending"
    }
  }
  data.verification = v
  return data
}
