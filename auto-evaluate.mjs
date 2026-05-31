#!/usr/bin/env node

/**
 * auto-evaluate.mjs — Headless evaluation dispatcher for queued pipeline URLs.
 *
 * Reads data/pipeline.md, pre-assigns sequential report numbers, then spawns
 * `claude -p` workers (capped concurrency) to evaluate each URL using oferta
 * mode + the user's modes/_profile.md overrides.
 *
 * Each worker writes:
 *   - reports/{NNN}-{slug}-{date}.md
 *   - batch/tracker-additions/{NNN}-{slug}.tsv
 *
 * After all workers finish, this script:
 *   - Marks completed entries `[x]` in pipeline.md
 *   - Runs merge-tracker.mjs (merges TSVs into applications.md)
 *   - Runs generate-dashboard.mjs (refreshes the dashboard)
 *
 * Usage:
 *   node auto-evaluate.mjs                     Evaluate all unchecked URLs (Sonnet)
 *   node auto-evaluate.mjs --dry-run           Show plan without spawning workers
 *   node auto-evaluate.mjs --limit 1           Evaluate at most N URLs
 *   node auto-evaluate.mjs --parallel 6        Max parallel workers (default 6)
 *   node auto-evaluate.mjs --model opus        Override model (default: claude-sonnet-4-6)
 *   node auto-evaluate.mjs --url <URL>         Evaluate one specific URL from the pipeline
 */

import { spawn } from 'child_process';
import { readFile, writeFile, readdir, mkdir, access } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PIPELINE = resolve(ROOT, 'data/pipeline.md');
const REPORTS_DIR = resolve(ROOT, 'reports');
const TRACKER_DIR = resolve(ROOT, 'batch/tracker-additions');
const LOGS_DIR = resolve(ROOT, 'batch/logs');

// --- args ---
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const parallelIdx = args.indexOf('--parallel');
const PARALLEL = parallelIdx >= 0 ? parseInt(args[parallelIdx + 1], 10) : 6;
const modelIdx = args.indexOf('--model');
const MODEL_ALIASES = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};
const rawModel = modelIdx >= 0 ? args[modelIdx + 1] : 'sonnet';
const MODEL = MODEL_ALIASES[rawModel] || rawModel;
const urlIdx = args.indexOf('--url');
const SINGLE_URL = urlIdx >= 0 ? args[urlIdx + 1] : null;

