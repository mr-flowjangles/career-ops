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

import { readFile, writeFile, readdir } from 'fs/promises';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const REPORTS_DIR = resolve(ROOT, 'reports');
const OUT_DIR = resolve(ROOT, 'output');
mkdirSync(OUT_DIR, { recursive: true });

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Pull metadata fields out of a report's front block.
function parseReport(filename, content) {
  const m = (pattern) => {
    const match = content.match(pattern);
    return match ? match[1].trim() : '';
  };

  const id = (filename.match(/^(\d+)/) || [])[1] || '?';
  const title = (content.match(/^#\s+(.+)$/m) || [])[1] || filename;

  // Pipe-separated metadata (TL;DR, Arquetipo, Remote, Comp)
  const pipe = (key) => {
    const re = new RegExp(`\\*\\*${key}\\*\\*\\s*\\|\\s*(.+)`);
    const match = content.match(re);
    return match ? match[1].trim() : '';
  };

  return {
    id,
    title: title.replace(/^\d+\s*[-—]\s*/, ''),
    file: filename,
    url: m(/^\*\*URL:\*\*\s*(\S+)/m),
    score: m(/^\*\*Score:\*\*\s*([\d.]+\/5)/m),
    scoreNum: parseFloat((m(/^\*\*Score:\*\*\s*([\d.]+)\/5/m)) || '0'),
    status: m(/^\*\*Status:\*\*\s*(.+)/m),
    date: m(/^\*\*Date:\*\*\s*(.+)/m),
    applied: m(/^\*\*Applied:\*\*\s*(.+)/m),
    rejected: m(/^\*\*Rejected:\*\*\s*(.+)/m),
    rejectionNote: m(/^\*\*Rejection Note:\*\*\s*(.+)/m),
    legitimacy: m(/^\*\*Legitimacy:\*\*\s*(.+)/m),
    tldr: pipe('TL;DR'),
    archetype: pipe('Arquetipo') || pipe('Archetype'),
    remote: pipe('Remote'),
    comp: pipe('Comp'),
    body: content,
  };
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

async function loadReports() {
  const files = (await readdir(REPORTS_DIR))
    .filter(f => f.endsWith('.md'))
    .sort();
  const outFiles = await readdir(OUT_DIR).catch(() => []);
  const reports = [];
  for (const f of files) {
    const content = await readFile(resolve(REPORTS_DIR, f), 'utf-8');
    const r = parseReport(f, content);
    const slug = (f.match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/) || [])[1];
    // Extract company from the report's H1: "# 003 — Arize AI — Engineering Manager"
    const firstLine = (content.split('\n')[0] || '').replace(/^#\s+/, '');
    const titleParts = firstLine.split(/\s+[—-]\s+/).map(p => p.trim());
    const company = titleParts[1] || '';
    const pascalCompany = companyToPascal(company);
    // Look for new RobRose{Company}.pdf naming first, fall back to legacy
    r.pdfFile = (pascalCompany && outFiles.find(pf => pf === `RobRose${pascalCompany}.pdf`))
      || (slug && outFiles.find(pf => pf.startsWith(`cv-rob-rose-${slug}-`) && pf.endsWith('.pdf')))
      || null;
    reports.push(r);
  }
  return reports;
}

function buildHTML(reports) {
  // Sort by score desc (SKIPs sink to bottom)
  reports.sort((a, b) => {
    const aSkip = (a.status || '').toUpperCase().includes('SKIP');
    const bSkip = (b.status || '').toUpperCase().includes('SKIP');
    if (aSkip !== bSkip) return aSkip ? 1 : -1;
    return b.scoreNum - a.scoreNum;
  });

  const cards = reports.map(r => {
    const tier = scoreTier(r.scoreNum, r.status);
    const status = statusBadge(r.status);
    const company = (r.title.split('—')[0] || r.title).trim();
    const role = (r.title.split('—').slice(1).join('—') || '').trim();
    const isApplied = tier === 'applied';
    const isRejected = tier === 'rejected';
    const slug = (r.file.match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/) || [])[1] || 'unknown';
    const hasPdf = !!r.pdfFile;
    const pdfHref = r.pdfFile ? `output/${r.pdfFile}` : '';

    // Apply button: server-mode uses fetch, static-mode is a plain link
    const applyBtn = (isApplied || isRejected)
      ? '' // these cards get View Resume + Open JD instead
      : (r.url
          ? `<a class="btn primary" href="${esc(r.url)}" target="_blank" rel="noopener" data-apply-id="${r.id}" onclick="if(window.CAREER_OPS_SERVER){event.preventDefault();window.applyToJob('${r.id}', '${esc(r.url)}');}">Apply →</a>`
          : '');

    // Resume button: View Resume if PDF exists, otherwise Generate Resume
    const resumeBtn = hasPdf
      ? `<a class="btn applied-pdf" href="${pdfHref}" target="_blank">📄 View Resume</a>`
      : `<button class="btn secondary" onclick="if(window.CAREER_OPS_SERVER){window.generateResume('${r.id}', this);}else{alert('Generate Resume requires the dashboard server. Run: npm run dashboard:serve');}">📄 Generate Resume</button>`;

    const reapplyBtn = (isApplied || isRejected) && r.url
      ? `<a class="btn secondary" href="${esc(r.url)}" target="_blank" rel="noopener">Open JD</a>`
      : '';

    const rejectBtn = isApplied
      ? `<button class="btn reject" onclick="if(window.CAREER_OPS_SERVER){window.rejectJob('${r.id}');}else{alert('Mark Rejected requires the dashboard server. Run: npm run dashboard:serve');}">❌ Mark Rejected</button>`
      : '';

    const undoBtn = (isApplied || isRejected)
      ? `<button class="btn undo" onclick="if(window.CAREER_OPS_SERVER){window.unapplyJob('${r.id}');}else{alert('Undo requires the dashboard server. Run: npm run dashboard:serve');}">${isRejected ? 'Undo' : 'Undo apply'}</button>`
      : '';

    const banner = isApplied
      ? `<div class="applied-banner">✉️ Applied${r.applied ? `<span class="applied-date">${esc(r.applied)}</span>` : ''}</div>`
      : (isRejected
          ? `<div class="rejected-banner">❌ Rejected${r.rejected ? `<span class="rejected-date">${esc(r.rejected)}</span>` : ''}</div>`
          : '');

    const rejectionNoteBlock = isRejected && r.rejectionNote
      ? `<div class="rejection-note"><strong>Why:</strong>${esc(r.rejectionNote)}</div>`
      : '';

    return `
    <article class="card" data-tier="${tier}" data-status="${status}">
      ${banner}
      <header class="card-header">
        <div class="card-title">
          <span class="company">${esc(company)}</span>
          ${role ? `<span class="role">${esc(role)}</span>` : ''}
        </div>
        <div class="card-score">
          <span class="score-badge tier-${tier}">${esc(r.score || 'n/a')}</span>
          <span class="tier-label">${tierLabel(tier)}</span>
        </div>
      </header>

      ${r.tldr ? `<p class="tldr">${esc(r.tldr)}</p>` : ''}

      ${rejectionNoteBlock}

      <dl class="meta">
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
        ${resumeBtn}
        ${reapplyBtn}
        <button class="btn secondary" onclick="toggleDetails('details-${r.id}')">View details</button>
        ${rejectBtn}
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
</style>
</head>
<body>

<header class="page">
  <h1>Career-Ops Dashboard</h1>
  <div class="subtitle">${actionable} actionable · ${counts.applied} applied · ${counts.rejected} rejected · ${counts.skip} skipped · generated ${new Date().toISOString().slice(0,10)}</div>
  <div class="filters">
    <button class="active" onclick="filterCards('actionable', this)">Actionable (${actionable})</button>
    <button onclick="filterCards('applied', this)">✉️ Applied (${counts.applied})</button>
    <button onclick="filterCards('rejected', this)">❌ Rejected (${counts.rejected})</button>
    <button onclick="filterCards('top', this)">🏆 Top (${counts.top})</button>
    <button onclick="filterCards('strong', this)">🟢 Strong (${counts.strong})</button>
    <button onclick="filterCards('maybe', this)">🟡 Maybe (${counts.maybe})</button>
    <button onclick="filterCards('weak', this)">⚠️ Weak (${counts.weak})</button>
    <button onclick="filterCards('skip', this)">🔴 SKIP (${counts.skip})</button>
    <button onclick="filterCards('all', this)">Show all (${reports.length})</button>
  </div>
</header>

<h2 class="section-heading" id="section-heading">Actionable Jobs <span class="count">${actionable} total</span></h2>

<main id="cards">
${cards || '<p class="empty">No evaluations yet. Run <code>node scan.mjs</code> then evaluate jobs from the pipeline.</p>'}
</main>

<script>
  function toggleDetails(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !el.hidden;
  }
  const SECTION_TITLES = {
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
      else if (tier === 'actionable') show = !['skip','applied','rejected'].includes(card.dataset.tier);
      else show = card.dataset.tier === tier;
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    const heading = document.getElementById('section-heading');
    if (heading) {
      heading.innerHTML = (SECTION_TITLES[tier] || tier) + ' <span class="count">' + visible + ' total</span>';
    }
  }
  // Default view is "Actionable" - hide SKIP, Applied, Rejected on initial load
  document.querySelectorAll('.card[data-tier="skip"], .card[data-tier="applied"], .card[data-tier="rejected"]').forEach(c => c.style.display = 'none');
</script>

</body>
</html>
`;
}

async function main() {
  const outputPath = resolve(process.argv[2] || resolve(OUT_DIR, 'dashboard.html'));
  const reports = await loadReports();
  const html = buildHTML(reports);
  await writeFile(outputPath, html);
  console.log(`✅ Dashboard written: ${outputPath}`);
  console.log(`📊 ${reports.length} reports rendered`);
}

main().catch(err => {
  console.error('Dashboard generation failed:', err.message);
  process.exit(1);
});
