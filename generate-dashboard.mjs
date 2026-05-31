#!/usr/bin/env node

/**
 * generate-dashboard.mjs — Static HTML dashboard of evaluated jobs.
 *
 * Usage:
 *   node generate-dashboard.mjs [output.html]
 *
 * Reads data/applications.md (tracker) and reports/*.md (full evaluations)
 * and emits a single-file HTML dashboard with:
 *   - Filterable cards (All / Strong Fit / Maybe / SKIP)
 *   - Score badge color-coded by tier
 *   - Comp, remote, TL;DR, archetype
 *   - "Apply" button that opens the original posting
 *   - "View details" toggle that expands the full A-G report inline
 *
 * Default output: output/dashboard.html
 */

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const REPORTS_DIR = resolve(ROOT, 'reports');
const OUT_DIR = resolve(ROOT, 'output');
const DB_PATH = resolve(ROOT, 'career-ops.db');
mkdirSync(OUT_DIR, { recursive: true });

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


function scoreTier(scoreNum, status) {
  const s = (status || '').toLowerCase();
  if (s.includes('rejected')) return 'rejected';
  if (s.includes('offer')) return 'applied';
  if (s.includes('interview')) return 'applied';
  if (s.includes('applied')) return 'applied';
  if (s.includes('skip')) return 'skip';
  if (scoreNum >= 4.5) return 'top';
  if (scoreNum >= 4.0) return 'strong';
  if (scoreNum >= 3.5) return 'maybe';
  return 'weak';
}

function tierLabel(tier) {
  return {
    applied: '✉️ Applied',
    rejected: '❌ Rejected',
    top: '🏆 Top fit',
    strong: '🟢 Strong fit',
    maybe: '🟡 Maybe',
    weak: '⚠️ Weak',
    skip: '🔴 SKIP',
  }[tier] || tier;
}

function statusBadge(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('skip')) return 'skip';
  if (s.includes('applied')) return 'applied';
  if (s.includes('interview')) return 'interview';
  if (s.includes('offer')) return 'offer';
  if (s.includes('rejected')) return 'rejected';
  return 'evaluated';
}

function companyToPascal(name) {
  return name
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+(AI|ML|Inc\.?|LLC|Corp\.?|Co\.|Ltd\.?)$/i, '')
    .replace(/[^a-zA-Z0-9]/g, '');
}

function loadPendingFromDb() {
  if (!existsSync(DB_PATH)) return [];
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT s.url, s.company, s.title, s.location, s.source, s.found_at
    FROM scan_history s
    LEFT JOIN evaluations e ON e.url = s.url
    WHERE e.url IS NULL
    ORDER BY s.found_at DESC, s.company ASC
  `).all();
  db.close();
  return rows.map(r => ({
    url: r.url,
    company: r.company || 'Unknown',
    title: r.title || '',
    location: r.location || '',
    source: r.source || '',
    foundAt: r.found_at || '',
  }));
}

async function loadReportsFromDb() {
  if (!existsSync(DB_PATH)) {
    throw new Error('career-ops.db not found — run: node sync-db.mjs --rebuild');
  }
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT id, slug, report_path, url, company, role, archetype, score, status,
           date_added, date_applied, date_rejected, remote, comp_raw,
           legitimacy, tldr, skip_note, rejection_note, pdf_filename
    FROM evaluations
  `).all();
  db.close();

  const outFiles = await readdir(OUT_DIR).catch(() => []);
  const reports = [];
  for (const row of rows) {
    const filename = basename(row.report_path);
    const absPath = resolve(ROOT, row.report_path);
    let body = '';
    let loadedAt = '';
    try {
      body = await readFile(absPath, 'utf-8');
    } catch {
      body = '(report file not found)';
    }
    try {
      const st = await stat(absPath);
      loadedAt = new Date(st.mtimeMs).toISOString().slice(0, 10);
    } catch {}
    // Fall back to legacy PDF naming if sync-db didn't catch it
    const pascalCompany = companyToPascal(row.company);
    const pdfFile = row.pdf_filename
      || (pascalCompany && outFiles.find(pf => pf === `RobRose${pascalCompany}.pdf`))
      || (row.slug && outFiles.find(pf => pf.startsWith(`cv-rob-rose-${row.slug}-`) && pf.endsWith('.pdf')))
      || null;

    reports.push({
      id: String(row.id).padStart(3, '0'),
      title: `${row.company} — ${row.role}`,
      file: filename,
      url: row.url || '',
      score: row.score != null ? `${row.score}/5` : '',
      scoreNum: row.score || 0,
      status: row.status || '',
      date: row.date_added || '',
      applied: row.date_applied || '',
      rejected: row.date_rejected || '',
      rejectionNote: row.rejection_note || '',
      skipNote: row.skip_note || '',
      legitimacy: row.legitimacy || '',
      tldr: row.tldr || '',
      archetype: row.archetype || '',
      remote: row.remote || '',
      comp: row.comp_raw || '',
      body,
      pdfFile,
      loadedAt,
    });
  }
  return reports;
}

