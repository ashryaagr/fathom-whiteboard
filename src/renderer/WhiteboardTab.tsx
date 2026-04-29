/**
 * Whiteboard tab — the React component that wraps Excalidraw and
 * orchestrates the per-paper Pass 1 + Pass 2 + drill-in flow.
 *
 * Flow:
 *   1. On mount, ask main for status. If `idle`, show the consent
 *      affordance. If `ready`, hydrate from disk and render.
 *   2. On consent accept, kick off `whiteboardGenerate`. While Pass 1
 *      streams, show the placeholder skeleton + streaming sidebar.
 *   3. When Pass 2 done, parse the WBDiagram, run ELK, convert to
 *      Excalidraw skeletons, mount in a frame at the origin.
 *   4. On click of a drillable node:
 *        - Doherty-paint immediately: parent-frame outline + spinning
 *          ⌖ glyph on the clicked node within 50ms.
 *        - Fire `whiteboardExpand` for that node id.
 *        - When the Pass 2 result lands, parse + ELK + Excalidraw and
 *          place the new frame to the right of the parent. Animate
 *          `scrollToContent` to it (320ms cubic-bezier) so the user
 *          feels they zoomed inside the parent.
 *
 * Spec: .claude/specs/whiteboard-diagrams.md
 * Methodology: docs/methodology/whiteboard.md (kept in sync with this file)
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { convertToExcalidrawElements, exportToCanvas } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useWhiteboardHost, type WhiteboardHost, type WhiteboardPaperRef } from './host';
import { useWhiteboardStore, type PaperWhiteboard } from './store';
import { parseWBDiagram, type WBDiagram } from './dsl';
import { layoutDiagram } from './elkLayout';
import { diagramToSkeleton, diagramBoundingBox, type WBNodeCustomData } from './toExcalidraw';
import WhiteboardConsent from './WhiteboardConsent';
import WhiteboardBreadcrumb from './WhiteboardBreadcrumb';
import WhiteboardChat from './WhiteboardChat';
import WhiteboardRegenerateButton from './WhiteboardRegenerateButton';

// Excalidraw is heavy (~1 MB); lazy-load it so the app shell doesn't
// pay for it until the user actually opens a Whiteboard tab.
const Excalidraw = lazy(() =>
  import('@excalidraw/excalidraw').then((m) => ({ default: m.Excalidraw })),
);

interface Props {
  /** Reference to the paper to render the whiteboard for. Hosts
   *  build this from whatever they call a "paper" internally
   *  (Fathom: `OpenDocument` from `state/document`; demo: a struct
   *  with the same `contentHash` + `indexPath` shape). */
  paper: WhiteboardPaperRef;
  /** Callback to open a PDF lens at a given page+text — wired into the
   * citation marker click handler so ⌘+click jumps to a Fathom lens
   * on the source paragraph. Plain click jumps the PDF tab to that
   * paragraph and pulses it. */
  onJumpToPage?: (page: number, quote: string | null, openLens: boolean) => void;
}

/** Approx. horizontal slot allocated to the L1 frame at origin. Level
 * 2 frames lay out to the right of this with this much gap. */
/** Used as the x-fallback when we can't find the parent rect (e.g.
 * the Excalidraw scene was hydrated from disk but the per-element
 * customData doesn't expose `nodeId`). Picks the visual middle of a
 * "typical" 5-node Level 1 row so the dropped Level 2 doesn't fly
 * off-canvas. */
const L1_LAYOUT_WIDTH = 1200;

