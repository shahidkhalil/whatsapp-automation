#!/usr/bin/env node
// Knowledge-base embedding loader (Spec §4.1 / §10).
// Reads a clinic KB file (prompts/knowledge-base.sample.md format: lines like
// "[category] text..."), embeds each chunk with OpenAI text-embedding-3-small
// (1536-dim, matches vector(1536) in db/schema.sql), and upserts into the
// knowledge_base table scoped to one clinic.
//
// Usage:
//   OPENAI_API_KEY=... node scripts/load-knowledge-base.mjs \
//     --file prompts/knowledge-base.sample.md \
//     --clinic-phone-id 1114486611757569 \
//     [--replace] [--dry-run]
//
// Env (falls back to .env-style values passed in the environment):
//   OPENAI_API_KEY   required unless --dry-run
//   EMBEDDING_MODEL  default text-embedding-3-small
//   DATABASE_URL     postgres connection string
//                    default postgres://postgres:${POSTGRES_PASSWORD}@localhost:5433/${POSTGRES_DB:-clinic}
//
// pg is the only runtime dependency: npm i pg   (node >= 18 for global fetch)

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const VALID_CATEGORIES = new Set([
  'services', 'pricing', 'hours', 'doctors', 'policies', 'faq', 'insurance',
]);

function parseArgs(argv) {
  const args = { file: 'prompts/knowledge-base.sample.md', replace: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--clinic-phone-id') args.clinicPhoneId = argv[++i];
    else if (a === '--clinic-id') args.clinicId = argv[++i];
    else if (a === '--replace') args.replace = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

// Parse the KB file into { category, content } chunks.
// A chunk is a non-empty, non-comment line beginning with "[category] ".
export function parseChunks(text) {
  const chunks = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.startsWith('    ')) continue; // indented example/code block, not a chunk
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^\[([a-z]+)\]\s+(.+)$/i);
    if (!m) continue;
    const category = m[1].toLowerCase();
    const content = m[2].trim();
    if (!VALID_CATEGORIES.has(category)) {
      throw new Error(`Unknown category "[${category}]" (valid: ${[...VALID_CATEGORIES].join(', ')})`);
    }
    if (content) chunks.push({ category, content });
  }
  return chunks;
}

async function embed(texts, { apiKey, model }) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  // Preserve request order (OpenAI returns items with an index field).
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// pgvector literal: '[0.1,0.2,...]'
function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

  const raw = await readFile(args.file, 'utf8');
  const chunks = parseChunks(raw);
  console.log(`Parsed ${chunks.length} chunk(s) from ${args.file}`);
  for (const c of chunks) console.log(`  [${c.category}] ${c.content.slice(0, 60)}...`);

  if (args.dryRun) {
    console.log('\n--dry-run: not embedding or writing to the database.');
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required (or pass --dry-run)');
  if (!args.clinicPhoneId && !args.clinicId) {
    throw new Error('Pass --clinic-phone-id <meta phone_number_id> or --clinic-id <uuid>');
  }

  const { default: pg } = await import('pg');
  const connectionString = process.env.DATABASE_URL
    || `postgres://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || ''}`
       + `@localhost:5433/${process.env.POSTGRES_DB || 'clinic'}`;
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // Resolve clinic_id.
    let clinicId = args.clinicId;
    if (!clinicId) {
      const r = await client.query('select id from clinics where phone_number_id = $1', [args.clinicPhoneId]);
      if (r.rowCount === 0) throw new Error(`No clinic with phone_number_id=${args.clinicPhoneId}`);
      clinicId = r.rows[0].id;
    }
    console.log(`\nClinic: ${clinicId}`);

    if (args.replace) {
      const del = await client.query('delete from knowledge_base where clinic_id = $1', [clinicId]);
      console.log(`Deleted ${del.rowCount} existing chunk(s) (--replace)`);
    }

    const embeddings = await embed(chunks.map((c) => c.content), { apiKey, model });
    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding count ${embeddings.length} != chunk count ${chunks.length}`);
    }
    if (embeddings[0].length !== 1536) {
      throw new Error(`Embedding dim ${embeddings[0].length} != 1536 — check EMBEDDING_MODEL matches the schema`);
    }

    let n = 0;
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        'insert into knowledge_base (clinic_id, content, embedding, category) values ($1, $2, $3, $4)',
        [clinicId, chunks[i].content, toVectorLiteral(embeddings[i]), chunks[i].category],
      );
      n++;
    }
    console.log(`Inserted ${n} chunk(s) with embeddings.`);
  } finally {
    await client.end();
  }
}

// Run only when invoked directly, so parseChunks can be imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
