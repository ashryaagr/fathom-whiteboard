/**
 * Agent SDK session runner — single source of truth for the for-await
 * loop the seven `query()` call sites in this directory used to each
 * carry their own copy of. Lifted per Dedup C (#72).
 *
 * Scope: ONE agent session. Step-loops (runPass2StepLoop,
 * runChatStepLoop) call this helper N times — once per step — and
 * keep the outer iteration + MCP-instance lifecycle in the caller.
 *
 * The helper is INTENTIONALLY narrow:
 *   - It does NOT compute `cwd` (caller's `safeCwd(indexPath)` —
 *     same shape duplicated across 4 files; future dedup target,
 *     out of scope for #72).
 *   - It does NOT resolve the Claude executable path (caller's
 *     `resolveClaudeExecutablePath() ?? undefined`).
 *   - It does NOT manage MCP-instance lifetimes (callers `dispose()`
 *     after the *outer* loop, not per-call).
 *   - It does NOT log under its own bracket prefix; every existing
 *     site already logs `[Lens AI]` / `[Whiteboard Pass1]` /
 *     `[Whiteboard Chat-StepLoop]` / etc., and those prefixes are
 *     part of the user-readable log surface. Helper stays silent.
 *
 * What it DOES handle, identically across all sites:
 *   1. Wraps the systemPrompt body in `{type: 'preset', preset:
 *      'claude_code', append: ...}` (every site does this verbatim).
 *   2. Iterates `for await (const msg of q)` once, dispatching the
 *      five message kinds (`stream_event`, `assistant`, `result`,
 *      `rate_limit_event`, others) to optional caller hooks.
 *   3. Token accumulation (last-value-wins from BOTH `assistant.usage`
 *      and `result.usage` — historic bug-magnet duplicate code).
 *   4. Cached-prefix detection via `cache_read_input_tokens`.
 *   5. Rate-limit handling (opt-in via `rateLimitDetection: true`):
 *      `rate_limit_event` with `rate_limit_info.status === 'rejected'`
 *      sets `result.sawRateLimitRejected = true` and breaks the
 *      iterator; `'allowed'` / `'allowed_warning'` are advisory and
 *      the iterator continues. Sites without rate-limit handling
 *      (decompose, client) leave the flag false.
 *   6. Post-iterator rethrow guard (opt-in via
 *      `postIteratorThrowGuard: true`): catches the SDK's
 *      `Reached maximum number of turns` / `Claude Code returned an
 *      error result` throw that some configurations emit AFTER the
 *      iterator yields the result message. Reports as
 *      `result.caughtPostIteratorThrow` so step-loop callers can
 *      treat as a soft yield instead of failing the whole session.
 *
 * Surfaces back to caller via {@link AgentSessionResult}:
 *   - `responseText` — accumulated text deltas, sites that don't
 *     stream-collect (pass2, chat-step) ignore.
 *   - token + cache stats.
 *   - `toolUseCount` + `toolNames` — chat-step uses `toolNames`
 *     to detect `export_scene` was called.
 *   - `sessionId` — from the first message that carries one
 *     (lens uses this for resume).
 *   - `resultSubtype` — the SDK's `'success' | 'error_max_turns' |
 *     'error_during_execution' | 'error_max_budget_usd' |
 *     'error_max_structured_output_retries' | null`. Callers
 *     classify (return partial / throw / log) per their existing
 *     behaviour.
 *   - `sawResult`, `sawRateLimitRejected`, `caughtPostIteratorThrow`
 *     — meta-flags for the post-iterator validation logic each
 *     caller used to inline.
 *
 * This file deliberately exports NO classification helpers (e.g.
 * "treat error_max_turns as soft"). Each caller used to make that
 * call inline; preserve the existing behaviour by giving each caller
 * the raw subtype + flags and letting it branch the same way it did
 * before.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, PermissionMode, SettingSource } from '@anthropic-ai/claude-agent-sdk';

/** SDK's terminal `result` message subtypes. Callers branch on this
 * to decide partial-body-vs-throw semantics; the runner does NOT
 * classify (per the file header). `null` means the iterator ended
 * without a `result` message at all (e.g. rate-limit break). */
export type AgentResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_during_execution'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries';

/** Inputs to one agent session. All `query()` Options that vary per
 * site are listed here; everything else (`includePartialMessages:
 * true` everywhere, `permissionMode: 'bypassPermissions'` everywhere,
 * the system-prompt preset wrapper) the helper supplies on the
 * caller's behalf — but only for fields where ALL existing sites
 * agree. Where they don't agree, it's a parameter. */
