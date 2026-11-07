// Decision rules for what outside contributors send us: fork PRs that add or
// correct a listing, and GitHub issues. Pure functions, no network and no
// GitHub calls, so every rule is covered by review-rules.test.mjs. All I/O
// lives in review-submissions.mjs.
//
// Why this exists (07/11/2026): in one month, three verified fork listings sat
// unmerged because fork PRs get a read-only token, two maker corrections sat
// for weeks, and two issues went unanswered for a month. The API path merges
// itself in ~20s; everything else waited for a human.
//
// Policy (Robin, 07/11/2026): new listings AND maker corrections that pass these
// checks plus a live badge check are applied automatically. Corrections get the
// `auto-merged-correction` label so a weekly sweep can eyeball them and revert
// vandalism. A live badge proves who owns the WEBSITE, not who opened the PR.
// Removals and anything unusual go to a maintainer.

import Ajv from "ajv"
import addFormats from "ajv-formats"
import { apexHost, updateVerificationBlock } from "./badge-check.mjs"

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/
const TOOL_PATH_RE = /^tools\/([^/]+)\.yaml$/

// Fields the bot owns. A contributor PR may not set or change them.
const BOT_FIELDS = ["verification", "submitted_at", "seeded"]

export const LABELS = {
  needsChanges: "needs-changes",
  needsMaintainer: "needs-maintainer",
  applied: "applied",
  correction: "auto-merged-correction",
}

export const STALE_DAYS = 14

// ---------------------------------------------------------------------------
// PR shape

/**
 * files: GitHub's pulls/{n}/files entries ({ filename, status }).
 * Returns { kind, file?, reasons }:
 *   new-listing | correction   → one tools/<slug>.yaml added / modified, nothing else
 *   no-listing                 → nothing under tools/ (README-only etc.)
 *   invalid                    → wrong shape, contributor can fix
 *   needs-maintainer           → deletes or renames a listing
 */
export function classifyPrFiles(files) {
  const tool = []
  const other = []
  for (const f of files) {
    const m = TOOL_PATH_RE.exec(f.filename)
    if (m && !m[1].startsWith("_")) tool.push({ ...f, slug: m[1] })
    else other.push(f)
  }
  if (tool.length === 0) {
    return {
      kind: "no-listing",
      reasons: ["this PR doesn't add or change a `tools/<slug>.yaml` listing file"],
    }
  }
  const removing = tool.filter((f) => f.status === "removed" || f.status === "renamed")
  if (removing.length > 0) {
    return {
      kind: "needs-maintainer",
      file: removing[0],
      reasons: ["removing or renaming a listing is done by a maintainer"],
    }
  }
  if (other.length > 0) {
    return {
      kind: "invalid",
      reasons: [
        `only the listing file may change; this PR also changes ${other
          .map((f) => `\`${f.filename}\``)
          .join(", ")} (the README catalog is regenerated automatically)`,
      ],
    }
  }
  if (tool.length > 1) {
    return { kind: "invalid", reasons: ["one listing per PR, please"] }
  }
  const file = tool[0]
  if (file.status === "added") return { kind: "new-listing", file, reasons: [] }
  if (file.status === "modified") return { kind: "correction", file, reasons: [] }
  return {
    kind: "needs-maintainer",
    file,
    reasons: [`unexpected file status \`${file.status}\``],
  }
}

// ---------------------------------------------------------------------------
// Content checks

const validators = new WeakMap()

export function schemaErrors(data, schema) {
  let validate = validators.get(schema)
  if (!validate) {
    const ajv = new Ajv({ allErrors: true, strict: false })
    addFormats(ajv)
    validate = ajv.compile(schema)
    validators.set(schema, validate)
  }
  if (validate(data)) return []
  return validate.errors.map((e) => {
    const where = e.instancePath ? `\`${e.instancePath.slice(1).replace(/\//g, ".")}\`` : "the entry"
    const extra = e.params?.additionalProperty ? ` (\`${e.params.additionalProperty}\`)` : ""
    const allowed = e.params?.allowedValues ? `: ${e.params.allowedValues.join(", ")}` : ""
    return `${where} ${e.message}${extra}${allowed}`
  })
}