export default function WhiteboardTab({ paper, onJumpToPage }: Props) {
  const host = useWhiteboardHost();
  const paperHash = paper.contentHash;
  const wb = useWhiteboardStore((s) => s.byPaper.get(paperHash));
  const store = useWhiteboardStore();
  // Round-14e v4: narrow selector bindings for the hydration effect.
  // Whole-store snapshot (`store` above) returns a NEW reference on
  // every mutation — putting it in the hydration-effect deps caused a
  // re-trigger loop where each `store.setX(...)` call inside the
  // effect's success branch invalidated the deps, the effect re-fired,
  // and `setHydrating(true)` flipped back on before the prior pass'
  // `finally` could flip it off. Net: "Loading whiteboard…" stuck
  // forever and `whiteboard:get` IPC fired 92K+ times in a session.
  // Selector-bound setters are stable across renders (zustand returns
  // the same function reference for `s.setX`), so depending on them
  // is a no-op for re-trigger purposes. The hydration effect uses
  // these; legacy callers throughout the file continue to use `store`
  // for now (separate audit task).
  const setIndexPath = useWhiteboardStore((s) => s.setIndexPath);
  const setUnderstanding = useWhiteboardStore((s) => s.setUnderstanding);
  const setExcalidrawScene = useWhiteboardStore((s) => s.setExcalidrawScene);
  const setVerifier = useWhiteboardStore((s) => s.setVerifier);
  const setStatus = useWhiteboardStore((s) => s.setStatus);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  // Generation handle so a tab-switch doesn't leak an in-flight call.
  const generateHandleRef = useRef<{ abort: () => void } | null>(null);
  const expandHandlesRef = useRef<Map<string, { abort: () => void }>>(new Map());
  // Scene-mount tracking: which nodeIds have we already laid out in
  // the canvas? Stops us from re-layouting the same diagram on every
  // re-render.
  const mountedFramesRef = useRef<Set<string>>(new Set());
  // Track per-node bounding boxes so click handlers + scrollToContent
  // can find the right rectangle without walking customData each time.
  const frameBoundsRef = useRef<
    Map<string, { x: number; y: number; width: number; height: number }>
  >(new Map());

  // -----------------------------------------------------------------
  // Hydration: ask main for any persisted whiteboard for this paper.
  // Runs once per paperHash change. Populates the store + scene.
  // -----------------------------------------------------------------
  // Round-14e v3: hydration. Re-runs whenever paperHash changes; safe
  // because whiteboardGet just reads files from disk (idempotent).
  // The previous ref-guard + cancelled-flag combo deadlocked under
  // React 18 Strict Mode: pass-1 effect set the ref + started fetch,
  // cleanup set cancelled=true, pass-2 effect found the ref already
  // matching paperHash and early-returned, and pass-1's `finally`
  // skipped setHydrating(false) due to `if (!cancelled)`. Result:
  // "Loading whiteboard…" stuck forever, no IPC ever runs the
  // user-visible flip. Fix: drop the ref, always flip `hydrating`
  // in finally, accept that Strict Mode runs the IPC twice — both
  // calls are read-only, so doubling them is harmless.
  const [hydrating, setHydrating] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setHydrating(true);
    void (async () => {
      try {
        const result = await host.load(paperHash);
        if (cancelled) return;
        console.log(
          `[WhiteboardTab] hydrate paper=${paperHash.slice(0, 10)} ` +
            `scene=${result.scene ? result.scene.length + 'ch' : 'null'} ` +
            `understanding=${result.understanding ? result.understanding.length + 'ch' : 'null'} ` +
            `status=${result.status}`,
        );
        if (result.indexPath) setIndexPath(paperHash, result.indexPath);
        if (result.understanding) setUnderstanding(paperHash, result.understanding);
        if (result.scene) {
          // One-time idempotent migration for chat-frame elements
          // saved before whiteboard-mcp.ts:place_chat_frame learned to
          // emit a complete Excalidraw v0.18 frame skeleton (children +
          // base-element fields). Without these fields,
          // convertToExcalidrawElements drops the frame silently on
          // mount, producing the "applied to canvas" + "Jump to chart →"
          // UX with nothing visible (observed on paper eca6c70e2a's
          // queryId 40c0c94c chat from 2026-04-27 09:39:50).
          //
          // Idempotent: stamps only when `children` is missing (the
          // unique tell of pre-fix frames). New frames already carry
          // children + the base fields and are no-op'd.
          const migrated = migrateChatFrames(result.scene);
          setExcalidrawScene(paperHash, migrated);
        }
        // Parse issues for verifier rehydration so citation markers
        // render with the right verified/unverified affordance on
        // first paint after a reopen.
        if (result.issues) {
          try {
            const parsed = JSON.parse(result.issues) as {
              verificationRate?: number;
              issues?: Array<{ quote: string; status: 'verified' | 'soft' | 'unverified'; score: number }>;
            };
            if (parsed.issues) {
              const quoteStatus: Record<
                string,
                { status: 'verified' | 'soft' | 'unverified'; score: number }
              > = {};
              for (const i of parsed.issues) {
                quoteStatus[i.quote] = { status: i.status, score: i.score };
              }
              setVerifier(paperHash, {
                verificationRate: parsed.verificationRate ?? 1,
                quoteStatus,
              });
            }
          } catch {
            /* malformed issues file — non-fatal */
          }
        }
        // Round-14e: a saved scene is the artifact the user paid for —
        // flip to 'ready' on scene presence alone. Previously we
        // additionally required `understanding` to be non-null, which
        // meant a stale or missing whiteboard-understanding.md sent
        // the user back to the consent screen and an inadvertent click
        // on "Generate" overwrote the saved $1.90 scene. The
        // understanding doc is non-essential at view time (it's only
        // needed by chat / regenerate); if it's missing we just leave
        // it empty and let chat re-derive context from content.md.
        if (result.scene) {
          setStatus(paperHash, 'ready');
        } else {
          setStatus(paperHash, 'idle');
        }
      } catch (err) {
        console.warn('[WhiteboardTab] hydrate failed', err);
      } finally {
        // Always flip — even when this effect's body got cancelled, a
        // sibling effect-pass (Strict Mode) is racing the same IPC and
        // will succeed. The state must reflect "we know what's on
        // disk" regardless of which pass got there first.
        setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Selector-bound setters above are stable across renders (zustand
    // returns the same function reference across mutations) so they
    // do not need to be in deps — only `paperHash` genuinely identifies
    // "we need to re-hydrate." Per #59 dispatch the deps array is
    // `[paperHash]` only; the eslint-disable suppresses
    // exhaustive-deps' false-positive on the stable setter refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperHash]);

  // -----------------------------------------------------------------
  // Doherty placeholder skeleton mounted on first tab visit.
  // -----------------------------------------------------------------
  const skeletonMountedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!api) return;
    if (wb?.status !== 'pass1' && wb?.status !== 'pass2') return;
    if (skeletonMountedRef.current === paperHash) return;
    skeletonMountedRef.current = paperHash;
    mountSkeleton(api);
  }, [api, wb?.status, paperHash]);

  // -----------------------------------------------------------------
  // Render Level 1 once the store has it. Then eagerly pre-warm every
  // drillable node's Level 2 expansion in parallel — each L2 call
  // hits the cached Pass 1 prefix so they're cheap (~$0.005 + ~5s
  // each), and running them concurrently turns the worst-case "user
  // clicks → wait 8 s for first L2" into "user clicks → it's already
  // there or close to it." Per the team-lead spec: "Run all Pass 2
  // expansions in parallel as Promise.all (each L2 is independent
  // given the cached prefix)." If the user closes the tab mid-warm
  // the abort controllers in expandHandlesRef cancel the in-flight
  // calls.
  // -----------------------------------------------------------------
  // -----------------------------------------------------------------
  // Hydrate-from-disk fit: when a scene loads from `whiteboard.excalidraw`
  // (status='ready' but no fresh L1 mount happens), Excalidraw restores
  // the saved appState including `zoom`/`scrollX`/`scrollY` (allowlisted
  // in sanitiseAppStateForDisk so the user's pan/zoom across sessions
  // round-trips). The downside: the previous session's saved zoom
  // might be tiny (e.g. 10%) so the diagram appears as a small cluster
  // in the corner. Fire scrollToContent once after the API mounts on
  // a hydrated scene to fit the diagram cleanly. Guarded by a ref so
  // we don't fight subsequent user pan/zoom.
  // -----------------------------------------------------------------
  const hydratedFitRef = useRef<string | null>(null);
  useEffect(() => {
    if (!api) return;
    if (!wb || wb.status !== 'ready') return;
    // Only fit on hydrate-from-disk (no live L1 mount happened this
    // session). When the L1 mount runs, IT calls scrollToContent
    // already; firing again here would fight that animation.
    if (mountedFramesRef.current.has('L1')) return;
    if (hydratedFitRef.current === paperHash) return;
    hydratedFitRef.current = paperHash;
    // Defer one tick so Excalidraw has finished applying initialData
    // (otherwise scrollToContent runs against an empty scene).
    const id = window.requestAnimationFrame(() => {
      try {
        api.scrollToContent(undefined, { fitToContent: true, animate: false });
      } catch {
        /* api disposed mid-mount — non-fatal */
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [api, wb, paperHash]);

  useEffect(() => {
    if (!api) return;
    if (!wb?.level1) return;
    if (mountedFramesRef.current.has('L1')) return;
    void mountLevel1Frame(host, api, wb.level1, paperHash).then((bounds) => {
      mountedFramesRef.current.add('L1');
      if (bounds) {
        frameBoundsRef.current.set('L1', bounds);
        // First paint: scroll the canvas so Level 1 fits cleanly.
        api.scrollToContent(undefined, { fitToContent: true, animate: true, duration: 320 });
      }
      // Persist the scene to disk so a reopen restores instantly.
      void persistScene(host, api, paperHash, store);
      // Pre-warm Level 2 expansions for every drillable node IN
      // PARALLEL. We don't await — the per-call result handler
      // installs the L2 frame as it lands.
      const drillable = wb.level1?.nodes.filter((n) => n.drillable) ?? [];
      if (drillable.length > 0) {
        console.log(
          `[Whiteboard UI] pre-warming ${drillable.length} Level 2 expansion(s) in parallel`,
        );
        for (const node of drillable) {
          // Skip if already mounted or in flight.
          if (mountedFramesRef.current.has(`L2:${node.id}`)) continue;
          if (expandHandlesRef.current.has(node.id)) continue;
          void runExpand(host, paperHash, node.id, node.label, store, expandHandlesRef);
        }
      }
    });
  }, [api, wb?.level1, paperHash, store]);

  // -----------------------------------------------------------------
  // MCP-driven Pass 2: when the agent's authored scene lands in
  // store.pass2L1Scene, parse it and replace the live canvas. This
  // is the new path (round-11/12+) — the in-MCP request_critic_review
  // already graded + patched the scene before export, so we skip the
  // renderer-side runCritiqueLoop and trust the persisted JSON.
  //
  // The `mountedFramesRef.has('L1')` gate prevents racing the legacy
  // diagramToSkeleton mount path: whichever fires first wins for that
  // paperHash within the session. After mount, we mark L1 mounted so
  // a hydrate-from-disk on a later session doesn't double-apply.
  // -----------------------------------------------------------------
  const mountedPass2SceneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!api) return;
    if (!wb?.pass2L1Scene) return;
    // Re-mount only when the scene actually changes (regenerate flow
    // produces a new string). Stops a benign re-render from re-applying.
    if (mountedPass2SceneRef.current === wb.pass2L1Scene) return;
    let parsed: { elements?: unknown[] } | null = null;
    try {
      parsed = JSON.parse(wb.pass2L1Scene) as { elements?: unknown[] };
    } catch (err) {
      console.warn('[Whiteboard UI] pass2L1Scene parse failed', err);
      return;
    }
    if (!parsed || !Array.isArray(parsed.elements)) {
      console.warn('[Whiteboard UI] pass2L1Scene missing elements[]');
      return;
    }
    // Wholesale replacement: remove every existing skeleton + L1 element
    // (anything stamped fathomKind=wb-* or unstamped — i.e. the prior
    // L1). Keep nothing — pass2L1Scene IS the new L1.
    const incoming = parsed.elements as Parameters<typeof convertToExcalidrawElements>[0];
    const converted = convertToExcalidrawElements(incoming, { regenerateIds: false });
    api.updateScene({ elements: converted });
    api.scrollToContent(undefined, { fitToContent: true, animate: true, duration: 320 });
    mountedFramesRef.current.add('L1');
    mountedPass2SceneRef.current = wb.pass2L1Scene;
    console.log(
      `[Whiteboard UI] pass2L1Scene mounted: ${converted.length} elements`,
    );
    // Persist the live scene now so a reopen restores instantly.
    void persistScene(host, api, paperHash, store);
  }, [api, wb?.pass2L1Scene, paperHash, store]);

  // -----------------------------------------------------------------
  // Round-13 streaming render. Subscribe to partial scene snapshots
  // pushed by main as the Pass 2 MCP agent authors the scene. Apply
  // each snapshot wholesale via `api.updateScene` so the user sees
  // the canvas filling in live (sections appearing one-by-one, then
  // nodes inside, then arrows) instead of waiting for export_scene.
  //
  // - The stream only matters during authoring (`wb.status === 'pass1'`
  //   or `'pass2'`). After Pass 2 completes, the canonical
  //   `pass2L1Scene` mount above takes over — we ignore late stream
  //   events from a stale closure to avoid fighting the canonical
  //   apply. Filter on status guards that.
  // - paperHash filter prevents cross-paper bleed if the user opens a
  //   second paper mid-generation.
  // - We DO NOT persist streamed snapshots — that's export_scene's job
  //   (handled by the pass2L1Scene mount + persistScene above).
  // - regenerateIds: false to preserve the namespaced ids the MCP
  //   stamps; same reasoning as the L1/L2/chat mount paths.
  useEffect(() => {
    if (!api || !paperHash) return;
    let firstStreamLogged = false;
    let lastStreamId: string | null = null;
    const unsubscribe = host.onSceneStream((payload) => {
      if (payload.paperHash !== paperHash) return;
      const status = useWhiteboardStore.getState().byPaper.get(paperHash)?.status;
      if (status !== 'pass1' && status !== 'pass2') return;
      // Log first arrival per (paperHash, streamId) so a DevTools peek
      // confirms streaming is alive without spamming on every push.
      if (!firstStreamLogged || lastStreamId !== payload.streamId) {
        firstStreamLogged = true;
        lastStreamId = payload.streamId;
        console.log(
          `[Whiteboard UI] scene-stream begin paper=${paperHash.slice(0, 10)} ` +
            `stream=${payload.streamId.slice(0, 12)} elements=${payload.elements.length}`,
        );
      }
      try {
        const incoming = payload.elements as Parameters<
          typeof convertToExcalidrawElements
        >[0];
        const converted = convertToExcalidrawElements(incoming, {
          regenerateIds: false,
        });
        api.updateScene({ elements: converted });
      } catch (err) {
        console.warn('[Whiteboard UI] scene-stream apply failed', err);
      }
    });
    return unsubscribe;
  }, [api, paperHash]);

  // Round 14b — step-loop status data path. The agent calls
  // yield_step at each step boundary; main pushes a `whiteboard:step`
  // event with the user-readable summary. We mirror it into store as
  // `lastStep` so a future status-strip UI can render it. Per
  // dispatch: just plumb the data path; UI is a future dispatch.
  // Cross-paper filter via paperHash (multiple windows safe).
  useEffect(() => {
    if (!paperHash) return;
    const unsubscribe = host.onStep((payload) => {
      if (payload.paperHash !== paperHash) return;
      console.log(
        `[Whiteboard UI] step paper=${paperHash.slice(0, 10)} ` +
          `step#${payload.stepNum} done=${payload.done} ` +
          `summary="${payload.summary.slice(0, 80)}${payload.summary.length > 80 ? '…' : ''}" ` +
          `elements=${payload.sceneSize}`,
      );
      useWhiteboardStore.getState().setLastStep(paperHash, {
        stepNum: payload.stepNum,
        summary: payload.summary,
        done: payload.done,
        sceneSize: payload.sceneSize,
      });
    });
    return unsubscribe;
  }, [paperHash]);

  // Round 14c — post-export critic verdict data path. Main emits
  // `whiteboard:critic-verdict` once per L1 generation or per chat
  // turn after the step-loop finishes. We stash the verdict on the
  // store so a future advisory-badge UI can surface defects without
  // blocking ship. v1 just plumbs the data.
  useEffect(() => {
    if (!paperHash) return;
    const unsubscribe = host.onCriticVerdict((payload) => {
      if (payload.paperHash !== paperHash) return;
      console.log(
        `[Whiteboard UI] critic-verdict paper=${paperHash.slice(0, 10)} ` +
          `scope=${payload.scope} pass=${payload.verdict.pass} ` +
          `defects=${payload.verdict.defects.length}` +
          (payload.scope === 'chat' && payload.chatQueryId
            ? ` chatQueryId=${payload.chatQueryId}`
            : ''),
      );
      const store = useWhiteboardStore.getState();
      if (payload.scope === 'l1') {
        store.setCriticVerdictL1(paperHash, payload.verdict);
      } else if (payload.scope === 'chat' && payload.chatQueryId) {
        store.setCriticVerdictForChatQuery(
          paperHash,
          payload.chatQueryId,
          payload.verdict,
        );
      }
    });
    return unsubscribe;
  }, [paperHash]);

  // -----------------------------------------------------------------
  // Render Level 2 when one lands. Position it to the right of L1.
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!api || !wb) return;
    for (const [parentId, diagram] of wb.level2) {
      const frameKey = `L2:${parentId}`;
      if (mountedFramesRef.current.has(frameKey)) continue;
      void mountLevel2Frame(host, api, diagram, parentId, paperHash).then((bounds) => {
        mountedFramesRef.current.add(frameKey);
        if (bounds) frameBoundsRef.current.set(frameKey, bounds);
        // If the user is currently focused on this Level 2, animate
        // the canvas into view.
        if (
          wb.focus.kind === 'level2' &&
          wb.focus.parentNodeId === parentId &&
          bounds
        ) {
          // scrollToContent accepts an array of elements; we hand it
          // the bounding rect via a synthetic invisible rectangle.
          // Simpler: scroll the API to the bounds via a refresh +
          // scrollToContent call on the relevant elements.
          api.scrollToContent(undefined, {
            fitToContent: true,
            animate: true,
            duration: 320,
          });
        }
        void persistScene(host, api, paperHash, store);
      });
    }
  }, [api, wb?.level2, wb?.focus, paperHash, store, wb]);

  // -----------------------------------------------------------------
  // Focus-change → animate scrollToContent so back-clicks animate.
  // Filter by customData.level + parentId so scroll-to-focus works
  // even on hydrated scenes where frameBoundsRef isn't populated
  // (e.g. user reopens the paper, scene loads from disk, no fresh
  // mount happened).
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!api || !wb) return;
    const focus = wb.focus;
    const elements = api
      .getSceneElements()
      .filter((el) => {
        const cd = (el as { customData?: WBNodeCustomData }).customData;
        if (!cd) return false;
        if (focus.kind === 'level1') return cd.level === 1;
        return cd.level === 2 && cd.parentId === focus.parentNodeId;
      });
    if (elements.length === 0) return;
    api.scrollToContent(elements, {
      fitToContent: true,
      animate: true,
      duration: 320,
    });
  }, [api, wb?.focus, wb]);

  // -----------------------------------------------------------------
  // Click handler. Excalidraw fires onPointerDown with the active tool
  // and a PointerDownState; the hit element (if any) is at
  // `pointerDownState.hit.element`. We branch on `customData.fathomKind`:
  //   - wb-node + drillable → expand into Level 2
  //   - wb-citation → open PDF tab + jump to source paragraph
  //   - wb-drill-glyph → same as wb-node click (clickable target is
  //     larger than the rect alone)
  //
  // Excalidraw doesn't pass us the underlying React event in
  // onPointerDown for v0.18; we read modifier keys off the global
  // event via window.event as a backup so ⌘+click still resolves.
  // (Caveat: this is renderer-only — no SSR consideration.)
  // -----------------------------------------------------------------
  const handlePointerDown = useCallback(
    (
      _activeTool: unknown,
      pointerDownState: unknown,
    ) => {
      // Excalidraw types `customData` as Record<string, any> on
      // every element so we can't get a structural narrowing here —
      // cast through unknown to our WBNodeCustomData (which IS what
      // the diagram-to-skeleton converter writes).
      const hit =
        (pointerDownState as { hit?: { element?: { customData?: Record<string, unknown> } | null } })
          .hit ?? null;
      const el = hit?.element ?? null;
      const cd = el?.customData as WBNodeCustomData | undefined;
      if (!cd || !cd.fathomKind) return;
      const evt = (window as unknown as { event?: { metaKey?: boolean } }).event;
      const isMeta = !!evt?.metaKey;

      if (cd.fathomKind === 'wb-citation' && cd.citation) {
        if (typeof cd.citation.page === 'number' && onJumpToPage) {
          onJumpToPage(cd.citation.page, cd.citation.quote ?? null, isMeta);
        }
        return;
      }
      if (
        (cd.fathomKind === 'wb-node' || cd.fathomKind === 'wb-drill-glyph') &&
        cd.drillable &&
        cd.nodeId
      ) {
        store.setFocus(paperHash, { kind: 'level2', parentNodeId: cd.nodeId });
        const existing = wb?.level2.get(cd.nodeId);
        if (existing) return;
        // If a pre-warm expansion is already in flight for this node,
        // don't double-fire — the eager-prewarm Promise will install
        // the L2 frame as it lands.
        if (expandHandlesRef.current.has(cd.nodeId)) return;
        void runExpand(host, paperHash, cd.nodeId, getNodeLabel(wb, cd.nodeId), store, expandHandlesRef);
      }
    },
    [paperHash, store, onJumpToPage, wb],
  );

  // -----------------------------------------------------------------
  // Cleanup pending generation on unmount / paper switch.
  // -----------------------------------------------------------------
  useEffect(() => {
    return () => {
      generateHandleRef.current?.abort();
      generateHandleRef.current = null;
      const map = expandHandlesRef.current;
      for (const h of map.values()) h.abort();
      map.clear();
    };
  }, [paperHash]);

  // -----------------------------------------------------------------
  // Reset the frame-mount cache when the paper changes (different
  // paperHash → fresh canvas, fresh frames).
  // -----------------------------------------------------------------
  useEffect(() => {
    mountedFramesRef.current = new Set();
    frameBoundsRef.current = new Map();
    skeletonMountedRef.current = null;
  }, [paperHash]);

  // -----------------------------------------------------------------
  // Generate-on-consent callback wired to WhiteboardConsent.
  // -----------------------------------------------------------------
  const onConsentAccept = useCallback(
    (rememberChoice: boolean) => {
      // Persist the "remember" toggle if the user opted in.
      if (rememberChoice) {
        void host.updateSettings({ whiteboardAutoGenerateOnIndex: true });
      }
      void runGenerate(host, paperHash, paper.path, store, generateHandleRef);
    },
    [paperHash, paper.path, store],
  );

  // -----------------------------------------------------------------
  // Auto-generate path: if the user has the "auto-generate" setting on
  // and this paper has no existing whiteboard, kick off generation
  // automatically the first time the tab mounts.
  // -----------------------------------------------------------------
  const autoCheckedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!wb) return;
    if (wb.status !== 'idle') return;
    // Round-14e: do NOT auto-generate while hydration is in flight —
    // we may be 50ms away from discovering a saved scene on disk and
    // kicking generation now would burn $1.90 to overwrite it.
    if (hydrating) return;
    if (autoCheckedRef.current === paperHash) return;
    autoCheckedRef.current = paperHash;
    void (async () => {
      try {
        const settings = await host.getSettings();
        if (settings.whiteboardAutoGenerateOnIndex) {
          void runGenerate(host, paperHash, paper.path, store, generateHandleRef);
        }
      } catch {
        /* settings unreadable — falls back to consent prompt */
      }
    })();
  }, [wb, paperHash, paper.path, store, hydrating]);

  // QA-harness shortcut: bypass the consent affordance and start
  // generation directly. Wired by `scripts/fathom-test.sh
  // whiteboard-generate` via the ⌘⇧F4 global shortcut → App.tsx
  // dispatches this event after switching to the Whiteboard tab.
  useEffect(() => {
    const handler = () => {
      const cur = useWhiteboardStore.getState().get(paperHash);
      if (cur.status === 'idle' || cur.status === 'consent' || cur.status === 'failed') {
        void runGenerate(host, paperHash, paper.path, store, generateHandleRef);
      }
    };
    window.addEventListener('fathom:qaWhiteboardGenerate', handler);
    return () => window.removeEventListener('fathom:qaWhiteboardGenerate', handler);
  }, [paperHash, paper.path, store]);

  // Render-only QA: skips Pass 1 + Pass 2, mounts a fixture WBDiagram
  // through the live render pipeline. NO Claude spend — the bug is in
  // the render layer, debug it in isolation (CLAUDE.md §0).
  useEffect(() => {
    const handler = () => {
      void runRenderOnlyFixture(host, paperHash, store);
    };
    window.addEventListener('fathom:qaWhiteboardRenderOnly', handler);
    return () => window.removeEventListener('fathom:qaWhiteboardRenderOnly', handler);
  }, [paperHash, store]);

  // QA: drill into the first drillable L1 node (parameterless — picks
  // the first one with `drillable: true`). Wired for the
  // `whiteboard-drill` script subcommand so automated close-the-loop
  // runs can capture L2 frames without coordinate-based clicks. If
  // there's no L1 yet or no drillable nodes, no-op (logs a warning).
  useEffect(() => {
    const handler = () => {
      const cur = useWhiteboardStore.getState().get(paperHash);
      const node = cur.level1?.nodes.find((n) => n.drillable);
      if (!node) {
        console.warn('[Whiteboard UI] qa drill-first: no drillable node found');
        return;
      }
      console.log(`[Whiteboard UI] qa drill-first: drilling into ${node.id} (${node.label})`);
      store.setFocus(paperHash, { kind: 'level2', parentNodeId: node.id });
      // If pre-warm already produced an L2, the focus change is enough.
      // Otherwise kick off expand explicitly (mirrors the click handler).
      if (cur.level2.has(node.id)) return;
      if (expandHandlesRef.current.has(node.id)) return;
      void runExpand(host, paperHash, node.id, node.label, store, expandHandlesRef);
    };
    window.addEventListener('fathom:qaWhiteboardDrillFirst', handler);
    return () => window.removeEventListener('fathom:qaWhiteboardDrillFirst', handler);
  }, [paperHash, store]);

  // -----------------------------------------------------------------
  // Regenerate from scratch: abort any in-flight generation handle, then
  // re-kick the same pipeline runGenerate uses on consent. Optional
  // guidance is forwarded as `purposeAnchor` — the IPC + main + Pass 1
  // + Pass 2 already accept and inject it as `<reader_purpose>` so the
  // model biases the digest + diagram toward the user's ask. Empty
  // guidance is a plain regenerate (same as before this change).
  // -----------------------------------------------------------------
  const handleRegenerate = useCallback(
    (guidance: string | null) => {
      try {
        generateHandleRef.current?.abort();
      } catch {
        /* ignore — best-effort */
      }
      generateHandleRef.current = null;
      void runGenerate(host, paperHash, paper.path, store, generateHandleRef, guidance ?? undefined);
    },
    [paperHash, paper.path, store],
  );

  // -----------------------------------------------------------------
  // Side-chat scene application: when a chat turn returns a new
  // chat-frame scene, merge its elements into the live Excalidraw
  // canvas and persist them in the store so a hydrate after restart
  // brings them back. The chat MCP namespaces every emitted id under
  // `wb-chat-<queryId>-...` (whiteboard-mcp.ts:320), so a plain merge
  // can't collide with L1/L2 ids — but we still de-dup defensively
  // by id in case the same chat scene is delivered twice.
  // -----------------------------------------------------------------
  const handleChatSceneApply = useCallback(
    (sceneJson: string, _frameId: string, chatQueryId?: string) => {
      if (!api) return;
      let parsed: { elements?: unknown[] } | null = null;
      try {
        parsed = JSON.parse(sceneJson) as { elements?: unknown[] };
      } catch (err) {
        console.warn('[Whiteboard UI] chat scene parse failed', err);
        return;
      }
      const incoming = Array.isArray(parsed?.elements) ? (parsed!.elements as Array<{ id?: string }>) : [];
      if (incoming.length === 0) return;
      const existing = api.getSceneElements();
      const existingIds = new Set(existing.map((e) => (e as { id: string }).id));
      const merged = [
        ...existing,
        ...incoming.filter((e) => !e.id || !existingIds.has(e.id)),
      ];
      // CRITICAL: regenerateIds=false. The chat MCP already gave us
      // namespaced stable ids (wb-chat-<queryId>-...) and arrows
      // reference each other by id; regenerating would break those
      // bindings. Same reasoning as L1/L2 mounts above.
      const converted = convertToExcalidrawElements(
        merged as Parameters<typeof convertToExcalidrawElements>[0],
        { regenerateIds: false },
      );
      api.updateScene({ elements: converted });
      if (chatQueryId) {
        store.setChatScene(paperHash, chatQueryId, sceneJson);
      }
      // Auto-scroll to the just-added chat frame so the user sees the
      // answer their question got. Without this the frame lands at
      // x ≈ bbox.maxX + 200 (per CHAT_SYSTEM prompt — typically 1740+
      // for an L1+L2 paper) which is well past the L1 fit-to-content
      // viewport — the side-chat panel says "applied to canvas" + the
      // assistant turn shows a "Jump to chart →" button, but the user
      // has no signal that anything visible happened. Scroll resolves
      // the affordance immediately.
      //
      // We match by customData.chatQueryId (stamped by pushElements
      // in chat mode at whiteboard-mcp.ts:339-342) AND fathomKind ===
      // 'wb-chat-frame' so we anchor on the frame rect, not on a
      // child node. Falls back to any wb-chat-frame in the incoming
      // batch if the queryId match misses (e.g. server didn't echo it
      // back due to a serialization edge).
      type ConvertedEl = (typeof converted)[number] & {
        customData?: { fathomKind?: string; chatQueryId?: string };
      };
      const chatFrame =
        (chatQueryId
          ? (converted as ConvertedEl[]).find(
              (el) =>
                el.type === 'frame' &&
                el.customData?.fathomKind === 'wb-chat-frame' &&
                el.customData?.chatQueryId === chatQueryId,
            )
          : undefined) ??
        (converted as ConvertedEl[])
          .filter(
            (el) => el.type === 'frame' && el.customData?.fathomKind === 'wb-chat-frame',
          )
          .pop();
      if (chatFrame) {
        try {
          api.scrollToContent([chatFrame], {
            fitToContent: true,
            animate: true,
            duration: 320,
          });
        } catch (scrollErr) {
          console.warn('[Whiteboard UI] chat-frame scroll failed', scrollErr);
        }
      }
      console.log(
        `[Whiteboard UI] chat scene applied: +${incoming.length} elements ` +
          `(query=${chatQueryId ?? '?'}, total=${converted.length}, ` +
          `scrolled=${chatFrame ? chatFrame.id : 'none'})`,
      );
    },
    [api, paperHash, store],
  );

  // Jump-to-frame: side chat passes the Excalidraw element id of the
  // chat frame on demand; we resolve it on the live scene and animate
  // scrollToContent to it (mirrors back-click animation parameters
  // already used elsewhere in the tab).
  const handleJumpToFrame = useCallback(
    (frameElementId: string) => {
      if (!api) return;
      const target = api.getSceneElements().find((el) => (el as { id: string }).id === frameElementId);
      if (!target) {
        console.warn(`[Whiteboard UI] jump-to-frame: ${frameElementId} not in scene`);
        return;
      }
      api.scrollToContent([target], { fitToContent: true, animate: true, duration: 320 });
    },
    [api],
  );

  // -----------------------------------------------------------------
  // Render branches: consent / pipeline-running / ready.
  // -----------------------------------------------------------------
  // Round-14e: while hydration is in flight (whiteboardGet IPC
  // pending), show a quiet placeholder instead of the consent
  // screen. Otherwise the user sees "Generate the whiteboard?" for
  // the 50-200ms window between mount and IPC-resolve, and a
  // misclick on Generate overwrites the saved scene with a fresh
  // $1.90 one.
  if (hydrating) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[color:var(--color-paper)]">
        <div className="text-[12px] text-black/40">Loading whiteboard…</div>
      </div>
    );
  }
  if (!wb || wb.status === 'idle') {
    return (
      <WhiteboardConsent
        onAccept={onConsentAccept}
        onCancel={() => {
          // Stay on the tab; user can change their mind.
          // No-op; consent re-renders.
        }}
      />
    );
  }
  if (wb.status === 'failed' && wb.error && !wb.level1) {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--color-paper)] p-8 text-center">
        <div className="max-w-[440px] rounded-lg border border-red-200 bg-white p-5 text-[13px] text-red-800">
          <div className="mb-2 font-medium">Whiteboard generation failed</div>
          <pre className="mb-4 max-h-48 overflow-auto whitespace-pre-wrap text-[11.5px] text-red-700/80">
            {wb.error}
          </pre>
          <button
            onClick={() => {
              store.reset(paperHash);
              autoCheckedRef.current = null;
            }}
            className="rounded bg-red-700 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-red-600"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-[color:var(--color-paper)]">
      <Suspense fallback={<CanvasLoadingFallback />}>
        <Excalidraw
          excalidrawAPI={(a) => setApi(a)}
          // Cast through unknown — the safe-parse helper hands back a
          // structurally compatible object whose `elements` are our
          // skeleton-derived elements. Excalidraw's
          // ExcalidrawInitialDataState is too strict to express here
          // without re-typing every field; we trust our serializer.
          initialData={
            (wb.excalidrawScene
              ? (safeParseScene(wb.excalidrawScene) as unknown)
              : ({ appState: { viewBackgroundColor: '#fafaf7' } } as unknown)) as Parameters<
              typeof Excalidraw
            >[0]['initialData']
          }
          // Read-only while Pass 1/2 streams. Flips false once L1 paints
          // so the user can manipulate the canvas afterwards.
          viewModeEnabled={wb.status === 'pass1' || wb.status === 'pass2'}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              clearCanvas: false,
              changeViewBackgroundColor: false,
              export: false,
            },
            tools: { image: false },
          }}
          onPointerDown={handlePointerDown}
          name="Fathom Whiteboard"
        />
      </Suspense>
      <WhiteboardBreadcrumb paperHash={paperHash} paperTitle={paper.name} />
      {/* Regenerate + Clear top-right. Self-disables while a Pass 1/2
          run is in flight via wb.status. */}
      <WhiteboardRegenerateButton paperHash={paperHash} onRegenerate={handleRegenerate} />
      {/* Unified chat right rail — always mounted whenever a whiteboard
          exists. During pass1/pass2 the same panel streams the
          understanding / pass2 tokens and disables the Ask input;
          afterwards it shows the per-frame chat history with Ask
          enabled. Replaces the prior split between
          WhiteboardStreamingSidebar and WhiteboardSideChat (#62/#63).

          Layout: the chat root expects a flex/grid cell (h-full,
          w-{rail-px}). Wrap it in an absolute right-edge column so it
          attaches to the right edge of the canvas without fighting the
          existing breadcrumb (top-left), regen button (top-right), or
          cost pill (bottom-left). z-20 puts it above the Excalidraw
          canvas; pointer-events-auto restores interaction. The wrapper
          is `pointer-events-none` so any margin around it doesn't
          intercept canvas drags. */}
      {wb.status !== 'consent' && (
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 z-20 flex">
          <div className="pointer-events-auto h-full">
            <WhiteboardChat
              paperHash={paperHash}
              onSceneModified={handleChatSceneApply}
              onJumpToFrame={handleJumpToFrame}
            />
          </div>
        </div>
      )}
      {/* Round 14d — L1 critic advisory badge. Top-left corner, below
          the streaming sidebar slot. Read-only: surfaces the post-
          export critic verdict from the step-loop without blocking
          ship. Click expands the defect list; Dismiss clears the
          store slot. */}
      <WhiteboardCriticAdvisory paperHash={paperHash} />
      {/* Cost pill bottom-left — small, dismissable, persistent
          state change so plain text is fine here (CLAUDE.md §11
          minor principle: visual indicators for transient,
          plain text for persistent). */}
      {wb.costUsd > 0 && wb.status === 'ready' && (
        <div className="pointer-events-none absolute bottom-3 left-4 z-20 rounded-full bg-white/85 px-3 py-1 text-[11px] text-black/55 shadow-sm backdrop-blur">
          ~${wb.costUsd.toFixed(2)} ·
          {wb.verificationRate !== null
            ? ` ${(wb.verificationRate * 100).toFixed(0)}% citations verified`
            : ''}
        </div>
      )}
    </div>
  );
}

function CanvasLoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center text-[12px] text-black/40">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-black/15 border-t-[#9f661b]" />
    </div>
  );
}

// =====================================================================
// Pipeline orchestration (kept outside the component so the closures
// don't capture stale store snapshots).
// =====================================================================

async function runGenerate(
  host: WhiteboardHost,
  paperHash: string,
  pdfPath: string | undefined,
  store: ReturnType<typeof useWhiteboardStore.getState>,
  handleRef: React.MutableRefObject<{ abort: () => void } | null>,
  purposeAnchor?: string,
): Promise<void> {
  if (!pdfPath) {
    console.warn(
      `[Whiteboard UI] generate aborted: paper=${paperHash.slice(0, 10)} has no pdfPath`,
    );
    return;
  }
  store.reset(paperHash);
  store.setStatus(paperHash, 'pass1');
  console.log(
    '[Whiteboard UI] generate begin',
    paperHash.slice(0, 10),
    purposeAnchor ? `purpose="${purposeAnchor.slice(0, 80)}"` : 'purpose=none',
  );
  void host.logDev?.(
    'info',
    'Whiteboard UI',
    `generate begin paper=${paperHash.slice(0, 10)}` +
      (purposeAnchor ? ` purpose="${purposeAnchor.slice(0, 80)}"` : ''),
  );
  try {
    const handle = await host.generate(
      { paperHash, pdfPath, purposeAnchor },
      {
        onPass1Delta: (text) => store.appendUnderstanding(paperHash, text),
        onPass1Done: (info) => {
          console.log(
            `[Whiteboard UI] pass1 done cost=$${info.costUsd.toFixed(3)} t=${info.latencyMs}ms`,
          );
          store.setUnderstanding(paperHash, info.understanding);
          store.setStatus(paperHash, 'pass2');
          store.setCost(paperHash, info.costUsd);
        },
        onPass2Delta: (text) => store.appendPass2Stream(paperHash, text),
        onPass2Done: (info) => {
          console.log(
            `[Whiteboard UI] pass2 done cost=$${info.costUsd.toFixed(4)} cache=${info.cachedPrefixHit ? 'HIT' : 'miss'} raw=${info.raw.length}ch`,
          );
          store.clearPass2Stream(paperHash);
          // MCP-driven Pass 2 returns a full .excalidraw scene JSON in
          // `info.raw` (per src/main/ai/whiteboard.ts:661). The
          // in-MCP visual self-loop already grades + patches the scene
          // before export, so the renderer-side runCritiqueLoop is
          // obsolete on this path. Sanity-check the shape, then push
          // the scene into the store via setPass2L1Scene — the
          // pass2L1Scene mount effect below picks it up and calls
          // api.updateScene to replace the live canvas.
          let parsed: { elements?: unknown[] } | null = null;
          try {
            parsed = JSON.parse(info.raw) as { elements?: unknown[] };
          } catch (err) {
            console.warn('[Whiteboard UI] pass2Done: raw is not JSON', err);
          }
          if (parsed && Array.isArray(parsed.elements) && parsed.elements.length > 0) {
            store.setPass2L1Scene(paperHash, info.raw);
            return;
          }
          // Fallback: legacy DSL path (for tests / older fixtures that
          // still emit WBDiagram-shaped output). Try the tolerant
          // parser; if it works, ship through the old runCritiqueLoop.
          const diagram = parseWBDiagram(info.raw, { level: 1 });
          if (!diagram) {
            store.setError(
              paperHash,
              'Pass 2 returned an unrenderable result (neither an Excalidraw scene nor a parseable WBDiagram). The raw output is in the streaming sidebar; try regenerating.',
            );
            return;
          }
          void runCritiqueLoop(host, paperHash, diagram, store);
        },
        onVerifier: (info) => {
          console.log(
            `[Whiteboard UI] verifier rate=${(info.verificationRate * 100).toFixed(0)}%`,
          );
          const quoteStatus: Record<
            string,
            { status: 'verified' | 'soft' | 'unverified'; score: number }
          > = {};
          for (const [k, v] of Object.entries(info.quoteStatus)) {
            quoteStatus[k] = { status: v.status, score: v.score };
          }
          store.setVerifier(paperHash, {
            verificationRate: info.verificationRate,
            quoteStatus,
          });
        },
        onDone: (info) => {
          console.log(
            `[Whiteboard UI] generation complete total=$${info.totalCost.toFixed(3)}`,
          );
          store.setCost(paperHash, info.totalCost);
          store.setStatus(paperHash, 'ready');
        },
        onError: (message) => {
          console.error('[Whiteboard UI] generate error:', message);
          store.setError(paperHash, message);
        },
      },
    );
    handleRef.current = handle;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.setError(paperHash, message);
  }
}

