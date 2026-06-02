#!/usr/bin/env node
/**
 * Auto-regenerate README.md.
 *
 * Reads tools/*.yaml + seed/*.yaml + removed/*.yaml, replaces two
 * delimited regions inside README.md:
 *
 *   <!-- AUTOGEN:STATS --> ... <!-- /AUTOGEN:STATS -->
 *   <!-- AUTOGEN:CATALOG --> ... <!-- /AUTOGEN:CATALOG -->
 *
 * Editorial copy outside those regions is preserved.
 *
 * Idempotent: if the regenerated README byte-matches the current one,
 * exits 0 without writing — breaks any self-trigger loop the workflow
 * might create.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"

const README_PATH = "README.md"
const TOOLS_DIR = "tools"
const SEED_DIR = "seed"
const REMOVED_DIR = "removed"

const STATS_START = "<!-- AUTOGEN:STATS"
const STATS_END = "<!-- /AUTOGEN:STATS -->"
const CATALOG_START = "<!-- AUTOGEN:CATALOG"
const CATALOG_END = "<!-- /AUTOGEN:CATALOG -->"

const CATEGORY_LABELS = {
  "image-generation": "Image generation",
  "video-generation": "Video generation",
  "text-generation": "Text & chat",
  "audio-generation": "Audio & music",
  "prompt-tools": "Prompt tools",
  agents: "Agents",
  chatbots: "Chatbots",
  "code-assist": "Code assist",
  productivity: "Productivity",
  "data-analysis": "Data analysis",
  "voice-cloning": "Voice",
  other: "Other",
}
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS)

function listYaml(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") && !f.startsWith("_") && !f.startsWith("."))
      .map((f) => ({ name: f, slug: f.replace(/\.yaml$/, ""), path: join(dir, f) }))
  } catch {
    return []
  }
}

function loadDir(dir, source) {
  return listYaml(dir).map((f) => {
    const data = parseYaml(readFileSync(f.path, "utf8"))
    return { ...data, slug: f.slug, source }
  })
}

function isVerifiedThisWeek(tool) {
  const t = tool.verification?.last_passed_at
  if (!t) return false
  const ms = Date.parse(t)
  if (isNaN(ms)) return false
  return Date.now() - ms <= 7 * 24 * 60 * 60 * 1000
}

function renderStats(active, removed) {
  const verified = active.filter((t) => t.verification?.status === "verified").length
  const seed = active.filter((t) => t.seeded).length
  const pending = active.filter((t) => t.verification?.status === "pending").length
  const verifiedThisWeek = active.filter(isVerifiedThisWeek).length

  const lines = [
    `**${active.length} tool${active.length === 1 ? "" : "s"} listed** &middot;` +
      ` ${verified} badge-verified &middot;` +
      ` ${seed} seed entries &middot;` +
      ` ${pending} pending &middot;` +
      ` ${removed.length} removed lifetime`,
  ]
  if (verifiedThisWeek > 0) {
    lines.push("")
    lines.push(`*${verifiedThisWeek} newly badge-verified in the last 7 days.*`)
  }
  return lines.join("\n")
}

function escapeMd(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function renderCatalog(active) {
  const byCat = new Map()
  for (const cat of CATEGORY_ORDER) byCat.set(cat, [])
  for (const t of active) {
    if (!byCat.has(t.category)) byCat.set(t.category, [])
    byCat.get(t.category).push(t)
  }

  const lines = ["## Currently in the directory", ""]
  lines.push(
    `Auto-generated, sorted alphabetically within each category. Each link goes to the tool's page on the directory site, where you'll also find its current verification status.`
  )
  lines.push("")

  for (const cat of CATEGORY_ORDER) {
    const items = byCat.get(cat) ?? []
    if (items.length === 0) continue
    items.sort((a, b) => a.name.localeCompare(b.name))
    lines.push(`### ${CATEGORY_LABELS[cat]} (${items.length})`)
    lines.push("")
    for (const t of items) {
      const desc = escapeMd(t.description)
      lines.push(`- [${escapeMd(t.name)}](https://promptfrenzy.com/directory/${t.slug}) &mdash; ${desc}`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd() + "\n"
}

function replaceRegion(text, startMarker, endMarker, body) {
  const sIdx = text.indexOf(startMarker)
  if (sIdx === -1) {
    throw new Error(`marker not found: ${startMarker}`)
  }
  const sLineEnd = text.indexOf("\n", sIdx)
  const eIdx = text.indexOf(endMarker)
  if (eIdx === -1) {
    throw new Error(`marker not found: ${endMarker}`)
  }
  return text.slice(0, sLineEnd + 1) + body + "\n" + text.slice(eIdx)
}

function main() {
  const active = [...loadDir(TOOLS_DIR, "tools"), ...loadDir(SEED_DIR, "seed")].filter(
    (t) => t.verification?.status !== "removed"
  )
  active.sort((a, b) => a.name.localeCompare(b.name))
  const removed = loadDir(REMOVED_DIR, "removed")

  const current = readFileSync(README_PATH, "utf8")
  let next = current
  next = replaceRegion(next, STATS_START, STATS_END, "\n" + renderStats(active, removed))
  next = replaceRegion(next, CATALOG_START, CATALOG_END, "\n" + renderCatalog(active))

  if (next === current) {
    console.log("README unchanged. exit 0.")
    return
  }
  writeFileSync(README_PATH, next)
  console.log(
    `regenerated README: ${active.length} active, ${removed.length} removed, ` +
      `${next.length - current.length} byte delta`
  )
}

main()
