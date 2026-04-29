/**
 * Whiteboard Diagrams pipeline. Spec:
 *   - .claude/specs/whiteboard-diagrams.md (PIPELINE V2 LOCKED)
 *   - docs/methodology/whiteboard.md (user-facing operations doc)
 *
 * Two passes:
 *   - Pass 1 (Opus 4.7, 1M context): reads the entire indexed paper
 *     + figure captions + digest, emits a structured-but-loose
 *     markdown "understanding doc". Cached for 1 hour. Read-only Grep
 *     on content.md is the only tool.
 *   - Pass 2 (Sonnet 4.6): takes the cached Pass 1 output + a render
 *     request ("Render Level 1" or "Render Level 2 for the node X")
 *     and emits one WBDiagram JSON. ≤ 5 calls per Level 2 + 1 call
 *     for Level 1 = ≤ 6 Pass 2 calls per paper.
 *
 * Plus a soft-verifier that grep-checks each `[p.N] "quote"` Pass 1
 * inlined; results land in `whiteboard-issues.json` for the renderer
 * to surface as the dashed-citation marker. The diagram is NEVER
 * mutated based on verifier output (per spec — soft, not structural).
 *
 * Logging contract (matches docs/methodology/whiteboard.md "What to
 * look for in logs"): every call emits one `[Whiteboard PassN] …` line
 * with token counts + latency + cache hit/miss + cost estimate. The
 * methodology doc lists these prefixes as user-facing — do not rename
 * without updating the doc in the same commit.
 */

import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveClaudeExecutablePath } from './claude-cli';
import { createWhiteboardMcpWithStateAccess } from './mcp/whiteboard-mcp';
import { PASS2_SYSTEM as PASS2_SYSTEM_BODY } from './prompts/whiteboard-pass2-system';
import { runAgentSession } from './_agent-runner';
import { runCritique, type CritiqueVerdict } from './whiteboard-critique';
import type { PipelineArtifact } from '../shared/types';

// --- Cost & model constants. Pricing per Anthropic's docs (Apr 2026).
//     We surface these in logs so the methodology doc's cost numbers
//     have a code-side source of truth.
const OPUS_INPUT_USD_PER_MTOKEN = 15.0; // $15 / Mtok
const OPUS_OUTPUT_USD_PER_MTOKEN = 75.0; // $75 / Mtok
const SONNET_INPUT_USD_PER_MTOKEN = 3.0; // $3 / Mtok
const SONNET_OUTPUT_USD_PER_MTOKEN = 15.0; // $15 / Mtok
// Cached prefix tokens are 10% the regular input rate on the cache hit.
const CACHE_DISCOUNT = 0.1;

// --- Filenames inside the per-paper sidecar. Stable so the
//     methodology doc can name them and a future user can poke at them
//     directly without a code dive.
export const WB_UNDERSTANDING_FILE = 'whiteboard-understanding.md';
export const WB_ISSUES_FILE = 'whiteboard-issues.json';
export const WB_SCENE_FILE = 'whiteboard.excalidraw';
export const WB_CHAT_FILE = 'whiteboard-chat.json'; // placeholder for v1

// --- Pass 1 system prompt — verbatim from the spec, paste-once-and-
//     never-edit-without-a-spec-change. The `<<INDEXPATH>>` placeholder
//     is templated in by `runPass1` because the main wrapper needs the
//     absolute path to scope the Grep tool.
const PASS1_SYSTEM = `You are reading a research paper to help a curious technical reader build a mental
model of what the paper does — its core methodology, its key components, and how
they fit together. NOT literature review, NOT related work, NOT acknowledgements.

You have:
  • The full paper text (with \`<!-- PAGE N -->\` markers).
  • Figure captions and references.
  • A pre-computed digest (sections, equations, glossary).
  • Optional: the user's stated purpose for reading this paper. If present, weight
    your synthesis toward what they came to learn — but don't omit core methodology
    they didn't explicitly ask about.

You may call \`Grep\` on \`content.md\` if you want to verify a specific phrase before
committing it to your output. Use it sparingly — the paper is already in your
context. Grep is for confirming verbatim quotes, not for re-reading.

Reason section by section first (out loud, in <thinking> tags if you support them,
otherwise as a numbered list). Then synthesise.

Output a markdown document organised however feels natural. As a STARTING TEMPLATE
(not a contract — adapt freely):

## Goal
One sentence: what does this paper do? Then one paragraph of context: why does it
matter, what problem space does it sit in.

## Core methodology
The heart of the paper, in plain language. 2–4 paragraphs. Reference figure
numbers when figures carry the explanation (e.g. "see Figure 2"). Quote sparingly
when the paper's wording is load-bearing — use inline \`[p.N]\` page tags so a
downstream renderer can attach citations.

## Components
The 4–7 distinct pieces that make up the methodology. For each: one-line label, a
2-3 sentence description, source page reference, and (if applicable) the figure
that depicts it. These are the candidate nodes for the Level 1 diagram.

## Suggested Level 1 diagram
The user will see a top-level diagram with at most 5 nodes (working memory limit).

**Level 1 captures the paper's TOP-LEVEL pipeline / contribution / architecture — what
Figure 1 of the paper would show. NEVER the internals of one sub-component.**
If a Component from your Components list is "the inside of the encoder block" or
"a sub-step of the algorithm's loop body", it does NOT belong at Level 1; it
belongs in a Level 2 expansion of the parent block that contains it.

The mental check: *"If a reader saw only my 5 L1 nodes, could they explain in one
sentence what the paper as a whole does, end-to-end?"* If no, you've zoomed too
far in.

Level 1 must include the paper's input(s) and terminal output(s) so the diagram
reads as a complete pipeline, not a fragment. If your Components list has more
than 5 candidate nodes, propose a grouping — which Components collapse into which
Level 1 nodes. Use the paper's own vocabulary for the groupings.

**Anti-patterns** (if your Suggested L1 looks like one of these, redo it):
  - Verb-of-computation labels: "Q,K,V projections", "Compute scaled dot-product",
    "Element-wise sum", "Softmax over logits". These name what is COMPUTED inside
    one block; they are L2 internals, never L1. Replace with the NAME of the
    bigger module that contains them ("Encoder ×6", "Multi-Head Attention layer").
  - Internal-only terminology: "Add & Norm", "Masked attention", "Position-wise
    FFN". Recognisable only to someone already inside one block.
  - Missing endpoints: an L1 with no input + no terminal output is a fragment.
  - More than one "novel contribution" or none at all: exactly one L1 node should
    be the paper's named architecture / contribution; the others are surrounding
    pipeline.

**Worked example — "Attention Is All You Need":**
  - Correct L1: Inputs → Token+Pos Embed → Encoder ×6 → Decoder ×6 → Linear+Softmax.
    Encoder ×6 is the novel contribution (drillable). Decoder ×6 is also drillable.
  - WRONG L1 (this is the failure mode we keep hitting): "Multi-Head Attention" /
    "Position-wise FFN" / "Q,K,V inputs" / "Add & Norm" / "Repeat ×6". These are
    Encoder *internals*; they belong in Level 2 of Encoder ×6, not at Level 1.

## Suggested Level 2 expansions
For each Level 1 node that contains 2+ Components, briefly say what its zoom-in
should show. Skip Level 1 nodes that are leaf concepts.

**Each Level 2 expansion shows ONLY the interior of its parent — never re-list any
sibling Level 1 node.** L2 of "Encoder ×6" lists Encoder's sub-blocks
(Multi-Head Self-Attn → Add+Norm → FFN → Add+Norm); L2 of "Decoder ×6" lists
Decoder's sub-blocks (Masked MHA → Add+Norm → Cross-Attn → Add+Norm → FFN →
Add+Norm). Encoder's L2 ≠ Decoder's L2 even when operations rhyme — they are
specialised content per parent.

If two of your L2 expansions would share more than one node label, you've
probably described the shared sub-block as belonging to multiple parents. Move
the shared concept up to L1 if it really is a separate top-level stage, or
duplicate the operation under each parent with parent-specific labels (e.g.
"Self-Attn" inside Encoder vs "Masked Self-Attn" inside Decoder).

Hard rules:
  - Do NOT invent components, stages, or relationships that aren't in the paper.
    If you're not sure, say so.
  - Use the paper's own terminology. Don't rename things.
  - If the paper isn't a methods/system/algorithm paper (e.g. a theory paper or a
    survey), say so explicitly at the top and adapt the structure: theory papers
    show theorems instead of stages; surveys show the categorisation taxonomy.
  - Quote inline (\`[p.N]: "..."\`) only when confident the quote is verbatim. The
    downstream renderer will run a soft verifier and flag any unverified quotes
    with a \`?\` marker — you don't need to be perfect, but flagged citations
    look bad to the user, so quote conservatively.`;