async function runExpand(
  host: WhiteboardHost,
  paperHash: string,
  nodeId: string,
  nodeLabel: string | undefined,
  store: ReturnType<typeof useWhiteboardStore.getState>,
  handlesRef: React.MutableRefObject<Map<string, { abort: () => void }>>,
): Promise<void> {
  store.startExpanding(paperHash, nodeId);
  console.log('[Whiteboard UI] expand begin', { paperHash: paperHash.slice(0, 10), nodeId });
  void host.logDev?.(
    'info',
    'Whiteboard UI',
    `expand begin paper=${paperHash.slice(0, 10)} node=${nodeId}`,
  );
  try {
    const handle = await host.expand(
      { paperHash, nodeId, nodeLabel },
      {
        onPass2Delta: (text) => store.appendPass2Stream(paperHash, text),
        onPass2Done: (info) => {
          console.log(
            `[Whiteboard UI] expand pass2 done cost=$${info.costUsd.toFixed(4)} cache=${info.cachedPrefixHit ? 'HIT' : 'miss'}`,
          );
          store.clearPass2Stream(paperHash);
          const diagram = parseWBDiagram(info.raw, { level: 2, parent: info.parentNodeId });
          if (!diagram) {
            store.setError(
              paperHash,
              `Sonnet returned an unparseable Level 2 diagram for node ${nodeId}.`,
            );
            store.endExpanding(paperHash, nodeId);
            return;
          }
          store.setLevel2(paperHash, info.parentNodeId, diagram);
        },
        onDone: (info) => {
          store.endExpanding(paperHash, info.parentNodeId);
          store.setCost(paperHash, info.totalCost);
          // Free the in-flight handle so the click handler doesn't
          // think a new click is "already pre-warming" indefinitely.
          handlesRef.current.delete(nodeId);
        },
        onError: (message) => {
          console.error('[Whiteboard UI] expand error:', message);
          store.setError(paperHash, message);
          store.endExpanding(paperHash, nodeId);
          handlesRef.current.delete(nodeId);
        },
      },
    );
    handlesRef.current.set(nodeId, handle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.setError(paperHash, message);
    store.endExpanding(paperHash, nodeId);
    handlesRef.current.delete(nodeId);
  }
}

// =====================================================================
// Excalidraw scene mounting helpers
// =====================================================================

function mountSkeleton(api: ExcalidrawImperativeAPI): void {
  // Doherty contract: the very first paint after the user clicks
  // Generate must show 5 placeholder node outlines + a generating
  // glyph within 1 frame, so the wait doesn't feel like a freeze.
  // Every skeleton element is tagged with `fathomKind: 'wb-skeleton'`
  // (not 'wb-node') so the Level 1 mount can wholesale strip them
  // even though Excalidraw rewrites the element ids on insertion.
  const skeletons: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    skeletons.push({
      type: 'rectangle',
      x: i * 220,
      y: 0,
      width: 160,
      height: 70,
      strokeColor: '#bcaa86',
      backgroundColor: 'transparent',
      strokeWidth: 1,
      strokeStyle: 'dashed',
      roundness: { type: 3 },
      roughness: 1,
      customData: { fathomKind: 'wb-skeleton', level: 1 } as WBNodeCustomData,
    });
  }
  skeletons.push({
    type: 'text',
    x: 0,
    y: -36,
    text: 'Generating…',
    fontSize: 14,
    fontFamily: 1,
    strokeColor: '#9f661b',
    customData: { fathomKind: 'wb-skeleton', level: 1 } as WBNodeCustomData,
  });
  // CRITICAL: regenerateIds=false. Default true. With true, the
  // skeleton's `containerId: rectId` references break because
  // Excalidraw assigns FRESH ids to every element on conversion,
  // leaving the bound text pointing at non-existent containers and
  // free-floating in scene coords with the synthetic x/y we wrote.
  // This was the root cause of "summary text outside the box" the
  // PM caught — the persisted scene from the previous build showed
  // every wb-summary text element with cid pointing at a non-existent
  // synthetic id like `wb-node-L1.2-mof0q7w`. Same risk for arrow
  // start/end bindings (would un-bind on conversion). Same fix.
  const elements = convertToExcalidrawElements(
    skeletons as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: false },
  );
  api.updateScene({ elements });
  api.scrollToContent(undefined, { fitToContent: true, animate: false });
}

