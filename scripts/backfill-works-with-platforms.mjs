#!/usr/bin/env node
/**
 * One-shot backfill (PRO-1340): add accurate `works_with` + `platforms` to the
 * editorial seed tools so the integration + platform rollup pages (PRO-1338)
 * cross MIN_ROLLUP_INDEX and go live. Real integrations only — no guessing.
 *
 * Idempotent: skips a file that already has either field. Appends the two
 * top-level keys at the end (YAML is order-independent) for a minimal diff.
 *
 *   node scripts/backfill-works-with-platforms.mjs [--dry]
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"

const SEED_DIR = "seed"
const DRY = process.argv.includes("--dry")

// slug -> { works_with, platforms }. Lowercase, consistent tokens so they group.
const ENRICH = {
  "adobe-firefly": { works_with: ["photoshop", "illustrator", "adobe express", "lightroom"], platforms: ["web", "api"] },
  "bolt-new": { works_with: ["github", "netlify", "supabase", "stripe"], platforms: ["web"] },
  "character-ai": { works_with: [], platforms: ["web", "ios", "android"] },
  "chatgpt": { works_with: ["dall-e", "python"], platforms: ["web", "ios", "android"] },
  "claude": { works_with: ["mcp", "python"], platforms: ["web", "ios", "android", "api"] },
  "codeium": { works_with: ["vs code", "jetbrains", "neovim"], platforms: ["windows", "macos", "linux"] },
  "cursor": { works_with: ["vs code", "github", "claude", "gpt-4"], platforms: ["macos", "windows", "linux"] },
  "dall-e": { works_with: ["chatgpt", "python"], platforms: ["web", "api"] },
  "descript": { works_with: ["zoom", "youtube", "premiere pro"], platforms: ["web", "macos", "windows"] },
  "devin": { works_with: ["github", "slack"], platforms: ["web", "slack"] },
  "elevenlabs": { works_with: ["python"], platforms: ["web", "api"] },
  "fireflies": { works_with: ["zoom", "google meet", "microsoft teams", "slack", "notion", "salesforce"], platforms: ["web", "ios", "android"] },
  "flowgpt": { works_with: ["chatgpt", "claude", "gpt-4"], platforms: ["web"] },
  "flux": { works_with: ["comfyui", "replicate", "hugging face"], platforms: ["api"] },
  "gamma": { works_with: ["powerpoint", "pdf", "notion"], platforms: ["web"] },
  "gemini": { works_with: ["google workspace", "google docs", "gmail"], platforms: ["web", "ios", "android", "api"] },
  "github-copilot": { works_with: ["vs code", "github", "jetbrains", "neovim"], platforms: ["web"] },
  "google-veo": { works_with: ["gemini", "vertex ai"], platforms: ["web", "api"] },
  "granola": { works_with: ["zoom", "google meet", "microsoft teams", "notion", "slack"], platforms: ["macos"] },
  "hailuo": { works_with: [], platforms: ["web", "api"] },
  "hex": { works_with: ["snowflake", "bigquery", "python", "sql", "dbt"], platforms: ["web"] },
  "hugging-face": { works_with: ["python", "pytorch", "transformers"], platforms: ["web", "api"] },
  "ideogram": { works_with: [], platforms: ["web", "ios", "api"] },
  "julius": { works_with: ["excel", "google sheets", "python"], platforms: ["web"] },
  "kling": { works_with: [], platforms: ["web", "api"] },
  "krea": { works_with: ["flux", "stable diffusion"], platforms: ["web"] },
  "leonardo-ai": { works_with: [], platforms: ["web", "ios", "api"] },
  "luma-dream-machine": { works_with: [], platforms: ["web", "ios", "api"] },
  "meta-ai": { works_with: ["instagram", "whatsapp", "facebook", "messenger"], platforms: ["web", "ios", "android"] },
  "midjourney": { works_with: [], platforms: ["web", "discord"] },
  "mistral-le-chat": { works_with: [], platforms: ["web", "ios", "android", "api"] },
  "notion-ai": { works_with: ["slack", "google drive"], platforms: ["web", "ios", "android"] },
  "openai-operator": { works_with: ["chatgpt"], platforms: ["web"] },
  "perplexity": { works_with: [], platforms: ["web", "ios", "android"] },
  "pi": { works_with: [], platforms: ["web", "ios", "android"] },
  "pika": { works_with: [], platforms: ["web", "discord"] },
  "playground": { works_with: ["stable diffusion"], platforms: ["web"] },
  "promptbase": { works_with: ["chatgpt", "midjourney", "stable diffusion", "dall-e"], platforms: ["web"] },
  "promptfrenzy": { works_with: ["chatgpt", "midjourney"], platforms: ["web"] },
  "prompthero": { works_with: ["midjourney", "stable diffusion", "chatgpt"], platforms: ["web"] },
  "promptperfect": { works_with: ["chatgpt", "midjourney", "claude"], platforms: ["web", "api"] },
  "recraft": { works_with: ["figma"], platforms: ["web", "api"] },
  "replika": { works_with: [], platforms: ["web", "ios", "android"] },
  "replit-agent": { works_with: ["github", "replit"], platforms: ["web", "ios"] },
  "runway": { works_with: [], platforms: ["web", "ios", "api"] },
  "sora": { works_with: ["chatgpt"], platforms: ["web"] },
  "stable-audio": { works_with: [], platforms: ["web", "api"] },
  "stable-diffusion": { works_with: ["comfyui", "automatic1111", "hugging face"], platforms: ["api", "self-hosted"] },
  "suno": { works_with: [], platforms: ["web", "ios"] },
  "udio": { works_with: [], platforms: ["web", "ios"] },
}

function yamlList(key, items) {
  if (!items || items.length === 0) return ""
  return `${key}:\n` + items.map((i) => `  - ${i}`).join("\n") + "\n"
}

let changed = 0
let skipped = 0
const files = readdirSync(SEED_DIR).filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
for (const f of files) {
  const slug = f.replace(/\.yaml$/, "")
  const enrich = ENRICH[slug]
  if (!enrich) {
    console.log(`  ? no enrichment data for ${slug} — skipping`)
    skipped++
    continue
  }
  const path = join(SEED_DIR, f)
  const raw = readFileSync(path, "utf8")
  const data = parseYaml(raw)
  if ("works_with" in data || "platforms" in data) {
    console.log(`  = ${slug} already enriched — skipping`)
    skipped++
    continue
  }
  let block = ""
  block += yamlList("works_with", enrich.works_with)
  block += yamlList("platforms", enrich.platforms)
  if (!block) {
    console.log(`  - ${slug}: nothing to add`)
    continue
  }
  const next = (raw.endsWith("\n") ? raw : raw + "\n") + block
  if (!DRY) writeFileSync(path, next)
  console.log(
    `  + ${slug}: works_with=[${enrich.works_with.join(", ")}] platforms=[${enrich.platforms.join(", ")}]`
  )
  changed++
}
console.log(`\n${DRY ? "(dry) " : ""}done — ${changed} enriched, ${skipped} skipped.`)
