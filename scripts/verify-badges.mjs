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
import { verifyData, updateVerificationBlock as applyVerification } from "./badge-check.mjs"
import { GRACE_DAYS, shouldRemove, markRemoved } from "./removal-policy.mjs"

const TOOLS_DIR = "tools"
const REMOVED_DIR = "removed"
const args = process.argv.slice(2)
const mode = args[0]

if (!mode) {
  console.error(
    "Usage: verify-badges.mjs --pr <yaml-path> | --all-active | --recent-7d | --sweep-removed [--dry-run]"
  )
  process.exit(1)
}

async function verifyFile(path) {
  return verifyData(parseYaml(readFileSync(path, "utf8")))
}

// VERIFY_NOW_ISO lets a dry run / test pin "now" (e.g. to preview which entries
// a future sweep would move). Never set in the workflow.
function nowIso() {
  return (process.env.VERIFY_NOW_ISO || new Date().toISOString())
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
  const updated = applyVerification(data, result, nowIso())
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