// --- Pass 2 system prompt. Pass 2 now drives the Whiteboard SDK MCP
//     directly (Option C per .claude/specs/whiteboard-mcp-pivot.md).
//     The agent calls tools (read_diagram_guide, create_node_with_fitted_text,
//     connect_nodes, describe_scene, export_scene) and the wrapper
//     mutates an in-memory scene state. Caller snapshots that state
//     after the stream completes and writes it to disk as the
//     .excalidraw file the renderer loads.
//
//     No more WBDiagram DSL — single source of truth: the agent
//     authors the .excalidraw shape directly, the renderer loads it
//     directly. No translation layer.
//
//     The prompt body lives in `whiteboard-pass2-system.ts` so Node-
//     only callers (smoke harness) can import it without dragging in
//     the Electron-bound transitive deps of THIS file. Re-exported
//     here so existing call sites keep working.
export const PASS2_SYSTEM = PASS2_SYSTEM_BODY;

// --- Public surface ---

export interface Pass1Result {
  /** The rendered understanding doc (markdown) — also persisted to
   * `<sidecar>/whiteboard-understanding.md`. */
  understanding: string;
  /** USD cost estimate for the call (input + output, no caching since
   * Pass 1 *is* the cached prefix for downstream calls). */
  costUsd: number;
  /** Wall-clock latency, milliseconds. */
  latencyMs: number;
  /** Anthropic-reported usage; null if the SDK didn't surface it. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Optional purpose anchor — passed through so the methodology doc
   * can show what the user came to learn. */
  purposeAnchor?: string;
}

export interface Pass2Result {
  /** Raw model output. The renderer's `parseWBDiagram` does the
   * tolerant decoding into a WBDiagram object. */
  raw: string;
  costUsd: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True iff the SDK reported a cache hit on the Pass 1 prefix. We
   * instrument this so the methodology doc's "1-hour TTL beta enabled"
   * claim is verifiable from the logs. */
  cachedPrefixHit: boolean;
}

export interface VerifierIssue {
  page: number;
  quote: string;
  /** Trigram overlap (0..1) against the closest passage in
   * `content.md` after whitespace + case + punctuation normalisation.
   * Soft-verifier rule (spec): ≥0.85 = verified; 0.50–0.85 = soft;
   * <0.50 = unverified. */
  score: number;
  /** Coarse classification from the score. */
  status: 'verified' | 'soft' | 'unverified';
  /** Best-matching passage we found, truncated to 240 chars. Useful
   * when the user opens whiteboard-issues.json to debug. */
  closest: string;
}

export interface VerifierResult {
  issues: VerifierIssue[];
  /** Fraction of quotes that passed the ≥0.85 threshold. The renderer
   * uses this to decide whether to show the "some citations may not
   * match" banner. */
  verificationRate: number;
  /** Map quote → status, so the per-node citation marker can render the
   * verified/unverified affordance without scanning issues. */
  quoteStatus: Record<string, VerifierIssue>;
}

export interface RunPass1Args {
  paperHash: string;
  indexPath: string;
  /** Optional purpose statement — appended to the user prompt so the
   * model can weight its synthesis toward what the reader came for.
   * Per the spec: present in the prompt but never required. */
  purposeAnchor?: string;
  abortController?: AbortController;
  /** Streaming hook — fired on every `text_delta`. Used by the
   * renderer to drive the Pass 1 streaming sidebar (cog reviewer
   * non-blocking note). Tool-use messages also reach this stream as
   * `[grep …]` lines so the user sees activity. */
  onProgress?: (text: string) => void;
  /** Persistence hook — fired with the Pass 1 understanding doc so
   *  the host can save it however it likes (filesystem, DB, S3). The
   *  pipeline does NOT write to disk itself. Required for any host
   *  that wants the understanding to survive across runs. */
  onArtifact?: (artifact: PipelineArtifact) => Promise<void>;
  /** Optional override of the Claude CLI binary path. Hosts with
   *  Electron-aware lookup (Fathom) pass the resolved path through;
   *  hosts without one fall back to `resolveClaudeExecutablePath()`
   *  from `claude-cli.ts`. Forwarded to the SDK as
   *  `pathToClaudeCodeExecutable`. */
  claudeExecutablePath?: string;
}

export interface RunPass2Args {
  paperHash: string;
  indexPath: string;
  understanding: string;
  /** "Render the Level 1 diagram" or "Render the Level 2 expansion of
   * the Level 1 node labelled X (id: L1.2)". Built by the IPC layer. */
  renderRequest: string;
  level: 1 | 2;
  /** Parent WBNode id when level=2. Threaded into the prompt so Sonnet
   * knows which Level 1 node we're zooming into. */
  parentNodeId?: string;
  abortController?: AbortController;
  onProgress?: (text: string) => void;
  /** Round-13 streaming render. Called with the in-progress
   * `state.elements` (full snapshot) every time the agent's
   * authoring mutates the scene — throttled inside the MCP factory
   * to ~80 ms (leading + trailing edge). The IPC layer wires this to
   * a `whiteboard:scene-stream` push so the renderer can show the
   * canvas filling in live instead of waiting for export_scene.
   * Pass undefined to disable; smoke + Pass-1 paths leave it off. */
  onSceneSnapshot?: (elements: readonly unknown[]) => void;
  /** Persistence hook — fired with `render-snapshot` (PNG) +
   *  `issues` (verifier JSON) artifacts. The pipeline DOES NOT
   *  write to disk; the host decides where output goes. */
  onArtifact?: (artifact: PipelineArtifact) => Promise<void>;
  /** Optional override of the Claude CLI binary path. See
   *  `RunPass1Args.claudeExecutablePath`. */
  claudeExecutablePath?: string;
}

/** TCC-aware cwd selector — same pattern as ai/client.ts and
 * ai/decompose.ts. Prefer the paper's sidecar (always inside userData
 * → no TCC prompt) when valid; fall back to homedir otherwise. */