export interface AgentSessionArgs {
  /** First-turn user prompt. */
  prompt: string;
  /** System-prompt body. Helper wraps as `{type:'preset',preset:'claude_code',append:body}`. */
  systemPrompt: string;
  /** Optional Anthropic model ID override. Default: SDK's `claude_code` preset (Sonnet). */
  model?: string;
  /** Optional MCP servers. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Required — every site lists allowedTools explicitly. */
  allowedTools: string[];
  /** Default `'bypassPermissions'` (every site uses this today; helper
   * defaults so callers don't have to repeat). */
  permissionMode?: PermissionMode;
  /** Per-paper sidecar / extra grounding directories. */
  additionalDirectories?: string[];
  /** Default `true` (every site uses this today). */
  includePartialMessages?: boolean;
  /** Round 14e — REVERTED across all sites; left as opt-in escape
   * hatch in case a future site needs it. */
  settingSources?: SettingSource[];
  /** Round 14e — REVERTED across all sites; opt-in escape hatch. */
  strictMcpConfig?: boolean;
  abortController?: AbortController;
  /** Session-resume id (lens.ts uses this; chat could in future). */
  resume?: string;
  /** Caller computes via `safeCwd(indexPath)`. */
  cwd: string;
  /** Caller computes via `resolveClaudeExecutablePath() ?? undefined`. */
  pathToClaudeCodeExecutable?: string;
  /** Required — every site supplies an explicit per-call cap. */
  maxTurns: number;
  /** Fired on every text delta from `stream_event.content_block_delta.text_delta`. */
  onTextDelta?: (delta: string) => void;
  /** Fired on every thinking delta. Only lens (client) + Pass1
   * surface these to the user today; other sites pass nothing. */
  onThinkingDelta?: (delta: string) => void;
  /** Fired on every `tool_use` block in an assistant message. The
   * helper passes the RAW tool name (with `mcp__whiteboard__` prefix
   * intact) — caller strips per its UX (lens uses `formatToolUse`,
   * whiteboard sites use `name.replace(/^mcp__whiteboard__/, '')`). */
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  /** Fired ONCE with the SDK's `session_id` from the first message
   * that carries one. Lens stores this on the focused-lens record
   * so subsequent Asks resume the same SDK session. */
  onSessionId?: (sessionId: string) => void;
  /** When true, the helper inspects every message for
   * `rate_limit_event` and surfaces the rejected-vs-advisory split
   * via `result.sawRateLimitRejected`. When false (decompose,
   * client), `rate_limit_event` messages are ignored and the
   * iterator runs to completion. */
  rateLimitDetection?: boolean;
  /** When true, the helper wraps the for-await in a try/catch that
   * recognises the SDK's post-iterator
   * `Reached maximum number of turns` /
   * `Claude Code returned an error result` throws and reports them
   * via `result.caughtPostIteratorThrow` instead of propagating.
   * Required by step-loops (pass2-step, chat-step) which want to
   * treat such throws as a soft step boundary. Other sites omit. */
  postIteratorThrowGuard?: boolean;
}

/** What the runner exposes back to the caller after one session. */
export interface AgentSessionResult {
  /** Concatenation of every `text_delta` the iterator yielded. Sites
   * that build their answer from text deltas (lens, pass1, critique)
   * read this; sites that author through MCP tools (pass2, chat-step)
   * ignore it. */
  responseText: string;
  /** Last-seen `input_tokens` from either `assistant.usage` or
   * `result.usage`. `null` if neither carried it. */
  inputTokens: number | null;
  /** Last-seen `output_tokens`. */
  outputTokens: number | null;
  /** True iff any `usage.cache_read_input_tokens > 0` was seen. */
  cachedPrefixHit: boolean;
  /** Number of `tool_use` blocks across all assistant messages. */
  toolUseCount: number;
  /** Ordered list of tool names invoked. Chat-step inspects this for
   * `'export_scene'`. */
  toolNames: string[];
  /** First `session_id` seen on any message, if any. Also delivered
   * via the optional `onSessionId` hook. */
  sessionId?: string;
  /** Subtype of the terminal `result` message. `null` if the iterator
   * ended without a `result` (e.g. rate-limit break, or the
   * post-iterator throw guard caught the throw). Callers branch on
   * this to decide partial-body vs throw semantics. */
  resultSubtype: AgentResultSubtype | null;
  /** Iterator yielded a terminal `result` message. */
  sawResult: boolean;
  /** A `rate_limit_event` with `rate_limit_info.status === 'rejected'`
   * was seen — the iterator was broken out of, no further messages
   * processed. Combine with `!sawResult` to detect "rate-limited
   * before completion". Only meaningful when
   * `args.rateLimitDetection === true`. */
  sawRateLimitRejected: boolean;
  /** Set when `postIteratorThrowGuard: true` AND the iterator threw
   * after yielding the result message. The SDK's known throws are
   * matched on the message text:
   *   - `kind: 'max_turns'`     ↔ `/maximum number of turns/i`
   *   - `kind: 'error_result'`  ↔ `/Claude Code returned an error result/i`
   * If the throw doesn't match either, the helper rethrows. */
  caughtPostIteratorThrow: { kind: 'max_turns' | 'error_result'; message: string } | null;
}

/** Run one agent session against the SDK's `query()` API.
 *
 * See file header for the full division-of-responsibility between
 * helper and callers. Returns when the iterator ends; throws only
 * when the SDK throws and `postIteratorThrowGuard` is false (or the
 * throw doesn't match the known SDK rethrow shapes). */
