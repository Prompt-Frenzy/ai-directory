#!/usr/bin/env node
// Applies the rules in review-rules.mjs to what outside contributors send:
// fork PRs that add or correct a listing, and issues. Run by
// .github/workflows/review-submissions.yml from a checkout of MAIN.
//
// SECURITY: contributor content is fetched through the GitHub API and parsed as
// YAML data. It is never checked out, installed or executed. The workflow has
// secrets (pull_request_target), so keep it that way.
//
// Usage:
//   node scripts/review-submissions.mjs pr <n> [--dry-run]
//   node scripts/review-submissions.mjs issue <n> [--dry-run]
//   node scripts/review-submissions.mjs sweep [--dry-run]
//   node scripts/review-submissions.mjs event        # GITHUB_EVENT_NAME / GITHUB_EVENT_PATH
//
// Env:
//   GITHUB_REPOSITORY  default Prompt-Frenzy/ai-directory
//   GH_TOKEN           comments, labels, closing (the workflow's GITHUB_TOKEN)
//   WRITE_TOKEN        commits to main (DIRECTORY_BOT_PAT: a PAT push triggers update-readme)
//   REVIEW_REF         git ref to read listings from (default HEAD; replays pin a past main)

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { apexHost, verifyData } from "./badge-check.mjs"
import {
  LABELS,
  MARKER,
  SLUG_RE,
  STALE_DAYS,
  classifyPrFiles,
  finalizeEntry,
  renderIssueReply,
  renderPrComment,
  renderStaleComment,
  reviewCorrection,
  reviewNewListing,
  triageIssue,
} from "./review-rules.mjs"

const API = "https://api.github.com"
const REPO = process.env.GITHUB_REPOSITORY || "Prompt-Frenzy/ai-directory"
const REF = process.env.REVIEW_REF || "HEAD"
const args = process.argv.slice(2)
let DRY = args.includes("--dry-run") || process.env.REVIEW_DRY_RUN === "1"

// ---------------------------------------------------------------------------
// GitHub

async function gh(method, path, { body, token = process.env.GH_TOKEN, allow = [] } = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pf-directory-review",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok && !allow.includes(res.status)) {
    throw new Error(`${method} ${path.replace(API, "")}: ${res.status} ${text.slice(0, 300)}`)
  }
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, data }
}

async function paginate(path) {
  const out = []
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes("?") ? "&" : "?"
    const { data } = await gh("GET", `${path}${sep}per_page=100&page=${page}`)
    out.push(...data)
    if (data.length < 100) break
  }
  return out
}

/** Every write goes through here so --dry-run is one switch. */
async function write(description, fn) {
  if (DRY) {
    console.log(`  [dry-run] would ${description}`)
    return null
  }
  console.log(`  ${description}`)
  return fn()
}

const decode = (b64) => Buffer.from(b64, "base64").toString("utf8")

async function fileAt(contentsUrl) {
  const { status, data } = await gh("GET", contentsUrl, { allow: [404] })
  return status === 404 ? null : decode(data.content)
}

const permissionCache = new Map()
async function isMaintainer(login) {
  if (!permissionCache.has(login)) {
    const { status, data } = await gh("GET", `/repos/${REPO}/collaborators/${login}/permission`, { allow: [403, 404] })
    permissionCache.set(login, status === 200 && ["admin", "maintain", "write"].includes(data.permission))
  }
  return permissionCache.get(login)
}

const ensured = new Set()
async function label(n, name) {
  if (!ensured.has(name)) {
    ensured.add(name)
    await write(`ensure label ${name}`, () => gh("POST", `/repos/${REPO}/labels`, { body: { name, color: "c5def5" }, allow: [422] }))
  }
  await write(`label #${n} ${name}`, () => gh("POST", `/repos/${REPO}/issues/${n}/labels`, { body: { labels: [name] } }))
}

