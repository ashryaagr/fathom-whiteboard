#!/usr/bin/env node
// Minimal stdio MCP server exposing arxiv.org search + download.
//
// Used by clawdSlate (and Fathom via the whiteboard pipeline) so the
// agent can pull a referenced paper from arXiv into the calling
// session's working directory and read it on-demand.
//
// No Python dep, no third-party SDK — talks the arXiv API + writes
// a PDF + writes JSON-RPC framing on stdio. Three tools:
//   - search_papers(query, max_results?)
//   - download_paper(arxiv_id)            → returns local pdf path
//   - list_downloaded_papers()            → enumerate the storage dir
//
// Storage path comes from ARXIV_STORAGE_PATH (set by the calling
// Electron main process to the per-session sidecar dir). Falls back
// to ~/.cache/arxiv-mcp if unset.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STORAGE_PATH =
  process.env.ARXIV_STORAGE_PATH ||
  join(homedir(), '.cache', 'arxiv-mcp');

await mkdir(STORAGE_PATH, { recursive: true });

const server = new Server(
  { name: 'arxiv-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: 'search_papers',
    description:
      'Search arXiv for papers matching a query. Returns up to max_results entries with id, title, summary, authors, published date, and PDF URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'arXiv search query — keywords, author names, or fielded queries like "all:diffusion+model".',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results (default 10, max 50).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'download_paper',
    description:
      'Download an arXiv paper as a PDF into the local storage directory and return the absolute path. Use the id from search_papers (e.g., "2310.06825" or "2310.06825v2").',
    inputSchema: {
      type: 'object',
      properties: {
        arxiv_id: {
          type: 'string',
          description: 'arXiv paper id (with or without version suffix).',
        },
      },
      required: ['arxiv_id'],
    },
  },
  {
    name: 'list_downloaded_papers',
    description:
      'List PDFs already downloaded into the storage directory, with file size + last-modified timestamp.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function parseArxivXml(xml) {
  // Minimal regex-based atom feed parser. Pulls the <entry> blocks
  // and extracts id, title, summary, author names, published date.
  // Avoids pulling in an XML parser dep — this is read-only and the
  // arxiv feed format is stable.
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
      return r ? r[1].trim().replace(/\s+/g, ' ') : '';
    };
    const idUrl = get('id');
    const idMatch = /abs\/([^\/v]+)(v\d+)?$/.exec(idUrl);
    const arxivId = idMatch ? idMatch[1] + (idMatch[2] || '') : idUrl;
    const authors = [];
    const authorRe = /<author>\s*<name>([^<]+)<\/name>/g;
    let am;
    while ((am = authorRe.exec(block)) !== null) authors.push(am[1].trim());
    const pdfMatch = /<link[^>]*type="application\/pdf"[^>]*href="([^"]+)"/.exec(
      block,
    );
    entries.push({
      id: arxivId,
      title: get('title'),
      summary: get('summary'),
      authors,
      published: get('published'),
      pdf_url: pdfMatch ? pdfMatch[1] : `https://arxiv.org/pdf/${arxivId}.pdf`,
    });
  }
  return entries;
}

async function searchPapers({ query, max_results }) {
  const n = Math.min(Math.max(parseInt(max_results, 10) || 10, 1), 50);
  const url = new URL('http://export.arxiv.org/api/query');
  url.searchParams.set('search_query', query);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(n));
  url.searchParams.set('sortBy', 'relevance');
  const res = await fetch(url.toString());
  if (!res.ok)
    throw new Error(`arxiv search failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  const entries = parseArxivXml(xml);
  return {
    query,
    count: entries.length,
    results: entries,
  };
}

async function downloadPaper({ arxiv_id }) {
  if (!arxiv_id || typeof arxiv_id !== 'string')
    throw new Error('arxiv_id is required');
  // Tolerate ids with or without version suffix.
  const safeId = arxiv_id.replace(/[^A-Za-z0-9._-]/g, '');
  if (!safeId) throw new Error(`invalid arxiv_id: ${arxiv_id}`);
  const url = `https://arxiv.org/pdf/${safeId}.pdf`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`arxiv download failed: ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const dest = join(STORAGE_PATH, `${safeId}.pdf`);
  await writeFile(dest, bytes);
  return {
    arxiv_id: safeId,
    abs_path: dest,
    bytes: bytes.length,
  };
}

async function listDownloadedPapers() {
  if (!existsSync(STORAGE_PATH)) return { count: 0, papers: [] };
  const files = await readdir(STORAGE_PATH);
  const papers = [];
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.pdf')) continue;
    const p = join(STORAGE_PATH, f);
    try {
      const st = await stat(p);
      papers.push({
        arxiv_id: f.replace(/\.pdf$/i, ''),
        abs_path: p,
        bytes: st.size,
        modified: st.mtimeMs,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return { count: papers.length, papers, storage_path: STORAGE_PATH };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  let result;
  try {
    if (name === 'search_papers') result = await searchPapers(args);
    else if (name === 'download_paper') result = await downloadPaper(args);
    else if (name === 'list_downloaded_papers')
      result = await listDownloadedPapers();
    else throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