const TRACKING_PARAM_RE = /^(utm_[a-z0-9_]+|ref|ref_src|source|fbclid|gclid|mc_cid|mc_eid)$/i

/** Remove tracking parameters from a URL; returns the input unchanged if none. */
export function stripTracking(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return url
  }
  let changed = false
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM_RE.test(key)) {
      u.searchParams.delete(key)
      changed = true
    }
  }
  return changed ? u.toString() : url
}

function safeApex(url) {
  try {
    return apexHost(url)
  } catch {
    return null
  }
}

function sameJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * New listing from a fork PR. `listings` = every entry currently in tools/ and
 * seed/ ({ slug, url, source }). The live badge check runs separately.
 */
export function reviewNewListing({ slug, data, schema, listings }) {
  const reasons = []
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reasons: ["the file isn't a YAML mapping"] }
  }
  if (!SLUG_RE.test(slug)) {
    reasons.push(`the file name \`${slug}\` must be lowercase letters, digits and hyphens`)
  }
  reasons.push(...schemaErrors(data, schema))
  for (const field of BOT_FIELDS) {
    if (data[field] !== undefined) reasons.push(`\`${field}\` is written by the bot; please remove it`)
  }
  const sameSlug = listings.find((l) => l.slug === slug)
  if (sameSlug) reasons.push(`\`${slug}\` is already taken in ${sameSlug.source}/`)
  const host = safeApex(data.url)
  if (host) {
    const dup = listings.find((l) => l.slug !== slug && safeApex(l.url) === host)
    if (dup) {
      reasons.push(
        `${host} is already listed as \`${dup.slug}\`; edit \`${dup.source}/${dup.slug}.yaml\` instead of adding a second entry`,
      )
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * Maker correction to an existing listing. `base` = the file as the PR started
 * from it, `head` = the PR's version, `current` = main today (may have moved on
 * because the nightly check rewrites the verification block). Returns the
 * fields the contributor changed, to be applied on top of `current`.
 */
export function reviewCorrection({ base, head, current, schema }) {
  const reasons = []
  if (!head || typeof head !== "object" || Array.isArray(head)) {
    return { ok: false, reasons: ["the file isn't a YAML mapping"], changed: [] }
  }
  if (!current) {
    return { ok: false, reasons: ["this listing no longer exists on main"], changed: [] }
  }
  if (current.seeded) {
    return { ok: false, reasons: ["seed entries are maintained by us"], changed: [] }
  }
  for (const field of BOT_FIELDS) {
    if (!sameJson(head[field], base?.[field])) {
      reasons.push(`\`${field}\` is written by the bot; please leave it unchanged`)
    }
  }
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(head)])
  const changed = [...keys].filter((k) => !BOT_FIELDS.includes(k) && !sameJson(head[k], base?.[k])).sort()
  if (changed.length === 0 && reasons.length === 0) {
    reasons.push("nothing changed in the listing")
  }
  const merged = applyCorrection(current, head, changed)
  reasons.push(...schemaErrors(merged, schema))
  const wasHost = safeApex(current.url)
  if (safeApex(merged.url) !== wasHost) {
    reasons.push(`\`url\` must stay on ${wasHost}; a different site is a new listing`)
  }
  if (current.badge_url && safeApex(merged.badge_url) !== safeApex(current.badge_url)) {
    reasons.push(`\`badge_url\` must stay on ${safeApex(current.badge_url)}`)
  }
  return { ok: reasons.length === 0, reasons, changed, merged }
}

/** current + the contributor's changed fields (a field they deleted is deleted). */
export function applyCorrection(current, head, changed) {
  const out = { ...current }
  for (const k of changed) {
    if (head[k] === undefined) delete out[k]
    else out[k] = head[k]
  }
  return out
}