function safeCwd(preferred?: string): string {
  if (preferred) {
    const home = homedir();
    const protectedPrefixes = [
      `${home}/Desktop`,
      `${home}/Documents`,
      `${home}/Downloads`,
    ];
    const isProtected = protectedPrefixes.some(
      (prefix) => preferred === prefix || preferred.startsWith(prefix + '/'),
    );
    if (!isProtected) {
      try {
        if (existsSync(preferred) && statSync(preferred).isDirectory()) return preferred;
      } catch {
        /* fall through */
      }
    }
  }
  return homedir();
}

// --------------------------------------------------------------------
// Pass 1 — UNDERSTAND
// --------------------------------------------------------------------

/** Run Pass 1 of the Whiteboard pipeline. Reads the entire paper into
 * Opus 4.7's 1M context window and emits a markdown understanding doc
 * via `onArtifact`, returning the doc + cost/latency for logging. The
 * pipeline does NOT write to disk; the host's `onArtifact` is the
 * persistence path. */
export async function runPass1(args: RunPass1Args): Promise<Pass1Result> {
  const t0 = Date.now();
  const cwd = safeCwd(args.indexPath);
  const pathToClaudeCodeExecutable =
    args.claudeExecutablePath ?? resolveClaudeExecutablePath() ?? undefined;

  // Load the inputs Opus needs. content.md is required; the digest
  // and figure captions are optional but useful.
  const contentPath = join(args.indexPath, 'content.md');
  if (!existsSync(contentPath)) {
    throw new Error(
      `Whiteboard Pass 1 needs content.md but it does not exist at ${contentPath}. The paper must be indexed first.`,
    );
  }
  const content = await readFile(contentPath, 'utf-8');
  // Digest is best-effort — if missing or unparseable, we still run.
  let digestText = '';
  const digestPath = join(args.indexPath, 'digest.json');
  if (existsSync(digestPath)) {
    try {
      digestText = await readFile(digestPath, 'utf-8');
    } catch {
      /* digest unreadable — Pass 1 still works without it */
    }
  }

  console.log(
    `[Whiteboard Pass1] BEGIN paper=${args.paperHash.slice(0, 10)} ` +
      `content=${content.length}ch digest=${digestText.length}ch ` +
      `purpose=${args.purposeAnchor ? `"${args.purposeAnchor.slice(0, 60)}"` : 'none'}`,
  );

  const userPrompt = buildPass1Prompt({
    indexPath: args.indexPath,
    content,
    digestText,
    purposeAnchor: args.purposeAnchor,
  });

  // The Agent SDK uses Sonnet by default (Claude Code preset). For Pass 1
  // we explicitly request Opus 4.7. The model ID is `claude-opus-4-7` —
  // there's no `-1m` variant; 1M context is the model's native window
  // (and also accessed via the `anthropic-beta: context-1m-2025-08-07`
  // header on Sonnet, but Opus 4.7 doesn't need that flag). The
  // initially-shipped `claude-opus-4-7-1m` was a hallucinated identifier
  // and produced a runtime "model not found" error on first generation.
  const session = await runAgentSession({
    prompt: userPrompt,
    systemPrompt: PASS1_SYSTEM,
    model: 'claude-opus-4-7',
    // Round 14e — REVERTED `settingSources: [] + strictMcpConfig: true`.
    // Hypothesis (per dispatch from team-lead 2026-04-28T03:34): the user
    // observed rate-limiting started AFTER round-13 production trim shipped.
    // Pass 1 ran successfully across 2026-04-25, 04-26, 04-27 PDT (many
    // calls, $0.20-$0.34 each, in_tokens=6, out=2700-4900). First failure
    // 03:04 UTC = 36 min after the bundle with `settingSources: []` was
    // rebuilt. Reverting to test whether the trim is implicated. SDK
    // runtime default (sdk.mjs `allowedSettingSources`) is all five
    // sources — `[]` cuts off userSettings/projectSettings/etc which
    // includes ~/.claude/settings.json (effortLevel, alwaysThinkingEnabled,
    // enabledPlugins). Test the hypothesis by running the dev app post-
    // revert and seeing if rate-limit goes away.
    // Read-only Grep on content.md is the only tool. Spec §"Pass 1":
    // "no Read (already loaded), no WebSearch, no Bash."
    allowedTools: ['Grep'],
    additionalDirectories: [args.indexPath],
    includePartialMessages: true,
    abortController: args.abortController,
    cwd,
    pathToClaudeCodeExecutable,
    // Opus might Grep a few times to verify quotes. 24 is generous.
    maxTurns: 24,
    rateLimitDetection: true,
    onTextDelta: (chunk) => args.onProgress?.(chunk),
    // Thinking deltas surface to the user as faint progress text —
    // gives the streaming sidebar something to render during the
    // long Pass 1 wait.
    onThinkingDelta: (chunk) => args.onProgress?.(chunk),
    onToolUse: (_name, input) => {
      const pat = String(input.pattern ?? '').slice(0, 60);
      console.log(`[Whiteboard Pass1] grep: "${pat}"`);
      args.onProgress?.(`\n🔎 Grep "${pat}"\n`);
    },
  });

  if (session.sawRateLimitRejected) {
    console.warn(
      `[Whiteboard Pass1] rate_limit_event REJECTED — stream aborted by runner.`,
    );
  }

  if (
    session.resultSubtype === 'error_max_turns' ||
    session.resultSubtype === 'error_during_execution'
  ) {
    if (session.responseText.length === 0) {
      throw new Error(`Whiteboard Pass 1 failed: ${session.resultSubtype}`);
    }
    console.warn(
      `[Whiteboard Pass1] ${session.resultSubtype}; returning partial body of ${session.responseText.length} chars`,
    );
  }

  if (session.sawRateLimitRejected && !session.sawResult) {
    throw new Error(
      'Rate limit hit before Pass 1 could finish reading the paper. Wait a minute and try again.',
    );
  }

  const body = session.responseText;
  const inputTokens = session.inputTokens;
  const outputTokens = session.outputTokens;
  const toolUseCount = session.toolUseCount;

  // Emit the understanding doc to the host. The pipeline does NOT
  // write to disk — `onArtifact` is the persistence path. Hosts that
  // omit `onArtifact` lose the doc on process exit (acceptable for
  // CI / demo / smoke; not acceptable for an interactive app).
  if (args.onArtifact) {
    await args.onArtifact({
      type: 'understanding',
      name: WB_UNDERSTANDING_FILE,
      body,
    });
  }

  const latencyMs = Date.now() - t0;
  // Cost estimate: full Opus pricing on input (no cache hit on Pass 1
  // itself — Pass 1 *creates* the cache). Output priced at Opus output
  // rate.
  const costUsd =
    ((inputTokens ?? estimateTokens(userPrompt)) / 1_000_000) * OPUS_INPUT_USD_PER_MTOKEN +
    ((outputTokens ?? estimateTokens(body)) / 1_000_000) * OPUS_OUTPUT_USD_PER_MTOKEN;

  console.log(
    `[Whiteboard Pass1] END paper=${args.paperHash.slice(0, 10)} ` +
      `body=${body.length}ch tools=${toolUseCount} ` +
      `tokens(in=${inputTokens ?? '?'}, out=${outputTokens ?? '?'}) ` +
      `cost=$${costUsd.toFixed(3)} t=${latencyMs}ms`,
  );

  return {
    understanding: body,
    costUsd,
    latencyMs,
    inputTokens,
    outputTokens,
    purposeAnchor: args.purposeAnchor,
  };
}

