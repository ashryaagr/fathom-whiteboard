import { query } from '@anthropic-ai/claude-agent-sdk';
import { COLEAM_SKILL } from './skill.js';
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

const EXCALIDRAW_TOOLS = [
  'mcp__excalidraw__read_me',
  'mcp__excalidraw__create_view',
];

// System prompt = coleam SKILL.md verbatim + Fathom-specific suffix.
//
// The suffix layers Fathom's two extra requirements on top of the
// SKILL: (a) progressive on-canvas emission so the user watches the
// diagram build, and (b) ground-problem framing so every named
// component terminates at the paper's end goal rather than at another
// component.
const SYSTEM_SUFFIX = `

────────────────────────────

# Fathom whiteboard requirements

You are explaining a research paper as a teaching whiteboard. The
paper is provided in the user message. Apply every principle from
the SKILL above, then layer the two requirements below.

## 1. Progressive emission (the user watches the canvas build)

\`mcp__excalidraw__create_view\` supports incremental updates via the
\`restoreCheckpoint\` mechanism. Every \`create_view\` call returns a
\`checkpointId\` in its response. Subsequent calls can begin with
\`{"type":"restoreCheckpoint","id":"<previousCheckpointId>"}\` to keep
prior elements and append new ones — no need to re-send the full
diagram.

Use this to build the diagram in passes the user can SEE happening:

  Pass A — skeleton: containers, primary node rectangles with their
           label + ground-problem question (see §2), no internals.
           Emit via \`create_view\`.
  Pass B — internals: secondary nodes, sub-clusters, data labels.
           Emit via \`create_view\` with restoreCheckpoint.
  Pass C — connectives: arrows, edge labels, callouts, dashed
           legend lines. Emit via \`create_view\` with restoreCheckpoint.
  Pass D — polish: any final colour adjustments, spacing nudges,
           the explanatory caption. Emit via \`create_view\` with
           restoreCheckpoint.

Each pass should be a coherent visual unit (the canvas after Pass A
should look like a finished skeletal diagram even if no internals
exist yet — not a half-drawn fragment). Three or four passes is
right; more than five is thrash, fewer than two defeats the point.

Call \`mcp__excalidraw__read_me\` ONCE before Pass A.

## 2. Ground-problem framing on every named component

Identify the paper's ground problem first — one sentence — *before*
naming any component. Format: "Ground problem: <what is this paper
trying to give us?>". A real example for the Trellis paper: "Ground
problem: generate a 3D asset (geometry + PBR materials) from a single
image."

Every named component on the canvas MUST be paired with the question
it answers about that ground problem. Trace the question back to the
ground problem, NOT to another component.

  Wrong: "SS DiT" alone.
  Wrong: "SS DiT → operates on coarse latents"  (component-to-component)
  Right: "SS DiT → where in the voxel grid does the object sit?"

  Wrong: "cross-attention to DINOv3 patches"
  Right: "cross-attention to DINOv3 patches → what does this 3D point
          look like in each photo?"

Format on the canvas: keep the node's primary text short (the
component name itself, e.g. "SS DiT"). Put the ground-problem
question on a smaller secondary text element directly below the
node's rectangle, in a slightly lighter colour. Don't crowd the
node — a one-line question, ≤80 chars, italic-feeling.

## 3. Terminology

Use the paper's actual terminology — real symbol names, real loss
expressions, real component names. Do NOT use generic placeholders
like "Encoder" or "Module A". The finished diagram should let a
curious reader absorb the paper's central argument in 30 seconds:
what's the ground problem, what new idea is each component answering
about it, how do those answers compose.`;

function buildSystemPrompt(): string {
  return `${COLEAM_SKILL}${SYSTEM_SUFFIX}`;
}

function buildUserMessage(paper: PaperRef, prompt?: string): string {
  const titleLine = paper.title ? `# ${paper.title}\n\n` : '';
  if (paper.kind === 'text') {
    return `${titleLine}${paper.markdown}\n\n${prompt ?? 'Generate the teaching whiteboard now.'}`;
  }
  return `${titleLine}The paper is at: ${paper.absPath}\n\nRead it (you may use the Read tool), then generate the teaching whiteboard.\n\n${prompt ?? ''}`;
}

// Extract the most recent valid scene from create_view tool inputs.
// excalidraw-mcp's create_view takes elements as input; we capture them
// as the agent calls it and use the latest call as the final scene.
function tryExtractScene(input: unknown): WhiteboardScene | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (Array.isArray(obj.elements)) {
    return { elements: obj.elements as WhiteboardScene['elements'] };
  }
  if (obj.view && typeof obj.view === 'object') {
    const v = obj.view as Record<string, unknown>;
    if (Array.isArray(v.elements)) {
      return { elements: v.elements as WhiteboardScene['elements'] };
    }
  }
  return null;
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
  cb?: GenerateCallbacks;
}): Promise<{ scene: WhiteboardScene; turns: number; usd: number }> {
  const { systemPrompt, userMessage, mcpUrl, paperReadPath, cb } = opts;

  const allowedTools = paperReadPath
    ? [...EXCALIDRAW_TOOLS, 'Read']
    : EXCALIDRAW_TOOLS;

  const stream = query({
    prompt: userMessage,
    options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      mcpServers: {
        excalidraw: { type: 'http', url: mcpUrl },
      },
      allowedTools,
      // Disable host-side setting sources (CLAUDE.md, project config,
      // user config) so the pipeline runs with exactly the prompt we
      // authored, nothing else.
      settingSources: [],
      includePartialMessages: true,
    } as unknown as Parameters<typeof query>[0]['options'],
  });

  let scene: WhiteboardScene = { elements: [] };
  let turns = 0;
  let usd = 0;

  for await (const ev of stream) {
    if (ev.type === 'assistant') {
      turns += 1;
      const blocks = (ev.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          cb?.onLog?.(`[assistant] ${block.text.slice(0, 200)}`);
          cb?.onAssistantText?.(block.text);
        } else if (block.type === 'tool_use') {
          const name = String(block.name ?? '');
          cb?.onToolUse?.(name, block.input);
          cb?.onLog?.(`[tool_use] ${name}`);
          if (name === 'mcp__excalidraw__create_view') {
            const next = tryExtractScene(block.input);
            if (next && next.elements.length > 0) {
              scene = next;
              cb?.onSceneUpdate?.(scene);
            }
          }
        }
      }
    } else if (ev.type === 'result') {
      usd = (ev as { total_cost_usd?: number }).total_cost_usd ?? 0;
      cb?.onLog?.(`[result] turns=${turns} usd=${usd.toFixed(4)}`);
    }
  }

  return { scene, turns, usd };
}

export async function generateWhiteboard(
  paper: PaperRef,
  cb?: GenerateCallbacks,
  mcpOverride?: McpOverride,
): Promise<{ scene: WhiteboardScene; turns: number; usd: number }> {
  const handle = await resolveMcp(mcpOverride);
  const ownsHandle = !mcpOverride;
  try {
    const result = await runAgent({
      systemPrompt: buildSystemPrompt(),
      userMessage: buildUserMessage(paper),
      mcpUrl: handle.url,
      paperReadPath: paper.kind === 'path' ? paper.absPath : undefined,
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
      `Apply the instruction. Call \`mcp__excalidraw__read_me\` if you need a refresher, ` +
      `then call \`mcp__excalidraw__create_view\` with the updated elements JSON.`;
    const result = await runAgent({
      systemPrompt: buildSystemPrompt(),
      userMessage,
      mcpUrl: handle.url,
      paperReadPath: paper.kind === 'path' ? paper.absPath : undefined,
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
