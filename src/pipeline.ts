import { query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { COLEAM_SKILL } from './skill.js';
import { EXCALIDRAW_CHEAT_SHEET } from './recall-cheat-sheet.js';
import {
  HOSTED_EXCALIDRAW_MCP_URL,
  spawnLocalMcp,
  type McpHandle,
} from './mcp-launcher.js';
import type {
  GenerateCallbacks,
  PaperRef,
  WhiteboardScene,
} from './types.js';

// The Agent SDK spawns the `claude` binary as a subprocess. When this
// pipeline runs inside an Electron main process whose cwd ends up as
// an `app.asar` virtual path (Electron's hook reports it as a dir;
// Node's actual posix_spawn syscall sees it as a file → ENOTDIR), the
// whole pipeline collapses with a bare "spawn ENOTDIR" error before
// any MCP tool fires. Picking a guaranteed-real directory side-steps
// that. Homedir is always a real dir on macOS; outside macOS we still
// prefer it over inheriting a possibly-asar cwd.
function safeAgentCwd(): string {
  const home = homedir();
  try {
    if (existsSync(home) && statSync(home).isDirectory()) return home;
  } catch {
    /* fall through */
  }
  return '/';
}

// Only one MCP tool we want the agent to call. `read_me` is now
// inlined into the system prompt so we don't burn a tool turn on it.
// The MCP server still exposes read_me for backward compat, but it's
// not in our allowedTools list — the agent never sees it.
const EXCALIDRAW_TOOLS = ['mcp__excalidraw__create_view'];

// arXiv MCP — gives the agent the ability to pull a cited paper from
// arxiv.org and read it locally during a generation. Useful when the
// user pastes a snippet that references a prior work the agent doesn't
// already know, or when a refine instruction asks "compare this to
// paper X."
const ARXIV_TOOLS = [
  'mcp__arxiv__search_papers',
  'mcp__arxiv__download_paper',
  'mcp__arxiv__list_downloaded_papers',
];

// System prompt = SKILL principles + Excalidraw element-format
// reference (formerly returned by `read_me`) + Fathom-specific
// suffix. By inlining the cheat sheet we save one full tool
// round-trip per generation — the model already has every detail it
// needs about element types, colors, camera sizes, etc., on session
// start.
//
// The suffix tells the agent two things neither the SKILL nor the
// cheat sheet covers:
//   (1) HOW to drive create_view progressively (multiple calls,
//       restoreCheckpoint between them).
//   (2) The subject is a research paper; every named component
//       must be paired with the question it answers about the
//       paper's ground problem.
//
// No examples on purpose: the model treats every example as a
// template to slot-fill. Principles only.
const SYSTEM_SUFFIX = `

────────────────────────────

# Fathom whiteboard

You are explaining a research paper as a teaching whiteboard. The
paper is provided in the user message. Apply the SKILL and the
Excalidraw element-format reference above, then layer the specifics
below.

## 1. How to use the MCP

You have ONE tool: \`mcp__excalidraw__create_view\`. Build the
diagram in **multiple \`create_view\` calls** so the canvas updates
progressively. Each subsequent call begins with a
\`restoreCheckpoint\` element referencing the \`checkpointId\`
returned by the previous call, then appends new elements.

Every call should leave the canvas in a coherent intermediate state
that a viewer would recognise as a meaningful step toward the final
picture, not a half-rendered fragment. How many calls and what each
one contains is your judgement — the subject decides.

If a call produced something wrong (overlap, mislabelled arrow,
wrong proportions), use the \`delete\` element inside the next call
to remove and replace.

You do NOT need to call any \`read_me\` tool — the format reference
is already in your context above. Start drawing immediately.

## 2. Ground-problem framing

Identify the paper's ground problem first — one sentence stating
what the paper is trying to deliver — before naming any component.

Every named component on the canvas must be paired with the question
it answers about that ground problem. Each question must trace back
to the ground problem, never to another component.

The component name is the primary visual element. The ground-problem
question accompanies it in secondary, smaller text — close enough to
read together, restrained enough not to crowd the name.

## 3. Constraints to remove

- You do not need to render math equations. Include one only if it
  makes a component's role visibly clearer.
- You do not need to follow any particular layout. Let the paper's
  own structure decide.
- You do not need to cover every section of the paper. Pick what is
  load-bearing for the central argument; let the rest go.
- Use the paper's own vocabulary. Substitutions invented by the
  agent are wrong.`;

// Built once and reused across calls — keeping the systemPrompt
// byte-identical lets Anthropic's prompt cache hit on every
// subsequent call within the 5-minute TTL. The system prompt is
// ~16KB (COLEAM_SKILL + cheat sheet + suffix) so the cache savings
// are substantial: a cache hit pays only for the cache_read input
// tokens (≈10% of full-input pricing) instead of re-processing the
// full prefix.
const CACHED_SYSTEM_PROMPT = `${COLEAM_SKILL}\n\n────────────────────────────\n\n${EXCALIDRAW_CHEAT_SHEET}${SYSTEM_SUFFIX}`;

// Appended only when arxiv tools are enabled. Goes AFTER the cached
// prefix so prompt-caching still hits on the long stable head — only
// the small arxiv tail re-encodes when the toggle is on.
const ARXIV_APPENDIX = `

## 4. Optional: arxiv access

You can pull cited prior work from arxiv when it would meaningfully
sharpen the diagram. Three tools are available:

- \`mcp__arxiv__search_papers\` — search arxiv by query
- \`mcp__arxiv__download_paper\` — fetch a paper's text by arxiv id
- \`mcp__arxiv__list_downloaded_papers\` — list what's already local

Use sparingly. The user's paper is the primary source. Reach for
arxiv only when the paper directly cites a prior work whose mechanism
you need to name correctly on the canvas, and you can't infer it from
context.`;

function buildSystemPrompt(opts: { arxivEnabled: boolean }): string {
  return opts.arxivEnabled
    ? CACHED_SYSTEM_PROMPT + ARXIV_APPENDIX
    : CACHED_SYSTEM_PROMPT;
}

// Cache-friendly ordering: stable paper text comes FIRST, variable
// per-call content (focus, instruction, scene) comes LAST. With the
// API's prompt-cache prefix matching, refines on the same paper hit
// the paper bytes from cache and only pay for the trailing variable
// tail. The biggest wins come from research papers where the paper
// markdown is 30-200KB.
function buildUserMessage(paper: PaperRef, prompt?: string, focus?: string): string {
  const titleLine = paper.title ? `# ${paper.title}\n\n` : '';
  // When the user has supplied a focus, surface it prominently so the
  // model treats it as the load-bearing instruction rather than a
  // suggestion buried after the paper text.
  const focusBlock = focus && focus.trim().length > 0
    ? `## Focus for this whiteboard\n\n${focus.trim()}\n\nLet this focus drive the diagram's central argument and what gets foregrounded. Out-of-focus parts of the paper should fall away or sit on the periphery.\n\n`
    : '';
  if (paper.kind === 'text') {
    return `${titleLine}${paper.markdown}\n\n${focusBlock}${prompt ?? 'Generate the teaching whiteboard now.'}`;
  }
  return `${titleLine}The paper is at: ${paper.absPath}\n\nRead it (you may use the Read tool), then generate the teaching whiteboard.\n\n${focusBlock}${prompt ?? ''}`;
}

// Resolve a create_view tool input against the previous scene, mirroring
// the vendor's checkpoint-resolve logic at
// vendor/excalidraw-mcp/src/server.ts:454-482. The vendor's input schema
// declares `elements: string` (JSON-encoded array). After the first call
// the agent sends only a delta — a `restoreCheckpoint` element pointing
// at the prior checkpointId, plus new elements (and possibly `delete`
// elements). To keep the renderer in sync without an extra round-trip
// to read_checkpoint, we apply the same merge here.
//
// Returns the new resolved scene, or null if the input can't be parsed.
type ExcalidrawElement = WhiteboardScene['elements'][number];

// Vendor MCP defines three "pseudo-elements" that are part of its wire
// protocol but NOT real Excalidraw element types. Excalidraw's
// updateScene rejects/ignores scenes containing them.
//   - cameraUpdate: vendor uses this to animate its own canvas viewport
//     (mcp-app.html). Required as the first element of every create_view
//     per vendor's docs. Useless to our renderer.
//   - restoreCheckpoint: vendor's delta-protocol marker pointing at a
//     prior scene id. Resolved upstream in this function.
//   - delete: vendor's deletion protocol. Resolved upstream too.
const PSEUDO_ELEMENT_TYPES = new Set([
  'cameraUpdate',
  'restoreCheckpoint',
  'delete',
]);

function isPseudoElement(el: unknown): boolean {
  if (typeof el !== 'object' || el === null) return false;
  const t = (el as Record<string, unknown>).type;
  return typeof t === 'string' && PSEUDO_ELEMENT_TYPES.has(t);
}

function resolveSceneFromInput(
  input: unknown,
  prev: WhiteboardScene,
): WhiteboardScene | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.elements !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(obj.elements);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const restoreEl = parsed.find(
    (el: unknown) =>
      typeof el === 'object' &&
      el !== null &&
      (el as Record<string, unknown>).type === 'restoreCheckpoint',
  );

  if (restoreEl) {
    // Delta call: gather deleteIds, filter prev, append new els.
    const deleteIds = new Set<string>();
    for (const el of parsed) {
      const e = el as Record<string, unknown>;
      if (e.type === 'delete') {
        const ids = String(e.ids ?? e.id ?? '');
        for (const id of ids.split(',')) {
          const t = id.trim();
          if (t) deleteIds.add(t);
        }
      }
    }
    const baseFiltered = prev.elements.filter((el) => {
      const e = el as Record<string, unknown>;
      const id = typeof e.id === 'string' ? e.id : '';
      const containerId =
        typeof e.containerId === 'string' ? e.containerId : '';
      return !deleteIds.has(id) && !deleteIds.has(containerId);
    });
    const newEls = parsed.filter(
      (el: unknown) => !isPseudoElement(el),
    ) as ExcalidrawElement[];
    return { elements: [...baseFiltered, ...newEls] };
  }

  // First call (or agent reset): take everything except pseudo-elements.
  const elements = parsed.filter(
    (el: unknown) => !isPseudoElement(el),
  ) as ExcalidrawElement[];
  return { elements };
}

