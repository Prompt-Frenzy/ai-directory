/**
 * De-listing policy, step 3 (README "What happens if your badge disappears"):
 * an entry that has sat in `failed` for GRACE_DAYS moves to removed/ with
 * removal_reason: badge-failure.
 *
 * Pure functions only — verify-badges.mjs does the file I/O so this can be
 * unit-tested without touching the corpus.
 *
 * The clock is `verification.failed_at`, stamped by the verifier on the
 * pending → failed transition (3rd consecutive miss). It is NOT
 * `last_passed_at`: for weekly-checked entries the two differ by up to three
 * weeks, and the README promises 30 days *in failed*.
 */

export const GRACE_DAYS = 30
export const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000

/** True when the entry has been `failed` for at least GRACE_DAYS as of nowMs. */
export function shouldRemove(data, nowMs) {
  const v = data?.verification
  if (!v || v.status !== "failed") return false
  if (!v.failed_at) return false
  const failedMs = Date.parse(v.failed_at)
  if (Number.isNaN(failedMs)) return false
  return nowMs - failedMs >= GRACE_MS
}

/** Returns a new data object with the verification block marked removed. */
export function markRemoved(data, nowIso) {
  const v = { ...(data.verification || {}) }
  v.status = "removed"
  v.removed_at = nowIso
  v.removal_reason = "badge-failure"
  return { ...data, verification: v }
}
