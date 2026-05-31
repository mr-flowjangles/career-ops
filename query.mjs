#!/usr/bin/env node

/**
 * query.mjs — Ad-hoc + canned SQL over career-ops.db
 *
 * Examples:
 *   node query.mjs                     List canned views
 *   node query.mjs top                 Top fits (Evaluated, score >= 4.0)
 *   node query.mjs actionable          Not yet applied/skipped/rejected
 *   node query.mjs applied             Current applied list
 *   node query.mjs stale [14]          Applied N+ days ago, no response (default 14)
 *   node query.mjs skipped             SKIP list with reasons
 *   node query.mjs comp-floor          Below $175K floor (where comp parsed)
 *   node query.mjs comp-target         In $200K-260K target band
 *   node query.mjs by-archetype        Counts by archetype
 *   node query.mjs by-status           Counts by status
 *   node query.mjs dupes               URLs evaluated more than once
 *   node query.mjs recent [10]         Last N evaluated (default 10)
 *   node query.mjs company Headway     All roles at company
 *   node query.mjs sql "SELECT ..."    Raw SQL
 *
 * Flags:
 *   --json     Output JSON instead of table
 *   --no-trunc Don't truncate long fields
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, 'career-ops.db');

if (!existsSync(DB_PATH)) {
  console.error('career-ops.db not found. Run: node sync-db.mjs --rebuild');
  process.exit(1);
}

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const JSON_OUT = flags.includes('--json');
const NO_TRUNC = flags.includes('--no-trunc');

const db = new Database(DB_PATH, { readonly: true });

// --- canned views ---

const VIEWS = {
  top: {
    desc: 'Top fits — Evaluated, score >= 4.0',
    sql: `SELECT id, company, role, score, comp_low, comp_high, remote, date_added
          FROM evaluations
          WHERE status='Evaluated' AND score >= 4.0
          ORDER BY score DESC, date_added DESC`,
  },
  actionable: {
    desc: 'Not yet applied/skipped/rejected',
    sql: `SELECT id, company, role, score, status, comp_low, comp_high
          FROM evaluations
          WHERE status NOT IN ('Applied','SKIP','Rejected','Interview','Offer','Discarded')
          ORDER BY score DESC`,
  },
  applied: {
    desc: 'Applied — current applications',
    sql: `SELECT id, company, role, score, date_applied
          FROM evaluations
          WHERE status='Applied'
          ORDER BY date_applied DESC`,
  },
  stale: {
    desc: 'Applied >N days ago, still status=Applied (no response)',
    paramHint: 'days (default 14)',
    sql: (days = 14) => `
      SELECT id, company, role, date_applied,
             CAST(julianday('now') - julianday(date_applied) AS INTEGER) AS days_since
      FROM evaluations
      WHERE status='Applied'
        AND date_applied IS NOT NULL
        AND julianday('now') - julianday(date_applied) >= ${parseInt(days, 10) || 14}
      ORDER BY date_applied ASC`,
  },
  skipped: {
    desc: 'SKIP list with reasons',
    sql: `SELECT id, company, role, score, skip_note
          FROM evaluations
          WHERE status='SKIP'
          ORDER BY score DESC`,
  },
  'comp-floor': {
    desc: 'Items below $175K floor (where comp_low parsed)',
    sql: `SELECT id, company, role, score, comp_low, comp_high, status
          FROM evaluations
          WHERE comp_low IS NOT NULL AND comp_low < 175000
          ORDER BY comp_low DESC`,
  },
  'comp-target': {
    desc: 'In $200K-260K target band',
    sql: `SELECT id, company, role, score, comp_low, comp_high, status
          FROM evaluations
          WHERE comp_high IS NOT NULL
            AND comp_high >= 200000 AND comp_low <= 260000
          ORDER BY comp_high DESC`,
  },
  'by-archetype': {
    desc: 'Counts by archetype',
    sql: `SELECT archetype, COUNT(*) AS n,
                 AVG(score) AS avg_score,
                 SUM(CASE WHEN status='Applied' THEN 1 ELSE 0 END) AS applied
          FROM evaluations
          GROUP BY archetype
          ORDER BY n DESC`,
  },
  'by-status': {
    desc: 'Counts by status',
    sql: `SELECT status, COUNT(*) AS n, AVG(score) AS avg_score
          FROM evaluations
          GROUP BY status
          ORDER BY n DESC`,
  },
  dupes: {
    desc: 'URLs evaluated more than once',
    sql: `SELECT url, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
          FROM evaluations
          GROUP BY url HAVING n > 1`,
  },
  recent: {
    desc: 'Last N evaluations by id',
    paramHint: 'limit (default 10)',
    sql: (n = 10) => `
      SELECT id, company, role, score, status, date_added
      FROM evaluations
      ORDER BY id DESC LIMIT ${parseInt(n, 10) || 10}`,
  },
  company: {
    desc: 'All roles at a company (case-insensitive)',
    paramHint: 'company name',
    sql: (name) => {
      if (!name) throw new Error('company requires a name argument');
      return `SELECT id, role, score, status, comp_low, comp_high, date_added
              FROM evaluations
              WHERE LOWER(company) LIKE '%${name.toLowerCase().replace(/'/g, "''")}%'
              ORDER BY score DESC`;
    },
  },
  pipeline: {
    desc: 'Pending pipeline URLs',
    sql: `SELECT company, role, url FROM pipeline WHERE evaluated=0 ORDER BY company, role`,
  },
};

// --- pretty printer ---

function fmt(v, maxWidth) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
  }
  const s = String(v);
  if (NO_TRUNC || s.length <= maxWidth) return s;
  return s.slice(0, maxWidth - 1) + '…';
}

function printTable(rows) {
  if (!rows.length) {
    console.log('(no rows)');
    return;
  }
  if (JSON_OUT) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const cols = Object.keys(rows[0]);
  const colWidths = {};
  const maxCellWidth = 60;
  for (const c of cols) {
    let w = c.length;
    for (const r of rows) {
      const v = fmt(r[c], maxCellWidth);
      if (v.length > w) w = v.length;
    }
    colWidths[c] = Math.min(w, maxCellWidth);
  }
  // Header
  console.log(cols.map(c => c.padEnd(colWidths[c])).join('  '));
  console.log(cols.map(c => '─'.repeat(colWidths[c])).join('  '));
  for (const r of rows) {
    console.log(cols.map(c => fmt(r[c], colWidths[c]).padEnd(colWidths[c])).join('  '));
  }
  console.log(`\n(${rows.length} row${rows.length === 1 ? '' : 's'})`);
}

// --- main ---

function listViews() {
  console.log('Canned views (run: node query.mjs <name>):\n');
  for (const [name, def] of Object.entries(VIEWS)) {
    const param = def.paramHint ? ` [${def.paramHint}]` : '';
    console.log(`  ${(name + param).padEnd(30)} ${def.desc}`);
  }
  console.log('\nRaw SQL:  node query.mjs sql "SELECT ..."');
  console.log('Flags:    --json   --no-trunc');
}

function runView(name, params) {
  const def = VIEWS[name];
  if (!def) {
    console.error(`Unknown view: ${name}`);
    console.error('Run: node query.mjs (to list canned views)');
    process.exit(1);
  }
  const sql = typeof def.sql === 'function' ? def.sql(...params) : def.sql;
  const rows = db.prepare(sql).all();
  printTable(rows);
}

function runRawSql(sql) {
  if (!sql) {
    console.error('Usage: node query.mjs sql "SELECT ..."');
    process.exit(1);
  }
  try {
    const stmt = db.prepare(sql);
    if (stmt.reader) {
      printTable(stmt.all());
    } else {
      const info = stmt.run();
      console.log(`Changes: ${info.changes}, lastInsertRowid: ${info.lastInsertRowid}`);
    }
  } catch (e) {
    console.error('SQL error:', e.message);
    process.exit(1);
  }
}

if (args.length === 0) {
  listViews();
} else if (args[0] === 'sql') {
  runRawSql(args.slice(1).join(' '));
} else {
  runView(args[0], args.slice(1));
}

db.close();
