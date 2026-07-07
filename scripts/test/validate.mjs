#!/usr/bin/env node
// Offline verification for the artifacts that don't need n8n or live credentials:
//  1. every JSON file parses
//  2. every n8n Code-node jsCode compiles as a function body
//  3. the KB loader's chunk parser works
//  4. the LLM-facing tool schemas are well-formed
// SQL is exercised separately against the live DB by scripts/test/sql.mjs.

import { readFile } from 'node:fs/promises';
import { parseChunks } from '../load-knowledge-base.mjs';

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failures++; };

async function readJson(p) { return JSON.parse(await readFile(p, 'utf8')); }

console.log('JSON files parse:');
const wfA = await readJson('n8n/workflow-a-inbound.json');
ok('n8n/workflow-a-inbound.json');
const wfB = await readJson('n8n/workflow-b-reminders.json');
ok('n8n/workflow-b-reminders.json');
const actions = await readJson('prompts/actions.json');
ok('prompts/actions.json');
await readJson('whatsapp/templates/appointment_reminder.json');
ok('whatsapp/templates/appointment_reminder.json');

console.log('\nn8n Code-node jsCode compiles:');
for (const wf of [wfA, wfB]) {
  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.code') {
      try {
        // n8n runs the body with $input/$json/$env/$ in scope; compile-check only.
        new Function('$input', '$json', '$env', '$', '$node', node.parameters.jsCode);
        ok(`${wf.name} / ${node.name}`);
      } catch (e) {
        bad(`${wf.name} / ${node.name}: ${e.message}`);
      }
    }
  }
}

console.log('\nWorkflow connections reference real nodes:');
for (const wf of [wfA, wfB]) {
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [from, conn] of Object.entries(wf.connections)) {
    if (!names.has(from)) bad(`${wf.name}: connection from unknown node "${from}"`);
    for (const group of conn.main || []) {
      for (const c of group) {
        if (!names.has(c.node)) bad(`${wf.name}: "${from}" -> unknown node "${c.node}"`);
      }
    }
  }
  ok(`${wf.name}: all connection endpoints exist`);
}

console.log('\nTool schemas (Anthropic format):');
const expected = ['check_availability', 'book_appointment', 'reschedule_appointment', 'cancel_appointment', 'escalate_to_human'];
const gotNames = actions.map((t) => t.name);
for (const n of expected) gotNames.includes(n) ? ok(`tool ${n}`) : bad(`missing tool ${n}`);
for (const t of actions) {
  if (!t.name || !t.description || !t.input_schema || t.input_schema.type !== 'object') bad(`tool ${t.name}: not a valid Anthropic tool`);
  if ('parameters' in t || 'function' in t) bad(`tool ${t.name}: still in OpenAI format`);
}
ok('all tools use name/description/input_schema');

console.log('\nKB loader chunk parser:');
const sample = await readFile('prompts/knowledge-base.sample.md', 'utf8');
const chunks = parseChunks(sample);
chunks.length >= 7 ? ok(`parsed ${chunks.length} chunks`) : bad(`only ${chunks.length} chunks`);
chunks.every((c) => c.category && c.content) ? ok('every chunk has category + content') : bad('malformed chunk');
try { parseChunks('[bogus] nope'); bad('bad category not rejected'); }
catch { ok('rejects unknown category'); }

console.log(failures === 0 ? '\nALL OFFLINE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
