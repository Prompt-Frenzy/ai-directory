#!/usr/bin/env python3
"""One-shot generator for seed/*.yaml. Run from repo root.

Not part of the verification pipeline. Lives in scripts/ for reproducibility
but isn't imported by any workflow. Safe to delete after the seed PR lands.
"""
import os
from pathlib import Path

# (slug, name, url, description, category, tags, pricing)
TOOLS = [
    # Image generation (10)
    ("midjourney", "Midjourney", "https://midjourney.com",
     "AI image generator known for high-quality artistic and photorealistic outputs, primarily accessed through Discord and a web interface.",
     "image-generation", ["discord", "photoreal", "artistic", "web-interface"], "subscription"),
    ("dall-e", "DALL-E", "https://openai.com/dall-e-3",
     "OpenAI's image generation model, available inside ChatGPT and via the OpenAI API for developers.",
     "image-generation", ["openai", "api", "text-to-image"], "freemium"),
    ("stable-diffusion", "Stable Diffusion", "https://stability.ai",
     "Open-source image generation model from Stability AI, available as a downloadable model and hosted API.",
     "image-generation", ["open-source", "api", "self-hostable"], "freemium"),
    ("leonardo-ai", "Leonardo AI", "https://leonardo.ai",
     "Image generation platform with fine-tuned models, an in-canvas editor, and tools for game asset and motion graphics workflows.",
     "image-generation", ["game-assets", "canvas", "motion-graphics"], "freemium"),
    ("ideogram", "Ideogram", "https://ideogram.ai",
     "Image generator with strong text rendering inside images, useful for posters, logos, and typography-driven designs.",
     "image-generation", ["text-rendering", "posters", "typography"], "freemium"),
    ("recraft", "Recraft", "https://recraft.ai",
     "Image generator with editable vector output, brand-style controls, and consistent character generation.",
     "image-generation", ["vector", "brand-style", "character-consistency"], "freemium"),
    ("flux", "Flux", "https://blackforestlabs.ai",
     "Open-weight image generation models from Black Forest Labs, used widely as a base for fine-tuning and hosted apps.",
     "image-generation", ["open-weight", "fine-tuning", "fast"], "freemium"),
    ("krea", "Krea", "https://krea.ai",
     "Real-time AI image and video generator with a live canvas, image-to-image workflow, and a community feed.",
     "image-generation", ["realtime", "canvas", "community"], "freemium"),
    ("adobe-firefly", "Adobe Firefly", "https://firefly.adobe.com",
     "Adobe's commercially-safe generative model integrated into Photoshop, Illustrator, and a standalone web app.",
     "image-generation", ["adobe", "commercial-safe", "photoshop"], "subscription"),
    ("playground", "Playground", "https://playground.com",
     "Image generation web app with multiple model options, a canvas editor, and a public feed of community creations.",
     "image-generation", ["canvas", "community", "multi-model"], "freemium"),

    # Video generation (7)
    ("runway", "Runway", "https://runwayml.com",
     "AI video generation and editing platform with Gen-3, motion brush, and post-production tools used by film and ad teams.",
     "video-generation", ["gen-3", "motion-brush", "post-production"], "subscription"),
    ("pika", "Pika", "https://pika.art",
     "Text-to-video and image-to-video generator with effects, transitions, and a strong community for short-form creators.",
     "video-generation", ["text-to-video", "image-to-video", "short-form"], "freemium"),
    ("luma-dream-machine", "Luma Dream Machine", "https://lumalabs.ai/dream-machine",
     "Video generation model from Luma AI with cinematic motion, keyframe control, and image-to-video workflows.",
     "video-generation", ["cinematic", "keyframes", "image-to-video"], "freemium"),
    ("sora", "Sora", "https://openai.com/sora",
     "OpenAI's video generation model, available through a dedicated web app for ChatGPT Plus and Pro subscribers.",
     "video-generation", ["openai", "text-to-video", "long-form"], "subscription"),
    ("kling", "Kling", "https://klingai.com",
     "Video generation model from Kuaishou with strong physical realism, camera control, and long-duration clips.",
     "video-generation", ["realism", "camera-control", "long-form"], "freemium"),
    ("hailuo", "Hailuo AI", "https://hailuoai.video",
     "MiniMax's text-to-video and image-to-video generator, known for fluid character motion and lip-sync features.",
     "video-generation", ["minimax", "character-motion", "lip-sync"], "freemium"),
    ("google-veo", "Google Veo", "https://deepmind.google/technologies/veo",
     "Google DeepMind's video generation model, accessible via Vertex AI and integrated into the Gemini app.",
     "video-generation", ["google", "vertex-ai", "gemini"], "subscription"),

    # Text generation / LLMs (6)
    ("chatgpt", "ChatGPT", "https://chatgpt.com",
     "OpenAI's conversational interface for the GPT family of models, with web search, code interpreter, and image generation built in.",
     "text-generation", ["openai", "gpt", "chat", "multimodal"], "freemium"),
    ("claude", "Claude", "https://claude.ai",
     "Anthropic's conversational AI assistant with long-context reasoning, file uploads, and a focus on helpful, harmless behavior.",
     "text-generation", ["anthropic", "long-context", "reasoning"], "freemium"),
    ("gemini", "Gemini", "https://gemini.google.com",
     "Google's conversational AI assistant powered by the Gemini family of models, with deep integration into Google Workspace.",
     "text-generation", ["google", "workspace", "multimodal"], "freemium"),
    ("mistral-le-chat", "Mistral Le Chat", "https://chat.mistral.ai",
     "Mistral's web chat interface for the Mistral and Codestral models, with image generation and web browsing built in.",
     "text-generation", ["mistral", "european", "web-browsing"], "freemium"),
    ("perplexity", "Perplexity", "https://perplexity.ai",
     "Answer engine that combines language models with live web search to produce cited, sourced responses.",
     "text-generation", ["search", "citations", "answer-engine"], "freemium"),
    ("meta-ai", "Meta AI", "https://meta.ai",
     "Meta's conversational AI assistant powered by Llama models, also embedded across Facebook, Instagram, and WhatsApp.",
     "text-generation", ["meta", "llama", "social-integration"], "free"),

    # Audio generation (3)
    ("suno", "Suno", "https://suno.com",
     "Text-to-music generator producing full songs with vocals, instrumentation, and lyrics from a single prompt.",
     "audio-generation", ["music", "vocals", "lyrics"], "freemium"),
    ("udio", "Udio", "https://udio.com",
     "Text-to-music platform from former Google DeepMind researchers, focused on high-fidelity vocal and instrumental tracks.",
     "audio-generation", ["music", "vocals", "high-fidelity"], "freemium"),
    ("stable-audio", "Stable Audio", "https://stableaudio.com",
     "Stability AI's text-to-audio model for music, sound effects, and instrumental loops up to several minutes long.",
     "audio-generation", ["stability", "sfx", "loops"], "freemium"),

    # Prompt tools (5)
    ("promptfrenzy", "PromptFrenzy", "https://promptfrenzy.com",
     "Free AI prompt library and generator covering ChatGPT, Midjourney, Nano Banana, and other models with one-click image gen.",
     "prompt-tools", ["library", "generator", "free", "multi-model"], "freemium"),
    ("prompthero", "PromptHero", "https://prompthero.com",
     "Searchable database of community-submitted prompts and example outputs for Midjourney, Stable Diffusion, and ChatGPT.",
     "prompt-tools", ["search", "midjourney", "stable-diffusion"], "freemium"),
    ("flowgpt", "FlowGPT", "https://flowgpt.com",
     "Community marketplace of ChatGPT and Claude prompts organized into categories like productivity, marketing, and roleplay.",
     "prompt-tools", ["community", "marketplace", "gpt"], "freemium"),
    ("promptbase", "PromptBase", "https://promptbase.com",
     "Marketplace where prompt creators sell tested prompts for image, text, and video models on a per-prompt basis.",
     "prompt-tools", ["marketplace", "paid-prompts", "creators"], "paid"),
    ("promptperfect", "PromptPerfect", "https://promptperfect.jina.ai",
     "Jina AI's prompt optimization tool that rewrites prompts to improve output quality for major language and image models.",
     "prompt-tools", ["optimization", "jina", "rewriting"], "freemium"),

    # Agents (3)
    ("devin", "Devin", "https://devin.ai",
     "Cognition Labs' autonomous AI software engineer, capable of taking on coding tasks end-to-end from a natural-language brief.",
     "agents", ["coding", "autonomous", "cognition"], "subscription"),
    ("replit-agent", "Replit Agent", "https://replit.com/agent",
     "Agent inside Replit that builds full applications from a prompt, configures the environment, and deploys to Replit's runtime.",
     "agents", ["replit", "deployment", "autonomous-coding"], "subscription"),
    ("openai-operator", "OpenAI Operator", "https://operator.chatgpt.com",
     "OpenAI's browser-using agent that performs multi-step tasks on websites on behalf of the user.",
     "agents", ["openai", "browser-automation", "research-preview"], "subscription"),

    # Chatbots / companion (3)
    ("character-ai", "Character.AI", "https://character.ai",
     "Platform for chatting with user-created character AI personas spanning fiction, history, learning, and roleplay.",
     "chatbots", ["characters", "roleplay", "community"], "freemium"),
    ("replika", "Replika", "https://replika.com",
     "Conversational AI companion focused on emotional support, personal growth, and ongoing relationship-style interactions.",
     "chatbots", ["companion", "emotional-support", "journaling"], "freemium"),
    ("pi", "Pi", "https://pi.ai",
     "Inflection AI's emotionally-intelligent conversational assistant, designed for natural back-and-forth dialogue and reflection.",
     "chatbots", ["inflection", "conversational", "reflection"], "free"),

    # Code assist (4)
    ("cursor", "Cursor", "https://cursor.com",
     "AI-first code editor built on VS Code with multi-file editing, tab autocomplete, and agent mode for end-to-end tasks.",
     "code-assist", ["editor", "vscode-fork", "agent-mode"], "subscription"),
    ("github-copilot", "GitHub Copilot", "https://github.com/features/copilot",
     "Microsoft and OpenAI's AI pair programmer that suggests code completions and chats in editors and on github.com.",
     "code-assist", ["microsoft", "github", "completion"], "subscription"),
    ("codeium", "Codeium", "https://codeium.com",
     "Free AI code completion and chat for individual developers, with Windsurf as its dedicated AI-first editor for teams.",
     "code-assist", ["completion", "windsurf", "free-tier"], "freemium"),
    ("bolt-new", "Bolt.new", "https://bolt.new",
     "StackBlitz's in-browser AI app builder that generates, edits, and deploys full-stack web apps from a single chat.",
     "code-assist", ["in-browser", "full-stack", "stackblitz"], "freemium"),

    # Productivity (4)
    ("notion-ai", "Notion AI", "https://notion.com/product/ai",
     "Notion's built-in AI assistant for drafting, summarizing, translating, and answering questions across a workspace's pages.",
     "productivity", ["notion", "writing", "summarization"], "subscription"),
    ("gamma", "Gamma", "https://gamma.app",
     "AI-powered presentation, document, and website builder that generates structured layouts from a single text prompt.",
     "productivity", ["presentations", "decks", "websites"], "freemium"),
    ("granola", "Granola", "https://granola.ai",
     "AI meeting notetaker that combines your typed notes with a transcript to produce structured summaries after the call.",
     "productivity", ["meetings", "transcription", "summaries"], "freemium"),
    ("fireflies", "Fireflies", "https://fireflies.ai",
     "Meeting assistant that joins calls, transcribes, summarizes, and surfaces action items across Zoom, Meet, and Teams.",
     "productivity", ["meetings", "transcription", "action-items"], "freemium"),

    # Data analysis (2)
    ("julius", "Julius", "https://julius.ai",
     "Data analysis chat interface that reads spreadsheets and databases, writes queries, and produces charts and statistical summaries.",
     "data-analysis", ["spreadsheets", "charts", "statistics"], "freemium"),
    ("hex", "Hex", "https://hex.tech",
     "Collaborative data workspace combining SQL, Python, and an AI assistant for building reproducible analyses and apps.",
     "data-analysis", ["sql", "python", "notebooks"], "freemium"),

    # Voice cloning (2)
    ("elevenlabs", "ElevenLabs", "https://elevenlabs.io",
     "Voice generation and cloning platform for AI voiceovers, dubbing, and conversational voice agents across 30+ languages.",
     "voice-cloning", ["tts", "voice-clone", "dubbing"], "freemium"),
    ("descript", "Descript", "https://descript.com",
     "Audio and video editor with AI voice cloning, transcript-based editing, and automatic filler-word removal.",
     "voice-cloning", ["video-editing", "transcript-editing", "overdub"], "freemium"),

    # Other (1)
    ("hugging-face", "Hugging Face", "https://huggingface.co",
     "Open-source ML platform hosting models, datasets, and Spaces apps for every modality across the community.",
     "other", ["open-source", "models", "datasets", "community"], "freemium"),
]