async function unlabel(n, name, current) {
  if (!current.includes(name)) return
  await write(`unlabel #${n} ${name}`, () => gh("DELETE", `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent(name)}`, { allow: [404] }))
}

/** One bot comment per thread: edit ours if it exists, otherwise post. */
async function upsertComment(n, body) {
  const comments = await paginate(`/repos/${REPO}/issues/${n}/comments`)
  const ours = comments.find((c) => typeof c.body === "string" && c.body.includes(MARKER))
  if (DRY) console.log(`  --- comment for #${n} ---\n${body.split("\n").map((l) => `  | ${l}`).join("\n")}`)
  if (ours) {
    if (ours.body === body) return
    await write(`edit comment on #${n}`, () => gh("PATCH", `/repos/${REPO}/issues/comments/${ours.id}`, { body: { body } }))
  } else {
    await write(`comment on #${n}`, () => gh("POST", `/repos/${REPO}/issues/${n}/comments`, { body: { body } }))
  }
}

async function hasOurComment(n) {
  const comments = await paginate(`/repos/${REPO}/issues/${n}/comments`)
  return comments.some((c) => typeof c.body === "string" && c.body.includes(MARKER))
}

// ---------------------------------------------------------------------------
// The directory as of REF (main in production)

function git(...a) {
  return execFileSync("git", a, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
}

function gitShow(path) {
  try {
    return git("show", `${REF}:${path}`)
  } catch {
    return null
  }
}

function loadDir(dir) {
  let names = []
  try {
    names = git("ls-tree", "--name-only", `${REF}:${dir}`).split("\n")
  } catch {
    return []
  }
  return names
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .map((f) => {
      const slug = f.replace(/\.yaml$/, "")
      try {
        const d = parseYaml(gitShow(`${dir}/${f}`)) || {}
        return { slug, source: dir, url: d.url, name: d.name, status: d.verification?.status, removal_reason: d.verification?.removal_reason }
      } catch {
        return { slug, source: dir }
      }
    })
}

function loadDirectory() {
  return { listings: [...loadDir("tools"), ...loadDir("seed")], removed: loadDir("removed") }
}

const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8"))

// ---------------------------------------------------------------------------
// PRs

async function reject(n, reasons, labels) {
  await upsertComment(n, renderPrComment({ outcome: "rejected", reasons }))
  await label(n, LABELS.needsChanges)
  await unlabel(n, LABELS.needsMaintainer, labels)
  return { outcome: "rejected", reasons }
}

export async function reviewPr(n) {
  console.log(`PR #${n}`)
  const { data: pr } = await gh("GET", `/repos/${REPO}/pulls/${n}`)
  const labels = (pr.labels || []).map((l) => l.name)
  if (pr.state !== "open" && !DRY) return skip("not open")
  if (pr.head?.repo?.full_name === REPO) return skip("same-repo branch; verify-badges handles it")
  if (pr.user?.type === "Bot") return skip("bot author")
  if (await isMaintainer(pr.user.login)) return skip("maintainer PR")

  const files = await paginate(`/repos/${REPO}/pulls/${n}/files`)
  const cls = classifyPrFiles(files)
  console.log(`  kind: ${cls.kind}`)
  if (cls.kind === "no-listing") {
    // guide-manual-submissions already posts the how-to; we only start the stale clock.
    await label(n, LABELS.needsChanges)
    return { outcome: "no-listing" }
  }
  if (cls.kind === "invalid") return reject(n, cls.reasons, labels)
  if (cls.kind === "needs-maintainer") {
    await upsertComment(n, renderPrComment({ outcome: "needs-maintainer", reasons: cls.reasons }))
    await label(n, LABELS.needsMaintainer)
    return { outcome: "needs-maintainer" }
  }

  const { slug } = cls.file
  if (!SLUG_RE.test(slug)) {
    return reject(n, ["the file name must be lowercase letters, digits and hyphens, like `tools/my-tool.yaml`"], labels)
  }
  const headText = await fileAt(cls.file.contents_url)
  let head
  try {
    head = parseYaml(headText)
  } catch (e) {
    return reject(n, [`the YAML doesn't parse (${String(e.message).split("\n")[0]})`], labels)
  }

  let review
  let input
  if (cls.kind === "new-listing") {
    review = reviewNewListing({ slug, data: head, schema, listings: loadDirectory().listings })
    input = head
  } else {
    const baseText = await fileAt(`/repos/${REPO}/contents/tools/${slug}.yaml?ref=${pr.base.sha}`)
    const currentText = gitShow(`tools/${slug}.yaml`)
    review = reviewCorrection({
      base: baseText ? parseYaml(baseText) : null,
      head,
      current: currentText ? parseYaml(currentText) : null,
      schema,
    })
    input = review.merged
  }
  if (review.ok) {
    // Same oracle as the nightly verifier: static HTML, no JavaScript, apex-host guard.
    const badge = await verifyData(input)
    console.log(`  badge: ${badge.ok ? "verified" : badge.reason}`)
    if (!badge.ok) review = { ...review, ok: false, reasons: [`badge check failed: ${badge.reason}`] }
  }
  if (!review.ok) {
    console.log(`  rejected: ${review.reasons.join(" | ")}`)
    return reject(n, review.reasons, labels)
  }

  const { data: final, notes } = finalizeEntry(input, { kind: cls.kind, now: new Date().toISOString() })
  const yamlText = stringifyYaml(final, { lineWidth: 100 })
  const path = `tools/${slug}.yaml`
  if (DRY) console.log(`  --- would write ${path} ---\n${yamlText.split("\n").map((l) => `  | ${l}`).join("\n")}`)

  const writeToken = process.env.WRITE_TOKEN
  const existing = DRY
    ? { status: cls.kind === "new-listing" ? 404 : 200, data: { sha: "dry-run" } }
    : await gh("GET", `/repos/${REPO}/contents/${path}?ref=main`, { token: writeToken, allow: [404] })
  if (cls.kind === "new-listing" && existing.status !== 404) {
    return reject(n, [`\`${slug}\` was taken on main while this PR was being checked; rename the file`], labels)
  }
  const verb = cls.kind === "new-listing" ? "submit" : "correct"
  const commit = await write(`commit ${path} to main`, () =>
    gh("PUT", `/repos/${REPO}/contents/${path}`, {
      token: writeToken,
      body: {
        message: `${verb}: ${slug} (from #${n} by ${pr.user.login})`,
        content: Buffer.from(yamlText, "utf8").toString("base64"),
        branch: "main",
        ...(existing.status === 200 ? { sha: existing.data.sha } : {}),
      },
    }),
  )
  const commitUrl = commit?.data?.commit?.html_url || "(dry run: no commit)"
  await upsertComment(
    n,
    renderPrComment({ outcome: "applied", kind: cls.kind, slug, host: apexHost(final.url), changed: review.changed || [], notes, commitUrl }),
  )
  await label(n, LABELS.applied)
  if (cls.kind === "correction") await label(n, LABELS.correction)
  await unlabel(n, LABELS.needsChanges, labels)
  await write(`close PR #${n}`, () => gh("PATCH", `/repos/${REPO}/pulls/${n}`, { body: { state: "closed" } }))
  return { outcome: "applied", kind: cls.kind, slug, changed: review.changed || [], notes }
}

function skip(why) {
  console.log(`  skipped: ${why}`)
  return { outcome: "skipped", why }
}

// ---------------------------------------------------------------------------
// Issues

export async function reviewIssue(n) {
  console.log(`Issue #${n}`)
  const { data: issue } = await gh("GET", `/repos/${REPO}/issues/${n}`)
  if (issue.pull_request) return skip("is a PR")
  if (issue.state !== "open" && !DRY) return skip("not open")
  if (issue.user?.type === "Bot") return skip("bot author")
  if (await isMaintainer(issue.user.login)) return skip("maintainer issue")
  if (!DRY && (await hasOurComment(n))) return skip("already answered")
  const { listings, removed } = loadDirectory()
  const t = triageIssue({ title: issue.title, body: issue.body, listings, removed })
  console.log(`  triage: ${t.action}${t.matches.length ? ` (${t.matches.map((m) => m.slug).join(", ")})` : ""}, close=${t.close}, label=${t.label}`)
  await upsertComment(n, renderIssueReply(t))
  if (t.label) await label(n, t.label)
  if (t.close) {
    const reason = t.action === "submit-guide" ? "not_planned" : "completed"
    await write(`close issue #${n} (${reason})`, () => gh("PATCH", `/repos/${REPO}/issues/${n}`, { body: { state: "closed", state_reason: reason } }))
  }
  return { outcome: t.action, close: t.close, label: t.label }
}

// ---------------------------------------------------------------------------
// Daily sweep: close stale PRs, and catch anything the event triggers missed
// (runs that failed, or PRs and issues opened before this workflow existed).

export async function sweep() {
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000
  for (const pr of await paginate(`/repos/${REPO}/pulls?state=open`)) {
    if (pr.head?.repo?.full_name === REPO || pr.user?.type === "Bot") continue
    if (await isMaintainer(pr.user.login)) continue
    const labels = pr.labels.map((l) => l.name)
    if (labels.includes(LABELS.needsMaintainer)) continue
    if (labels.includes(LABELS.needsChanges)) {
      if (Date.parse(pr.updated_at) < cutoff) {
        console.log(`PR #${pr.number}: stale since ${pr.updated_at}`)
        await upsertComment(pr.number, renderStaleComment())
        await write(`close stale PR #${pr.number}`, () => gh("PATCH", `/repos/${REPO}/pulls/${pr.number}`, { body: { state: "closed" } }))
      }
      continue
    }
    await guarded(() => reviewPr(pr.number))
  }
  for (const issue of await paginate(`/repos/${REPO}/issues?state=open`)) {
    if (issue.pull_request) continue
    if (issue.labels.some((l) => l.name === LABELS.needsMaintainer)) continue
    if (await hasOurComment(issue.number)) continue
    await guarded(() => reviewIssue(issue.number))
  }
}

async function guarded(fn) {
  try {
    return await fn()
  } catch (e) {
    // One bad thread must not stop the sweep; the run still fails at the end.
    console.error(`  ERROR: ${e.message}`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const [cmd, num] = args.filter((a) => !a.startsWith("--"))
  if (cmd === "pr") return reviewPr(Number(num))
  if (cmd === "issue") return reviewIssue(Number(num))
  if (cmd === "sweep") return sweep()
  if (cmd === "event") {
    const name = process.env.GITHUB_EVENT_NAME
    const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
    if (name === "pull_request_target") return reviewPr(payload.pull_request.number)
    if (name === "issues") return reviewIssue(payload.issue.number)
    if (name === "schedule") return sweep()
    if (name === "workflow_dispatch") {
      DRY = process.env.INPUT_DRY_RUN !== "false"
      const target = process.env.INPUT_TARGET || "sweep"
      if (target === "sweep") return sweep()
      const n = Number(process.env.INPUT_NUMBER)
      if (!n) throw new Error("workflow_dispatch: `number` is required for pr/issue")
      return target === "pr" ? reviewPr(n) : reviewIssue(n)
    }
    throw new Error(`unhandled event ${name}`)
  }
  console.error("usage: review-submissions.mjs pr <n> | issue <n> | sweep | event [--dry-run]")
  process.exit(2)
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())
if (isEntry) {
  main()
    .then((r) => r && console.log(`result: ${JSON.stringify(r)}`))
    .catch((e) => {
      console.error(`review-submissions failed: ${e.message}`)
      process.exit(1)
    })
}
