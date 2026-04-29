/**
 * Cross-cut types shared by `pipeline/` (Node) and `renderer/` (React).
 *
 * Keep this file dependency-free — no Node `fs`, no React, no SDK
 * imports — so both halves can pull it in without dragging the
 * other side's runtime deps.
 */

/**
 * A pre-built per-paper index. The pipeline's only contract with the
 * filesystem: it reads via the lazy accessors below; it never assumes
 * a specific layout (Fathom uses `<pdf>.lens/`, the demo can use any
 * shape).
 *
 * Hosts construct one of these from whatever filesystem layout they
 * own and pass it into `runPass1` / `runPass2` / `runWhiteboardPass2`.
 */
export interface PaperIndex {
  /** Stable content-hash key for the paper. The host's choice — the
   *  pipeline only uses this for log lines and as a back-reference
   *  in step events. */
  paperHash: string;

  /** Absolute path to the index directory. Passed to the SDK as
   *  `additionalDirectories` so the agent can `Grep` inside it. The
   *  pipeline does NOT write to this path — see `onArtifact` for
   *  outputs. */
  indexPath: string;

  /** Read the paper's `content.md` (the markdown serialisation of
   *  the paper). Required for Pass 1; the pipeline throws if this
   *  rejects. */
  readContent: () => Promise<string>;

  /** Read the per-paper digest JSON if one exists. Best-effort —
   *  Pass 1 still runs without it. Return `null` if the host has no
   *  digest. */
  readDigest: () => Promise<string | null>;

  /** Resolve a figure's relative path (e.g. `images/page-003-fig-1.png`)
   *  to an absolute path the agent's `Read` tool can open. Return
   *  `null` if the figure is unknown. Used by the Pass 2 MCP server
   *  when the agent embeds figures via `instantiate_template`. */
  resolveFigurePath: (relPath: string) => string | null;
}

/**
 * Persistence hook — fired by the pipeline whenever it produces an
 * output the host should durably retain. The pipeline never writes
 * to disk itself; the host wraps `onArtifact` with a `writeFile` call,
 * a SQLite blob insert, an S3 upload, etc.
 *
 * Artifact types:
 * - `understanding`: Pass 1's markdown synthesis of the paper.
 * - `issues`: Verifier output (JSON).
 * - `render-snapshot`: PNG of an in-pipeline scene render (Pass 2.5
 *   feeds these to the visual critic).
 *
 * `body` is `Buffer` for binary artifacts, `string` for text.
 *
 * `name` is a stable filename suggestion ("whiteboard-understanding.md",
 * "whiteboard-issues.json", "render-l1-{hash8}.png") — hosts that
 * write to disk can use it verbatim; hosts that map to DB rows can
 * ignore it.
 */
export interface PipelineArtifact {
  type: 'understanding' | 'issues' | 'render-snapshot';
  name: string;
  body: Buffer | string;
}

/**
 * Persistence callback signature shared by all pipeline functions
 * that previously wrote to disk. Always called with `await` so the
 * host can fail the pipeline by throwing.
 */
export type OnArtifactCallback = (artifact: PipelineArtifact) => Promise<void>;
