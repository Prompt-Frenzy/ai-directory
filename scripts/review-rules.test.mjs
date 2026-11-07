// Guards the outside-contributor rules. Cases are modelled on the real PRs and
// issues that sat unhandled in Oct–Nov 2026 (#70, #100, #102, #106, #114, #130,
// #133, #134), so a rule change that would have mishandled one of them fails here.
import { readFileSync } from "node:fs"
import {
  classifyPrFiles,
  reviewNewListing,
  reviewCorrection,
  finalizeEntry,
  stripTracking,
  extractHosts,
  triageIssue,
  renderIssueReply,
  renderPrComment,
  LABELS,
} from "./review-rules.mjs"

const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8"))

let failures = 0
let count = 0
function check(label, got, want) {
  count++
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) {
    failures++
    console.error(`✗ ${label}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`)
  }
}

const listings = [
  { slug: "relayshield", url: "https://relayshield.net", source: "tools", status: "verified", name: "RelayShield" },
  { slug: "kardly", url: "https://kardly.ai", source: "tools", status: "failed", name: "Kardly.ai" },
  { slug: "suno", url: "https://suno.com", source: "seed", status: undefined, name: "Suno" },
]
const removed = [{ slug: "tinydeskoutstanding", url: "https://tinydeskoutstanding.com", removal_reason: "editorial", name: "Tiny Desk Outstanding" }]

const newListing = {
  name: "AgentCraft",
  url: "https://agentcraft.dev",
  description: "Free library of AI image and video prompts, each shown next to the output it made.",
  category: "prompt-tools",
  pricing: "free",
  badge_url: "https://agentcraft.dev",
}

// --- classifyPrFiles --------------------------------------------------------
check("new listing (#133/#134 shape)", classifyPrFiles([{ filename: "tools/agentcraft.yaml", status: "added" }]).kind, "new-listing")
check("correction (#114/#130 shape)", classifyPrFiles([{ filename: "tools/x.yaml", status: "modified" }]).kind, "correction")
check("README-only (#70 shape)", classifyPrFiles([{ filename: "README.md", status: "modified" }]).kind, "no-listing")
check("listing + README edit is invalid", classifyPrFiles([{ filename: "tools/a.yaml", status: "added" }, { filename: "README.md", status: "modified" }]).kind, "invalid")
check("two listings is invalid", classifyPrFiles([{ filename: "tools/a.yaml", status: "added" }, { filename: "tools/b.yaml", status: "added" }]).kind, "invalid")
check("deleting a listing needs a maintainer", classifyPrFiles([{ filename: "tools/a.yaml", status: "removed" }]).kind, "needs-maintainer")
check("template file is not a listing", classifyPrFiles([{ filename: "tools/_example.yaml", status: "modified" }]).kind, "no-listing")
check("a script change is not a listing", classifyPrFiles([{ filename: "scripts/verify-badges.mjs", status: "modified" }]).kind, "no-listing")

// --- reviewNewListing -------------------------------------------------------
check("clean new listing passes", reviewNewListing({ slug: "agentcraft", data: newListing, schema, listings }), { ok: true, reasons: [] })
check(
  "bot-owned verification block is refused",
  reviewNewListing({ slug: "agentcraft", data: { ...newListing, verification: { status: "verified" } }, schema, listings }).reasons.some((r) => r.includes("`verification` is written by the bot")),
  true,
)
check(
  "same host as an existing listing is a duplicate (ReelForge case)",
  reviewNewListing({ slug: "relayshield-2", data: { ...newListing, url: "https://www.relayshield.net/app", badge_url: "https://relayshield.net" }, schema, listings }).reasons.some((r) => r.includes("already listed as `relayshield`")),
  true,
)
check("slug already taken", reviewNewListing({ slug: "suno", data: { ...newListing, url: "https://other.example" }, schema, listings }).reasons.some((r) => r.includes("already taken in seed/")), true)
check("schema enum is enforced", reviewNewListing({ slug: "agentcraft", data: { ...newListing, category: "not-a-real-category" }, schema, listings }).ok, false)
check("unknown field is refused", reviewNewListing({ slug: "agentcraft", data: { ...newListing, bogus: 1 }, schema, listings }).reasons.some((r) => r.includes("bogus")), true)
check("bad file name", reviewNewListing({ slug: "Agent_Craft", data: newListing, schema, listings }).ok, false)
check("non-mapping YAML", reviewNewListing({ slug: "x", data: "just a string", schema, listings }).ok, false)