# Sanity checks before writing
assert len(TOOLS) == 50, f"Expected 50 tools, got {len(TOOLS)}"
slugs = [t[0] for t in TOOLS]
assert len(set(slugs)) == 50, "Duplicate slug detected"
for t in TOOLS:
    slug, name, url, desc, cat, tags, pricing = t
    assert 20 <= len(desc) <= 200, f"{slug}: description length {len(desc)} out of [20,200]"
    assert len(tags) <= 5, f"{slug}: too many tags"
    assert len(set(tags)) == len(tags), f"{slug}: duplicate tag"
    for tag in tags:
        assert all(c.islower() or c.isdigit() or c == '-' for c in tag), f"{slug}: bad tag '{tag}'"
    assert pricing in ("free", "freemium", "paid", "subscription"), f"{slug}: bad pricing"
    assert cat in ("image-generation", "video-generation", "text-generation", "audio-generation",
                   "prompt-tools", "agents", "chatbots", "code-assist", "productivity",
                   "data-analysis", "voice-cloning", "other"), f"{slug}: bad category"

# Emit YAMLs
seed_dir = Path("seed")
seed_dir.mkdir(exist_ok=True)
# Wipe placeholder .gitkeep — replaced by actual entries
gitkeep = seed_dir / ".gitkeep"
if gitkeep.exists():
    gitkeep.unlink()

def yaml_str(s):
    """Quote strings to be safe (avoid YAML special-char surprises)."""
    if any(c in s for c in ":#&*!|>'\"%@`{}[],") or s != s.strip():
        return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return s

for slug, name, url, desc, cat, tags, pricing in TOOLS:
    lines = []
    lines.append(f"name: {yaml_str(name)}")
    lines.append(f"url: {url}")
    lines.append(f"description: {yaml_str(desc)}")
    lines.append(f"category: {cat}")
    if tags:
        lines.append("tags:")
        for t in tags:
            lines.append(f"  - {t}")
    lines.append(f"pricing: {pricing}")
    lines.append("seeded: true")
    (seed_dir / f"{slug}.yaml").write_text("\n".join(lines) + "\n")

print(f"wrote {len(TOOLS)} files to {seed_dir}/")