function buildPass1Prompt(args: {
  indexPath: string;
  content: string;
  digestText: string;
  purposeAnchor?: string;
}): string {
  const parts: string[] = [];
  parts.push(
    `You have a per-paper index folder at "${args.indexPath}". The paper text is in "${args.indexPath}/content.md" (also pasted below for direct reading). Use \`Grep\` on content.md to verify any specific phrase before quoting it; otherwise rely on the inline text.`,
  );
  if (args.purposeAnchor && args.purposeAnchor.trim().length > 0) {
    parts.push(`<reader_purpose>\n${args.purposeAnchor.trim()}\n</reader_purpose>`);
  }
  if (args.digestText.length > 0) {
    parts.push(`<paper_digest>\n${args.digestText}\n</paper_digest>`);
  }
  parts.push(`<paper_content>\n${args.content}\n</paper_content>`);
  parts.push(
    `Now produce the structured-but-loose markdown understanding document described in the system prompt. Begin directly — no preamble.`,
  );
  return parts.join('\n\n');
}

// --------------------------------------------------------------------
// Pass 2 — RENDER
// --------------------------------------------------------------------

export async function runPass2(args: RunPass2Args): Promise<Pass2Result> {
  const t0 = Date.now();
  const cwd = safeCwd(args.indexPath);
  const pathToClaudeCodeExecutable = resolveClaudeExecutablePath() ?? undefined;

  console.log(
    `[Whiteboard Pass2] BEGIN paper=${args.paperHash.slice(0, 10)} ` +
      `level=${args.level} ${args.parentNodeId ? `parent=${args.parentNodeId} ` : ''}` +
      `understanding=${args.understanding.length}ch (MCP-driven)`,
  );

  const userPrompt = buildPass2Prompt(args);

  // Spawn one MCP per Pass 2 call. State is per-call by construction;
  // concurrent L2 expansions get their own scenes. The wrapper's
  // closure-scoped `state` lives until the SDK MCP instance is GC'd
  // (when this function returns).
  //
  // Round-11: thread paperHash + indexPath + claude bin path so the new
  // `request_critic_review` tool can rasterise + invoke runCritique.
  const { mcp, getScene, dispose } = createWhiteboardMcpWithStateAccess({
    level: args.level,
    parent: args.parentNodeId,
    paperHash: args.paperHash,
    indexPath: args.indexPath,
    pathToClaudeCodeExecutable,
    onSceneSnapshot: args.onSceneSnapshot,
  });

  // Pass 2 uses Opus 4.7 — same model as Pass 1 — for quality consistency
  // (PM update 2026-04-25). The MCP-driven authoring path lets the agent
  // self-critique via describe_scene inside the tool-use loop instead
  // of a separate Pass 2.5 call (which is now deleted).
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cachedPrefixHit = false;
  let toolUseCount = 0;
  let sawRateLimit = false;
  let sawResult = false;

  try {
    const session = await runAgentSession({
      prompt: userPrompt,
      systemPrompt: PASS2_SYSTEM,
      model: 'claude-opus-4-7',
      mcpServers: { whiteboard: mcp },
      // Round 14e — REVERTED `settingSources: [] + strictMcpConfig: true`. See Pass 1 above.
      // Allowed tools: every tool the wrapper MCP exposes (prefixed
      // by `mcp__whiteboard__` per the SDK's MCP-tool naming
      // convention) + Read for citation grounding against
      // <indexPath>/content.md. No Glob (figure_refs are now passed
      // through the create_node_with_fitted_text tool's figure_ref
      // arg; the model's understanding doc tells it which figures
      // exist). No WebSearch.
      allowedTools: [
        'mcp__whiteboard__read_diagram_guide',
        'mcp__whiteboard__create_node_with_fitted_text',
        'mcp__whiteboard__connect_nodes',
        'mcp__whiteboard__describe_scene',
        'mcp__whiteboard__look_at_scene',
        'mcp__whiteboard__export_scene',
        'mcp__whiteboard__clear_scene',
        // v3.2.1 — section / zone / text / callout / camera primitives
        'mcp__whiteboard__create_section',
        'mcp__whiteboard__create_background_zone',
        'mcp__whiteboard__create_text',
        'mcp__whiteboard__create_callout_box',
        'mcp__whiteboard__set_camera',
        // Round-11 — in-product visual self-loop. The agent calls this
        // once before export_scene; the wrapper invokes the vision
        // critic on the rasterised scene and feeds back a structured
        // verdict the agent then patches against. Capped at 3 rounds.
        'mcp__whiteboard__request_critic_review',
        // Round-13 — template library. list_templates returns the
        // catalog (with implemented:true|false flags); instantiate_template
        // drops a configured template instance into the active section.
        // Round 13 ships flow-chart, comparison-matrix, time-chain, and
        // key-insight-callout (P0 set).
        'mcp__whiteboard__list_templates',
        'mcp__whiteboard__instantiate_template',
        'Read',
      ],
      additionalDirectories: [args.indexPath],
      includePartialMessages: true,
      abortController: args.abortController,
      cwd,
      pathToClaudeCodeExecutable,
      // 80 turns (round-11, was 60): up to 3 critic-review rounds × ~10
      // patch tool calls each + the agent's normal authoring (~40-50).
      maxTurns: 80,
      rateLimitDetection: true,
      // Stream text deltas to the placeholder for Doherty progress.
      // The agent's text output between tool calls is the "drawing
      // rectangle 1 of 5..." narration the user reads while waiting.
      onTextDelta: (chunk) => args.onProgress?.(chunk),
      // Surface tool calls to the progress stream so the user sees
      // "🔧 create_node_with_fitted_text" instead of dead air.
      onToolUse: (rawName) => {
        const toolName = rawName.replace(/^mcp__whiteboard__/, '');
        args.onProgress?.(`\n🔧 ${toolName}\n`);
      },
    });
    inputTokens = session.inputTokens;
    outputTokens = session.outputTokens;
    cachedPrefixHit = session.cachedPrefixHit;
    toolUseCount = session.toolUseCount;
    sawRateLimit = session.sawRateLimitRejected;
    sawResult = session.sawResult;
    if (sawRateLimit) {
      console.warn(
        `[Whiteboard Pass2] rate_limit_event REJECTED — stream aborted by runner.`,
      );
    }
    if (
      session.resultSubtype === 'error_max_turns' ||
      session.resultSubtype === 'error_during_execution'
    ) {
      // Don't throw — the agent may have authored most of the scene
      // before hitting the limit; persist whatever's in the in-memory
      // state. The renderer's scene-load tolerates partial scenes.
      console.warn(`[Whiteboard Pass2] ${session.resultSubtype}; persisting partial scene`);
    }
  } finally {
    // Tear down the headless-render subprocess if `look_at_scene`
    // was ever invoked. No-op if not.
    try {
      await dispose();
    } catch (err) {
      console.warn('[Whiteboard Pass2] render-server dispose failed', err);
    }
  }

  // Round-13: if the stream ended on rate_limit_event without a
  // terminal `result` event, surface that to the IPC handler so the
  // renderer's `whiteboard:status` flips to 'error' and the user can
  // try again. Persist whatever scene the agent had authored so far —
  // partial scenes are still valuable. The IPC handler emits a
  // structured error event the WhiteboardTab listens for; without
  // this throw the handler would resolve as success with an empty/
  // partial scene and the renderer would silently mount it.
  if (sawRateLimit && !sawResult) {
    throw new Error(
      'Rate limit hit before the whiteboard could finish. Wait a minute and try again.',
    );
  }

  // Snapshot the in-memory scene state regardless of whether the agent
  // explicitly called export_scene. Defensive: even partial scenes
  // get persisted, the renderer will mount whatever's there.
  const scene = getScene();
  const sceneJson = JSON.stringify(scene);

  // For Level 2 diagrams the renderer needs to know the parent so it
  // can vertically offset the scene below the parent L1 node. Stamp
  // the parent into the appState as a custom field; the renderer's
  // L2 mount path reads it.
  if (args.level === 2 && args.parentNodeId) {
    (scene.appState as Record<string, unknown>).fathomParentNodeId = args.parentNodeId;
  }

  const latencyMs = Date.now() - t0;
  const inTokensEst = inputTokens ?? estimateTokens(userPrompt);
  const outTokensEst = outputTokens ?? estimateTokens(sceneJson);
  // Use Opus pricing (Pass 2 is Opus 4.7).
  const inputCost = cachedPrefixHit
    ? (inTokensEst / 1_000_000) * OPUS_INPUT_USD_PER_MTOKEN * CACHE_DISCOUNT
    : (inTokensEst / 1_000_000) * OPUS_INPUT_USD_PER_MTOKEN;
  const costUsd = inputCost + (outTokensEst / 1_000_000) * OPUS_OUTPUT_USD_PER_MTOKEN;

  console.log(
    `[Whiteboard Pass2] END paper=${args.paperHash.slice(0, 10)} ` +
      `level=${args.level} elements=${scene.elements.length} tools=${toolUseCount} ` +
      `tokens(in=${inputTokens ?? '?'}, out=${outputTokens ?? '?'}) ` +
      `cache=${cachedPrefixHit ? 'HIT' : 'miss'} ` +
      `cost=$${costUsd.toFixed(4)} t=${latencyMs}ms`,
  );

  // Pass2Result.raw now carries the full .excalidraw scene JSON
  // (instead of the old WBDiagram JSON the renderer used to parse).
  // Renderer's WhiteboardTab parses this directly and feeds it into
  // Excalidraw's initialData — single source of truth, no DSL middle
  // step.
  return { raw: sceneJson, costUsd, latencyMs, inputTokens, outputTokens, cachedPrefixHit };
}