export async function runAgentSession(args: AgentSessionArgs): Promise<AgentSessionResult> {
  const q = query({
    prompt: args.prompt,
    options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: args.systemPrompt },
      ...(args.model ? { model: args.model } : {}),
      ...(args.mcpServers ? { mcpServers: args.mcpServers } : {}),
      allowedTools: args.allowedTools,
      ...(args.additionalDirectories ? { additionalDirectories: args.additionalDirectories } : {}),
      includePartialMessages: args.includePartialMessages ?? true,
      permissionMode: args.permissionMode ?? 'bypassPermissions',
      ...(args.settingSources ? { settingSources: args.settingSources } : {}),
      ...(args.strictMcpConfig !== undefined ? { strictMcpConfig: args.strictMcpConfig } : {}),
      ...(args.abortController ? { abortController: args.abortController } : {}),
      ...(args.resume ? { resume: args.resume } : {}),
      cwd: args.cwd,
      ...(args.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: args.pathToClaudeCodeExecutable }
        : {}),
      maxTurns: args.maxTurns,
    },
  });

  let responseText = '';
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cachedPrefixHit = false;
  let toolUseCount = 0;
  const toolNames: string[] = [];
  let sessionId: string | undefined;
  let sessionIdReported = false;
  let resultSubtype: AgentResultSubtype | null = null;
  let sawResult = false;
  let sawRateLimitRejected = false;
  let caughtPostIteratorThrow:
    | { kind: 'max_turns' | 'error_result'; message: string }
    | null = null;

  const consumeUsage = (
    usage:
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
        }
      | undefined,
  ): void => {
    if (!usage) return;
    if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
    if (
      typeof usage.cache_read_input_tokens === 'number' &&
      usage.cache_read_input_tokens > 0
    ) {
      cachedPrefixHit = true;
    }
  };

  try {
    for await (const msg of q) {
      // Capture the SDK session_id from the first message that carries one.
      // The 'system' bootstrap, 'assistant', and 'result' messages all carry
      // session_id; we take whichever lands first.
      if (!sessionIdReported) {
        const maybe = (msg as { session_id?: unknown }).session_id;
        if (typeof maybe === 'string' && maybe.length > 0) {
          sessionId = maybe;
          sessionIdReported = true;
          args.onSessionId?.(maybe);
        }
      }

      // Rate-limit handling — opt-in. Two-state model per round-14e:
      // 'rejected' is a hard throttle (break iterator), 'allowed' /
      // 'allowed_warning' are advisory pings the SDK sends near a
      // window boundary while the call continues normally.
      if (args.rateLimitDetection) {
        const mtype = (msg as { type?: string }).type;
        const msubtype = (msg as { subtype?: string }).subtype;
        if (mtype === 'rate_limit_event' || msubtype === 'rate_limit_event') {
          const rli = (msg as { rate_limit_info?: { status?: string } }).rate_limit_info;
          if (rli?.status === 'rejected') {
            sawRateLimitRejected = true;
            break;
          }
          // advisory — fall through (don't dispatch as a normal message).
          continue;
        }
      }

      if (msg.type === 'stream_event') {
        const event = msg.event;
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            responseText += event.delta.text;
            args.onTextDelta?.(event.delta.text);
          } else if (event.delta.type === 'thinking_delta') {
            args.onThinkingDelta?.(event.delta.thinking);
          }
        }
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content ?? []) {
          if (block.type === 'tool_use') {
            toolUseCount++;
            const name = String(block.name ?? '');
            toolNames.push(name);
            args.onToolUse?.(name, block.input as Record<string, unknown>);
          } else if (
            block.type === 'text' &&
            args.includePartialMessages === false
          ) {
            // When the caller passes `includePartialMessages: false`, the
            // SDK does NOT emit `stream_event.text_delta` messages — text
            // arrives only inside the assistant message's content blocks.
            // Accumulate here so `responseText` is still populated.
            // With `includePartialMessages: true` we DO NOT take this
            // branch — the same text would double-count against the
            // stream_event deltas already accumulated above.
            const txt = (block as { text?: unknown }).text;
            if (typeof txt === 'string') responseText += txt;
          }
        }
        const usage = (
          msg.message as unknown as {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
            };
          }
        ).usage;
        consumeUsage(usage);
      } else if (msg.type === 'result') {
        sawResult = true;
        // The SDK's result subtype is the source of truth. We don't
        // classify (caller decides what's fatal vs partial-OK); we
        // just expose it.
        resultSubtype = msg.subtype as AgentResultSubtype;
        const usageR = (
          msg as unknown as {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
            };
          }
        ).usage;
        consumeUsage(usageR);
      }
    }
  } catch (err) {
    if (!args.postIteratorThrowGuard) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/maximum number of turns/i.test(msg)) {
      caughtPostIteratorThrow = { kind: 'max_turns', message: msg };
    } else if (/Claude Code returned an error result/i.test(msg)) {
      caughtPostIteratorThrow = { kind: 'error_result', message: msg };
    } else {
      throw err;
    }
  }

  return {
    responseText,
    inputTokens,
    outputTokens,
    cachedPrefixHit,
    toolUseCount,
    toolNames,
    sessionId,
    resultSubtype,
    sawResult,
    sawRateLimitRejected,
    caughtPostIteratorThrow,
  };
}
