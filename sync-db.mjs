#!/usr/bin/env node

/**
 * sync-db.mjs — Derive career-ops.db from the MD source-of-truth files.
 *
 * The DB is an INDEX over reports/*.md, data/pipeline.md, and
 * data/scan-history.tsv. It is gitignored, fully regenerable, never
 * the source of truth.
 *
 * Usage:
 *   node sync-db.mjs              Incremental sync — only re-read files
 *                                  whose mtime is newer than the DB row.
 *   node sync-db.mjs --rebuild    Drop everything and re-derive from scratch.
 *   node sync-db.mjs --schema     Just create/upgrade schema, no data load.
 *   node sync-db.mjs --stats      Print row counts (no write).
 */

import Database from 'better-sqlite3';
import { readFile, readdir, stat } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DB_PATH = resolve(ROOT, 'career-ops.db');
const REPORTS_DIR = resolve(ROOT, 'reports');
const PIPELINE_PATH = resolve(ROOT, 'data/pipeline.md');
const SCAN_HISTORY_PATH = resolve(ROOT, 'data/scan-history.tsv');

const args = process.argv.slice(2);
const REBUILD = args.includes('--rebuild');
const SCHEMA_ONLY = args.includes('--schema');
const STATS_ONLY = args.includes('--stats');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS evaluations (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL,
  report_path     TEXT NOT NULL,
  url             TEXT NOT NULL,
  company         TEXT NOT NULL,
  role            TEXT NOT NULL,
  archetype       TEXT,
  score           REAL,
  status          TEXT,
  date_added      TEXT,
  date_applied    TEXT,
  date_rejected   TEXT,
  remote          TEXT,
  comp_raw        TEXT,
  comp_low        INTEGER,
  comp_high       INTEGER,
  legitimacy      TEXT,
  tldr            TEXT,
  skip_note       TEXT,
  rejection_note  TEXT,
  pdf_filename    TEXT,
  file_mtime      INTEGER,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_url ON evaluations(url);
CREATE INDEX IF NOT EXISTS idx_eval_status   ON evaluations(status);
CREATE INDEX IF NOT EXISTS idx_eval_score    ON evaluations(score);
CREATE INDEX IF NOT EXISTS idx_eval_company  ON evaluations(company);

CREATE TABLE IF NOT EXISTS pipeline (
  url        TEXT PRIMARY KEY,
  company    TEXT,
  role       TEXT,
  evaluated  INTEGER DEFAULT 0,
  added_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_history (
  url       TEXT PRIMARY KEY,
  company   TEXT,
  title     TEXT,
  location  TEXT,
  source    TEXT,
  found_at  TEXT
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluation_id  INTEGER REFERENCES evaluations(id),
  attempt        INTEGER,
  date           TEXT,
  channel        TEXT,
  outcome        TEXT
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT
);
`;

// --- field parsers (same heuristics generate-dashboard uses) ---

function field(content, pattern) {
  const m = content.match(pattern);
  return m ? m[1].trim() : null;
}

function pipeField(content, key) {
  const re = new RegExp(`\\*\\*${key}\\*\\*\\s*\\|\\s*(.+)`);
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function parseCompRange(comp) {
  if (!comp) return [null, null];
  // Examples we want to parse:
  //   $190,000-$237,500
  //   $206,550-$243,000 base
  //   $160,000–$180,000 USD
  //   $213,435-$251,100 base + equity
  //   $214K + bonus
  const norm = comp.replace(/,/g, '').replace(/[–—]/g, '-');
  const dollar = /\$\s*(\d{2,3})(?:K|k|000)?\s*(?:-|to|—|–)\s*\$?\s*(\d{2,3})(?:K|k|000)?/;
  const m = norm.match(dollar);
  if (m) {
    const lo = parseInt(m[1], 10);
    const hi = parseInt(m[2], 10);
    // If the original used K shorthand, the regex already normalized via K? matcher
    // Heuristic: if lo or hi < 1000, assume K-units
    const loFull = lo < 1000 ? lo * 1000 : lo;
    const hiFull = hi < 1000 ? hi * 1000 : hi;
    return [loFull, hiFull];
  }
  // Single value like $214K
  const single = norm.match(/\$\s*(\d{2,3})(?:K|k)?/);
  if (single) {
    const v = parseInt(single[1], 10);
    const full = v < 1000 ? v * 1000 : v;
    return [full, full];
  }
  return [null, null];
}

function companyToPascal(name) {
  return (name || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+(AI|ML|Inc\.?|LLC|Corp\.?|Co\.|Ltd\.?)$/i, '')
    .replace(/[^a-zA-Z0-9]/g, '');
}

function parseReport(filename, content) {
  const id = parseInt((filename.match(/^(\d+)/) || [])[1], 10);
  const slug = (filename.match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/) || [])[1] || null;

  // Title: "# 015 — Rula — Engineering Manager (Remote)"
  const firstLine = (content.split('\n')[0] || '').replace(/^#\s+/, '');
  const titleParts = firstLine.split(/\s+[—-]\s+/).map(p => p.trim());
  const company = titleParts[1] || '';
  const role = titleParts.slice(2).join(' — ') || '';

  const url = field(content, /^\*\*URL:\*\*\s*(\S+)/m);
  const scoreStr = field(content, /^\*\*Score:\*\*\s*([\d.]+)\/5/m);
  const status = field(content, /^\*\*Status:\*\*\s*(.+)$/m);
  const date_added = field(content, /^\*\*Date:\*\*\s*(.+)$/m);
  const date_applied = field(content, /^\*\*Applied:\*\*\s*(.+)$/m);
  const date_rejected = field(content, /^\*\*Rejected:\*\*\s*(.+)$/m);
  const legitimacy = field(content, /^\*\*Legitimacy:\*\*\s*(.+)$/m);
  const skip_note = field(content, /^\*\*Skip Note:\*\*\s*(.+)$/m);
  const rejection_note = field(content, /^\*\*Rejection Note:\*\*\s*(.+)$/m);

  const tldr = pipeField(content, 'TL;DR');
  const archetype = pipeField(content, 'Arquetipo') || pipeField(content, 'Archetype');
  const remote = pipeField(content, 'Remote');
  const compRaw = pipeField(content, 'Comp');
  const [comp_low, comp_high] = parseCompRange(compRaw);

  return {
    id, slug,
    report_path: `reports/${filename}`,
    url, company, role,
    archetype,
    score: scoreStr ? parseFloat(scoreStr) : null,
    status, date_added, date_applied, date_rejected,
    remote, comp_raw: compRaw, comp_low, comp_high,
    legitimacy, tldr, skip_note, rejection_note,
    pascal_company: companyToPascal(company),
  };
}

// --- DB helpers ---

function ensureSchema(db) {
  db.exec(SCHEMA);
  db.prepare('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)')
    .run('schema_version', '1');
}

function upsertEvaluation(db, row, mtime) {
  // Find the matching PDF if it exists
  let pdf_filename = null;
  if (row.pascal_company) {
    const candidate = resolve(ROOT, 'output', `RobRose${row.pascal_company}.pdf`);
    if (existsSync(candidate)) pdf_filename = `RobRose${row.pascal_company}.pdf`;
  }
  const updated_at = new Date().toISOString();

  // ON CONFLICT(id) — primary key dedup
  // Note: url has UNIQUE index but we want id to win; URL dupes will throw and need handling
  try {
    db.prepare(`
      INSERT INTO evaluations
        (id, slug, report_path, url, company, role, archetype, score, status,
         date_added, date_applied, date_rejected, remote, comp_raw, comp_low, comp_high,
         legitimacy, tldr, skip_note, rejection_note, pdf_filename, file_mtime, updated_at)
      VALUES
        (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        slug=excluded.slug, report_path=excluded.report_path, url=excluded.url,
        company=excluded.company, role=excluded.role, archetype=excluded.archetype,
        score=excluded.score, status=excluded.status, date_added=excluded.date_added,
        date_applied=excluded.date_applied, date_rejected=excluded.date_rejected,
        remote=excluded.remote, comp_raw=excluded.comp_raw,
        comp_low=excluded.comp_low, comp_high=excluded.comp_high,
        legitimacy=excluded.legitimacy, tldr=excluded.tldr,
        skip_note=excluded.skip_note, rejection_note=excluded.rejection_note,
        pdf_filename=excluded.pdf_filename, file_mtime=excluded.file_mtime,
        updated_at=excluded.updated_at
    `).run(
      row.id, row.slug, row.report_path, row.url || '', row.company, row.role,
      row.archetype, row.score, row.status,
      row.date_added, row.date_applied, row.date_rejected,
      row.remote, row.comp_raw, row.comp_low, row.comp_high,
      row.legitimacy, row.tldr, row.skip_note, row.rejection_note,
      pdf_filename, mtime, updated_at
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function loadReports(db, { incremental }) {
  const files = (await readdir(REPORTS_DIR)).filter(f => f.endsWith('.md')).sort();

  // For incremental, build a map of id -> file_mtime in DB
  const knownMtimes = new Map();
  if (incremental) {
    const rows = db.prepare('SELECT id, file_mtime FROM evaluations').all();
    for (const r of rows) knownMtimes.set(r.id, r.file_mtime || 0);
  }

  let added = 0, updated = 0, skipped = 0, errored = 0;
  const errors = [];

  // Wrap in transaction for speed
  const txn = db.transaction(async (files) => {
    for (const f of files) {
      const fullPath = resolve(REPORTS_DIR, f);
      const st = await stat(fullPath);
      const mtimeMs = Math.floor(st.mtimeMs);

      const idMatch = f.match(/^(\d+)/);
      if (!idMatch) { skipped++; continue; }
      const id = parseInt(idMatch[1], 10);

      if (incremental && knownMtimes.has(id) && knownMtimes.get(id) >= mtimeMs) {
        skipped++;
        continue;
      }

      const content = await readFile(fullPath, 'utf-8');
      const row = parseReport(f, content);
      if (!row.url) {
        errors.push(`${f}: no URL in header`);
        errored++;
        continue;
      }

      const result = upsertEvaluation(db, row, mtimeMs);
      if (result.ok) {
        if (knownMtimes.has(id)) updated++;
        else added++;
      } else {
        errors.push(`${f}: ${result.error}`);
        errored++;
      }
    }
  });

  // better-sqlite3 transactions are synchronous; we read files async then upsert sync.
  // Refactor: load all parsed rows first, then upsert in a sync transaction.
  const parsedRows = [];
  for (const f of files) {
    const fullPath = resolve(REPORTS_DIR, f);
    const st = await stat(fullPath);
    const mtimeMs = Math.floor(st.mtimeMs);

    const idMatch = f.match(/^(\d+)/);
    if (!idMatch) { skipped++; continue; }
    const id = parseInt(idMatch[1], 10);

    if (incremental && knownMtimes.has(id) && knownMtimes.get(id) >= mtimeMs) {
      skipped++;
      continue;
    }

    const content = await readFile(fullPath, 'utf-8');
    const row = parseReport(f, content);
    if (!row.url) {
      errors.push(`${f}: no URL in header`);
      errored++;
      continue;
    }
    parsedRows.push({ row, mtimeMs, knownPreviously: knownMtimes.has(id) });
  }

  const upsertTxn = db.transaction((rows) => {
    for (const { row, mtimeMs, knownPreviously } of rows) {
      const result = upsertEvaluation(db, row, mtimeMs);
      if (result.ok) {
        if (knownPreviously) updated++;
        else added++;
      } else {
        errors.push(`${row.report_path}: ${result.error}`);
        errored++;
      }
    }
  });
  upsertTxn(parsedRows);

  return { added, updated, skipped, errored, errors, total: files.length };
}

async function loadPipeline(db) {
  if (!existsSync(PIPELINE_PATH)) return { count: 0 };
  const content = await readFile(PIPELINE_PATH, 'utf-8');
  const lines = content.split('\n');
  const now = new Date().toISOString();

  // Clear and reload (pipeline is small + mutable)
  db.prepare('DELETE FROM pipeline').run();
  const insert = db.prepare(
    'INSERT OR REPLACE INTO pipeline (url, company, role, evaluated, added_at) VALUES (?, ?, ?, ?, ?)'
  );

  let count = 0;
  const txn = db.transaction(() => {
    for (const ln of lines) {
      const m = ln.match(/^- \[([ x])\] (\S+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*$/);
      if (!m) continue;
      const evaluated = m[1] === 'x' ? 1 : 0;
      insert.run(m[2], m[3], m[4], evaluated, now);
      count++;
    }
  });
  txn();
  return { count };
}

async function loadScanHistory(db) {
  if (!existsSync(SCAN_HISTORY_PATH)) return { count: 0 };
  const content = await readFile(SCAN_HISTORY_PATH, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  // Header probe (TSV may or may not have one)
  let startIdx = 0;
  const first = (lines[0] || '').toLowerCase();
  if (first.includes('url') && first.includes('company')) startIdx = 1;

  db.prepare('DELETE FROM scan_history').run();
  const insert = db.prepare(
    'INSERT OR REPLACE INTO scan_history (url, company, title, location, source, found_at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  let count = 0;
  const txn = db.transaction(() => {
    for (let i = startIdx; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      // Best-effort column mapping. scan.mjs writes columns we'll inspect at runtime.
      // Common shape: url, company, title, location, [source,] found_at
      if (cols.length < 2) continue;
      const url = cols[0];
      const company = cols[1] || null;
      const title = cols[2] || null;
      const location = cols[3] || null;
      const source = cols[4] && !/^\d{4}-/.test(cols[4]) ? cols[4] : null;
      const found_at = cols[cols.length - 1] && /^\d{4}-/.test(cols[cols.length - 1])
        ? cols[cols.length - 1]
        : null;
      insert.run(url, company, title, location, source, found_at);
      count++;
    }
  });
  txn();
  return { count };
}

function printStats(db) {
  const counts = {
    evaluations: db.prepare('SELECT COUNT(*) AS n FROM evaluations').get().n,
    pipeline: db.prepare('SELECT COUNT(*) AS n FROM pipeline').get().n,
    scan_history: db.prepare('SELECT COUNT(*) AS n FROM scan_history').get().n,
    follow_ups: db.prepare('SELECT COUNT(*) AS n FROM follow_ups').get().n,
  };
  console.log('career-ops.db — row counts');
  console.log('  evaluations  ' + counts.evaluations);
  console.log('  pipeline     ' + counts.pipeline);
  console.log('  scan_history ' + counts.scan_history);
  console.log('  follow_ups   ' + counts.follow_ups);

  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM evaluations GROUP BY status ORDER BY n DESC').all();
  if (byStatus.length) {
    console.log('  by status:');
    for (const r of byStatus) console.log(`    ${r.status || '(none)'}: ${r.n}`);
  }
}

async function main() {
  const exists = existsSync(DB_PATH);
  if (REBUILD && exists) {
    const { rmSync } = await import('fs');
    rmSync(DB_PATH);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);

  if (SCHEMA_ONLY) {
    console.log('Schema ensured at ' + DB_PATH);
    db.close();
    return;
  }
  if (STATS_ONLY) {
    printStats(db);
    db.close();
    return;
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Sync DB ${REBUILD ? '(REBUILD)' : '(incremental)'} — ${DB_PATH}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const reportsResult = await loadReports(db, { incremental: !REBUILD });
  console.log(`reports/      added=${reportsResult.added}  updated=${reportsResult.updated}  skipped=${reportsResult.skipped}  errored=${reportsResult.errored}`);
  if (reportsResult.errors.length) {
    console.log('  Errors:');
    for (const e of reportsResult.errors) console.log('    - ' + e);
  }

  const pipelineResult = await loadPipeline(db);
  console.log(`pipeline.md   rows=${pipelineResult.count}`);

  const scanResult = await loadScanHistory(db);
  console.log(`scan-history  rows=${scanResult.count}`);

  console.log('');
  printStats(db);

  db.close();
}

main().catch(err => {
  console.error('sync-db failed:', err);
  process.exit(1);
});