// --------------------------------------------------------------------
// Round-14b — runPass2StepLoop: outer loop for step-by-step authoring
// --------------------------------------------------------------------
//
// The agent emits ONE section's worth of work per step then calls
// `yield_step({stepSummary})`. The orchestrator:
//   - Reads the yield's `stepSummary` + `done` + `screenshotRequest`
//   - If !done: re-issues with the cached Pass 1 prefix + the prior
//     step's summary appended as next-turn context, optionally with
//     a rasterised PNG of the current canvas attached
//   - If done: stops
//   - Hard cap at MAX_STEPS to bound runaway loops
//
// The MCP instance + scene state are shared across all steps. Cost
// stays low because the system prompt + understanding doc hit the
// 1-hour prompt cache on every turn after the first.
//
// Per-step maxTurns (~10) is much smaller than the global runPass2
// budget (80) — each step is supposed to be one cohesive unit, not
// the whole whiteboard.

const STEP_LOOP_MAX_STEPS = 12;
const STEP_LOOP_PER_STEP_MAX_TURNS = 12;

export interface StepRecord {
  stepNum: number;
  summary: string;
  done: boolean;
  sceneSize: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedPrefixHit: boolean;
}

export interface RunPass2StepLoopArgs extends RunPass2Args {
  /** Fired after each step's yield_step returns. The IPC layer pushes
   * this through `whiteboard:step` so the renderer can show a status
   * line ("§1 Architecture: 5-node flow-chart from photos to mesh"). */
  onStep?: (info: { stepNum: number; summary: string; done: boolean; sceneSize: number }) => void;
}

export interface Pass2StepLoopResult extends Pass2Result {
  /** Append-only audit trail across every step. Useful for end-of-run
   * logging + debugging if the agent stalls partway. */
  steps: StepRecord[];
  /** True if the agent called yield_step({done:true}); false if the
   * loop terminated on MAX_STEPS or per-step error. */
  finishedCleanly: boolean;
  /** Round-14c — advisory post-export critic verdict. Run ONCE by the
   * orchestrator after the step-loop terminates cleanly + the scene
   * is non-empty. NOT used to block; the IPC layer surfaces it as a
   * `whiteboard:critic-verdict` event so a future advisory-badge UI
   * can show defects without blocking ship.
   *
   * `null` when:
   *   - the loop didn't finish cleanly (no critique attempted),
   *   - the scene is empty (nothing to critique),
   *   - the critique call threw or the verdict was unparseable. */
  criticVerdict: CritiqueVerdict | null;
}

/**
 * Round-14b — multi-step authoring loop. Wraps the existing single-turn
 * runPass2 semantics with an outer loop that re-issues per yield_step.
 *
 * Key design points:
 * - One MCP instance for the whole run. Scene state persists across
 *   steps. The renderer's scene-stream broadcast already shows partial
 *   scenes during each step.
 * - One cached Pass 1 prefix for the whole run. Steps after the first
 *   should hit the prompt cache for the system prompt + understanding
 *   doc; only the per-step user message differs.
 * - Per-step maxTurns is small (~10) — each step is one section's work,
 *   not the whole whiteboard.
 * - Hard MAX_STEPS cap (12) bounds the loop in case the agent fails
 *   to ever set done=true.
 */
