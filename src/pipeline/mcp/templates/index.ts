/**
 * Templates registry.
 *
 * Round-13 P0 set: 4 templates (flow-chart, comparison-matrix,
 * time-chain, key-insight-callout). Round 14 will add the P1 set
 * (taxonomy-tree, definition-with-callouts, axis-on-number-line,
 * before-after-panels, equation-decomposition).
 *
 * The registry is a map from `templateId` → `TemplateDef`. The MCP
 * `instantiate_template` tool looks up by id; `list_templates` returns
 * the catalog (loaded from `scripts/template-catalog.json` so the
 * agent sees the curated `fitSignals` and `examples` fields the scout
 * authored).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { TemplateDef } from './types';
import { stampTemplate } from './types';
import { flowChartTemplate } from './flow-chart';
import { comparisonMatrixTemplate } from './comparison-matrix';
import { timeChainTemplate } from './time-chain';
import { keyInsightCalloutTemplate } from './key-insight-callout';

export type { SceneElement, TemplateDef, TemplateResult, BBox } from './types';
export { stampTemplate };

const TEMPLATE_REGISTRY: ReadonlyArray<TemplateDef<unknown>> = [
  flowChartTemplate as TemplateDef<unknown>,
  comparisonMatrixTemplate as TemplateDef<unknown>,
  timeChainTemplate as TemplateDef<unknown>,
  keyInsightCalloutTemplate as TemplateDef<unknown>,
];

/** Return the registered template for an id, or undefined if not
 * registered (round-13 ships only the P0 set). */
export function getTemplate(id: string): TemplateDef<unknown> | undefined {
  return TEMPLATE_REGISTRY.find((t) => t.id === id);
}

/** Names of all registered template ids — for diagnostics + the
 * `list_templates` tool's "implemented" filter. */
export function registeredTemplateIds(): string[] {
  return TEMPLATE_REGISTRY.map((t) => t.id);
}

/** Locate `scripts/template-catalog.json` at runtime. Mirrors the
 * server-script search path in whiteboard-mcp.ts (RenderClient) so
 * we work from `src/main/mcp/templates/` (tsx dev), `out/main/`
 * (electron-vite built), and `app.asar.unpacked/` (packaged). */
function catalogPath(): string {
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  const candidates = [
    join(here, '..', '..', '..', '..', 'scripts', 'template-catalog.json'),
    join(here, '..', '..', '..', 'scripts', 'template-catalog.json'),
    join(here, '..', '..', 'scripts', 'template-catalog.json'),
    join(here, '..', 'scripts', 'template-catalog.json'),
    join(process.cwd(), 'scripts', 'template-catalog.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[candidates.length - 1];
}

let cachedCatalog: unknown = null;
let cachedCatalogPath: string | null = null;

/** Read the catalog JSON once and cache. Returns the parsed catalog as
 * an opaque JSON value the MCP `list_templates` tool serialises back
 * to the agent. */
export function loadCatalog(): unknown {
  if (cachedCatalog) return cachedCatalog;
  const p = catalogPath();
  cachedCatalogPath = p;
  try {
    const raw = readFileSync(p, 'utf-8');
    cachedCatalog = JSON.parse(raw);
  } catch (err) {
    cachedCatalog = {
      schemaVersion: 1,
      _error: `Could not load catalog at ${p}: ${err instanceof Error ? err.message : String(err)}`,
      templates: [],
    };
  }
  return cachedCatalog;
}

/** Diagnostic: the path actually used to read the catalog (after
 * loadCatalog() runs). */
export function lastCatalogPath(): string | null {
  return cachedCatalogPath;
}

/** Filter a catalog object's `templates` array to those whose id is
 * registered in this build, and tag each with `implemented: true|false`.
 * The MCP tool surfaces both — the agent can read the full catalog
 * (incl. P1/P2 entries the scout authored) but knows which ones it
 * can actually call instantiate_template on right now. */
export function annotateCatalog(catalog: unknown): unknown {
  if (!catalog || typeof catalog !== 'object') return catalog;
  const c = catalog as { templates?: Array<Record<string, unknown>> };
  if (!Array.isArray(c.templates)) return catalog;
  const implemented = new Set(registeredTemplateIds());
  return {
    ...catalog,
    templates: c.templates.map((t) => ({
      ...t,
      implemented: typeof t.id === 'string' && implemented.has(t.id),
    })),
  };
}

/** Translate a layout-local element coordinate set to scene-absolute
 * by adding (dx, dy) to every element's x/y. Non-mutating — returns
 * a fresh array. The MCP `instantiate_template` handler uses this
 * after calling layout() so templates stay pure (origin 0,0) but the
 * pushed elements land at the section's content position.
 *
 * Arrows store their points relative to (arrow.x, arrow.y), so only
 * arrow.x/y need translation; the points stay relative.
 */
export function translateElements<T extends { x?: number; y?: number; type?: string }>(
  els: T[],
  dx: number,
  dy: number,
): T[] {
  return els.map((el) => {
    if (typeof el.x !== 'number' || typeof el.y !== 'number') return el;
    return { ...el, x: el.x + dx, y: el.y + dy } as T;
  });
}