async function mountLevel1Frame(
  host: WhiteboardHost,
  api: ExcalidrawImperativeAPI,
  diagram: WBDiagram,
  paperHash: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const layout = await layoutDiagram(diagram);
  const origin = { x: 0, y: 0 };
  // Resolve any figure_refs to fileIds before generating skeletons —
  // see resolveFigureBindings for the disk-IO + addFiles dance. Done
  // first so the figure-image skeletons reference fileIds Excalidraw
  // already knows about (otherwise the image element renders as a
  // grey "missing file" placeholder until the next render tick).
  const figureBindings = await resolveFigureBindings(host, api, diagram, paperHash);
  const sceneSkeletons = diagramToSkeleton(diagram, layout, origin, figureBindings);
  const newElements = convertToExcalidrawElements(
    sceneSkeletons as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: false },
  );
  // Replace ALL skeleton elements with the real Level 1. The filter
  // matches `customData.fathomKind === 'wb-skeleton'` rather than the
  // element id — convertToExcalidrawElements regenerates ids on
  // insertion (regenerateIds defaults to true), so id-prefix filtering
  // never matched. This was the root of the "empty boxes still painted
  // behind real nodes" bug the PM screenshot caught.
  const surviving = api
    .getSceneElements()
    .filter((el) => {
      const cd = (el as { customData?: WBNodeCustomData }).customData;
      if (!cd) return true; // user-drawn — keep
      if (cd.fathomKind === 'wb-skeleton') return false;
      return true;
    });
  api.updateScene({ elements: [...surviving, ...newElements] });
  console.log(
    `[Whiteboard UI] L1 mounted: ${newElements.length} elements, ${diagram.nodes.length} nodes ` +
      `(${figureBindings.size} figures embedded), removed ${api.getSceneElements().length - surviving.length - newElements.length} skeleton elements`,
  );
  return diagramBoundingBox(diagram, layout, origin);
}

