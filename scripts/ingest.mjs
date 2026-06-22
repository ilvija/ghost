#!/usr/bin/env node
/**
 * Ghost Help Center ingestion.
 *
 *   1. Discover article URLs from the help center sitemap (with a bundled fallback list).
 *   2. Fetch each article, extract clean, heading-aware text.
 *   3. Chunk it, embed with OpenAI, and upsert into Supabase (pgvector).
 *
 * Usage:  npm run ingest            (full crawl)
 *         npm run ingest -- --limit 5   (quick test on the first 5 URLs)
 *
 * Requires in .env / .env.local:
 *   OPENAI_API_KEY
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SITEMAP_INDEX = "https://ghost.org/help/sitemap.xml";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const CHUNK_CHARS = 1200; // ~300 tokens
const CHUNK_OVERLAP = 150;
const EMBED_BATCH = 64;
const FETCH_CONCURRENCY = 5;

const argLimit = (() => {
  const i = process.argv.indexOf("--limit");
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : Infinity;
})();

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
const supabase = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } }
);

// ---------- 1. Discover URLs ----------

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "ghost-help-ai-ingest/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

async function discoverUrls() {
  // Always start with the bundled list (includes /resources articles not in the help sitemap).
  const bundled = JSON.parse(
    fs.readFileSync(path.join(ROOT, "data", "urls.json"), "utf8")
  );

  let sitemapUrls = [];
  try {
    const indexXml = await fetchText(SITEMAP_INDEX);
    const childMaps = extractLocs(indexXml).filter(
      (u) => u.includes("sitemap-posts") || u.includes("sitemap-pages")
    );
    const all = [];
    for (const m of childMaps) {
      const xml = await fetchText(m);
      all.push(...extractLocs(xml));
    }
    sitemapUrls = all.filter(
      (u) =>
        u.startsWith("https://ghost.org/help/") &&
        !u.endsWith("/help/") &&
        !u.includes("/manual-nav")
    );
    if (sitemapUrls.length) {
      console.log(`Discovered ${sitemapUrls.length} URLs from sitemap.`);
    }
  } catch (err) {
    console.warn(`Sitemap discovery failed (${err.message}); using bundled list only.`);
  }

  // Merge: sitemap (freshest help URLs) + bundled (includes /resources).
  const merged = [...new Set([...sitemapUrls, ...bundled])];
  console.log(`Total URLs to ingest: ${merged.length} (${sitemapUrls.length} sitemap + ${bundled.length} bundled, deduped).`);
  return merged;
}

// ---------- 2. Extract article ----------

function meta(doc, selector) {
  const el = doc.querySelector(selector);
  return el?.getAttribute("content")?.trim() ?? null;
}

function pickArticleNode(doc) {
  const selectors = [
    "article .gh-content",
    ".gh-content",
    "article .post-content",
    "main article",
    "article",
  ];
  for (const s of selectors) {
    const el = doc.querySelector(s);
    if (el && el.textContent && el.textContent.trim().length > 200) return el;
  }
  return null;
}

const BLOCK_TAGS = new Set([
  "P", "LI", "PRE", "BLOCKQUOTE", "TABLE", "FIGCAPTION",
]);
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4"]);

/** Walk the article DOM in order, producing { heading, text } blocks. */
function blocksFromNode(node) {
  const blocks = [];
  let currentHeading = null;

  function walk(el) {
    for (const child of el.children) {
      const tag = child.tagName;
      if (HEADING_TAGS.has(tag)) {
        currentHeading = child.textContent.trim().replace(/\s+/g, " ");
      } else if (BLOCK_TAGS.has(tag)) {
        const text = child.textContent.trim().replace(/\s+/g, " ");
        if (text) blocks.push({ heading: currentHeading, text });
      } else if (child.children.length) {
        walk(child);
      }
    }
  }
  walk(node);
  return blocks;
}

