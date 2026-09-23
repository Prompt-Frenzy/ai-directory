#!/usr/bin/env node
/**
 * Badge verifier for PromptFrenzy AI Directory.
 *
 * Modes:
 *   --pr <yaml-path>     verify a single file (used by PR-time GH Action)
 *   --all-active         verify every tools/*.yaml (used by weekly cron)
 *   --recent-7d          verify tools/*.yaml first_verified_at within 7 days (daily cron)
 *   --sweep-removed      move entries `failed` for ≥30 days to removed/ (cron, after a verify pass)
 *                        add --dry-run to print what would move without touching disk
 *
 * Verification logic (intentionally dumb):
 *   1. Fetch badge_url with desktop UA, follow redirects up to 3, 10s timeout
 *   2. Parse HTML
 *   3. Find any <a> with href matching https://promptfrenzy.com/directory*
 *   4. Check rel does NOT contain "nofollow" or "sponsored"
 *   5. Pass = update verification block, commit changes
 *
 * Lifecycle (README "What happens if your badge disappears"):
 *   miss 1-2 → pending · miss 3 → failed (stamps failed_at) · failed for
 *   30 days → --sweep-removed moves the file to removed/ with
 *   removal_reason: badge-failure. Policy maths live in removal-policy.mjs.
 *
 * No JS execution. If a badge requires JS to render, it doesn't count —
 * forces real static markup and prevents most spoofing.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs"
import { join, basename } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { parseHTML } from "linkedom"
import { classifyHost } from "./host-class.mjs"
import { GRACE_DAYS, shouldRemove, markRemoved } from "./removal-policy.mjs"

const TOOLS_DIR = "tools"
const REMOVED_DIR = "removed"
// Accept both apex and www forms. Docs canonicalize on www, but legacy
// badge HTML on submitter sites uses the apex form (original README shipped
// with that). Rejecting apex would break existing pastes.
const TARGET_PREFIXES = [
  "https://www.promptfrenzy.com/directory",
  "https://promptfrenzy.com/directory",
]
const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const USER_AGENT =
  "Mozilla/5.0 (compatible; PromptFrenzyDirectoryBot/1.0; +https://www.promptfrenzy.com/directory)"

const args = process.argv.slice(2)
const mode = args[0]

if (!mode) {
  console.error(
    "Usage: verify-badges.mjs --pr <yaml-path> | --all-active | --recent-7d | --sweep-removed [--dry-run]"
  )
  process.exit(1)
}

async function fetchWithRedirects(url, depth = 0) {
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

function findBadgeAnchor(html) {
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
function apexHost(urlStr) {
  return new URL(urlStr).host.toLowerCase().replace(/^www\./, "")
}

async function verifyFile(path) {
  const raw = readFileSync(path, "utf8")
  const data = parseYaml(raw)
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

// VERIFY_NOW_ISO lets a dry run / test pin "now" (e.g. to preview which entries
// a future sweep would move). Never set in the workflow.
function nowIso() {
  return (process.env.VERIFY_NOW_ISO || new Date().toISOString())
}

function updateVerificationBlock(data, result) {
  const v = data.verification || {}
  const now = nowIso()
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

async function processFile(path) {
  console.log(`→ ${path}`)
  const result = await verifyFile(path)
  if (result.skipped) {
    console.log(`  skipped (${result.reason})`)
    return { path, skipped: true }
  }
  const raw = readFileSync(path, "utf8")
  const data = parseYaml(raw)
  const updated = updateVerificationBlock(data, result)
  writeFileSync(path, stringifyYaml(updated, { lineWidth: 100 }))
  console.log(
    result.ok
      ? `  ✓ verified — ${result.anchor_href}`
      : `  ✗ failed — ${result.reason}`
  )
  return { path, ...result }
}

// Step 3 of the policy. Reads every tools/*.yaml, moves the ones that have
// been `failed` for GRACE_DAYS to removed/ and stamps the punitive reason.
// Safe to run repeatedly: removed files are no longer in tools/, so a second
// pass finds nothing. Returns the list of moved slugs.
function sweepRemoved({ dryRun }) {
  const now = nowIso()
  const nowMs = Date.parse(now)
  const moved = []
  const files = readdirSync(TOOLS_DIR).filter(
    (f) => f.endsWith(".yaml") && !f.startsWith("_")
  )
  for (const f of files) {
    const src = join(TOOLS_DIR, f)
    const data = parseYaml(readFileSync(src, "utf8"))
    if (!shouldRemove(data, nowMs)) continue
    // A slug can be re-listed and fail again; never clobber the earlier record.
    let dest = join(REMOVED_DIR, f)
    if (existsSync(dest)) {
      dest = join(REMOVED_DIR, f.replace(/\.yaml$/, `-${now.slice(0, 10)}.yaml`))
    }
    const days = Math.floor((nowMs - Date.parse(data.verification.failed_at)) / 86_400_000)
    console.log(
      `${dryRun ? "[dry-run] would move" : "→ moving"} ${src} → ${dest} (failed ${days}d, ${data.verification.failure_reason})`
    )
    if (!dryRun) {
      writeFileSync(dest, stringifyYaml(markRemoved(data, now), { lineWidth: 100 }))
      unlinkSync(src)
    }
    moved.push(basename(f, ".yaml"))
  }
  console.log(
    `\nSweep done. ${moved.length} entr${moved.length === 1 ? "y" : "ies"} past the ${GRACE_DAYS}-day grace window${dryRun ? " (dry run, nothing written)" : ""}.`
  )
  return moved
}

async function main() {
  let targets = []
  if (mode === "--sweep-removed") {
    sweepRemoved({ dryRun: args.includes("--dry-run") })
    return
  }
  if (mode === "--pr") {
    const path = args[1]
    if (!path) {
      console.error("--pr requires a yaml path")
      process.exit(1)
    }
    targets = [path]
  } else if (mode === "--all-active") {
    targets = readdirSync(TOOLS_DIR)
      .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
      .map((f) => join(TOOLS_DIR, f))
  } else if (mode === "--recent-7d") {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    targets = readdirSync(TOOLS_DIR)
      .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
      .map((f) => join(TOOLS_DIR, f))
      .filter((p) => {
        const d = parseYaml(readFileSync(p, "utf8"))
        const first = d.verification?.first_verified_at
        return first && new Date(first).getTime() > sevenDaysAgo
      })
  } else {
    console.error(`Unknown mode: ${mode}`)
    process.exit(1)
  }
  const results = []
  for (const t of targets) {
    results.push(await processFile(t))
  }
  const failed = results.filter((r) => r.ok === false)
  if (mode === "--pr" && failed.length > 0) {
    process.exit(2) // signal PR-time failure
  }
  console.log(
    `\nDone. ${results.filter((r) => r.ok).length} verified, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped.`
  )
}

main().catch((e) => {
  console.error("verifier crashed:", e)
  process.exit(1)
})