async function mountLevel2Frame(
  host: WhiteboardHost,
  api: ExcalidrawImperativeAPI,
  diagram: WBDiagram,
  parentNodeId: string,
  paperHash: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const layout = await layoutDiagram(diagram);
  // VERTICAL drill — the Level 2 frame sits BELOW its parent Level 1
  // node, not to the right. The user's mental model is "zooming into
  // a node moves you DOWN the page, not across." Per the team-lead
  // brief 2026-04-25: same recursion grammar applies if Level 3 ever
  // ships. We find the parent node's rectangle in the live scene
  // (placed by mountLevel1Frame), center the new frame's x on the
  // parent's x-midpoint, and stack vertically with VERTICAL_GAP px
  // of breathing room.
  const VERTICAL_GAP = 140;
  const FALLBACK_BELOW_L1_Y = 600;
  const parentRect = api
    .getSceneElements()
    .find((el) => {
      const cd = (el as { customData?: WBNodeCustomData }).customData;
      return (
        cd?.fathomKind === 'wb-node' && cd.level === 1 && cd.nodeId === parentNodeId
      );
    });
  // If a Level 2 frame for a *different* parent has already been
  // placed below the L1 row, stack subsequent L2 frames below it
  // again rather than crashing into it. Each L2 frame's bottom edge
  // becomes the next placement's top reference.
  let baseY: number;
  let centerX: number;
  if (parentRect) {
    const px = (parentRect as unknown as { x: number; y: number; width: number; height: number }).x;
    const py = (parentRect as unknown as { x: number; y: number; width: number; height: number }).y;
    const pw = (parentRect as unknown as { x: number; y: number; width: number; height: number }).width;
    const ph = (parentRect as unknown as { x: number; y: number; width: number; height: number }).height;
    centerX = px + pw / 2;
    baseY = py + ph + VERTICAL_GAP;
  } else {
    centerX = L1_LAYOUT_WIDTH / 2;
    baseY = FALLBACK_BELOW_L1_Y;
  }
  // Stack against any already-placed L2 frames so two simultaneous
  // pre-warm drills don't overlap each other.
  const placedLevel2Frames = api
    .getSceneElements()
    .filter((el) => {
      const cd = (el as { customData?: WBNodeCustomData }).customData;
      return cd?.level === 2 && cd.fathomKind === 'wb-frame';
    }) as Array<{ x: number; y: number; width: number; height: number }>;
  for (const f of placedLevel2Frames) {
    const fBottom = f.y + f.height;
    if (fBottom + VERTICAL_GAP > baseY) baseY = fBottom + VERTICAL_GAP;
  }
  const origin = { x: centerX - layout.width / 2, y: baseY };
  const figureBindings = await resolveFigureBindings(host, api, diagram, paperHash);
  const sceneSkeletons = diagramToSkeleton(diagram, layout, origin, figureBindings);
  const newElements = convertToExcalidrawElements(
    sceneSkeletons as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: false },
  );
  const existing = api.getSceneElements();
  api.updateScene({ elements: [...existing, ...newElements] });
  console.log(
    `[Whiteboard UI] L2 mounted parent=${parentNodeId} at (${Math.round(origin.x)}, ${Math.round(origin.y)}): ` +
      `${newElements.length} elements, ${diagram.nodes.length} nodes ` +
      `(${figureBindings.size} figures embedded)`,
  );
  return diagramBoundingBox(diagram, layout, origin);
}

// =====================================================================
// Render-only QA fixture (CLAUDE.md §0 isolation)
// =====================================================================
//
// Skip Pass 1 + Pass 2. Mount a hand-written WBDiagram (or one
// loaded from `<sidecar>/whiteboard-test-diagram.json` if it exists)
// through the live render pipeline so we can iterate on the render
// layer in ~2s per round, with NO Claude spend. Fires on the
// `fathom:qaWhiteboardRenderOnly` custom event, dispatched by App.tsx
// when ⌘⇧F3 lands.
//
// Derived from the actual whiteboard-understanding.md the live
// pipeline produced for the bundled sample paper (ReconViaGen). Node
// labels + summaries reflect realistic worst-case widths so the
// text-fits-in-box fix is exercised against representative content.

const RENDER_ONLY_FIXTURE: WBDiagram = {
  level: 1,
  title: 'ReconViaGen — pose-free 3D reconstruction',
  nodes: [
    {
      id: 'L1.1',
      label: 'VGGT Encoder',
      kind: 'input',
      summary:
        'Pre-trained pose-free MVS transformer, LoRA-tuned on Objaverse; outputs multi-layer features ϕ_vggt from layers 4/11/17/23.',
      drillable: false,
      citation: { page: 4, quote: 'we use scaled dot-product attention' },
    },
    {
      id: 'L1.2',
      label: 'Reconstruction Conditioning',
      kind: 'process',
      summary:
        'Condition Net (4 cross-attn blocks) distills VGGT features into Global Geometry Condition (GGC) + Per-View Conditions (PVC).',
      drillable: true,
      citation: { page: 5, quote: 'condition net cross-attention' },
    },
    {
      id: 'L1.3',
      label: 'Coarse-to-Fine Generation',
      kind: 'model',
      summary:
        'TRELLIS SS Flow generates sparse voxels conditioned on GGC; SLAT Flow generates per-voxel latents conditioned on PVC.',
      drillable: true,
      citation: { page: 6, quote: 'rectified flow transformer' },
    },
    {
      id: 'L1.4',
      label: 'Camera Pose Refinement',
      kind: 'process',
      summary:
        'VGGT estimates poses from 30 auxiliary views; refined via image-matching + PnP/RANSAC against partial-generation renders.',
      drillable: false,
    },
    {
      id: 'L1.5',
      label: 'Velocity Compensation',
      kind: 'output',
      summary:
        'When t<0.5, decode SLAT to mesh, render from refined poses, compute SSIM+LPIPS+DreamSim loss, derive Δv added to next step.',
      drillable: true,
      citation: { page: 6, quote: 'rendering aware velocity correction' },
    },
  ],
  edges: [
    { from: 'L1.1', to: 'L1.2', label: 'ϕ_vggt' },
    { from: 'L1.2', to: 'L1.3', label: 'GGC, PVC' },
    { from: 'L1.1', to: 'L1.4', label: 'poses' },
    { from: 'L1.4', to: 'L1.5', label: 'refined poses' },
    { from: 'L1.3', to: 'L1.5', label: 'partial mesh' },
  ],
  layout_hint: 'lr',
};

async function runRenderOnlyFixture(
  host: WhiteboardHost,
  paperHash: string,
  store: ReturnType<typeof useWhiteboardStore.getState>,
): Promise<void> {
  console.log('[Whiteboard UI] render-only fixture begin', paperHash.slice(0, 10));
  // Try a per-paper fixture file first; fall back to the hardcoded
  // ReconViaGen one. The file path lets a tester drop a custom JSON
  // into the sidecar without rebuilding.
  let diagram: WBDiagram = RENDER_ONLY_FIXTURE;
  try {
    const result = await host.load(paperHash);
    if (result.indexPath) {
      // Best-effort: try to read a fixture from the sidecar via the
      // asset-read IPC. If absent, the catch falls through to the
      // hardcoded fixture.
      const fixturePath = `${result.indexPath}/whiteboard-test-diagram.json`;
      try {
        const dataUrl = await host.readAssetAsDataUrl(fixturePath);
        if (dataUrl && dataUrl.startsWith('data:')) {
          // dataURL of a JSON file decodes to base64 of the JSON.
          const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
          const json = atob(b64);
          const parsed = parseWBDiagram(json, { level: 1 });
          if (parsed) {
            diagram = parsed;
            console.log('[Whiteboard UI] render-only loaded fixture from disk');
          }
        }
      } catch {
        /* fixture absent — using hardcoded */
      }
    }
  } catch {
    /* whiteboardGet failed — using hardcoded */
  }
  // Skip Pass 1 + Pass 2. Reset state, set status straight to ready,
  // and feed the fixture diagram into setLevel1 — the existing mount
  // effect picks it up and renders to the live canvas.
  store.reset(paperHash);
  store.setStatus(paperHash, 'pass2'); // so the skeleton paints first
  // Defer the setLevel1 call so the user sees the skeleton-tear-down
  // animation work end-to-end (this exercises the wb-skeleton filter
  // bug fix too).
  setTimeout(() => {
    store.setLevel1(paperHash, diagram);
    store.setStatus(paperHash, 'ready');
    store.setCost(paperHash, 0); // explicitly $0 — render-only
    console.log('[Whiteboard UI] render-only setLevel1 done; mount effect will fire');
  }, 200);
}

// =====================================================================
// Pass 2.5 — visual critique loop (renderer side)
// =====================================================================
//
// "AI agents that produce visual artefacts must see-and-iterate." After
// Pass 2 emits a WBDiagram we:
//   1. Lay it out via ELK + diagramToSkeleton + convertToExcalidrawElements.
//   2. Render the resulting elements to a PNG via Excalidraw's
//      `exportToCanvas` — DOES NOT mount in the live scene; it's a
//      headless rasterise that returns a Canvas we read as PNG.
//   3. Write the PNG to the per-paper sidecar via the
//      `whiteboard:writeRenderPng` IPC.
//   4. Call `whiteboard:critique` with the PNG path + the diagram JSON.
//   5. If verdict is {ok: true}, ship the diagram to the live scene.
//      If {fix: 'patch'}, apply the typed ops and loop.
//      If {fix: 'replace'}, swap to the new diagram and loop.
//   6. Cap at 3 iterations to bound spend + latency. After 3, ship the
//      best diagram we have (the latest, even if not "ok") so the user
//      never sees a permanent stall.

// Downgraded round 11: primary critique loop now lives inside Pass 2 MCP. This is the safety net.
const CRITIQUE_MAX_ITERATIONS = 1;