// --- helpers ---
function pad(n) {
  return String(n).padStart(3, '0');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function slugify(company, role) {
  return [company, role]
    .join('-')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function nextReportNumber() {
  const files = await readdir(REPORTS_DIR);
  const nums = files
    .map(f => parseInt((f.match(/^(\d+)/) || [])[1], 10))
    .filter(n => !isNaN(n));
  return Math.max(0, ...nums) + 1;
}

async function readPipelineItems() {
  const content = await readFile(PIPELINE, 'utf-8');
  const lines = content.split('\n');
  const items = [];
  lines.forEach((ln, i) => {
    const m = ln.match(/^- \[ \] (\S+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*$/);
    if (m) items.push({ url: m[1], company: m[2], role: m[3], lineIdx: i });
  });
  return { lines, items };
}

async function existingReportUrls() {
  const urls = new Set();
  const files = (await readdir(REPORTS_DIR)).filter(f => f.endsWith('.md'));
  for (const f of files) {
    const c = await readFile(resolve(REPORTS_DIR, f), 'utf-8');
    const m = c.match(/^\*\*URL:\*\*\s*(\S+)/m);
    if (m) urls.add(m[1]);
  }
  return urls;
}

function buildPrompt(item, num, slug, date) {
  return `You are a career-ops evaluation worker. Evaluate ONE job offer and write the evaluation artifacts.

URL: ${item.url}
Company: ${item.company}
Role: ${item.role}
Report number (pre-assigned, do NOT change): ${pad(num)}
Slug (pre-assigned, do NOT change): ${slug}
Today's date: ${date}

REQUIRED READING (read these BEFORE evaluating):
1. AGENTS.md — project conventions
2. modes/_shared.md — system defaults
3. modes/_profile.md — Rob's USER LAYER overrides. THIS WINS for archetypes, narrative, comp targets, deal-breakers.
4. modes/oferta.md — the evaluation mode
5. cv.md — the candidate's CV (source of truth for proof points)

ARCHETYPES: Use Rob's archetypes from modes/_profile.md ONLY. They are: Engineering Manager / Senior EM, Director of Engineering, Head of Engineering / VP Engineering, AI Engineering Lead / Head of Applied AI, Senior Solutions Architect / Principal Engineer, Director / Sr. Technical Program Manager. Do NOT use the AI-focused archetypes in _shared.md.

DEAL-BREAKERS to apply during scoring:
- Comp floor $175K base — anything below scores ≤2.5 even if technical match is high
- Remote US only — non-US, EU-only, EMEA, APAC roles score ≤2.0
- No crypto, no Web3, no gambling, no adtech
- No Wells Fargo or subsidiaries

PROCESS:
1. Fetch the JD. For greenhouse/ashby URLs, prefer canonical APIs (faster, more reliable):
   - Greenhouse: https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{jobId}
   - Ashby: https://api.ashbyhq.com/posting-api/job-board/{board}/{postingId}
   Otherwise WebFetch.
2. Produce a complete Block A-F + Block G (Posting Legitimacy) evaluation in the standard format used by recent reports (e.g., reports/015-rula-em-2026-05-13.md or reports/038-rula-sr-analytics-em-2026-05-13.md).

OUTPUT REQUIREMENTS:

(A) Write the report to: reports/${pad(num)}-${slug}-${date}.md

Report MUST start with this exact header structure:

\`\`\`
# ${pad(num)} — ${item.company} — ${item.role}

**URL:** ${item.url}
**Score:** {X.X}/5
**Status:** Evaluated
**Date:** ${date}
**PDF:** ❌
**Legitimacy:** {High Confidence | Probable | Suspect}
**Verification:** {one-line description of how you verified}

**TL;DR** | {one sentence}
**Arquetipo** | {detected archetype from Rob's _profile.md}
**Remote** | {remote policy}
**Comp** | {posted comp or "not listed"}
\`\`\`

Followed by Block A, Block B, Block C, Block D, Block E, Block F, Block G.

(B) Write the tracker TSV to: batch/tracker-additions/${pad(num)}-${slug}.tsv

TSV must be EXACTLY one line, 9 tab-separated columns in this order:

${num}\t${date}\t${item.company}\t${item.role}\tEvaluated\t{X.X}/5\t❌\t[${pad(num)}](reports/${pad(num)}-${slug}-${date}.md)\t{1-line note summarizing the fit}

DO NOT:
- Generate any PDF
- Modify data/applications.md (the merge script handles that)
- Modify data/pipeline.md (the dispatcher handles that)
- Modify any other report files
- Apply to the job

When complete, print exactly: COMPLETED ${pad(num)}
`;
}

function runWorker(item, num, slug, date) {
  return new Promise((resolveFn) => {
    const prompt = buildPrompt(item, num, slug, date);
    const logPath = resolve(LOGS_DIR, `auto-${pad(num)}-${slug}.log`);
    const reportPath = resolve(REPORTS_DIR, `${pad(num)}-${slug}-${date}.md`);
    const tsvPath = resolve(TRACKER_DIR, `${pad(num)}-${slug}.tsv`);

    const t0 = Date.now();
    const proc = spawn(
      'claude',
      ['-p', '--model', MODEL, '--dangerously-skip-permissions', prompt],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', async (code) => {
      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      await writeFile(logPath, `EXIT: ${code}\nSECONDS: ${seconds}\n\n=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}`).catch(() => {});
      let ok = false;
      let reason = '';
      if (code === 0) {
        try { await access(reportPath); } catch { reason = 'no report file'; }
        try { await access(tsvPath); } catch { reason = reason || 'no tsv file'; }
        if (!reason) ok = true;
      } else {
        reason = `exit ${code}`;
      }
      resolveFn({ ok, num, item, seconds, reason });
    });
  });
}

async function runPool(tasks, parallel) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const my = idx++;
      const t = tasks[my];
      process.stdout.write(`  → starting #${pad(t.num)} ${t.item.company} — ${t.item.role}\n`);
      const r = await runWorker(t.item, t.num, t.slug, t.date);
      process.stdout.write(`  ${r.ok ? '✅' : '❌'} #${pad(r.num)} ${r.item.company} (${r.seconds}s)${r.reason ? ' — ' + r.reason : ''}\n`);
      results.push(r);
    }
  }
  await Promise.all(Array(Math.min(parallel, tasks.length)).fill(0).map(() => worker()));
  return results;
}

async function markPipelineComplete(completedUrls) {
  const content = await readFile(PIPELINE, 'utf-8');
  const completed = new Set(completedUrls);
  const updated = content.split('\n').map(ln => {
    const m = ln.match(/^- \[ \] (\S+)/);
    if (m && completed.has(m[1])) {
      return ln.replace('- [ ]', '- [x]');
    }
    return ln;
  }).join('\n');
  await writeFile(PIPELINE, updated);
}

async function runCmd(cmd, args) {
  return new Promise((resolveFn) => {
    const proc = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    proc.on('close', code => resolveFn(code));
  });
}

async function lookupScanHistoryItem(targetUrl) {
  const path = resolve(ROOT, 'data/scan-history.tsv');
  try {
    const content = await readFile(path, 'utf-8');
    const lines = content.split('\n').slice(1);
    for (const line of lines) {
      const cols = line.split('\t');
      if (cols[0] === targetUrl) {
        // columns: url, first_seen, portal, title, company, status, location
        return { url: cols[0], company: cols[4] || 'Unknown', role: cols[3] || 'Unknown' };
      }
    }
  } catch {}
  return null;
}

