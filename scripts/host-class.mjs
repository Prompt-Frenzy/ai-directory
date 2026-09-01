/**
 * Host-quality classifier for directory submissions.
 *
 * Pure function of the tool's URL. Returns one of three tiers plus a
 * human-readable reason:
 *
 *   established — a custom domain the submitter controls. Full listing.
 *   early-stage — a durable hosting-platform subdomain (vercel.app,
 *                 netlify.app, github.io, ...). A real project might legitimately
 *                 live here before it moves to a custom domain, so we list it,
 *                 flag it "early-stage", and soften the outbound link. The
 *                 submitter can re-submit on a custom domain for a full listing.
 *   reject      — not a real, durable product home: raw IP hosts, auto-provisioned
 *                 hostnames with an embedded IP, throwaway tunnels, free-host
 *                 junk, link shorteners, or placeholder/localhost hosts.
 *
 * The taxonomy is deliberately conservative: when a host could plausibly be a
 * real indie tool's permanent home (carrd.co, a custom domain we don't
 * recognise), it lands in early-stage or established, never reject. reject is
 * reserved for hosts that are self-evidently not a durable product site.
 *
 * This file is the canonical copy. prompt-frenzy2 carries a byte-compatible
 * TypeScript mirror at lib/directory/host-class.ts — keep the two lists in sync.
 */

// Durable but platform-owned subdomains. A real tool can ship here, but it's
// not a custom domain, so it's listed as early-stage rather than established.
export const EARLY_STAGE_SUFFIXES = [
  "vercel.app",
  "vercel.dev",
  "netlify.app",
  "netlify.live",
  "pages.dev", // Cloudflare Pages
  "workers.dev", // Cloudflare Workers
  "github.io",
  "github.dev",
  "gitlab.io",
  "web.app", // Firebase
  "firebaseapp.com",
  "onrender.com",
  "render.com",
  "fly.dev",
  "railway.app",
  "up.railway.app",
  "railway.dev",
  "streamlit.app",
  "repl.co",
  "replit.app",
  "replit.dev",
  "glitch.me",
  "surge.sh",
  "deno.dev",
  "hf.space", // Hugging Face Spaces
  "gradio.app",
  "azurewebsites.net",
  "appspot.com", // Google App Engine
  "wixsite.com",
  "weebly.com",
  "webflow.io",
  "framer.website",
  "framer.app",
  "bubbleapps.io",
  "softr.app",
  "durable.co",
  "carrd.co",
  "notion.site",
  "super.site",
  // AI app-builders that auto-provision a per-user publish subdomain. Same
  // shape as the PaaS entries above: durable enough to list, but the submitter
  // does not own the domain, so it is early-stage rather than a custom domain.
  // Only add a suffix here if it is the *publish* domain and NOT the builder's
  // own homepage — listing "bolt.host" is right, listing "bolt.new" would
  // demote Bolt itself to early-stage.
  "chatgpt.site",
  "lovable.app",
  "bolt.host",
  "base44.app",
  "canva.site",
]

// Hosts that are never a durable product home. reject outright with a reason.
export const REJECT_SUFFIXES = [
  // Temporary tunnels — resolve for minutes/hours, not a home.
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "trycloudflare.com",
  "loca.lt",
  "lhr.life",
  "serveo.net",
  "localtunnel.me",
  // Auto-provisioned / free-host junk.
  "plesk.page",
  "myftpupload.com", // GoDaddy default
  "000webhostapp.com",
  "temp.domains",
  "onmypc.net",
  // Link shorteners / link-in-bio — not the tool's own site.
  "linktr.ee",
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "lnk.to",
  "rebrand.ly",
  "cutt.ly",
  "s.id",
]

const PLACEHOLDER_HOSTS = new Set([
  "localhost",
  "example.com",
  "example.org",
  "example.net",
])

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
// A label that embeds a dotted or dashed IP, e.g. "217-154-146-197" in a
// Plesk-style auto-provisioned host.
const EMBEDDED_IP_RE = /\b\d{1,3}[-.]\d{1,3}[-.]\d{1,3}[-.]\d{1,3}\b/

function hostMatchesSuffix(host, suffix) {
  return host === suffix || host.endsWith("." + suffix)
}

/**
 * @param {string} urlStr
 * @returns {{ tier: "established"|"early-stage"|"reject", host: string, reason: string, platform?: string }}
 */
export function classifyHost(urlStr) {
  let host
  try {
    host = new URL(urlStr).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return {
      tier: "reject",
      host: "",
      reason: "the URL is not a valid absolute https URL.",
    }
  }

  if (!host) {
    return { tier: "reject", host, reason: "no hostname in the URL." }
  }

  // Raw IPv4 / IPv6 literal.
  if (IPV4_RE.test(host) || host.includes(":")) {
    return {
      tier: "reject",
      host,
      reason:
        "the URL points at a raw IP address rather than a domain name. List your tool at its real hostname.",
    }
  }

  // Localhost / placeholder / non-public TLDs.
  if (
    PLACEHOLDER_HOSTS.has(host) ||
    /\.(local|localhost|test|invalid|example|internal|lan)$/.test(host)
  ) {
    return {
      tier: "reject",
      host,
      reason:
        "that is a localhost or placeholder hostname, not a public website.",
    }
  }

  // Reject suffixes (tunnels, free-host junk, shorteners).
  for (const s of REJECT_SUFFIXES) {
    if (hostMatchesSuffix(host, s)) {
      return {
        tier: "reject",
        host,
        reason:
          `\`${s}\` hosts are temporary tunnels, free-host placeholders, or link shorteners, ` +
          "not a durable home for a tool. List your tool at its own domain.",
      }
    }
  }

  // Embedded-IP auto-provisioned host (e.g. foo.217-154-146-197.plesk.page —
  // caught above by the plesk suffix, but also generic control-panel defaults).
  if (EMBEDDED_IP_RE.test(host)) {
    return {
      tier: "reject",
      host,
      reason:
        "that looks like an auto-provisioned server hostname with an embedded IP address, not a real domain. Point the badge at your tool's actual domain.",
    }
  }

  // Durable platform subdomains → early-stage.
  for (const s of EARLY_STAGE_SUFFIXES) {
    if (hostMatchesSuffix(host, s)) {
      return {
        tier: "early-stage",
        host,
        platform: s,
        reason:
          `this is hosted on a \`${s}\` platform subdomain. It is listed as early-stage; ` +
          "move it to a custom domain and re-submit for a full listing.",
      }
    }
  }

  return { tier: "established", host, reason: "custom domain." }
}