// `mcpOverride` lets advanced consumers point the pipeline at a
// pre-spawned MCP (their own, hosted, mocked for tests, etc.). When
// undefined, the pipeline spawns a fresh local instance per call.
export type McpOverride = McpHandle;

async function resolveMcp(override: McpOverride | undefined): Promise<McpHandle> {
  if (override) return override;
  return spawnLocalMcp();
}

async function runAgent(opts: {
  systemPrompt: string;
  userMessage: string;
  mcpUrl: string;
  paperReadPath?: string; // when paper.kind === 'path', allow Read tool on it
  // WebSearch availability — when false, the agent can only ground in
  // the paper text itself. Defaults true (the historical behaviour).
  webSearch?: boolean;
  // arXiv MCP server config — pass `command` + `args` to spawn a stdio
  // MCP that exposes search_papers / download_paper / list_downloaded_papers.
  // When undefined, the agent simply doesn't have arxiv access.
  arxivMcp?: { command: string; args: string[]; env?: Record<string, string> };
  // When the SDK runs inside an Electron app.asar bundle, its default
  // resolution of the bundled `claude` binary path (via import.meta.url)
  // points at `app.asar/.../claude`. asar's hook lets Electron Read that
  // path, but child_process.spawn() goes through the real filesystem and
  // sees `app.asar` as a FILE → ENOTDIR. Hosts that ship inside asar
  // (Fathom) must pre-resolve the unpacked binary path and pass it here;
  // standalone Node hosts (clawdSlate dev, raw library users) leave it unset
  // and the SDK default works.
  pathToClaudeCodeExecutable?: string;
  // Caller-supplied controller so the host can abort an in-flight run
  // (e.g. the user types a new prompt and hits Send while a generation
  // is still streaming). When the signal is aborted mid-stream the SDK
  // raises an AbortError; we catch it, log `[aborted]`, and return what
  // we have so far rather than propagating the throw.
  abortController?: AbortController;
  cb?: GenerateCallbacks;
}): Promise<{ scene: WhiteboardScene; turns: number; usd: number }> {
  const {
    systemPrompt,
    userMessage,
    mcpUrl,
    paperReadPath,
    webSearch = true,
    arxivMcp,
    pathToClaudeCodeExecutable,
    abortController,
    cb,
  } = opts;

  // WebSearch lets the agent look up external context the paper
  // references (a cited prior work, a technical term it doesn't
  // define). Read is added when the paper itself is a file path the
  // agent has to open. Everything else (Bash, Grep, Glob, ToolSearch,
  // the rest of the claude_code preset) stays disabled so the
  // single-purpose JSON-emission task isn't taxed by tool
  // descriptions it never uses.
  const allowedTools = [
    ...EXCALIDRAW_TOOLS,
    ...(arxivMcp ? ARXIV_TOOLS : []),
    ...(webSearch ? ['WebSearch'] : []),
    ...(paperReadPath ? ['Read'] : []),
  ];

  const mcpServers: Record<string, unknown> = {
    excalidraw: { type: 'http', url: mcpUrl },
  };
  if (arxivMcp) {
    mcpServers.arxiv = {
      type: 'stdio',
      command: arxivMcp.command,
      args: arxivMcp.args,
      ...(arxivMcp.env ? { env: arxivMcp.env } : {}),
    };
  }

  const stream = query({
    prompt: userMessage,
    options: {
      // Plain-string system prompt (not the claude_code preset) — the
      // preset adds 40+ builtin-tool descriptions, file-system orientation,
      // and dynamic sections we don't want for a single-purpose
      // diagram-generation agent. Pure SKILL + Fathom suffix only.
      systemPrompt,
      cwd: safeAgentCwd(),
      mcpServers,
      allowedTools,
      // Builtin-tool allowlist. The claude_code preset auto-loads ~40
      // tools (Bash, Glob, Grep, ToolSearch, …) which we don't need
      // for a single-purpose diagram-emission task; each one taxes
      // input-token budget per turn. We keep WebSearch (so the agent
      // can look up a cited reference or a technical term) and Read
      // (only when the paper is on disk). Both honour their toggles.
      tools: [
        ...(webSearch ? ['WebSearch'] : []),
        ...(paperReadPath ? ['Read'] : []),
      ],
      // Disable host-side setting sources (CLAUDE.md, project config,
      // user config) so the pipeline runs with exactly the prompt we
      // authored, nothing else.
      settingSources: [],
      includePartialMessages: true,
      // clawdSlate runs a single-purpose JSON-emission task (read_me, then
      // create_view with thousands of tokens of Excalidraw scene). Opus
      // is overkill for this — its strength is reasoning, but the
      // bottleneck here is output token rate, where Sonnet runs ~3×
      // faster and the diagram quality is comparable. Override per-run
      // via SLATE_MODEL=claude-opus-4-7 if a particularly hard paper
      // benefits from deeper planning.
      model: process.env.SLATE_MODEL || 'claude-sonnet-4-6',
      ...(pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable }
        : {}),
      ...(abortController ? { abortController } : {}),
    } as unknown as Parameters<typeof query>[0]['options'],
  });

  let scene: WhiteboardScene = { elements: [] };
  let turns = 0;
  let usd = 0;

  // Timing checkpoints — emitted as `[timing] phase=… elapsed=…s` so
  // the activity panel makes it obvious where seconds are going. Phases:
  //   submit  → query() returned, stream awaiting
  //   ttft    → first non-system event (model has actually started)
  //   create_view_start → input_json_delta begun for create_view
  //   create_view_done  → block_stop for the create_view tool_use
  //   total   → run finished
  // (read_me used to fire here too; it's now inlined into the system
  // prompt so the agent goes straight from ttft → create_view_start.)
  const t0 = Date.now();
  const tElapsed = () => ((Date.now() - t0) / 1000).toFixed(2);
  const checkpoint = (phase: string) => {
    cb?.onLog?.(`[timing] ${phase} elapsed=${tElapsed()}s`);
  };
  let sawTtft = false;
  checkpoint('submit');

  // Truncate-then-stringify for log lines. Tool inputs and results are
  // often large; we cap to keep the activity panel readable but still
  // diagnostic. Renderer side can choose to render these collapsed.
  const summarize = (val: unknown, max = 800): string => {
    let s: string;
    try {
      s = typeof val === 'string' ? val : JSON.stringify(val);
    } catch {
      s = String(val);
    }
    if (s.length <= max) return s;
    return `${s.slice(0, max)}… (+${s.length - max} chars)`;
  };

  // Token-stream progress tracking. With `includePartialMessages: true`
  // the SDK emits a `stream_event` for every delta the model produces.
  // The big silent gap users hit is between `read_me` returning and the
  // FULL `create_view` tool_use landing: the model is generating maybe
  // 5–20KB of input_json_delta tokens for the scene description. Without
  // surfacing those we look frozen. We log a heartbeat — current block
  // type + accumulated bytes + elapsed since last log — at most every
  // ~600ms so the activity panel doesn't flood.
  let progressBytes = 0;
  let progressBlockKind = '';
  let progressLastFlush = 0;
  let progressStart = 0;
  const PROGRESS_FLUSH_MS = 600;
  const flushProgress = (final = false) => {
    if (progressBytes === 0 && !final) return;
    const now = Date.now();
    if (!final && now - progressLastFlush < PROGRESS_FLUSH_MS) return;
    const elapsed = ((now - progressStart) / 1000).toFixed(1);
    const kind = progressBlockKind || 'text';
    cb?.onLog?.(
      `[thinking] ${kind} streaming · ${progressBytes.toLocaleString()} chars · ${elapsed}s`,
    );
    progressLastFlush = now;
  };
  const resetProgress = () => {
    progressBytes = 0;
    progressBlockKind = '';
    progressStart = Date.now();
    progressLastFlush = 0;
  };

  try {
  for await (const ev of stream) {
    if (!sawTtft && ev.type !== 'system') {
      sawTtft = true;
      checkpoint('ttft');
    }
    if (ev.type === 'assistant') {
      turns += 1;
      const blocks = (ev.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          cb?.onLog?.(`[assistant] ${block.text.slice(0, 200)}`);
          cb?.onAssistantText?.(block.text);
        } else if (block.type === 'tool_use') {
          const name = String(block.name ?? '');
          const id = String(block.id ?? '');
          cb?.onToolUse?.(name, block.input);
          cb?.onLog?.(`[tool_use] ${name} ${id ? `id=${id.slice(0, 8)} ` : ''}input=${summarize(block.input, 400)}`);
          if (name === 'mcp__excalidraw__create_view') checkpoint('create_view_done');
          if (name === 'mcp__excalidraw__create_view') {
            const next = resolveSceneFromInput(block.input, scene);
            // Empty scene is a meaningful resolved state — e.g. agent
            // emits [restoreCheckpoint, delete every-id] to start over.
            // Only `null` (parse failure) means "no signal."
            if (next) {
              scene = next;
              cb?.onSceneUpdate?.(scene);
            }
          }
        }
      }
    } else if (ev.type === 'user') {
      // The Agent SDK threads tool_result blocks back as `user` messages
      // — that's how the conversation loop closes. Surface them so the
      // user sees the agent isn't "stuck" — read_me has actually returned.
      const blocks = ((ev as { message?: { content?: unknown[] } }).message?.content ??
        []) as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const id = String(block.tool_use_id ?? '').slice(0, 8);
          const isErr = block.is_error === true;
          const content = block.content;
          let text: string;
          if (typeof content === 'string') text = content;
          else if (Array.isArray(content)) {
            text = content
              .map((c) => {
                const cc = c as Record<string, unknown>;
                return typeof cc.text === 'string' ? cc.text : JSON.stringify(cc);
              })
              .join('\n');
          } else text = summarize(content);
          cb?.onLog?.(
            `[tool_result] ${id ? `id=${id} ` : ''}${isErr ? 'ERROR ' : ''}${summarize(text, 800)}`,
          );
          checkpoint('tool_result');
        }
      }
    } else if (ev.type === 'result') {
      usd = (ev as { total_cost_usd?: number }).total_cost_usd ?? 0;
      // Cache stats — when subsequent calls within the 5-minute TTL
      // hit the cached system-prompt/user-message prefix,
      // cache_read tokens dominate over input. The activity panel
      // surfaces this so the user sees prompt-caching working.
      const u = (ev as { usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      } }).usage;
      const cacheRead = u?.cache_read_input_tokens ?? 0;
      const cacheCreate = u?.cache_creation_input_tokens ?? 0;
      const inputTok = u?.input_tokens ?? 0;
      const outputTok = u?.output_tokens ?? 0;
      cb?.onLog?.(
        `[result] turns=${turns} usd=${usd.toFixed(4)} input=${inputTok} output=${outputTok}` +
          (cacheRead || cacheCreate
            ? ` cache_read=${cacheRead} cache_create=${cacheCreate}`
            : ''),
      );
    } else if (ev.type === 'system') {
      // System init events carry useful info (which tools registered,
      // model, etc.). Surface a one-liner so the user sees the agent
      // *started* even before the first tool_use lands.
      const subtype = (ev as { subtype?: string }).subtype;
      if (subtype === 'init') {
        const tools = ((ev as { tools?: string[] }).tools ?? []).join(',');
        const model = (ev as { model?: string }).model ?? '?';
        cb?.onLog?.(`[system] init model=${model} tools=${tools}`);
      }
    } else if (ev.type === 'stream_event') {
      // Per-token deltas from the model. The SDK wraps Anthropic's
      // raw message-stream API events: content_block_start carries the
      // block kind (text vs tool_use) + name; content_block_delta
      // carries `text_delta` for text or `input_json_delta` for tool
      // input. We flush a heartbeat every ~600ms so the user sees
      // continuous progress while the model writes a 5–20KB
      // create_view input.
      const inner = ((ev as unknown as { event?: Record<string, unknown> })
        .event ?? {}) as Record<string, unknown>;
      const innerType = String(inner.type ?? '');
      if (innerType === 'content_block_start') {
        resetProgress();
        const cb2 = (inner.content_block ?? {}) as Record<string, unknown>;
        const blockType = String(cb2.type ?? '');
        if (blockType === 'tool_use') {
          progressBlockKind = `tool_use ${String(cb2.name ?? '')}`;
          if (String(cb2.name ?? '') === 'mcp__excalidraw__create_view') {
            checkpoint('create_view_start');
          }
        } else if (blockType === 'text') {
          progressBlockKind = 'assistant text';
        } else {
          progressBlockKind = blockType || 'block';
        }
        cb?.onLog?.(`[thinking] start ${progressBlockKind}`);
      } else if (innerType === 'content_block_delta') {
        const delta = (inner.delta ?? {}) as Record<string, unknown>;
        const dt = String(delta.type ?? '');
        if (dt === 'text_delta' && typeof delta.text === 'string') {
          progressBytes += (delta.text as string).length;
          cb?.onAssistantText?.(delta.text as string);
          flushProgress();
        } else if (dt === 'input_json_delta' && typeof delta.partial_json === 'string') {
          progressBytes += (delta.partial_json as string).length;
          flushProgress();
        }
      } else if (innerType === 'content_block_stop') {
        flushProgress(true);
      }
    }
  }
  } catch (err) {
    // AbortError — caller signalled the run should stop. Surface a
    // clean log line and return whatever scene we have so far rather
    // than rethrowing (which would force the host into the error
    // branch). Any other error propagates normally.
    const e = err as { name?: string; message?: string };
    const aborted =
      abortController?.signal.aborted ||
      e?.name === 'AbortError' ||
      /aborted|abort/i.test(e?.message ?? '');
    if (!aborted) throw err;
    cb?.onLog?.('[aborted] run cancelled by caller');
  }

  checkpoint('total');
  return { scene, turns, usd };
}