interface CritiqueVerdict {
  ok?: boolean;
  fix?: 'patch' | 'replace';
  ops?: Array<{
    op: 'shorten_summary' | 'rename_label' | 'drop_node' | 'drop_edge' | 'set_drillable' | 'set_figure_ref';
    node_id?: string;
    to?: string;
    from?: string;
    drillable?: boolean;
    figure_ref?: { page: number; figure: number };
  }>;
  diagram?: unknown;
  reason?: string;
}

async function runCritiqueLoop(
  host: WhiteboardHost,
  paperHash: string,
  initialDiagram: WBDiagram,
  store: ReturnType<typeof useWhiteboardStore.getState>,
): Promise<void> {
  let current = initialDiagram;
  for (let iter = 1; iter <= CRITIQUE_MAX_ITERATIONS; iter++) {
    let verdict: CritiqueVerdict | null = null;
    try {
      // Render to PNG (off-screen — does not touch the live canvas).
      const pngBase64 = await renderDiagramToPng(host, current, paperHash);
      if (!pngBase64) {
        console.warn(
          `[Whiteboard UI] Pass2.5 iter=${iter} render failed; shipping current diagram unchanged`,
        );
        break;
      }
      // Write to sidecar so the critique prompt can Read it.
      const writeResult = await host.writeRenderPng(
        paperHash,
        iter,
        pngBase64,
      );
      if (!writeResult.ok || !writeResult.path) {
        console.warn(
          `[Whiteboard UI] Pass2.5 iter=${iter} writeRenderPng failed: ${writeResult.error ?? 'unknown'}; shipping current`,
        );
        break;
      }
      const critique = await host.critique(
        paperHash,
        JSON.stringify(current),
        writeResult.path,
        iter,
      );
      console.log(
        `[Whiteboard UI] Pass2.5 iter=${iter} verdict=${critique.verdict ? JSON.stringify(critique.verdict).slice(0, 80) : 'unparseable'} cost=$${critique.costUsd.toFixed(4)}`,
      );
      verdict = critique.verdict as CritiqueVerdict | null;
    } catch (err) {
      console.warn(
        `[Whiteboard UI] Pass2.5 iter=${iter} threw: ${err instanceof Error ? err.message : err}; shipping current`,
      );
      break;
    }
    if (!verdict || verdict.ok === true) {
      // Approved (or unparseable verdict — treat as approved to never
      // block on a critique parse bug).
      break;
    }
    if (verdict.fix === 'patch' && Array.isArray(verdict.ops) && verdict.ops.length > 0) {
      const next = applyOpsToDiagram(current, verdict.ops);
      if (!next) {
        console.warn('[Whiteboard UI] Pass2.5 patch produced an unusable diagram; shipping pre-patch');
        break;
      }
      current = next;
      continue;
    }
    if (verdict.fix === 'replace' && verdict.diagram) {
      // Re-run the tolerant parser against the model's replacement
      // diagram. parseWBDiagram only takes a string — so re-stringify
      // the verdict's diagram object, then parse.
      const replaced = parseWBDiagram(JSON.stringify(verdict.diagram), {
        level: current.level,
        parent: current.parent,
      });
      if (!replaced) {
        console.warn('[Whiteboard UI] Pass2.5 replace produced an unparseable diagram; shipping pre-replace');
        break;
      }
      current = replaced;
      continue;
    }
    // Unrecognised verdict shape — bail.
    break;
  }
  // Ship the diagram (original or after up to 3 iterations) to the
  // store. The mount effect picks it up and renders to the live
  // canvas + kicks off L2 pre-warm.
  store.setLevel1(paperHash, current);
}

/** Apply a list of typed ops to a WBDiagram. Returns null if the
 * patched diagram has zero usable nodes (e.g. all nodes dropped),
 * which is a no-op signal to the caller. */
function applyOpsToDiagram(d: WBDiagram, ops: NonNullable<CritiqueVerdict['ops']>): WBDiagram | null {
  let nodes = [...d.nodes];
  let edges = [...d.edges];
  for (const op of ops) {
    if (op.op === 'shorten_summary' && op.node_id && typeof op.to === 'string') {
      nodes = nodes.map((n) => (n.id === op.node_id ? { ...n, summary: op.to } : n));
    } else if (op.op === 'rename_label' && op.node_id && typeof op.to === 'string') {
      const safe = op.to.length > 28 ? op.to.slice(0, 27) + '…' : op.to;
      nodes = nodes.map((n) => (n.id === op.node_id ? { ...n, label: safe } : n));
    } else if (op.op === 'drop_node' && op.node_id) {
      nodes = nodes.filter((n) => n.id !== op.node_id);
      edges = edges.filter((e) => e.from !== op.node_id && e.to !== op.node_id);
    } else if (op.op === 'drop_edge' && op.from && op.node_id) {
      // Note: critique JSON uses {from, to} for edges; we accept
      // either {from, to} or {from, node_id} pairing.
      const target = op.node_id;
      edges = edges.filter((e) => !(e.from === op.from && e.to === target));
    } else if (op.op === 'set_drillable' && op.node_id && typeof op.drillable === 'boolean') {
      nodes = nodes.map((n) => (n.id === op.node_id ? { ...n, drillable: op.drillable } : n));
    } else if (op.op === 'set_figure_ref' && op.node_id && op.figure_ref) {
      nodes = nodes.map((n) => (n.id === op.node_id ? { ...n, figure_ref: op.figure_ref } : n));
    }
  }
  if (nodes.length === 0) return null;
  return { ...d, nodes, edges };
}

/** Off-screen render the (laid-out) diagram to a PNG. Uses
 * Excalidraw's `exportToCanvas` so we DON'T need to mount the diagram
 * in the live scene during critique. Returns a base64-encoded PNG
 * (without the data: prefix), ready to ship through IPC. Returns
 * null on any failure — the critique loop treats null as "skip this
 * iteration, ship as-is." */