export async function runPass2StepLoop(
  args: RunPass2StepLoopArgs,
): Promise<Pass2StepLoopResult> {
  const t0 = Date.now();
  const cwd = safeCwd(args.indexPath);
  const pathToClaudeCodeExecutable = resolveClaudeExecutablePath() ?? undefined;

  console.log(
    `[Whiteboard Pass2-StepLoop] BEGIN paper=${args.paperHash.slice(0, 10)} ` +
      `level=${args.level} ${args.parentNodeId ? `parent=${args.parentNodeId} ` : ''}` +
      `understanding=${args.understanding.length}ch maxSteps=${STEP_LOOP_MAX_STEPS}`,
  );

  // One MCP instance shared across all steps. State (sections, scene
  // elements, lastBottomY, yieldHistory) persists.
  const {
    mcp,
    getScene,
    getLastYield,
    getYieldHistory,
    clearLastYield,
    renderScene,
    dispose,
  } = createWhiteboardMcpWithStateAccess({
    level: args.level,
    parent: args.parentNodeId,
    paperHash: args.paperHash,
    indexPath: args.indexPath,
    pathToClaudeCodeExecutable,
    onSceneSnapshot: args.onSceneSnapshot,
  });

  const allowedTools = [
    'mcp__whiteboard__read_diagram_guide',
    'mcp__whiteboard__create_node_with_fitted_text',
    'mcp__whiteboard__connect_nodes',
    'mcp__whiteboard__describe_scene',
    'mcp__whiteboard__look_at_scene',
    'mcp__whiteboard__export_scene',
    'mcp__whiteboard__clear_scene',
    'mcp__whiteboard__create_section',
    'mcp__whiteboard__create_background_zone',
    'mcp__whiteboard__create_text',
    'mcp__whiteboard__create_callout_box',
    'mcp__whiteboard__set_camera',
    'mcp__whiteboard__request_critic_review',
    'mcp__whiteboard__list_templates',
    'mcp__whiteboard__instantiate_template',
    'mcp__whiteboard__yield_step',
    'Read',
  ];

  const steps: StepRecord[] = [];
  let totalInputTokens: number | null = null;
  let totalOutputTokens: number | null = null;
  let aggregateCachedHit = false;
  let finishedCleanly = false;
  let sawRateLimit = false;
  // Round-14c — advisory post-export critic verdict. Populated after
  // the step-loop terminates cleanly; null otherwise.
  let postExportVerdict: CritiqueVerdict | null = null;

  try {
    for (let stepNum = 0; stepNum < STEP_LOOP_MAX_STEPS; stepNum++) {
      const stepStart = Date.now();
      clearLastYield();
      const userPrompt = buildPass2StepPrompt({
        baseArgs: args,
        stepNum,
        priorSteps: getYieldHistory(),
      });

      console.log(
        `[Whiteboard Pass2-StepLoop] step #${stepNum} BEGIN ` +
          `priorSteps=${steps.length} elements=${getScene().elements.length}`,
      );

      // Round-14e: SDK post-iterator rethrow guard — see chat
      // step-loop for full rationale. When the agent hits maxTurns
      // without yielding, the SDK delivers result + then throws on
      // the next .next(); without this catch the throw escapes the
      // step-loop and fails the whole Pass 2 generation. The runner
      // exposes this via `caughtPostIteratorThrow`.
      const session = await runAgentSession({
        prompt: userPrompt,
        systemPrompt: PASS2_SYSTEM,
        model: 'claude-opus-4-7',
        mcpServers: { whiteboard: mcp },
        // Round 14e — REVERTED settingSources/strictMcpConfig (step-loop site).
        allowedTools,
        additionalDirectories: [args.indexPath],
        includePartialMessages: true,
        abortController: args.abortController,
        cwd,
        pathToClaudeCodeExecutable,
        // Per-step budget — small. One section's worth of work
        // (~3-10 tool calls + 1 yield_step) should land well under
        // this. If we hit it, the step terminates and the outer
        // loop re-issues anyway (treats it as an implicit yield).
        maxTurns: STEP_LOOP_PER_STEP_MAX_TURNS,
        rateLimitDetection: true,
        postIteratorThrowGuard: true,
        onTextDelta: (chunk) => args.onProgress?.(chunk),
        onToolUse: (rawName) => {
          const toolName = rawName.replace(/^mcp__whiteboard__/, '');
          args.onProgress?.(`\n🔧 ${toolName}\n`);
        },
      });

      const stepInputTokens = session.inputTokens;
      const stepOutputTokens = session.outputTokens;
      const stepCachedHit = session.cachedPrefixHit;
      const stepToolCount = session.toolUseCount;
      const stepSawResult = session.sawResult;
      if (session.sawRateLimitRejected) {
        sawRateLimit = true;
        console.warn(
          `[Whiteboard Pass2-StepLoop] step #${stepNum} rate_limit_event REJECTED — stream aborted by runner.`,
        );
      }
      if (
        session.resultSubtype === 'error_max_turns' ||
        session.resultSubtype === 'error_during_execution'
      ) {
        console.warn(
          `[Whiteboard Pass2-StepLoop] step #${stepNum} ${session.resultSubtype}; treating as implicit yield`,
        );
      }
      if (session.caughtPostIteratorThrow) {
        const { kind, message } = session.caughtPostIteratorThrow;
        console.warn(
          `[Whiteboard Pass2-StepLoop] step #${stepNum} SDK post-iterator throw (${kind}); treating as implicit yield. msg="${message.slice(0, 200)}"`,
        );
      }

      const yieldArgs = getLastYield();
      const stepDurationMs = Date.now() - stepStart;
      const sceneSize = getScene().elements.length;
      // Aggregate token + cache stats. We sum step tokens because each
      // step is a separate billable Anthropic call.
      if (stepInputTokens !== null) {
        totalInputTokens = (totalInputTokens ?? 0) + stepInputTokens;
      }
      if (stepOutputTokens !== null) {
        totalOutputTokens = (totalOutputTokens ?? 0) + stepOutputTokens;
      }
      if (stepCachedHit) aggregateCachedHit = true;

      const summary = yieldArgs?.stepSummary ?? '(no yield_step — implicit step boundary)';
      const done = yieldArgs?.done === true;

      const record: StepRecord = {
        stepNum,
        summary,
        done,
        sceneSize,
        durationMs: stepDurationMs,
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        cachedPrefixHit: stepCachedHit,
      };
      steps.push(record);

      console.log(
        `[Whiteboard Pass2-StepLoop] step #${stepNum} END ` +
          `summary="${summary.slice(0, 80)}${summary.length > 80 ? '…' : ''}" ` +
          `done=${done} elements=${sceneSize} tools=${stepToolCount} ` +
          `tokens(in=${stepInputTokens ?? '?'}, out=${stepOutputTokens ?? '?'}) ` +
          `cache=${stepCachedHit ? 'HIT' : 'miss'} t=${stepDurationMs}ms`,
      );

      args.onStep?.({ stepNum, summary, done, sceneSize });

      // Round-14b — bail on rate-limit (don't try to re-issue, the
      // next step will hit the same wall). Persist whatever's
      // emitted so far.
      if (sawRateLimit && !stepSawResult) break;

      if (done) {
        finishedCleanly = true;
        break;
      }

      // No yield_step + no result is the abnormal path; treat as
      // implicit yield so we don't deadlock. The next step will see
      // priorSteps = [..., implicit] and the agent should converge.
      // (The PASS2_SYSTEM teaches the agent to call yield_step
      // explicitly; this branch is just a safety net.)
    }

    // ----------------------------------------------------------------
    // Round-14c — POST-EXPORT CRITIC (advisory).
    //
    // After the agent has finished its step-loop cleanly + the scene
    // is non-empty, run ONE critic call here in the orchestrator (not
    // mid-loop the way `request_critic_review` does in pass2 mode).
    // The verdict is purely advisory — non-blocking, surfaced via IPC
    // so a future advisory-badge UI can show defects without blocking
    // ship. Per dispatch round 14c: "If verdict.pass === false, do
    // NOT auto-patch this dispatch. The user-acceptance flow is round
    // 14d UX work."
    //
    // CRITICAL: this MUST run before `dispose()` (in the finally
    // below) because dispose tears down the render-server subprocess
    // that `renderScene` depends on. Hence the call is inside the
    // try, not after it.
    // ----------------------------------------------------------------
    if (finishedCleanly && getScene().elements.length > 0) {
      try {
        const finalScene = getScene();
        const pngBytes = await renderScene(finalScene);
        // Optionally hand the PNG to the host for persistence (e.g.
        // Fathom saves a render-snapshot for in-app debug viewing).
        // The pipeline never writes to disk itself — runCritique
        // takes the buffer directly.
        if (args.onArtifact) {
          await args.onArtifact({
            type: 'render-snapshot',
            name: `wb-postexport-critic-${args.paperHash.slice(0, 10)}-${Date.now()}.png`,
            body: pngBytes,
          });
        }
        console.log(
          `[Whiteboard Pass2-StepLoop] post-export critic BEGIN ` +
            `elements=${finalScene.elements.length} png=${pngBytes.length}b`,
        );
        const result = await runCritique({
          paperHash: args.paperHash,
          indexPath: args.indexPath,
          iter: 1, // single advisory round
          pngBytes,
          sceneJsonString: JSON.stringify(finalScene),
          pathToClaudeCodeExecutable,
        });
        postExportVerdict = result.verdict;
        console.log(
          `[Whiteboard Pass2-StepLoop] post-export critic END ` +
            `verdict=${
              result.verdict
                ? `pass=${result.verdict.pass} defects=${result.verdict.defects.length}`
                : 'unparseable'
            } cost=$${result.costUsd.toFixed(4)}`,
        );
      } catch (err) {
        // Critic is advisory — never block the user's diagram on a
        // critic call failure. Log + continue.
        console.warn(
          `[Whiteboard Pass2-StepLoop] post-export critic failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } finally {
    try {
      await dispose();
    } catch (err) {
      console.warn('[Whiteboard Pass2-StepLoop] render-server dispose failed', err);
    }
  }

  if (sawRateLimit && steps.length === 0) {
    throw new Error(
      'Rate limit hit before the whiteboard could finish step 0. Wait a minute and try again.',
    );
  }

  const scene = getScene();
  const sceneJson = JSON.stringify(scene);
  if (args.level === 2 && args.parentNodeId) {
    (scene.appState as Record<string, unknown>).fathomParentNodeId = args.parentNodeId;
  }

  const latencyMs = Date.now() - t0;
  const inTokensEst = totalInputTokens ?? 0;
  const outTokensEst = totalOutputTokens ?? 0;
  // Cost estimate: Opus pricing on input + output. Cached prefix
  // discount applied if any step reported a cache hit (conservative
  // since some steps may not have hit; the next dispatch can refine
  // by tracking per-step cache_read_input_tokens separately).
  const inputCost = aggregateCachedHit
    ? (inTokensEst / 1_000_000) * OPUS_INPUT_USD_PER_MTOKEN * CACHE_DISCOUNT
    : (inTokensEst / 1_000_000) * OPUS_INPUT_USD_PER_MTOKEN;
  const costUsd = inputCost + (outTokensEst / 1_000_000) * OPUS_OUTPUT_USD_PER_MTOKEN;

  console.log(
    `[Whiteboard Pass2-StepLoop] END paper=${args.paperHash.slice(0, 10)} ` +
      `steps=${steps.length} finishedCleanly=${finishedCleanly} ` +
      `elements=${scene.elements.length} ` +
      `tokens(in=${totalInputTokens ?? '?'}, out=${totalOutputTokens ?? '?'}) ` +
      `cache=${aggregateCachedHit ? 'HIT' : 'miss'} ` +
      `cost=$${costUsd.toFixed(4)} t=${latencyMs}ms`,
  );

  return {
    raw: sceneJson,
    costUsd,
    latencyMs,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cachedPrefixHit: aggregateCachedHit,
    steps,
    finishedCleanly,
    criticVerdict: postExportVerdict,
  };
}

/** Build the user prompt for one step of the step-loop.
 *
 * Step 0 = full PASS A planning brief (paper-driven section count,
 * template selection per section, ground-problem sentence, ...).
 *
 * Step N (N≥1) = same Pass 1 understanding doc + render request, plus
 * a short "you have already emitted these steps; continue with the
 * next one and call yield_step when done" suffix containing the
 * prior steps' summaries.
 *
 * The shared prefix (system prompt + understanding doc + render
 * request) is identical across steps so the Anthropic prompt cache
 * hits from step 1 onward.
 */
function buildPass2StepPrompt(opts: {
  baseArgs: RunPass2Args;
  stepNum: number;
  priorSteps: readonly { stepSummary: string; done?: boolean }[];
}): string {
  const parts: string[] = [];
  parts.push(`<pass1_understanding>\n${opts.baseArgs.understanding}\n</pass1_understanding>`);
  parts.push(`<render_request>\n${opts.baseArgs.renderRequest}\n</render_request>`);
  if (opts.baseArgs.level === 2 && opts.baseArgs.parentNodeId) {
    parts.push(
      `You are authoring the Level 2 expansion of the Level 1 node with id "${opts.baseArgs.parentNodeId}". ` +
        `Focus on the components INSIDE that node — the renderer offsets your scene below the parent automatically. ` +
        `Place sub-nodes at y=0 in your scene; the offset happens later.`,
    );
  }

  if (opts.stepNum === 0) {
    parts.push(
      `STEP 0 — PLANNING.\n\n` +
        `Read the understanding doc above + call read_diagram_guide + list_templates ONCE to see the catalog. ` +
        `Then PLAN the section breakdown for this whiteboard:\n` +
        `  - One ground-problem sentence (the paper's end-goal in plain reader language).\n` +
        `  - Section count (paper-driven — theory: 2, methods: 3, survey: 4-5, ablation: 2).\n` +
        `  - Template per section (flow-chart / comparison-matrix / time-chain / key-insight-callout / primitives-mode).\n` +
        `  - Per-section args sketch.\n\n` +
        `Emit the plan as a brief assistant text (no tool calls beyond read_diagram_guide + list_templates). ` +
        `Then call yield_step({stepSummary: "Plan: <one-line plan summary>"}). ` +
        `DO NOT emit any create_section / instantiate_template / create_* calls in this step — that is step 1+.`,
    );
  } else {
    const priorSummaries = opts.priorSteps
      .map((s, i) => `  ${i}. ${s.stepSummary}${s.done ? ' [done]' : ''}`)
      .join('\n');
    parts.push(
      `STEP ${opts.stepNum} — EMIT.\n\n` +
        `Prior steps:\n${priorSummaries || '  (none yet)'}\n\n` +
        `Emit ONE section's worth of work in this step (one create_section + the templates / primitives / camera ` +
        `for that section). Then call yield_step({stepSummary: "<user-readable one-liner>"}). ` +
        `If this is the FINAL section, set done: true so the orchestrator can stop the loop. ` +
        `If you need a screenshot of the canvas to verify what's landed before deciding the next step, set ` +
        `screenshotRequest: true and the next step's prompt will include a PNG of the current scene.\n\n` +
        `stepSummary should be user-readable language (e.g. "§1 Architecture: 5-node flow-chart from photos to mesh") — ` +
        `it surfaces in the status strip the user sees while the loop runs.`,
    );
  }
  return parts.join('\n\n');
}

function buildPass2Prompt(args: RunPass2Args): string {
  const parts: string[] = [];
  parts.push(`<pass1_understanding>\n${args.understanding}\n</pass1_understanding>`);
  parts.push(`<render_request>\n${args.renderRequest}\n</render_request>`);
  if (args.level === 2 && args.parentNodeId) {
    parts.push(
      `You are authoring the Level 2 expansion of the Level 1 node with id "${args.parentNodeId}". Focus on the components INSIDE that node — the renderer offsets your scene below the parent automatically. Place sub-nodes at y=0 in your scene; the offset happens later.`,
    );
  } else {
    parts.push(
      `Render the diagram from the understanding doc. ` +
      `This is a multi-section whiteboard — at minimum the architecture section is required, ` +
      `with math + KEY IDEA recommended if the paper has equations or a thesis.`,
    );
  }
  // v3.2.1 — explicit workflow that mirrors PASS2_SYSTEM. Earlier
  // prompts said "create_node_with_fitted_text + connect_nodes per the
  // understanding doc," which collapsed the agent into a v2 single-row
  // pipeline. The critic graded that REJECTED. The section/zone/callout/
  // camera workflow IS the contract — name it explicitly, in order.
  parts.push(
    `Begin by calling read_diagram_guide. Then PLAN the section breakdown ` +
    `before any create_* calls (architecture is required; math + KEY IDEA recommended ` +
    `if the paper has equations or a thesis). ` +
    `For EACH section: create_section → create_background_zone(s) → inner shapes/text/callouts → ` +
    `connect_nodes for arrows → set_camera for the storyboard frame. ` +
    `Emit shapes in narrative order (zone, then its inner shapes one at a time, then the next zone) — ` +
    `NOT all rectangles first, then all text, then all arrows. ` +
    `Verify with describe_scene. Then call look_at_scene and self-critique against the 6 design-grammar ` +
    `rules: zones do the categorization, colors are role-correct, camera reads as narration, narrative ` +
    `order, modality matches content, math is text not boxes. Iterate up to 3 rounds. ` +
    `Finish with export_scene.`,
  );
  return parts.join('\n\n');
}

// --------------------------------------------------------------------
// Soft verifier — background grep-check of inline citations
// --------------------------------------------------------------------

/**
 * Extract every `[p.N]: "quote"` or `[p.N] "quote"` citation from the
 * Pass 1 markdown and grep-verify each against `content.md`.
 *
 * Trigram overlap is the score: ≥0.85 = verified; ≥0.50 = soft;
 * <0.50 = unverified. The verifier never mutates the diagram — it
 * just writes `whiteboard-issues.json`.
 */
export async function runVerifier(args: {
  paperHash: string;
  indexPath: string;
  understanding: string;
  /** Optional persistence hook — fired with the verifier issues JSON
   *  so hosts can save it for the renderer's "unverified citation"
   *  affordance. Pipeline does not write to disk. */
  onArtifact?: (artifact: PipelineArtifact) => Promise<void>;
}): Promise<VerifierResult> {
  const t0 = Date.now();
  const contentPath = join(args.indexPath, 'content.md');
  if (!existsSync(contentPath)) {
    console.warn(`[Whiteboard Verifier] no content.md at ${contentPath}; skipping verification`);
    return { issues: [], verificationRate: 1, quoteStatus: {} };
  }
  const content = await readFile(contentPath, 'utf-8');
  const normalisedContent = normalise(content);

  const citations = extractCitations(args.understanding);
  console.log(
    `[Whiteboard Verifier] BEGIN paper=${args.paperHash.slice(0, 10)} ` +
      `quotes=${citations.length}`,
  );

  const issues: VerifierIssue[] = [];
  const quoteStatus: Record<string, VerifierIssue> = {};

  for (const c of citations) {
    const target = normalise(c.quote);
    if (target.length < 8) {
      // Too short to score reliably — assume verified rather than
      // peppering the doc with question marks on bare words.
      const issue: VerifierIssue = {
        page: c.page,
        quote: c.quote,
        score: 1,
        status: 'verified',
        closest: c.quote,
      };
      issues.push(issue);
      quoteStatus[c.quote] = issue;
      continue;
    }
    const { score, closest } = bestTrigramOverlap(target, normalisedContent);
    const status: VerifierIssue['status'] =
      score >= 0.85 ? 'verified' : score >= 0.5 ? 'soft' : 'unverified';
    const issue: VerifierIssue = {
      page: c.page,
      quote: c.quote,
      score,
      status,
      closest: closest.length > 240 ? closest.slice(0, 240) + '…' : closest,
    };
    issues.push(issue);
    quoteStatus[c.quote] = issue;
  }

  const verifiedCount = issues.filter((i) => i.status === 'verified').length;
  const verificationRate = issues.length > 0 ? verifiedCount / issues.length : 1;

  // Emit the verifier issues to the host for persistence. The
  // pipeline does not write to disk; hosts that want the issues
  // surfaced to the renderer's "unverified citation" affordance
  // implement `onArtifact`.
  if (args.onArtifact) {
    await args.onArtifact({
      type: 'issues',
      name: WB_ISSUES_FILE,
      body: JSON.stringify(
        { paperHash: args.paperHash, generatedAt: new Date().toISOString(), verificationRate, issues },
        null,
        2,
      ),
    });
  }

  console.log(
    `[Whiteboard Verifier] END paper=${args.paperHash.slice(0, 10)} ` +
      `verified=${verifiedCount}/${issues.length} (${(verificationRate * 100).toFixed(0)}%) ` +
      `t=${Date.now() - t0}ms`,
  );

  return { issues, verificationRate, quoteStatus };
}

interface ExtractedCitation {
  page: number;
  quote: string;
}

/** Pull `[p.N]: "quote"`, `[p.N] "quote"`, and `[p.N]: 'quote'` out
 * of a markdown body. Tolerant to alternate quote chars and the
 * presence/absence of the colon. */
function extractCitations(md: string): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  // Pattern: [p.N] optional colon, then a quoted string in " or '.
  const re = /\[p\.\s*(\d+)\]\s*:?\s*["“'‘]([^"”'’]{4,400})["”'’]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(md)) !== null) {
    const page = parseInt(match[1], 10);
    const quote = match[2].trim();
    if (Number.isFinite(page) && page > 0 && quote.length > 0) {
      out.push({ page, quote });
    }
  }
  return out;
}

