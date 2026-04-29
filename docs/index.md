---
layout: default
title: Slate
---

## Built alongside Fathom

I'm [Ashrya](https://github.com/ashryaagr), an AI scientist. While building [Fathom](https://github.com/ashryaagr/Fathom) — a research-paper reader with a per-paper whiteboard tab — it became clear that the whiteboard surface was useful on its own. People wanted it for paste-driven brainstorming against arbitrary content (slide decks, code architectures, screenshots of the whiteboard you just photographed in a meeting), not just papers.

So I extracted the same component into a standalone Mac app and a published npm package. That's Slate. There's nothing to sign up for. If you already pay for [Claude](https://claude.com/product/overview), you have everything Slate needs.

## A canvas, not a chat

Slate doesn't return text-about-a-diagram. It returns the diagram. On a real Excalidraw canvas. That you can edit.

You paste content into a chat input. Claude reads it. The agent draws — boxes, arrows, labels, evidence callouts — on the canvas while you watch. When it lands, you can move things around, rewrite labels, add your own annotations. Type into the chat to refine: *"add the loss equation under the training loop", "show what happens when the cache misses"*. Each refinement sees what's already on the canvas plus what you originally pasted.

## What it feels like

Open Slate. Paste. Hit return. Watch the agent draw. Edit the result. Type a refinement. Repeat. Close the app, reopen tomorrow — the canvas is still there.

## What makes it different

- **The canvas is live, not a generated image.** Slate doesn't return a PNG. The agent draws on a real Excalidraw canvas — same primitives the open-source editor uses — so anything Claude draws, you can edit.
- **Grounded in what you paste.** No retrieval, no embeddings, no general-purpose web lookup.
- **Paste anything.** Markdown, plain text, PDFs, images.
- **Available two ways.** Standalone Mac app, or `fathom-whiteboard` on npm as an embeddable React component.

## Install

Mac app — Apple Silicon only for now:

[Slate-arm64.dmg]({{ '/INSTALL#1-download-slate' | relative_url }}) (preferred) or [Slate-arm64.zip]({{ '/INSTALL#1-download-slate' | relative_url }}). First launch needs a one-time approval through System Settings — full walkthrough in the [install guide]({{ '/INSTALL' | relative_url }}).

Embed in your own app:

```bash
npm install fathom-whiteboard
```

## Your data stays yours

Slate runs entirely on your machine. No telemetry. No analytics. No accounts. No server ever sees your pasted content, your canvas, or your conversations with Claude. The only network calls are your own Claude Code CLI talking to Anthropic on your behalf, and the app's release-checker pinging GitHub for new versions.

Per-session canvas state lives under `~/Library/Application Support/Slate/sessions/last/`. Delete that folder any time to wipe local state without touching anything else.

## Free and open source

Slate is MIT-licensed and built in the open.

- [**Source →**](https://github.com/ashryaagr/fathom-whiteboard)
- [**Releases →**](https://github.com/ashryaagr/fathom-whiteboard/releases)
- [**Methodology →**]({{ '/methodology' | relative_url }}) — how the pipeline actually works.
- [**Design principles →**]({{ '/PRINCIPLES' | relative_url }}) — the rules Slate was built on. Read before proposing changes.
- [**Report a bug →**](https://github.com/ashryaagr/fathom-whiteboard/issues)

## Slate and Fathom

[Fathom](https://github.com/ashryaagr/Fathom) is the research-paper reader. Slate is the standalone version of Fathom's in-paper whiteboard tab. Use Fathom for reading and zooming into research papers; use Slate for paste-driven brainstorming against arbitrary content. Both ship the same `fathom-whiteboard` npm package — Fathom embeds it as one of the per-paper tabs, Slate wraps it in a minimal Electron shell.