async function renderDiagramToPng(
  host: WhiteboardHost,
  diagram: WBDiagram,
  paperHash: string,
): Promise<string | null> {
  try {
    const layout = await layoutDiagram(diagram);
    // Build BOTH the BinaryFiles map (for exportToCanvas) AND the
    // nodeId→fileId bindings (for diagramToSkeleton) in a single
    // walk — same fileId format on both sides means the rendered
    // image element references a file the canvas will render.
    const { files, bindings } = await collectFiguresForExport(host, diagram, paperHash);
    const skeletons = diagramToSkeleton(diagram, layout, { x: 0, y: 0 }, bindings);
    const elements = convertToExcalidrawElements(
      skeletons as Parameters<typeof convertToExcalidrawElements>[0],
      { regenerateIds: false },
    );
    const canvas = await exportToCanvas({
      elements,
      appState: { viewBackgroundColor: '#fafaf7' } as Parameters<typeof exportToCanvas>[0]['appState'],
      files: files as Parameters<typeof exportToCanvas>[0]['files'],
      getDimensions: (w: number, h: number) => ({
        width: Math.max(800, w),
        height: Math.max(400, h),
        scale: 1,
      }),
      exportPadding: 24,
    });
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn(`[Whiteboard UI] renderDiagramToPng failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Walk every node with a figure_ref and read its PNG via the asset
 * IPC, packing into BOTH the BinaryFiles map (keyed by fileId, the
 * shape `exportToCanvas` expects) AND the nodeId→fileId bindings
 * (the shape `diagramToSkeleton` expects). Same file id format
 * (`wb-fig-<8 of hash>-p<NNN>-f<K>`) keeps the two in sync. */
async function collectFiguresForExport(
  host: WhiteboardHost,
  diagram: WBDiagram,
  paperHash: string,
): Promise<{
  files: Record<string, { mimeType: 'image/png'; id: string; dataURL: string; created: number }>;
  bindings: Map<string, string>;
}> {
  const files: Record<
    string,
    { mimeType: 'image/png'; id: string; dataURL: string; created: number }
  > = {};
  const bindings = new Map<string, string>();
  const indexPath = useWhiteboardStore.getState().get(paperHash).indexPath;
  if (!indexPath) return { files, bindings };
  for (const node of diagram.nodes) {
    const ref = node.figure_ref;
    if (!ref) continue;
    const padded = String(ref.page).padStart(3, '0');
    const absPath = `${indexPath}/images/page-${padded}-fig-${ref.figure}.png`;
    try {
      const dataUrl = await host.readAssetAsDataUrl(absPath);
      if (!dataUrl || !dataUrl.startsWith('data:image/')) continue;
      const fileId = `wb-fig-${paperHash.slice(0, 8)}-p${padded}-f${ref.figure}`;
      files[fileId] = { mimeType: 'image/png', id: fileId, dataURL: dataUrl, created: Date.now() };
      bindings.set(node.id, fileId);
    } catch {
      /* missing on disk — silently fall back to text-only */
    }
  }
  return { files, bindings };
}

/**
 * For every node with a `figure_ref`, read the cropped figure PNG from
 * the per-paper sidecar (`<indexPath>/images/page-NNN-fig-K.png`),
 * register it with Excalidraw via `addFiles`, and return a map from
 * nodeId → fileId. Nodes whose figure file doesn't exist are silently
 * skipped — the renderer falls back to text-only.
 *
 * The renderer never lists the images directory itself (no embeddings,
 * no semantic search, just a deterministic path computed from the
 * model's `figure_ref`). This preserves CLAUDE.md §6's no-RAG rule.
 */
async function resolveFigureBindings(
  host: WhiteboardHost,
  api: ExcalidrawImperativeAPI,
  diagram: WBDiagram,
  paperHash: string,
): Promise<Map<string, string>> {
  const bindings = new Map<string, string>();
  const indexPath = useWhiteboardStore.getState().get(paperHash).indexPath;
  if (!indexPath) {
    if (diagram.nodes.some((n) => n.figure_ref)) {
      console.warn(
        '[Whiteboard UI] figure_refs present but no indexPath in store — skipping figure embed',
      );
    }
    return bindings;
  }
  const filesToAdd: Array<{
    mimeType: 'image/png';
    id: string;
    dataURL: string;
    created: number;
  }> = [];
  for (const node of diagram.nodes) {
    const ref = node.figure_ref;
    if (!ref) continue;
    const padded = String(ref.page).padStart(3, '0');
    const filename = `images/page-${padded}-fig-${ref.figure}.png`;
    const absPath = `${indexPath}/${filename}`;
    try {
      const dataUrl = await host.readAssetAsDataUrl(absPath);
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        console.warn(`[Whiteboard UI] figure missing or invalid: ${absPath}`);
        continue;
      }
      // FileId is content-addressed via a stable hash of the figure
      // filename — the same node→figure mapping across renders maps to
      // the same fileId, so re-renders don't duplicate files in the
      // BinaryFiles store. (We rely on the page+fig uniqueness within a
      // paper; collisions across papers don't matter, the BinaryFiles
      // map is per-scene.)
      const fileId = `wb-fig-${paperHash.slice(0, 8)}-p${padded}-f${ref.figure}`;
      filesToAdd.push({
        mimeType: 'image/png',
        id: fileId,
        dataURL: dataUrl,
        created: Date.now(),
      });
      bindings.set(node.id, fileId);
    } catch (err) {
      console.warn(
        `[Whiteboard UI] figure read failed for ${absPath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  if (filesToAdd.length > 0) {
    api.addFiles(
      filesToAdd as unknown as Parameters<ExcalidrawImperativeAPI['addFiles']>[0],
    );
    console.log(`[Whiteboard UI] embedded ${filesToAdd.length} paper figure(s)`);
  }
  return bindings;
}

async function persistScene(
  host: WhiteboardHost,
  api: ExcalidrawImperativeAPI,
  paperHash: string,
  store: ReturnType<typeof useWhiteboardStore.getState>,
): Promise<void> {
  try {
    const elements = api.getSceneElements();
    const appState = api.getAppState?.();
    // Strip transient/runtime-only appState fields before persisting.
    // Excalidraw uses a JS `Map` for `collaborators` internally, but
    // JSON.stringify silently turns it into `{}`; on restore Excalidraw
    // calls `appState.collaborators.forEach(...)` and crashes inside
    // its render loop with "forEach is not a function" — caught by
    // the React error boundary, the whole Whiteboard tab goes dark.
    // Same risk for other non-serialisable fields (selectedElementIds,
    // openMenu, contextMenu, draggingElement, etc.). Cheapest robust
    // fix: persist only the small set of `appState` fields that are
    // both plain-data AND useful across reloads. Anything else,
    // Excalidraw will re-initialise to a sane default.
    const persistableAppState = sanitiseAppStateForDisk(appState);
    const scene = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'fathom-whiteboard',
      elements,
      appState: persistableAppState,
      files: api.getFiles?.() ?? {},
    });
    store.setExcalidrawScene(paperHash, scene);
    await host.saveScene(paperHash, scene);
  } catch (err) {
    console.warn('[Whiteboard UI] persistScene failed', err);
  }
}

/** Filter Excalidraw's appState down to the JSON-safe subset we care
 * about across reloads. Anything not in the allowlist gets dropped
 * because (a) most appState fields are runtime-only — selection,
 * dragging, hover, menu open state — and (b) some are non-JSON-safe
 * (Map, Set, DOM refs) that round-trip badly. */
function sanitiseAppStateForDisk(
  appState: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const a = (appState ?? {}) as Record<string, unknown>;
  const allow = [
    'viewBackgroundColor',
    'gridSize',
    'theme',
    'zoom',
    'scrollX',
    'scrollY',
    'currentItemFontFamily',
    'currentItemFontSize',
  ];
  const out: Record<string, unknown> = { viewBackgroundColor: '#fafaf7' };
  for (const k of allow) {
    if (k in a && a[k] !== undefined) out[k] = a[k];
  }
  return out;
}

/** Stamp the Excalidraw v0.18 frame-skeleton fields onto chat-frame
 * elements that were saved by an older `place_chat_frame` (pre
 * 2026-04-27) which omitted `children` + 9 base-element fields. Without
 * them, `convertToExcalidrawElements` drops the frame silently and the
 * user sees "applied to canvas" with no visible diagram.
 *
 * Idempotent: the fix is detected by `children === undefined`. A
 * frame written by the new code already has `children: []` and is
 * untouched. Returns the (possibly-migrated) scene as a JSON string;
 * if the scene is unparseable or has no chat frames, returns the
 * original string verbatim.
 *
 * Walks both top-level chat frames and any future variants tagged
 * `customData.fathomKind === 'wb-chat-frame'` so a non-frame element
 * accidentally typed as a frame is still caught. */
function migrateChatFrames(raw: string): string {
  type FrameLike = {
    type?: string;
    children?: unknown;
    customData?: { fathomKind?: string };
    [k: string]: unknown;
  };
  let parsed: { elements?: FrameLike[]; [k: string]: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!Array.isArray(parsed.elements)) return raw;
  let touched = 0;
  for (const el of parsed.elements) {
    const isChatFrame =
      el.type === 'frame' && el.customData?.fathomKind === 'wb-chat-frame';
    if (!isChatFrame) continue;
    if (el.children !== undefined) continue; // already migrated
    el.children = [];
    if (el.backgroundColor === undefined) el.backgroundColor = 'transparent';
    if (el.fillStyle === undefined) el.fillStyle = 'solid';
    if (el.strokeWidth === undefined) el.strokeWidth = 1;
    if (el.strokeStyle === undefined) el.strokeStyle = 'solid';
    if (el.roughness === undefined) el.roughness = 0;
    if (el.opacity === undefined) el.opacity = 100;
    if (el.angle === undefined) el.angle = 0;
    if (el.boundElements === undefined) el.boundElements = [];
    if (el.groupIds === undefined) el.groupIds = [];
    touched++;
  }
  if (touched === 0) return raw;
  console.log(
    `[Whiteboard UI] migrated ${touched} pre-2026-04-27 chat-frame element(s) on hydrate`,
  );
  return JSON.stringify(parsed);
}

function safeParseScene(raw: string): { elements?: unknown[]; appState?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(raw) as { elements?: unknown[]; appState?: Record<string, unknown> };
    // Re-sanitise on restore as well — defensive against scenes that
    // were saved before the persist-side fix landed (existing users
    // may have a corrupt whiteboard.excalidraw on disk from a prior
    // version of this code that JSON.stringify'd `collaborators: {}`).
    return {
      elements: parsed.elements ?? [],
      appState: sanitiseAppStateForDisk(parsed.appState),
    };
  } catch {
    return { appState: { viewBackgroundColor: '#fafaf7' } };
  }
}

function getNodeLabel(wb: PaperWhiteboard | undefined, nodeId: string): string | undefined {
  if (!wb || !wb.level1) return undefined;
  return wb.level1.nodes.find((n) => n.id === nodeId)?.label;
}

// -----------------------------------------------------------------
// Round 14d — L1 critic advisory badge.
//
// Subscribes to `criticVerdictL1` (set by the
// `whiteboard:critic-verdict` IPC event handler at ~line 372). When
// non-null, renders a small chip in the canvas top-left below the
// breadcrumb. Click expands a popover listing each defect's
// fix_suggestion + stage_attribution; Dismiss clears the store slot.
//
// Read-only per dispatch: round 14d only surfaces the verdict.
// "Apply patch" / auto-fix UX is round 14e or later.
//
// Per-chat-frame badges (canvas-anchored to each chat frame) are
// deferred — those need per-frame screen-coord math against the
// Excalidraw API and are scoped as a follow-up. The L1 badge alone
// already closes the "user has no idea the critic ran" gap that the
// dispatch flagged.
// -----------------------------------------------------------------
function WhiteboardCriticAdvisory({ paperHash }: { paperHash: string }) {
  const verdict = useWhiteboardStore((s) => s.byPaper.get(paperHash)?.criticVerdictL1 ?? null);
  const setVerdict = useWhiteboardStore((s) => s.setCriticVerdictL1);
  const [expanded, setExpanded] = useState(false);

  if (!verdict) return null;

  const defectCount = verdict.defects.length;
  const summary = verdict.pass
    ? '✓ critic graded'
    : `${defectCount} suggestion${defectCount === 1 ? '' : 's'}`;
  const tone = verdict.pass
    ? 'border-emerald-200 bg-emerald-50/95 text-emerald-900'
    : 'border-amber-200 bg-amber-50/95 text-amber-900';

  return (
    <div
      className="pointer-events-auto absolute top-3 left-4 z-20 flex max-w-[360px] flex-col items-start"
      style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`rounded-full border px-3 py-1 text-[11.5px] font-medium shadow-sm backdrop-blur transition hover:shadow-md ${tone}`}
        title={
          verdict.pass
            ? 'Critic reviewed this whiteboard and found no defects'
            : `Click to see ${defectCount} suggestion${defectCount === 1 ? '' : 's'} from the critic`
        }
        aria-expanded={expanded}
        aria-haspopup="dialog"
      >
        {summary}
      </button>
      {expanded && (
        <div
          role="dialog"
          aria-label="Critic verdict details"
          className="mt-2 max-h-[60vh] w-[360px] overflow-y-auto rounded-lg border border-black/10 bg-white/97 p-3 shadow-[0_8px_32px_rgba(0,0,0,0.12)] backdrop-blur"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-black/55">
              Critic verdict
            </span>
            <button
              type="button"
              onClick={() => {
                setVerdict(paperHash, null);
                setExpanded(false);
              }}
              className="rounded-md px-2 py-0.5 text-[11px] font-medium text-black/45 transition hover:bg-black/[0.05] hover:text-black/75"
              title="Dismiss this verdict"
              aria-label="Dismiss critic verdict"
            >
              Dismiss
            </button>
          </div>
          {defectCount === 0 ? (
            <p className="m-0 text-[12px] leading-snug text-black/65">
              The critic found no structural defects. The whiteboard passed all rubric
              checks.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {verdict.defects.map((d, i) => (
                <li
                  key={`${d.kind}-${i}`}
                  className="rounded-md border border-black/[0.06] bg-black/[0.02] p-2"
                >
                  <div className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-black/50">
                    <span>{d.kind}</span>
                    <span className="text-black/30">·</span>
                    <span>{d.stage_attribution}</span>
                    <span
                      className={
                        d.severity === 'fail'
                          ? 'ml-auto text-rose-600'
                          : 'ml-auto text-amber-600'
                      }
                    >
                      {d.severity}
                    </span>
                  </div>
                  <div className="text-[12px] leading-snug text-black/80">
                    {d.fix_suggestion}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