/**
 * What actually lands on main. Strips tracking params; a new listing gets the
 * same verification block and submitted_at the API path writes, so it is not
 * left "pending" until the weekly all-active check.
 */
export function finalizeEntry(data, { kind, now }) {
  const out = { ...data }
  const notes = []
  const clean = stripTracking(out.url)
  if (clean !== out.url) {
    out.url = clean
    notes.push("removed tracking parameters from `url`")
  }
  if (kind === "new-listing") {
    if (!out.submitted_at) out.submitted_at = now
    Object.assign(out, updateVerificationBlock({}, { ok: true }, now))
  }
  return { data: out, notes }
}

// ---------------------------------------------------------------------------
// Issues

const MAINTAINER_RE =
  /\b(remov(e|al|ed)|delet(e|ed|ion)|delist|unlist|take[\s-]?down|opt[\s-]?out|bugs?|errors?|broken|not working|doesn'?t work|crash\w*|5\d\d|spam|abuse|scam|copyright|dmca|trademark|legal|security|vulnerab\w*|privacy|gdpr)\b/i
const ADD_RE = /\b(add|adding|list|listed|listing|submit\w*|include|feature|directory)\b/i
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+/gi
const BARE_HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b/gi
// Hosts that are never the subject of a listing request, and "domains" that are
// really file names.
const IGNORE_HOSTS = new Set([
  "promptfrenzy.com",
  "github.com",
  "raw.githubusercontent.com",
  "githubusercontent.com",
  "shields.io",
  "img.shields.io",
])
const FILE_TLDS = new Set(["md", "yaml", "yml", "json", "js", "mjs", "ts", "tsx", "png", "jpg", "jpeg", "gif", "svg", "html", "txt", "css"])

export function extractHosts(text) {
  const hosts = new Set()
  const add = (h) => {
    const host = h.toLowerCase().replace(/^www\./, "").replace(/\.+$/, "")
    const tld = host.split(".").pop()
    if (FILE_TLDS.has(tld)) return
    if (IGNORE_HOSTS.has(host) || [...IGNORE_HOSTS].some((i) => host.endsWith(`.${i}`))) return
    hosts.add(host)
  }
  for (const m of text.matchAll(URL_RE)) {
    const host = safeApex(m[0].replace(/[.,;:!?]+$/, ""))
    if (host) add(host)
  }
  const withoutUrls = text.replace(URL_RE, " ")
  for (const m of withoutUrls.matchAll(BARE_HOST_RE)) add(m[0])
  return [...hosts]
}

/**
 * listings: tools/ + seed/ entries ({ slug, url, source, status });
 * removed: removed/ entries ({ slug, url, removal_reason }).
 * Returns { action, close, label, matches }.
 */
export function triageIssue({ title, body, listings, removed }) {
  const text = `${title || ""}\n${body || ""}`
  const hosts = new Set(extractHosts(text))
  const hit = (l) => hosts.has(safeApex(l.url))
  const listed = listings.filter(hit)
  const gone = removed.filter(hit)
  const wantsMaintainer = MAINTAINER_RE.test(text)
  const flag = wantsMaintainer ? LABELS.needsMaintainer : null
  if (listed.length > 0) {
    return { action: "already-listed", close: !wantsMaintainer, label: flag, matches: listed }
  }
  if (gone.length > 0) {
    return { action: "removed-listing", close: !wantsMaintainer, label: flag, matches: gone }
  }
  if (hosts.size > 0 && ADD_RE.test(text) && !wantsMaintainer) {
    return { action: "submit-guide", close: true, label: null, matches: [] }
  }
  return { action: "needs-maintainer", close: false, label: LABELS.needsMaintainer, matches: [] }
}

// ---------------------------------------------------------------------------
// Messages. Every bot comment carries MARKER so reruns edit instead of repeat.

export const MARKER = "<!-- pf-directory:review -->"
// Reasons and names echo contributor-controlled text (field names, listing
// names). A bare @handle in a bot comment would ping a real account.
export const neutralize = (s) => String(s).replace(/@/g, "@​")
const SITE = "https://www.promptfrenzy.com"
const SUBMIT = `${SITE}/directory/submit`

const STATUS_WORDS = {
  verified: "badge-verified and live",
  pending: "listed; its badge check is pending and re-runs automatically",
  failed:
    "listed but marked **failed** because the badge wasn't found on your site. Put the badge back and the next check (daily for new entries, weekly for all) reinstates it",
}

export function renderPrComment(result) {
  const lines = [MARKER]
  if (result.outcome === "applied") {
    const what =
      result.kind === "correction"
        ? `Your badge is still live and the listing stays on ${result.host}, so your correction is applied (${result.changed.map((c) => `\`${neutralize(c)}\``).join(", ")}).`
        : "Badge verified, so the listing is applied."
    lines.push(`✅ ${what} It's live at ${SITE}/directory/${result.slug} within about 10 minutes.`)
    for (const n of result.notes || []) lines.push(`\nNote: we ${neutralize(n)}.`)
    lines.push(`\nApplied in ${result.commitUrl}. Closing this PR; thanks!`)
    return lines.join("\n")
  }
  if (result.outcome === "needs-maintainer") {
    lines.push(`Thanks! ${result.reasons.map(neutralize).join(" ")}. A maintainer looks at these weekly.`)
    return lines.join("\n")
  }
  lines.push("Thanks for the PR. It can't be applied automatically yet:\n")
  for (const r of result.reasons) lines.push(`- ${neutralize(r)}`)
  lines.push(
    `\nPush a fix to this branch and it's re-checked automatically. For a new listing, the quickest route is the form or one API call at ${SUBMIT} (merged in under a minute). PRs that still can't be applied after ${STALE_DAYS} days are closed.`,
  )
  return lines.join("\n")
}