// --- reviewCorrection -------------------------------------------------------
const verification = { status: "verified", first_verified_at: "2026-09-27T12:40:07.583Z", last_checked_at: "2026-10-01T00:00:00.000Z", last_passed_at: "2026-10-01T00:00:00.000Z", failure_count: 0, failure_reason: null }
const museBase = {
  name: "Muse Me",
  url: "https://muse-me-avatar-beta.zhangwei798879.chatgpt.site/",
  description: "Turn one authorized adult selfie into an original anime-style profile picture.",
  category: "image-generation",
  pricing: "free",
  badge_url: "https://muse-me-avatar-beta.zhangwei798879.chatgpt.site/brand",
  submitted_at: "2026-09-27T12:40:07.583Z",
  verification,
}
// main moved on after the PR was opened: the nightly check rewrote verification.
const museCurrent = { ...museBase, verification: { ...verification, last_checked_at: "2026-11-07T06:00:00.000Z", last_passed_at: "2026-11-07T06:00:00.000Z" } }
const museHead = {
  ...museBase,
  name: "Muse Studio",
  url: "https://muse-me-avatar-beta.zhangwei798879.chatgpt.site/create?utm_source=promptfrenzy&utm_campaign=ad_recovery",
  description: "Generates static ad concepts from text; edit headline, offer and CTA, then export PNG.",
}
const museReview = reviewCorrection({ base: museBase, head: museHead, current: museCurrent, schema })
check("Muse correction passes (#114)", museReview.ok, true)
check("Muse changed fields", museReview.changed, ["description", "name", "url"])
check("Muse keeps main's newer verification block", museReview.merged.verification, museCurrent.verification)
check(
  "correction that moves the listing to another site is refused",
  reviewCorrection({ base: museBase, head: { ...museHead, url: "https://evil.example" }, current: museCurrent, schema }).reasons.some((r) => r.includes("must stay on")),
  true,
)
check(
  "correction touching verification is refused",
  reviewCorrection({ base: museBase, head: { ...museHead, verification: { ...verification, status: "verified", failure_count: 0, first_verified_at: "2020-01-01T00:00:00.000Z" } }, current: museCurrent, schema }).reasons.some((r) => r.includes("`verification` is written by the bot")),
  true,
)
check("correction to a listing that no longer exists (#130 today)", reviewCorrection({ base: museBase, head: museHead, current: null, schema }).reasons, ["this listing no longer exists on main"])
check("empty correction", reviewCorrection({ base: museBase, head: museBase, current: museCurrent, schema }).reasons, ["nothing changed in the listing"])
check("seed entries can't be corrected by PR", reviewCorrection({ base: museBase, head: museHead, current: { ...museCurrent, seeded: true }, schema }).ok, false)
check(
  "deleting an optional field is applied as a deletion (#130 dropped works_with)",
  reviewCorrection({ base: { ...museBase, works_with: ["seedance"] }, head: museHead, current: { ...museCurrent, works_with: ["seedance"] }, schema }).merged.works_with,
  undefined,
)

// --- finalizeEntry / stripTracking -----------------------------------------
check("utm params stripped", stripTracking("https://x.com/create?utm_source=pf&utm_campaign=a&id=7"), "https://x.com/create?id=7")
check("source param stripped (#49 precedent)", stripTracking("https://x.com/?source=community"), "https://x.com/")
check("clean url untouched", stripTracking("https://x.com"), "https://x.com")
check("invalid url untouched", stripTracking("not a url"), "not a url")
const fin = finalizeEntry({ ...newListing, url: "https://agentcraft.dev/?utm_source=pf" }, { kind: "new-listing", now: "2026-11-08T00:00:00.000Z" })
check("new listing gets the API path's verification block", fin.data.verification, { last_checked_at: "2026-11-08T00:00:00.000Z", status: "verified", last_passed_at: "2026-11-08T00:00:00.000Z", first_verified_at: "2026-11-08T00:00:00.000Z", failure_count: 0, failure_reason: null })
check("new listing gets submitted_at", fin.data.submitted_at, "2026-11-08T00:00:00.000Z")
check("finalize strips tracking and says so", [fin.data.url, fin.notes], ["https://agentcraft.dev/", ["removed tracking parameters from `url`"]])
check("correction finalize leaves verification alone", finalizeEntry(museReview.merged, { kind: "correction", now: "x" }).data.verification, museCurrent.verification)

