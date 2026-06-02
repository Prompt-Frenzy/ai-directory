#!/usr/bin/env node
/**
 * Badge verifier for PromptFrenzy AI Directory.
 *
 * Modes:
 *   --pr <yaml-path>     verify a single file (used by PR-time GH Action)
 *   --all-active         verify every tools/*.yaml (used by weekly cron)
 *   --recent-7d          verify tools/*.yaml first_verified_at within 7 days (daily cron)
 *
 * Verification logic (intentionally dumb):
 *   1. Fetch badge_url with desktop UA, follow redirects up to 3, 10s timeout
 *   2. Parse HTML
 *   3. Find any <a> with href matching https://promptfrenzy.com/directory*
 *   4. Check rel does NOT contain "nofollow" or "sponsored"
 *   5. Pass = update verification block, commit changes
 *
 * No JS execution. If a badge requires JS to render, it doesn't count —
 * forces real static markup and prevents most spoofing.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join, basename } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { parseHTML } from "linkedom"

const TOOLS_DIR = "tools"
const TARGET_PREFIX = "https://promptfrenzy.com/directory"
const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const USER_AGENT =
  "Mozilla/5.0 (compatible; PromptFrenzyDirectoryBot/1.0; +https://promptfrenzy.com/directory)"

const args = process.argv.slice(2)
const mode = args[0]

if (!mode) {
  console.error(
    "Usage: verify-badges.mjs --pr <yaml-path> | --all-active | --recent-7d"
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
    if (!href.startsWith(TARGET_PREFIX)) continue
    const rel = (a.getAttribute("rel") || "").toLowerCase()
    if (rel.includes("nofollow")) {
      return { found: true, error: "anchor has rel=nofollow" }
    }
    if (rel.includes("sponsored")) {
      return { found: true, error: "anchor has rel=sponsored" }
    }
    return { found: true, error: null, href }
  }
  return { found: false, error: "no anchor with href starting " + TARGET_PREFIX }
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

function nowIso() {
  return new Date().toISOString()
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
  } else {
    v.failure_count = (v.failure_count || 0) + 1
    v.failure_reason = result.reason
    if (v.failure_count >= 3) {
      v.status = "failed"
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

async function main() {
  let targets = []
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