function buildPendingCard(p, idx) {
  const cardId = `pending-${idx}`;
  return `
    <article class="card pending" data-tier="pending" data-status="pending" data-new="0" data-company="${esc(p.company.toLowerCase())}">
      <div class="pending-banner">🆕 Scanned — not yet evaluated</div>
      <header class="card-header">
        <div class="card-title">
          <span class="company">${esc(p.company)}</span>
          ${p.title ? `<span class="role">${esc(p.title)}</span>` : ''}
        </div>
        <div class="card-score">
          <span class="score-badge tier-pending">—</span>
          <span class="tier-label">🆕 Pending</span>
        </div>
      </header>

      <dl class="meta">
        ${p.foundAt ? `<div><dt>Scanned</dt><dd>${esc(p.foundAt)}</dd></div>` : ''}
        ${p.location ? `<div><dt>Location</dt><dd>${esc(p.location)}</dd></div>` : ''}
        ${p.source ? `<div><dt>Source</dt><dd>${esc(p.source)}</dd></div>` : ''}
      </dl>

      <footer class="card-actions">
        <a class="btn secondary" href="${esc(p.url)}" target="_blank" rel="noopener">Open JD ↗</a>
        <button class="btn primary" data-pending-id="${cardId}" onclick="if(window.CAREER_OPS_SERVER){window.evaluateJob(${JSON.stringify(p.url).replace(/"/g,'&quot;')}, this);}else{showServerHelp('Evaluate');}">⚡ Evaluate</button>
      </footer>
    </article>`;
}

