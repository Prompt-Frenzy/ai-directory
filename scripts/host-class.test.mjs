// Differential probe for the EARLY_STAGE_SUFFIXES change: assert the positive
// (the builder subdomain now demotes) AND that the builders' own homepages are
// untouched, which is the way this edit could silently go wrong.
import { classifyHost } from "./host-class.mjs"

const CASES = [
  ["https://kilat-works-audit.alexloo552771.chatgpt.site/", "early-stage"],
  ["https://someone.lovable.app", "early-stage"],
  ["https://myapp.bolt.host", "early-stage"],
  ["https://x.base44.app", "early-stage"],
  ["https://portfolio.my.canva.site", "early-stage"],
  // Must stay established: these are the builders' own product homes.
  ["https://bolt.new", "established"],
  ["https://chatgpt.com", "established"],
  ["https://operator.chatgpt.com", "established"],
  ["https://lovable.dev", "established"],
  ["https://www.canva.com", "established"],
  // Regression guard on the pre-existing list.
  ["https://reelforge-landing-steel.vercel.app", "early-stage"],
  ["https://kardly.com", "established"],
]

let bad = 0
for (const [url, want] of CASES) {
  const got = classifyHost(url).tier
  const ok = got === want
  bad += !ok
  console.log(`${ok ? "PASS" : "FAIL"}  ${url.padEnd(56)} want=${want} got=${got}`)
}
console.log(bad ? `\n${bad} FAILED` : "\nall pass")
process.exit(bad ? 1 : 0)