export function renderStaleComment() {
  return [
    MARKER,
    `Closing because this couldn't be applied automatically for ${STALE_DAYS} days. To get listed, use ${SUBMIT}; for a correction, open a new PR that changes only your \`tools/<slug>.yaml\`.`,
  ].join("\n")
}

export function renderIssueReply(triage) {
  const lines = [MARKER]
  const link = (m) => `${SITE}/directory/${m.slug}`
  if (triage.action === "already-listed") {
    for (const m of triage.matches) {
      lines.push(`**${neutralize(m.name || m.slug)}** is already in the directory: ${link(m)} (${STATUS_WORDS[m.status] || "listed"}).`)
    }
    lines.push(
      "\nIf you were trying to resubmit, there's no need: a \"slug already taken\" error from the API means the listing already exists. To change its details, open a PR that edits only that `tools/<slug>.yaml`; it's applied automatically if your badge is live.",
    )
  } else if (triage.action === "removed-listing") {
    for (const m of triage.matches) {
      lines.push(`**${neutralize(m.name || m.slug)}** was removed from the directory (reason: ${m.removal_reason || "not recorded"}).`)
    }
    lines.push(
      `\nTo come back, put the badge on your site and submit again at ${SUBMIT}. A removed entry doesn't block resubmission.`,
    )
  } else if (triage.action === "submit-guide") {
    lines.push(
      "Thanks! Every listing here is badge-verified, so we don't add entries from issues. To get listed:\n",
      `1. Add the PromptFrenzy badge to your site as a static link in the footer or on an About page. The snippet is at ${SUBMIT}. It has to be in the server-rendered HTML; the checker doesn't run JavaScript.`,
      `2. Submit with the form on that page, or one POST to ${SITE}/api/directory/submit (fields in this repo's README). The bot checks the badge and lists you itself, usually in under a minute.`,
      "\nClosing this; the submission flow is the quickest route in.",
    )
  } else {
    lines.push("Thanks, a maintainer will look at this. Flagged issues are reviewed weekly.")
  }
  if (triage.action !== "needs-maintainer" && triage.label === LABELS.needsMaintainer) {
    lines.push("\nIt sounds like you may also need something removed or fixed, so a maintainer will follow up here.")
  }
  return lines.join("\n")
}
