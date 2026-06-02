# PromptFrenzy AI Directory

A badge-required directory of AI tools.

**Submit your AI tool. Auto-merge in under 60 seconds — if you've earned the spot.**

Every other AI directory is abandonware. Maintainers stopped merging PRs months ago. We took a different approach: paste our badge on your site, open a PR, our bot verifies in seconds and merges itself. We re-check weekly. No human review queue. No pay-to-play.

---

## How to get listed

### 1. Paste this badge somewhere on your tool's site

```html
<a href="https://promptfrenzy.com/directory" rel="noopener"
   target="_blank" title="Featured on PromptFrenzy AI Directory">
  <img src="https://promptfrenzy.com/badges/directory.svg"
       alt="Featured on PromptFrenzy AI Directory"
       width="180" height="40" loading="lazy" />
</a>
```

Anywhere visible to crawlers: footer, sidebar, /about page. Must be:
- **Static HTML** (no JS-rendered DOM — our verifier doesn't run JavaScript)
- **Dofollow** (no `rel="nofollow"` or `rel="sponsored"`)
- **On a domain you control** (the URL you submit below)

### 2. Add a YAML file to `tools/`

Copy `tools/_example.yaml`, rename it to your tool's slug, fill it in:

```yaml
name: Your Tool Name
url: https://yourtool.com
description: One sentence (max 200 chars), factual, no superlatives.
category: image-generation   # see schema.json for the full enum
tags: [photo-editing, portrait]
pricing: freemium             # free | freemium | paid | subscription
logo: https://yourtool.com/logo.png   # optional
badge_url: https://yourtool.com       # the page where you pasted the badge
```

### 3. Open a PR

Our bot will:
1. Fetch your `badge_url` and look for the badge anchor
2. Comment on the PR with pass or fail (typically < 60 seconds)
3. Auto-merge if it passes
4. Open a tracking issue to follow your listing

If it fails, you'll get a comment explaining exactly what we couldn't find. Fix it, push, and the verifier re-runs.

---

## Verification & re-checks

| When | What we check |
|---|---|
| On your PR | Initial badge present, dofollow, on the URL you declared |
| Daily for first 7 days post-merge | Catches paste-then-yank gaming |
| Weekly thereafter | Ongoing health check |

### What happens if your badge disappears

1. **First failed check**: we open a GitHub issue tagged with your username explaining what we couldn't find. Your listing stays public, marked `pending`.
2. **3 consecutive failed checks**: your listing moves to `failed` state. Still visible, but flagged.
3. **30 days in `failed`** without resolution: your listing moves to [`/directory/removed`](https://promptfrenzy.com/directory/removed) — public, permanent.
4. **Reinstating**: re-add the badge, comment `/reverify` on your tracking issue. Bot picks it up within an hour.

This isn't punitive — honest mistakes (site redesigns, forgot to add the badge back) have a 30-day grace period plus email notifications. But ongoing gaming costs you a permanent public mark.

---

## Categories

`image-generation` · `video-generation` · `text-generation` · `audio-generation` · `prompt-tools` · `agents` · `chatbots` · `code-assist` · `productivity` · `data-analysis` · `voice-cloning` · `other`

Pick one. Use tags for granularity.

---

## What we don't do

- **No paid placements.** No featured tier, no "boosted" listings. The badge is the only currency.
- **No editorial scoring.** Our bot doesn't have opinions about your tool. If the badge is on your site and you fit a category, you're in.
- **No reviews or comments.** Visit the tool, judge for yourself. We're a directory, not Yelp.
- **No tracking pixels in the badge.** It's a plain SVG with one anchor.

---

## Why this works where awesome-lists died

The dominant model — humans review PRs to community-curated lists — collapsed under volume in 2024-2025. Every major AI awesome-list repo we surveyed has 30+ unmerged PRs sitting open for months. Maintainers gave up.

Our model swaps the human reviewer for a verification bot. The bot has one job: check the badge. That's mechanical, fast, and unbiased. We can review every submission within a minute because we're not reading any of them — we're checking a single anchor tag.

The badge requirement does the quality filtering instead of human judgment:
- **Real tools** add badges easily. Their site is already under their control; they can paste an HTML snippet in 30 seconds.
- **Spam farms** can't. Their throwaway WordPress sites can't host a badge without revealing themselves as throwaway.

---

## For tool consumers

The public-facing directory lives at **[promptfrenzy.com/directory](https://promptfrenzy.com/directory)** — filter by category, search by name, see each tool's current verification status.

A machine-readable index for LLMs and other tools: **[promptfrenzy.com/.well-known/ai-tools.json](https://promptfrenzy.com/.well-known/ai-tools.json)**.

---

## License

MIT. Submit, fork, or scrape freely.

---

*Maintained by [PromptFrenzy](https://promptfrenzy.com). Issues + questions welcome.*