// --- issues -----------------------------------------------------------------
const issue106 = {
  title: 'Request to delete reserved slug "relayshield" from removed listing',
  body: "Our tool RelayShield (https://relayshield.net) was previously listed in the directory but the listing was removed because our badge was missing from the site. We've now added the badge to our footer. When we try to resubmit via the API, we get: slug already taken. Could you please delete the old reserved slug?",
}
const issue102 = {
  title: "Add FalcoScan (AI tool directory and market tracker)",
  body: "Hi, could you add FalcoScan to the list?\n- **URL:** https://falcoscan.com\nA directory and market tracker for 7,000+ AI products. Suggested line: `- [FalcoScan](https://falcoscan.com) - Find and compare AI tools`",
}
const t106 = triageIssue({ ...issue106, listings, removed })
check("#106 → already listed, flagged because it asks for a delete", [t106.action, t106.close, t106.label, t106.matches.map((m) => m.slug)], ["already-listed", false, LABELS.needsMaintainer, ["relayshield"]])
const t102 = triageIssue({ ...issue102, listings, removed })
check("#102 → submit guide, closed", [t102.action, t102.close, t102.label], ["submit-guide", true, null])
check("plain 'am I listed?' closes", triageIssue({ title: "Is kardly.ai listed?", body: "", listings, removed }).close, true)
check("removed listing explains how to come back", triageIssue({ title: "Where did my listing go?", body: "https://tinydeskoutstanding.com", listings, removed }).action, "removed-listing")
check("bug report with no host → maintainer", triageIssue({ title: "Submit API returns 500", body: "The form says non-JSON (500)", listings, removed }).action, "needs-maintainer")
check("bug report naming a new site stays open", triageIssue({ title: "Submit form error", body: "Trying to add https://newtool.io but get an error", listings, removed }).close, false)
check("removal request for an unlisted site → maintainer", triageIssue({ title: "Please remove my tool", body: "https://other.io", listings, removed }).action, "needs-maintainer")
check("extractHosts ignores our own domain, GitHub and file names", extractHosts("see https://www.promptfrenzy.com/directory and github.com/x, README.md, tools/a.yaml, mysite.app"), ["mysite.app"])
check("extractHosts reads bare domains and trailing punctuation", extractHosts("We're at Example.COM. Also https://www.foo.dev/path?x=1."), ["foo.dev", "example.com"])

// --- messages carry the marker and the right link ---------------------------
check("issue reply links the listing", renderIssueReply(t106).includes("https://www.promptfrenzy.com/directory/relayshield"), true)
check("issue reply flags the follow-up", renderIssueReply(t106).includes("a maintainer will follow up"), true)
check("PR failure comment lists reasons", renderPrComment({ outcome: "rejected", reasons: ["a", "b"] }).includes("- a\n- b"), true)
check(
  "applied comment names changed fields and notes",
  renderPrComment({ outcome: "applied", kind: "correction", host: "x.com", changed: ["name"], slug: "x", notes: ["removed tracking parameters from `url`"], commitUrl: "C" }).includes("(`name`)"),
  true,
)

check(
  "contributor text can't @-mention anyone",
  renderPrComment({ outcome: "rejected", reasons: ["`@robin-blocks` must NOT have additional properties"] }).includes("@robin-blocks"),
  false,
)

if (failures > 0) {
  console.error(`\n${failures} of ${count} cases failed`)
  process.exit(1)
}
console.log(`all ${count} cases pass`)