async function appendUrlToPipeline(item) {
  const content = await readFile(PIPELINE, 'utf-8');
  if (content.includes(item.url)) return;
  const marker = '## Pendientes';
  const idx = content.indexOf(marker);
  const line = `- [ ] ${item.url} | ${item.company} | ${item.role}`;
  let updated;
  if (idx === -1) {
    updated = content + `\n${marker}\n\n${line}\n`;
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = content.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? content.length : nextSection;
    updated = content.slice(0, insertAt) + `\n${line}` + content.slice(insertAt);
  }
  await writeFile(PIPELINE, updated);
}

async function main() {
  await mkdir(LOGS_DIR, { recursive: true });
  await mkdir(TRACKER_DIR, { recursive: true });

  // Single-URL mode: if the URL isn't in pipeline.md, look it up in scan-history
  // and append it so the rest of the flow works unchanged.
  let synthesizedItem = null;
  if (SINGLE_URL) {
    const existing = await readPipelineItems();
    const inPipeline = existing.items.some(it => it.url === SINGLE_URL);
    if (!inPipeline) {
      const scanned = await lookupScanHistoryItem(SINGLE_URL);
      if (!scanned) {
        console.error(`URL not found in pipeline.md or scan-history.tsv: ${SINGLE_URL}`);
        process.exit(1);
      }
      if (!dryRun) {
        await appendUrlToPipeline(scanned);
        console.log(`Appended to pipeline: ${scanned.company} — ${scanned.role}`);
      } else {
        synthesizedItem = scanned;
        console.log(`(dry-run) Would append to pipeline: ${scanned.company} — ${scanned.role}`);
      }
    }
  }

  let { items } = await readPipelineItems();
  if (synthesizedItem) items = [...items, synthesizedItem];
  if (SINGLE_URL) {
    items = items.filter(it => it.url === SINGLE_URL);
  }
  if (items.length === 0) {
    console.log(SINGLE_URL
      ? `URL not found unchecked in pipeline.md: ${SINGLE_URL}`
      : 'No unchecked URLs in pipeline.md. Nothing to do.');
    return;
  }

  // Dedup: skip URLs that already have a report; mark them complete in pipeline anyway
  const alreadyEvaluated = await existingReportUrls();
  const dupItems = items.filter(it => alreadyEvaluated.has(it.url));
  const freshItems = items.filter(it => !alreadyEvaluated.has(it.url));

  const startNum = await nextReportNumber();
  const date = today();
  const toProcess = freshItems.slice(0, Math.min(freshItems.length, limit));

  const tasks = toProcess.map((item, i) => ({
    item,
    num: startNum + i,
    slug: slugify(item.company, item.role),
    date,
  }));

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Auto-Evaluate — ${date}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Pipeline URLs unchecked:  ${items.length}`);
  console.log(`  already evaluated:      ${dupItems.length} (will mark [x], no AI cost)`);
  console.log(`  fresh:                  ${freshItems.length}`);
  console.log(`Will evaluate now:        ${tasks.length}${limit < Infinity ? ` (limit ${limit})` : ''}`);
  console.log(`Model:                    ${MODEL}`);
  console.log(`Parallel workers:         ${PARALLEL}`);
  console.log(`Next report number:       ${pad(startNum)}`);
  console.log('');

  if (dryRun) {
    console.log('DRY RUN — would launch these workers:\n');
    tasks.forEach(t => {
      console.log(`  #${pad(t.num)} ${t.item.company} — ${t.item.role}`);
      console.log(`         ${t.item.url}`);
    });
    console.log('\nRe-run without --dry-run to execute.');
    return;
  }

  console.log('Spawning workers...\n');
  const results = await runPool(tasks, PARALLEL);

  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Completed: ${ok.length}   Failed: ${failed.length}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (failed.length) {
    console.log('Failed evaluations:');
    failed.forEach(r => console.log(`  #${pad(r.num)} ${r.item.company} — ${r.reason}`));
    console.log('Logs: batch/logs/auto-NNN-slug.log');
    console.log('');
  }

  // Mark both freshly-evaluated URLs and already-evaluated dupes complete in pipeline.md
  const toMark = [...ok.map(r => r.item.url), ...dupItems.map(it => it.url)];
  if (toMark.length) {
    await markPipelineComplete(toMark);
    console.log(`✓ pipeline.md updated — ${toMark.length} URLs marked [x] (${ok.length} fresh + ${dupItems.length} dedup)`);
  }
  if (ok.length) {
    console.log('');
    console.log('Running merge-tracker.mjs...');
    await runCmd('node', ['merge-tracker.mjs']);
    console.log('');
    console.log('Running sync-db.mjs...');
    await runCmd('node', ['sync-db.mjs']);
    console.log('');
    console.log('Running generate-dashboard.mjs...');
    await runCmd('node', ['generate-dashboard.mjs']);
  } else if (toMark.length) {
    console.log('');
    console.log('Running sync-db.mjs...');
    await runCmd('node', ['sync-db.mjs']);
    console.log('');
    console.log('Running generate-dashboard.mjs...');
    await runCmd('node', ['generate-dashboard.mjs']);
  }
}

main().catch(err => {
  console.error('auto-evaluate failed:', err);
  process.exit(1);
});