function buildHTML(reports, pending = []) {
  const TODAY = new Date().toISOString().slice(0, 10);

  // Group by company so all jobs from the same employer appear together.
  // Companies are ordered by (a) SKIPs sink, (b) any "new today" jumps to top,
  // (c) freshest date in the group, (d) highest score in the group.
  // Within a company, sort by score desc then date desc.
  const companyOf = r => ((r.title.split('—')[0] || r.title).trim().toLowerCase());
  const groups = new Map();
  for (const r of reports) {
    const key = companyOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const groupMeta = Array.from(groups.entries()).map(([key, rows]) => {
    const allSkip = rows.every(r => (r.status || '').toUpperCase().includes('SKIP'));
    const anyNew = rows.some(r => r.loadedAt === TODAY || r.date === TODAY);
    const maxDate = rows.reduce((m, r) => (r.date || '') > m ? (r.date || '') : m, '');
    const maxScore = rows.reduce((m, r) => Math.max(m, r.scoreNum || 0), 0);
    return { key, rows, allSkip, anyNew, maxDate, maxScore };
  });
  groupMeta.sort((a, b) => {
    if (a.allSkip !== b.allSkip) return a.allSkip ? 1 : -1;
    if (a.anyNew !== b.anyNew) return a.anyNew ? -1 : 1;
    const dateCmp = b.maxDate.localeCompare(a.maxDate);
    if (dateCmp !== 0) return dateCmp;
    return b.maxScore - a.maxScore;
  });
  for (const g of groupMeta) {
    g.rows.sort((a, b) => {
      const sc = (b.scoreNum || 0) - (a.scoreNum || 0);
      if (sc !== 0) return sc;
      return (b.date || '').localeCompare(a.date || '');
    });
    g.rows.forEach((r, i) => {
      r._groupSize = g.rows.length;
      r._groupIndex = i + 1;
      r._groupKey = g.key;
    });
  }
  reports.length = 0;
  for (const g of groupMeta) reports.push(...g.rows);

  const cards = reports.map(r => {
    const tier = scoreTier(r.scoreNum, r.status);
    const status = statusBadge(r.status);
    const company = (r.title.split('—')[0] || r.title).trim();
    const role = (r.title.split('—').slice(1).join('—') || '').trim();
    const isApplied = tier === 'applied';
    const isRejected = tier === 'rejected';
    const isSkip = tier === 'skip';
    const slug = (r.file.match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/) || [])[1] || 'unknown';
    const isNew = r.loadedAt === TODAY || r.date === TODAY;
    const hasPdf = !!r.pdfFile;
    const pdfHref = r.pdfFile ? `output/${r.pdfFile}` : '';

    // Apply button: server-mode uses fetch, static-mode is a plain link
    const applyBtn = (isApplied || isRejected || isSkip)
      ? '' // these cards get other actions instead
      : (r.url
          ? `<a class="btn primary" href="${esc(r.url)}" target="_blank" rel="noopener" data-apply-id="${r.id}" onclick="if(window.CAREER_OPS_SERVER){event.preventDefault();window.applyToJob('${r.id}', '${esc(r.url)}');}">Apply →</a>`
          : '');

    // Resume button: View Resume if PDF exists, otherwise Generate Resume
    const resumeBtn = hasPdf
      ? `<a class="btn applied-pdf" href="${pdfHref}" target="_blank">📄 View Resume</a>`
      : `<button class="btn secondary" onclick="if(window.CAREER_OPS_SERVER){window.generateResume('${r.id}', this);}else{showServerHelp('Generate Resume');}">📄 Generate Resume</button>`;

    const reapplyBtn = (isApplied || isRejected) && r.url
      ? `<a class="btn secondary" href="${esc(r.url)}" target="_blank" rel="noopener">Open JD</a>`
      : '';

    const rejectBtn = isApplied
      ? `<button class="btn reject" onclick="if(window.CAREER_OPS_SERVER){window.rejectJob('${r.id}');}else{showServerHelp('Mark Rejected');}">❌ Mark Rejected</button>`
      : '';

    const skipBtn = (!isApplied && !isRejected && !isSkip)
      ? `<button class="btn skip-it" onclick="if(window.CAREER_OPS_SERVER){window.skipJob('${r.id}');}else{showServerHelp('Not interested');}">🙅 Not interested</button>`
      : '';

    const undoLabel = isRejected ? 'Undo' : (isSkip ? 'Restore' : 'Undo apply');
    const undoBtn = (isApplied || isRejected || isSkip)
      ? `<button class="btn undo" onclick="if(window.CAREER_OPS_SERVER){window.unapplyJob('${r.id}');}else{showServerHelp('Undo');}">${undoLabel}</button>`
      : '';

    const banner = isApplied
      ? `<div class="applied-banner">✉️ Applied${r.applied ? `<span class="applied-date">${esc(r.applied)}</span>` : ''}</div>`
      : (isRejected
          ? `<div class="rejected-banner">❌ Rejected${r.rejected ? `<span class="rejected-date">${esc(r.rejected)}</span>` : ''}</div>`
          : '');

    const rejectionNoteBlock = isRejected && r.rejectionNote
      ? `<div class="rejection-note"><strong>Why:</strong>${esc(r.rejectionNote)}</div>`
      : '';

    const skipNoteBlock = isSkip && r.skipNote
      ? `<div class="rejection-note"><strong>Why skipped:</strong>${esc(r.skipNote)}</div>`
      : '';

    const groupBadge = (r._groupSize > 1)
      ? ` <span class="group-badge" title="${r._groupSize} jobs at ${esc(company)}">${r._groupIndex}/${r._groupSize}</span>`
      : '';
    const groupClass = (r._groupSize > 1) ? ' grouped' : '';
    return `
    <article class="card${groupClass}" data-tier="${tier}" data-status="${status}" data-new="${isNew ? '1' : '0'}" data-company="${esc(r._groupKey || '')}">
      ${banner}
      <header class="card-header">
        <div class="card-title">
          <span class="company">${esc(company)}${groupBadge}${isNew ? ' <span class="new-badge">NEW</span>' : ''}</span>
          ${role ? `<span class="role">${esc(role)}</span>` : ''}
        </div>
        <div class="card-score">
          <span class="score-badge tier-${tier}">${esc(r.score || 'n/a')}</span>
          <span class="tier-label">${tierLabel(tier)}</span>
        </div>
      </header>

      ${r.tldr ? `<p class="tldr">${esc(r.tldr)}</p>` : ''}

      ${rejectionNoteBlock}
      ${skipNoteBlock}

      <dl class="meta">
        ${r.date ? `<div><dt>Added</dt><dd>${esc(r.date)}</dd></div>` : ''}
        ${r.archetype ? `<div><dt>Archetype</dt><dd>${esc(r.archetype)}</dd></div>` : ''}
        ${r.remote ? `<div><dt>Remote</dt><dd>${esc(r.remote)}</dd></div>` : ''}
        ${r.comp ? `<div><dt>Comp</dt><dd>${esc(r.comp)}</dd></div>` : ''}
        ${r.status ? `<div><dt>Status</dt><dd class="status-${status}">${esc(r.status)}</dd></div>` : ''}
        ${r.applied ? `<div><dt>Applied</dt><dd>${esc(r.applied)}</dd></div>` : ''}
        ${r.rejected ? `<div><dt>Rejected</dt><dd>${esc(r.rejected)}</dd></div>` : ''}
        ${r.legitimacy ? `<div><dt>Legitimacy</dt><dd>${esc(r.legitimacy)}</dd></div>` : ''}
      </dl>

      <footer class="card-actions">
        ${applyBtn}
        ${isSkip ? '' : resumeBtn}
        ${reapplyBtn}
        <button class="btn secondary" onclick="toggleDetails('details-${r.id}')">View details</button>
        ${rejectBtn}
        ${skipBtn}
        ${undoBtn}
      </footer>

      <section id="details-${r.id}" class="details" hidden>
        <pre class="report-body">${esc(r.body)}</pre>
      </section>
    </article>`;
  }).join('\n');

  const counts = {
    applied: reports.filter(r => scoreTier(r.scoreNum, r.status) === 'applied').length,
    rejected: reports.filter(r => scoreTier(r.scoreNum, r.status) === 'rejected').length,
    top: reports.filter(r => scoreTier(r.scoreNum, r.status) === 'top').length,
    strong: reports.filter(r => scoreTier(r.scoreNum, r.status) === 'strong').length,
    maybe: reports.filter(r => scoreTier(r.scoreNum, r.status) === 'maybe').length,
    weak: reports.filter(r => scoreTier(r.scoreNum, r.status) === 'weak').length,
    skip: reports.filter(r => scoreTier(r.scoreNum, r.status) === 'skip').length,
  };
  const actionable = counts.top + counts.strong + counts.maybe + counts.weak;
  const suggested = counts.top + counts.strong;  // 4.0+ unapplied, non-SKIP — apply now
  const newToday = reports.filter(r => r.loadedAt === TODAY || r.date === TODAY).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Career-Ops Dashboard</title>
<style>
  :root {
    --bg: #fafafa;
    --card: #ffffff;
    --border: #e2e2e2;
    --text: #1a1a2e;
    --muted: #777;
    --cyan: hsl(187, 74%, 32%);
    --purple: hsl(270, 70%, 45%);
    --top: hsl(140, 60%, 38%);
    --strong: hsl(187, 74%, 38%);
    --maybe: hsl(38, 90%, 50%);
    --weak: hsl(20, 80%, 50%);
    --skip: hsl(0, 60%, 50%);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  header.page {
    background: white;
    padding: 24px 32px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  header.page h1 {
    margin: 0 0 4px;
    font-size: 22px;
    background: linear-gradient(90deg, var(--cyan), var(--purple));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .page-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .btn.scan-btn {
    background: white;
    border: 1.5px solid var(--cyan);
    color: var(--cyan);
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn.scan-btn:hover {
    background: var(--cyan);
    color: white;
  }
  .btn.scan-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .header-buttons { display: flex; gap: 8px; align-items: center; }
  .btn.eval-all-btn {
    background: hsl(220, 50%, 50%);
    border: 1.5px solid hsl(220, 50%, 50%);
    color: white;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn.eval-all-btn:hover {
    background: hsl(220, 60%, 40%);
    border-color: hsl(220, 60%, 40%);
  }
  .btn.eval-all-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  header.page .subtitle {
    font-size: 13px;
    color: var(--muted);
  }
  .filters {
    display: flex;
    gap: 8px;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .filters button {
    background: white;
    border: 1px solid var(--border);
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .filters button:hover { border-color: var(--cyan); }
  .filters button.active {
    background: var(--cyan);
    border-color: var(--cyan);
    color: white;
  }
  main {
    padding: 24px 32px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 16px;
    max-width: 1600px;
    margin: 0 auto;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px;
    transition: box-shadow 0.15s, transform 0.15s;
  }
  .card:hover {
    box-shadow: 0 4px 16px rgba(0,0,0,0.06);
    transform: translateY(-1px);
  }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 10px;
  }
  .card-title { display: flex; flex-direction: column; gap: 2px; }
  .company {
    font-weight: 700;
    font-size: 15px;
    color: var(--purple);
  }
  .group-badge {
    display: inline-block;
    background: hsl(220, 15%, 90%);
    color: hsl(220, 20%, 35%);
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 999px;
    vertical-align: middle;
    margin-left: 6px;
    letter-spacing: 0;
  }
  .card.grouped {
    border-left: 3px solid var(--purple);
  }
  .card.grouped[data-company]:hover ~ .card[data-company] { /* placeholder */ }
  .new-badge {
    display: inline-block;
    background: hsl(140, 60%, 38%);
    color: white;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.08em;
    padding: 2px 6px;
    border-radius: 4px;
    vertical-align: middle;
    margin-left: 6px;
    animation: pulse-new 1.6s ease-in-out infinite;
  }
  @keyframes pulse-new {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  .role { font-size: 13px; color: var(--text); }
  .card-score { text-align: right; flex-shrink: 0; }
  .score-badge {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 6px;
    font-weight: 700;
    font-size: 14px;
    color: white;
  }
  .tier-top    .score-badge, .score-badge.tier-top    { background: var(--top); }
  .tier-strong .score-badge, .score-badge.tier-strong { background: var(--strong); }
  .tier-maybe  .score-badge, .score-badge.tier-maybe  { background: var(--maybe); }
  .tier-weak   .score-badge, .score-badge.tier-weak   { background: var(--weak); }
  .tier-skip   .score-badge, .score-badge.tier-skip   { background: var(--skip); }
  .tier-applied .score-badge, .score-badge.tier-applied { background: var(--purple); }
  .tier-rejected .score-badge, .score-badge.tier-rejected { background: hsl(0, 0%, 50%); }
  .tier-pending .score-badge, .score-badge.tier-pending { background: hsl(220, 15%, 70%); color: #fff; }
  .card[data-tier="pending"] {
    border: 1.5px dashed hsl(220, 30%, 70%);
    background: hsl(220, 30%, 99%);
  }
  .pending-banner {
    background: hsl(220, 50%, 50%);
    color: white;
    padding: 5px 10px;
    border-radius: 6px 6px 0 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: -18px -18px 14px;
  }
  .pending-filter {
    border-color: hsl(220, 50%, 50%) !important;
    color: hsl(220, 50%, 35%);
    font-weight: 600;
  }
  .btn.applied-pdf {
    background: var(--purple);
    color: white;
  }
  .btn.applied-pdf:hover { background: hsl(270, 70%, 40%); }
  .btn.undo {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    margin-left: auto;
    font-size: 12px;
  }
  .btn.undo:hover {
    color: var(--skip);
    border-color: var(--skip);
  }
  .btn.reject {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    font-size: 12px;
  }
  .btn.reject:hover {
    color: var(--skip);
    border-color: var(--skip);
  }
  .btn.skip-it {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    font-size: 12px;
  }
  .btn.skip-it:hover {
    color: var(--skip);
    border-color: var(--skip);
  }

  /* Rejection box shown on rejected cards */
  .rejected-banner {
    background: hsl(0, 0%, 35%);
    color: white;
    padding: 5px 10px;
    border-radius: 6px 6px 0 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: -18px -18px 14px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .rejected-banner .rejected-date {
    font-weight: 400;
    letter-spacing: 0;
    font-size: 11px;
    text-transform: none;
  }
  .card[data-tier="rejected"] {
    border: 1.5px solid hsl(0, 0%, 50%);
    opacity: 0.92;
  }
  .rejection-note {
    background: hsl(0, 0%, 95%);
    border-left: 3px solid hsl(0, 0%, 50%);
    padding: 8px 12px;
    font-size: 12px;
    color: #555;
    margin: 8px 0 12px;
    border-radius: 0 4px 4px 0;
    font-style: italic;
  }
  .rejection-note strong {
    font-style: normal;
    font-weight: 600;
    color: #333;
    display: block;
    margin-bottom: 2px;
  }

  /* Section header that updates with the active filter */
  .section-heading {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 18px;
    font-weight: 700;
    color: var(--text);
    margin: 0 32px 8px;
    padding-top: 24px;
    max-width: 1600px;
  }
  .section-heading .count {
    color: var(--muted);
    font-weight: 400;
    font-size: 14px;
    margin-left: 8px;
  }

  /* APPLIED banner on cards */
  .applied-banner {
    background: var(--purple);
    color: white;
    padding: 5px 10px;
    border-radius: 6px 6px 0 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: -18px -18px 14px;
    text-align: left;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .applied-banner .applied-date {
    font-weight: 400;
    letter-spacing: 0;
    font-size: 11px;
    text-transform: none;
  }
  .card[data-tier="applied"] {
    border: 1.5px solid var(--purple);
  }
  .tier-label {
    display: block;
    font-size: 11px;
    color: var(--muted);
    margin-top: 4px;
  }
  .tldr {
    font-size: 13px;
    color: #444;
    margin: 0 0 12px;
    line-height: 1.45;
  }
  .meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    font-size: 12px;
    margin: 0 0 14px;
  }
  .meta div { display: contents; }
  .meta dt { color: var(--muted); }
  .meta dd { margin: 0; color: var(--text); }
  .status-skip { color: var(--skip); font-weight: 600; }
  .status-applied { color: var(--strong); font-weight: 600; }
  .status-interview { color: var(--purple); font-weight: 600; }
  .status-offer { color: var(--top); font-weight: 600; }
  .card-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .btn {
    padding: 7px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s;
    display: inline-flex;
    align-items: center;
  }
  .btn.primary {
    background: var(--cyan);
    color: white;
  }
  .btn.primary:hover { background: hsl(187, 74%, 27%); }
  .btn.secondary {
    background: white;
    color: var(--text);
    border-color: var(--border);
  }
  .btn.secondary:hover { border-color: var(--cyan); color: var(--cyan); }
  .details {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .report-body {
    font-family: 'SF Mono', Menlo, Consolas, monospace;
    font-size: 11.5px;
    line-height: 1.5;
    background: #f5f5f7;
    padding: 14px;
    border-radius: 6px;
    overflow-x: auto;
    white-space: pre-wrap;
    color: #2f2f2f;
  }
  .empty {
    text-align: center;
    padding: 60px 20px;
    color: var(--muted);
  }
  .static-banner {
    background: hsl(38, 90%, 96%);
    border-bottom: 2px solid hsl(38, 90%, 60%);
    color: hsl(38, 90%, 22%);
    padding: 14px 0;
    font-size: 14px;
  }
  .static-banner-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 32px;
  }
  .static-banner code {
    background: hsl(38, 60%, 88%);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
  }
  .static-banner a {
    color: hsl(38, 90%, 30%);
    font-weight: 600;
  }
  /* Server mode injects CAREER_OPS_SERVER and the inline script below hides the banner */
  .server-mode .static-banner { display: none; }
</style>
</head>
<body>

<div id="static-mode-banner" class="static-banner">
  <div class="static-banner-inner">
    <strong>📭 You're viewing a static snapshot.</strong>
    Buttons like Apply / Evaluate / Scan need the dashboard server.
    To start it: open a terminal in the <code>career-ops</code> folder and run <code>make up</code>,
    then open <a href="http://localhost:3030">http://localhost:3030</a> (instead of this file).
  </div>
</div>

<header class="page">
  <div class="page-header-row">
    <h1>Career-Ops Dashboard</h1>
    <div class="header-buttons">
      ${pending.length > 0 ? `<button class="btn eval-all-btn" onclick="if(window.CAREER_OPS_SERVER){window.evaluateAll(this);}else{showServerHelp('Evaluate all');}">⚡ Evaluate all (${pending.length})</button>` : ''}
      <button class="btn scan-btn" onclick="if(window.CAREER_OPS_SERVER){window.scanForJobs(this);}else{showServerHelp('Scan for new jobs');}">🔍 Scan for new jobs</button>
    </div>
  </div>
  <div class="subtitle">${actionable} actionable · ${counts.applied} applied · ${counts.rejected} rejected · ${counts.skip} skipped · generated ${new Date().toLocaleString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Chicago', timeZoneName: 'short' })}</div>
  <div class="filters">
    <button class="active" onclick="filterCards('suggested', this)">✨ Suggested (${suggested})</button>
    ${pending.length > 0 ? `<button class="pending-filter" onclick="filterCards('pending', this)">🆕 Pending eval (${pending.length})</button>` : ''}
    ${newToday > 0 ? `<button onclick="filterCards('new', this)">🆕 New today (${newToday})</button>` : ''}
    <button onclick="filterCards('actionable', this)">Actionable (${actionable})</button>
    <button onclick="filterCards('applied', this)">✉️ Applied (${counts.applied})</button>
    <button onclick="filterCards('rejected', this)">❌ Rejected (${counts.rejected})</button>
    <button onclick="filterCards('top', this)">🏆 Top (${counts.top})</button>
    <button onclick="filterCards('strong', this)">🟢 Strong (${counts.strong})</button>
    <button onclick="filterCards('maybe', this)">🟡 Maybe (${counts.maybe})</button>
    <button onclick="filterCards('weak', this)">⚠️ Weak (${counts.weak})</button>
    <button onclick="filterCards('skip', this)">🔴 SKIP (${counts.skip})</button>
    <button onclick="filterCards('all', this)">Show all (${reports.length + pending.length})</button>
  </div>
</header>

<h2 class="section-heading" id="section-heading">✨ Suggested — apply now <span class="count">${suggested} total</span></h2>

<main id="cards">
${pending.map((p, i) => buildPendingCard(p, i)).join('\n')}
${cards || (pending.length === 0 ? '<p class="empty">No evaluations yet. Run <code>node scan.mjs</code> then evaluate jobs from the pipeline.</p>' : '')}
</main>

<script>
  function showServerHelp(action) {
    const msg =
      '"' + action + '" needs the dashboard server.\\n\\n' +
      'You\\'re viewing this file directly — buttons that change data require the backend.\\n\\n' +
      'To start the server:\\n' +
      '  1. Open a terminal in the career-ops folder\\n' +
      '  2. Run:  make up\\n' +
      '  3. Open http://localhost:3030 in your browser\\n\\n' +
      '(Use http://localhost:3030 instead of opening dashboard.html directly.)';
    alert(msg);
  }
  function toggleDetails(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !el.hidden;
  }
  const SECTION_TITLES = {
    suggested: '✨ Suggested — apply now',
    pending: '🆕 Scanned — not yet evaluated',
    new: '🆕 New today',
    actionable: 'Actionable Jobs',
    applied: '✉️ Applied Jobs',
    rejected: '❌ Rejected',
    top: '🏆 Top Fits',
    strong: '🟢 Strong Fits',
    maybe: '🟡 Maybe',
    weak: '⚠️ Weak Matches',
    skip: '🔴 Skipped',
    all: 'All Evaluations',
  };
  function filterCards(tier, btn) {
    document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    let visible = 0;
    document.querySelectorAll('.card').forEach(card => {
      let show;
      if (tier === 'all') show = true;
      else if (tier === 'suggested') show = ['top','strong'].includes(card.dataset.tier);
      else if (tier === 'pending') show = card.dataset.tier === 'pending';
      else if (tier === 'new') show = card.dataset.new === '1';
      else if (tier === 'actionable') show = !['skip','applied','rejected','pending'].includes(card.dataset.tier);
      else show = card.dataset.tier === tier;
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    const heading = document.getElementById('section-heading');
    if (heading) {
      heading.innerHTML = (SECTION_TITLES[tier] || tier) + ' <span class="count">' + visible + ' total</span>';
    }
  }
  // Default view priority: Pending eval (if any) → New today → Suggested.
  (function applyDefaultFilter() {
    const hasPending = !!document.querySelector('.card[data-tier="pending"]');
    if (hasPending) {
      const pendingBtn = Array.from(document.querySelectorAll('.filters button'))
        .find(b => b.textContent.includes('Pending eval'));
      if (pendingBtn) { filterCards('pending', pendingBtn); return; }
    }
    const hasNew = !!document.querySelector('.card[data-new="1"]');
    if (hasNew) {
      const newBtn = Array.from(document.querySelectorAll('.filters button'))
        .find(b => b.textContent.includes('New today'));
      if (newBtn) { filterCards('new', newBtn); return; }
    }
    document.querySelectorAll('.card').forEach(c => {
      if (!['top','strong'].includes(c.dataset.tier)) c.style.display = 'none';
    });
  })();
</script>

</body>
</html>
`;
}

async function main() {
  const outputPath = resolve(process.argv[2] || resolve(OUT_DIR, 'dashboard.html'));
  const reports = await loadReportsFromDb();
  const pending = loadPendingFromDb();
  const html = buildHTML(reports, pending);
  await writeFile(outputPath, html);
  console.log(`✅ Dashboard written: ${outputPath}`);
  console.log(`📊 ${reports.length} reports + ${pending.length} pending-eval (from career-ops.db)`);
}

main().catch(err => {
  console.error('Dashboard generation failed:', err.message);
  process.exit(1);
});