export async function generateWhiteboard(
  paper: PaperRef,
  cb?: GenerateCallbacks,
  mcpOverride?: McpOverride,
  focus?: string,
  pathToClaudeCodeExecutable?: string,
  abortController?: AbortController,
  arxivMcp?: { command: string; args: string[]; env?: Record<string, string> },
  webSearch: boolean = true,
): Promise<{ scene: WhiteboardScene; turns: number; usd: number }> {
  const handle = await resolveMcp(mcpOverride);
  const ownsHandle = !mcpOverride;
  try {
    const result = await runAgent({
      systemPrompt: buildSystemPrompt({ arxivEnabled: !!arxivMcp }),
      userMessage: buildUserMessage(paper, undefined, focus),
      mcpUrl: handle.url,
      paperReadPath: paper.kind === 'path' ? paper.absPath : undefined,
      webSearch,
      arxivMcp,
      pathToClaudeCodeExecutable,
      abortController,
      cb,
    });
    cb?.onDone?.(result);
    return result;
  } catch (err) {
    cb?.onError?.(err as Error);
    throw err;
  } finally {
    // Only dispose handles we created. Caller-supplied overrides retain
    // ownership — they may want to reuse the same instance across calls.
    if (ownsHandle) await handle.dispose();
  }
}

export async function refineWhiteboard(
  prevScene: WhiteboardScene,
  paper: PaperRef,
  userInstruction: string,
  cb?: GenerateCallbacks,
  mcpOverride?: McpOverride,
  pathToClaudeCodeExecutable?: string,
  abortController?: AbortController,
  arxivMcp?: { command: string; args: string[]; env?: Record<string, string> },
  webSearch: boolean = true,
): Promise<{ scene: WhiteboardScene; turns: number; usd: number }> {
  const handle = await resolveMcp(mcpOverride);
  const ownsHandle = !mcpOverride;
  try {
    const sceneJson = JSON.stringify(prevScene, null, 2);
    const userMessage =
      `${buildUserMessage(paper)}\n\n` +
      `## Current whiteboard scene\n\n` +
      `\`\`\`json\n${sceneJson}\n\`\`\`\n\n` +
      `## User instruction\n\n${userInstruction}\n\n` +
      `Apply the instruction. Call \`mcp__excalidraw__create_view\` with the updated elements JSON.`;
    const result = await runAgent({
      systemPrompt: buildSystemPrompt({ arxivEnabled: !!arxivMcp }),
      userMessage,
      mcpUrl: handle.url,
      paperReadPath: paper.kind === 'path' ? paper.absPath : undefined,
      webSearch,
      arxivMcp,
      pathToClaudeCodeExecutable,
      abortController,
      cb,
    });
    cb?.onDone?.(result);
    return result;
  } catch (err) {
    cb?.onError?.(err as Error);
    throw err;
  } finally {
    if (ownsHandle) await handle.dispose();
  }
}

export { HOSTED_EXCALIDRAW_MCP_URL };
