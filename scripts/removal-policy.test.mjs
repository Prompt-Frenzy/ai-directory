// Guards the 30-day mover: the clock is failed_at (not last_passed_at), only
// `failed` entries are eligible, and the boundary is inclusive at exactly
// GRACE_DAYS. A wrong clock here silently delists paying-attention owners early.
import { GRACE_MS, shouldRemove, markRemoved } from "./removal-policy.mjs"

const NOW = Date.parse("2026-10-07T12:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

const entry = (verification) => ({ name: "x", url: "https://x.com", verification })

const CASES = [
  // [label, data, want]
  ["failed for exactly 30 days → remove", entry({ status: "failed", failed_at: iso(NOW - GRACE_MS) }), true],
  ["failed for 45 days → remove", entry({ status: "failed", failed_at: iso(NOW - 45 * DAY) }), true],
  ["failed for 29 days → keep", entry({ status: "failed", failed_at: iso(NOW - 29 * DAY) }), false],
  ["failed but no failed_at → keep (clock not started)", entry({ status: "failed", last_passed_at: iso(NOW - 60 * DAY) }), false],
  ["old last_passed_at is NOT the clock", entry({ status: "failed", failed_at: iso(NOW - 5 * DAY), last_passed_at: iso(NOW - 90 * DAY) }), false],
  ["pending, even if ancient → keep", entry({ status: "pending", failed_at: iso(NOW - 90 * DAY) }), false],
  ["verified with stale failed_at → keep", entry({ status: "verified", failed_at: iso(NOW - 90 * DAY) }), false],
  ["already removed → keep (idempotent)", entry({ status: "removed", failed_at: iso(NOW - 90 * DAY) }), false],
  ["garbage failed_at → keep", entry({ status: "failed", failed_at: "yesterday" }), false],
  ["no verification block → keep", { name: "x" }, false],
]

let bad = 0
for (const [label, data, want] of CASES) {
  const got = shouldRemove(data, NOW)
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? "ok " : "BAD"}  ${label}  (got ${got}, want ${want})`)
}

// markRemoved must not mutate its input and must stamp the punitive reason.
const src = entry({ status: "failed", failed_at: iso(NOW - GRACE_MS), failure_count: 7 })
const out = markRemoved(src, iso(NOW))
const checks = [
  ["status becomes removed", out.verification.status === "removed"],
  ["removed_at stamped", out.verification.removed_at === iso(NOW)],
  ["removal_reason is badge-failure", out.verification.removal_reason === "badge-failure"],
  ["failure history preserved", out.verification.failure_count === 7 && out.verification.failed_at === src.verification.failed_at],
  ["input not mutated", src.verification.status === "failed" && src.verification.removed_at === undefined],
]
for (const [label, ok] of checks) {
  if (!ok) bad++
  console.log(`${ok ? "ok " : "BAD"}  markRemoved: ${label}`)
}

if (bad) {
  console.error(`\n${bad} failing case(s)`)
  process.exit(1)
}
console.log(`\nall ${CASES.length + checks.length} cases pass`)