function normalise(s: string): string {
  // Lowercase, collapse whitespace, strip punctuation. Aggressive on
  // purpose — we're matching paraphrased / re-typed quotes, not byte-
  // exact substrings.
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best trigram overlap between `target` and any window of the same
 * length within `content`. Returns the score (0..1) and the matched
 * passage substring at the best window. */
function bestTrigramOverlap(target: string, content: string): { score: number; closest: string } {
  const targetGrams = trigrams(target);
  if (targetGrams.size === 0) return { score: 0, closest: '' };

  // Slide a window of `target.length` over content. Step by half the
  // window for performance; trigram overlap is robust to alignment
  // shifts of a few words.
  const winLen = Math.max(target.length, 24);
  const step = Math.max(8, Math.floor(winLen / 4));
  let bestScore = 0;
  let bestStart = -1;
  for (let i = 0; i + winLen <= content.length; i += step) {
    const window = content.slice(i, i + winLen);
    const winGrams = trigrams(window);
    const intersection = countIntersect(targetGrams, winGrams);
    const score = intersection / targetGrams.size;
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
    // Early exit on a clean match.
    if (bestScore >= 0.95) break;
  }
  // Also try a tail window in case the loop's step missed it.
  if (content.length >= winLen) {
    const tail = content.slice(content.length - winLen);
    const tailScore = countIntersect(targetGrams, trigrams(tail)) / targetGrams.size;
    if (tailScore > bestScore) {
      bestScore = tailScore;
      bestStart = content.length - winLen;
    }
  }

  const closest =
    bestStart >= 0 ? content.slice(bestStart, bestStart + winLen) : '';
  return { score: bestScore, closest };
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

function countIntersect<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/** Rough token estimate for cost reporting when the SDK didn't surface
 * usage. ~4 chars/token is the standard Anthropic rule of thumb. */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