/** Group consecutive same-heading blocks into ~CHUNK_CHARS chunks. */
function chunkBlocks(blocks, fallbackText) {
  const chunks = [];
  let buf = "";
  let heading = null;

  const flush = () => {
    const text = buf.trim();
    if (text.length > 40) chunks.push({ heading, content: text });
    buf = "";
  };

  for (const b of blocks) {
    if (b.heading !== heading && buf) flush();
    heading = b.heading;

    // A single block larger than the chunk size: hard-split it on its own.
    if (b.text.length > CHUNK_CHARS) {
      if (buf) flush();
      for (let i = 0; i < b.text.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
        const slice = b.text.slice(i, i + CHUNK_CHARS).trim();
        if (slice.length > 40) chunks.push({ heading, content: slice });
      }
      continue;
    }

    if ((buf + " " + b.text).length > CHUNK_CHARS) {
      flush();
      // start new buffer with overlap tail from previous chunk
      const prev = chunks[chunks.length - 1]?.content ?? "";
      buf = prev.slice(-CHUNK_OVERLAP) + " " + b.text;
    } else {
      buf = buf ? `${buf}\n${b.text}` : b.text;
    }
  }
  flush();

  if (!chunks.length && fallbackText) {
    for (let i = 0; i < fallbackText.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
      chunks.push({
        heading: null,
        content: fallbackText.slice(i, i + CHUNK_CHARS).trim(),
      });
    }
  }
  return chunks;
}

async function extractArticle(url) {
  const html = await fetchText(url);
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const title =
    meta(doc, 'meta[property="og:title"]') ||
    doc.querySelector("h1")?.textContent?.trim() ||
    url;
  const topic = meta(doc, 'meta[property="article:tag"]');

  const node = pickArticleNode(doc);
  let blocks = [];
  let fallbackText = "";

  if (node) {
    blocks = blocksFromNode(node);
  }
  if (!blocks.length) {
    const reader = new Readability(doc).parse();
    fallbackText = reader?.textContent?.trim() ?? "";
  }

  const chunks = chunkBlocks(blocks, fallbackText).map((c) => ({
    url,
    title,
    topic,
    heading: c.heading,
    content: c.content,
    token_count: Math.ceil(c.content.length / 4),
  }));
  return chunks;
}

// ---------- helpers ----------

async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        console.warn(`  ! ${items[i]}: ${err.message}`);
        results[i] = [];
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- 3. Embed + upsert ----------

async function embedBatch(texts) {
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}

async function main() {
  const urls = (await discoverUrls()).slice(0, argLimit);
  console.log(`Ingesting ${urls.length} articles...`);

  const perArticle = await mapWithConcurrency(
    urls,
    FETCH_CONCURRENCY,
    async (url, i) => {
      const chunks = await extractArticle(url);
      console.log(`  [${i + 1}/${urls.length}] ${chunks.length} chunks  ${url}`);
      return chunks;
    }
  );

  const allChunks = perArticle.flat();
  console.log(`Total chunks: ${allChunks.length}`);
  if (!allChunks.length) {
    console.error("No chunks produced — aborting before touching the database.");
    process.exit(1);
  }

  // Save a local snapshot for inspection / re-use.
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "data", "corpus.json"),
    JSON.stringify(allChunks, null, 2)
  );

  // Embed in batches.
  const rows = [];
  for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
    const batch = allChunks.slice(i, i + EMBED_BATCH);
    const embeddings = await embedBatch(batch.map((c) => c.content));
    batch.forEach((c, j) => rows.push({ ...c, embedding: embeddings[j] }));
    console.log(`  embedded ${Math.min(i + EMBED_BATCH, allChunks.length)}/${allChunks.length}`);
  }

  // Replace existing data, then insert.
  console.log("Clearing existing rows...");
  const { error: delErr } = await supabase
    .from("help_chunks")
    .delete()
    .neq("id", -1);
  if (delErr) throw new Error(`Delete failed: ${delErr.message}`);

  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabase.from("help_chunks").insert(batch);
    if (error) throw new Error(`Insert failed: ${error.message}`);
    console.log(`  inserted ${Math.min(i + 200, rows.length)}/${rows.length}`);
  }

  console.log(`Done. ${rows.length} chunks indexed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
