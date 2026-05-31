#!/usr/bin/env node

/**
 * dashboard-server.mjs — Interactive dashboard server.
 *
 * Serves the career-ops dashboard with working Apply buttons. When a user
 * clicks Apply on a card, the server:
 *   1. Marks the job as `Applied` in data/applications.md and the report file
 *   2. Copies the most recent generic CV PDF to a company-named file
 *   3. Returns { pdfPath, appliedDate } so the page can update the card
 *
 * For JD-tailored CVs (real keyword injection, archetype-adapted summary),
 * ask Claude in chat: "tailor the PDF for #16". Claude rewrites the report's
 * tailored CV in place, and the next page load picks up the change.
 *
 * Usage:
 *   node dashboard-server.mjs        # listens on :3030
 *   PORT=4000 node dashboard-server.mjs
 */

import http from 'node:http';
import { readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getOnboardingStatus,
  renderWizardHTML,
  writeCv,
  writeProfile,
  writePortals,
  ensureUserProfileMd,
} from './onboarding.mjs';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3030', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

async function regenerateDashboard() {
  await execAsync('node generate-dashboard.mjs', { cwd: __dirname });
  return readFile(resolve(__dirname, 'output/dashboard.html'), 'utf-8');
}

async function syncDb() {
  // Non-fatal — DB is a derived index. If sync fails, MD files are still canonical.
  try {
    await execAsync('node sync-db.mjs', { cwd: __dirname, timeout: 10000 });
  } catch (e) {
    console.error('sync-db warning:', e.message);
  }
}

async function findReportPath(id) {
  const padded = String(id).padStart(3, '0');
  const files = await readdir(resolve(__dirname, 'reports'));
  const match = files.find(f => f.startsWith(`${padded}-`) && f.endsWith('.md'));
  return match ? { path: resolve(__dirname, 'reports', match), filename: match } : null;
}

function slugFromReportFilename(filename) {
  const m = filename.match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  return m ? m[1] : 'unknown';
}

// Extract the company name from a report's H1 line: "# 003 — Arize AI — Engineering Manager".
async function extractCompany(reportPath) {
  const content = await readFile(reportPath, 'utf-8');
  const firstLine = (content.split('\n')[0] || '').replace(/^#\s+/, '');
  const parts = firstLine.split(/\s+[—-]\s+/).map(p => p.trim());
  // parts[0] is the ID number, parts[1] is the company, parts[2] is the role
  return parts[1] || 'Unknown';
}

// "Arize AI" → "Arize". "Pearl Health" → "PearlHealth". "GHX (Global Healthcare Exchange)" → "GHX".
function companyToPascal(name) {
  return name
    .replace(/\([^)]*\)/g, '')                                              // strip parens
    .replace(/\s+(AI|ML|Inc\.?|LLC|Corp\.?|Co\.|Ltd\.?)$/i, '')             // drop trailing entity word
    .replace(/[^a-zA-Z0-9]/g, '');                                          // PascalCase
}

async function tailoredPdfName(reportPath) {
  const company = await extractCompany(reportPath);
  return `RobRose${companyToPascal(company)}.pdf`;
}

async function findLatestGenericPDF() {
  const outDir = resolve(__dirname, 'output');
  try {
    const files = await readdir(outDir);
    const generic = files
      .filter(f => /^cv-rob-rose-\d{4}-\d{2}-\d{2}\.pdf$/.test(f))
      .sort();
    if (generic.length) return resolve(outDir, generic[generic.length - 1]);
  } catch {}
  return null;
}

async function updateReportStatus(reportPath, status, appliedDate) {
  let content = await readFile(reportPath, 'utf-8');
  // Anchor to single line: ^...[^\n]+$ with /m flag stays within one line
  content = content.replace(/^\*\*Status:\*\*[^\n]*$/m, `**Status:** ${status}`);
  if (appliedDate && !/^\*\*Applied:\*\*/m.test(content)) {
    content = content.replace(/^\*\*Status:\*\* Applied$/m, `**Status:** Applied\n**Applied:** ${appliedDate}`);
  }
  if (status === 'Evaluated') {
    // Reverting all the way back: scrub all decision metadata
    content = content.replace(/^\*\*Applied:\*\*[^\n]*\n/m, '');
    content = content.replace(/^\*\*Rejected:\*\*[^\n]*\n/m, '');
    content = content.replace(/^\*\*Rejection Note:\*\*[^\n]*\n/m, '');
    content = content.replace(/^\*\*Skip Note:\*\*[^\n]*\n/m, '');
  } else if (status === 'Rejected') {
    // Keep Applied (history), Rejected/Note are set by rejectJob
  } else if (status !== 'Applied') {
    content = content.replace(/^\*\*Applied:\*\*[^\n]*\n/m, '');
  }
  await writeFile(reportPath, content);
}

async function updateApplicationsRow(id, status, pdfFlag) {
  const trackerPath = resolve(__dirname, 'data/applications.md');
  const idShort = String(parseInt(id, 10));
  const tracker = await readFile(trackerPath, 'utf-8');

  const updatedLines = tracker.split('\n').map(line => {
    // | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
    if (!line.startsWith('|')) return line;
    const cols = line.split('|');
    if (cols.length < 10) return line;
    if (cols[1].trim() !== idShort) return line;
    if (status !== undefined) cols[6] = ` ${status} `;     // Status column
    if (pdfFlag !== undefined) cols[7] = ` ${pdfFlag} `;   // PDF column
    return cols.join('|');
  });

  await writeFile(trackerPath, updatedLines.join('\n'));
}

async function generatePdfForJob(id) {
  const report = await findReportPath(id);
  if (!report) throw new Error(`Report not found for id ${id}`);

  const date = new Date().toISOString().slice(0, 10);
  const slug = slugFromReportFilename(report.filename);
  const pdfName = await tailoredPdfName(report.path);
  const pdfPath = resolve(__dirname, 'output', pdfName);

  const generic = await findLatestGenericPDF();
  if (!generic || !existsSync(generic)) {
    throw new Error('No generic CV PDF found. Run `node generate-pdf.mjs cv.md output/cv-rob-rose-{date}.pdf --format=letter` first.');
  }
  await copyFile(generic, pdfPath);

  // Update report PDF flag to ✅ (status untouched)
  let content = await readFile(report.path, 'utf-8');
  content = content.replace(/^\*\*PDF:\*\*[^\n]*$/m, '**PDF:** ✅');
  await writeFile(report.path, content);

  await updateApplicationsRow(id, undefined, '✅');

  return {
    ok: true,
    id,
    slug,
    pdfPath: `/output/${pdfName}`,
    pdfTailored: false,
    note: 'Placeholder PDF: copy of your generic CV. For a JD-tailored version, ask Claude in chat "tailor PDF for #' + id + '".',
  };
}

async function applyToJob(id) {
  const report = await findReportPath(id);
  if (!report) throw new Error(`Report not found for id ${id}`);

  const date = new Date().toISOString().slice(0, 10);
  const slug = slugFromReportFilename(report.filename);
  const pdfName = await tailoredPdfName(report.path);
  const pdfPath = resolve(__dirname, 'output', pdfName);

  const generic = await findLatestGenericPDF();
  let pdfCreated = false;
  if (generic && existsSync(generic)) {
    await copyFile(generic, pdfPath);
    pdfCreated = true;
  }

  await updateReportStatus(report.path, 'Applied', date);
  await updateApplicationsRow(id, 'Applied', pdfCreated ? '✅' : '❌');

  return {
    ok: true,
    id,
    slug,
    appliedDate: date,
    pdfPath: pdfCreated ? `/output/${pdfName}` : null,
    pdfTailored: false,
    note: pdfCreated
      ? 'Placeholder PDF: copy of your generic CV. Ask Claude in chat "tailor PDF for #' + id + '" for a JD-customized version.'
      : 'No generic CV PDF found. Run `node generate-pdf.mjs cv.md output/cv-rob-rose-{date}.pdf --format=letter` first.',
  };
}

async function runScan() {
  const { stdout: scanOut } = await execAsync('node scan.mjs', {
    cwd: __dirname,
    maxBuffer: 10 * 1024 * 1024,
  });
  const num = (re) => {
    const m = scanOut.match(re);
    return m ? parseInt(m[1], 10) : 0;
  };
  const newOffers = num(/New offers added:\s+(\d+)/);

  let evalOut = '';
  let evalCompleted = 0;
  let evalFailed = 0;
  // Policy: every job added gets evaluated. Run auto-evaluate after scan.
  // Skip if scan added zero (no new work) AND no leftover unchecked items.
  // auto-evaluate handles its own dedup against existing reports.
  try {
    const res = await execAsync('node auto-evaluate.mjs', {
      cwd: __dirname,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
    evalOut = res.stdout;
    const compMatch = evalOut.match(/Completed:\s+(\d+)\s+Failed:\s+(\d+)/);
    if (compMatch) {
      evalCompleted = parseInt(compMatch[1], 10);
      evalFailed = parseInt(compMatch[2], 10);
    }
  } catch (e) {
    evalOut = `auto-evaluate error: ${e.message}`;
  }

  return {
    ok: true,
    companies: num(/Companies scanned:\s+(\d+)/),
    totalJobs: num(/Total jobs found:\s+(\d+)/),
    titleFiltered: num(/Filtered by title:\s+(\d+)/),
    locationFiltered: num(/Filtered by location:\s+(\d+)/),
    duplicates: num(/Duplicates:\s+(\d+)/),
    newOffers,
    evalCompleted,
    evalFailed,
    summaryTail: (scanOut.split('\n').slice(-40).join('\n')
      + '\n--- auto-evaluate ---\n'
      + evalOut.split('\n').slice(-40).join('\n')),
  };
}

async function skipJob(id, reason) {
  const report = await findReportPath(id);
  if (!report) throw new Error(`Report not found for id ${id}`);

  const note = (reason || '').replace(/\r?\n+/g, ' ').trim();
  let content = await readFile(report.path, 'utf-8');
  content = content.replace(/^\*\*Status:\*\*[^\n]*$/m, '**Status:** SKIP');
  if (note) {
    if (/^\*\*Skip Note:\*\*/m.test(content)) {
      content = content.replace(/^\*\*Skip Note:\*\*[^\n]*$/m, `**Skip Note:** ${note}`);
    } else {
      content = content.replace(/^\*\*Status:\*\* SKIP$/m, `**Status:** SKIP\n**Skip Note:** ${note}`);
    }
  } else {
    content = content.replace(/^\*\*Skip Note:\*\*[^\n]*\n/m, '');
  }
  await writeFile(report.path, content);
  await updateApplicationsRow(id, 'SKIP');
  return { ok: true, id, status: 'SKIP', reason: note };
}

async function rejectJob(id, reason) {
  const report = await findReportPath(id);
  if (!report) throw new Error(`Report not found for id ${id}`);

  const date = new Date().toISOString().slice(0, 10);
  const note = (reason || '').replace(/\r?\n+/g, ' ').trim();

  let content = await readFile(report.path, 'utf-8');
  // Status -> Rejected
  content = content.replace(/^\*\*Status:\*\*[^\n]*$/m, '**Status:** Rejected');
  // Add or update Rejected: date
  if (/^\*\*Rejected:\*\*/m.test(content)) {
    content = content.replace(/^\*\*Rejected:\*\*[^\n]*$/m, `**Rejected:** ${date}`);
  } else {
    content = content.replace(/^\*\*Status:\*\* Rejected$/m, `**Status:** Rejected\n**Rejected:** ${date}`);
  }
  // Add or update Rejection Note: text
  if (note) {
    if (/^\*\*Rejection Note:\*\*/m.test(content)) {
      content = content.replace(/^\*\*Rejection Note:\*\*[^\n]*$/m, `**Rejection Note:** ${note}`);
    } else {
      content = content.replace(/^\*\*Rejected:\*\* [^\n]*$/m, (m) => `${m}\n**Rejection Note:** ${note}`);
    }
  } else {
    // Remove existing note if user marked rejected with no reason
    content = content.replace(/^\*\*Rejection Note:\*\*[^\n]*\n/m, '');
  }
  await writeFile(report.path, content);

  await updateApplicationsRow(id, 'Rejected');

  return { ok: true, id, status: 'Rejected', date, reason: note };
}

async function unapplyJob(id) {
  const report = await findReportPath(id);
  if (!report) throw new Error(`Report not found for id ${id}`);

  await updateReportStatus(report.path, 'Evaluated');
  await updateApplicationsRow(id, 'Evaluated', '❌');

  // Remove the placeholder PDF if it exists (new RobRose{Company}.pdf naming
  // plus the old cv-rob-rose-{slug}-{date}.pdf naming for backward compat)
  const slug = slugFromReportFilename(report.filename);
  const newName = await tailoredPdfName(report.path);
  const { unlink } = await import('node:fs/promises');
  try {
    const outDir = resolve(__dirname, 'output');
    const files = await readdir(outDir);
    const matches = files.filter(f =>
      f === newName || (f.startsWith(`cv-rob-rose-${slug}-`) && f.endsWith('.pdf'))
    );
    for (const m of matches) {
      await unlink(resolve(outDir, m));
    }
  } catch {}

  return { ok: true, id, slug, status: 'Evaluated' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // GET / → onboarding wizard if config missing, else dashboard
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const onboarding = getOnboardingStatus();
      if (onboarding.needsOnboarding && url.searchParams.get('force') !== 'dashboard') {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(renderWizardHTML());
        return;
      }
      let html = await regenerateDashboard();
      // Inject server-mode flag and apply-button JS into the page
      const inject = `
<script>
  window.CAREER_OPS_SERVER = true;
  // Hide the "you're viewing a static snapshot" banner — we're in server mode.
  document.documentElement.classList.add('server-mode');
  window.applyToJob = async function(id, url) {
    const btn = document.querySelector('button[data-apply-id="' + id + '"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
    try {
      const resp = await fetch('/apply/' + id, { method: 'POST' });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Apply failed');
      // Open the original JD in a new tab
      if (url) window.open(url, '_blank', 'noopener');
      // Trigger full reload so the card re-renders with Applied state + PDF link
      setTimeout(() => location.reload(), 250);
    } catch (err) {
      alert('Apply failed: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Apply →'; }
    }
  };
  window.unapplyJob = async function(id) {
    if (!confirm('Undo apply for #' + id + '? This will revert status to Evaluated and delete the placeholder PDF.')) return;
    try {
      const resp = await fetch('/unapply/' + id, { method: 'POST' });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Unapply failed');
      setTimeout(() => location.reload(), 200);
    } catch (err) {
      alert('Undo failed: ' + err.message);
    }
  };
  window.generateResume = async function(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
    try {
      const resp = await fetch('/generate-pdf/' + id, { method: 'POST' });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Generate failed');
      setTimeout(() => location.reload(), 200);
    } catch (err) {
      alert('Generate failed: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = '📄 Generate Resume'; }
    }
  };
  window.rejectJob = async function(id) {
    const reason = prompt('Why was this rejected? (optional — leave blank if you don\\'t want to record a reason)');
    if (reason === null) return;
    try {
      const resp = await fetch('/reject/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || '' })
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Reject failed');
      setTimeout(() => location.reload(), 200);
    } catch (err) {
      alert('Mark Rejected failed: ' + err.message);
    }
  };
  window.scanForJobs = async function(btn) {
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '🔍 Scanning + evaluating…'; }
    try {
      const resp = await fetch('/scan', { method: 'POST' });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Scan failed');
      let msg = '✅ Scan complete\\n\\n' +
        'Companies scanned: ' + data.companies + '\\n' +
        'New openings: ' + data.newOffers + '\\n' +
        'Duplicates already in pipeline: ' + data.duplicates;
      if (data.evalCompleted > 0 || data.evalFailed > 0) {
        msg += '\\n\\nAuto-evaluation:\\n' +
          '  Completed: ' + data.evalCompleted + '\\n' +
          '  Failed: ' + data.evalFailed;
      }
      if (data.evalCompleted > 0) msg += '\\n\\nDashboard updated. Reloading.';
      alert(msg);
      if (data.evalCompleted > 0 || data.newOffers > 0) {
        setTimeout(() => location.reload(), 300);
      }
    } catch (err) {
      alert('Scan failed: ' + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original || '🔍 Scan for new jobs'; }
    }
  };
  window.evaluateAll = async function(btn) {
    const pendingCount = document.querySelectorAll('.card[data-tier="pending"]').length;
    if (pendingCount === 0) { alert('No pending evaluations.'); return; }
    const input = prompt('How many to evaluate? (Sonnet @ ~$0.25/eval)\\n\\nPending total: ' + pendingCount + '\\nDefault: 25', '25');
    if (input === null) return;
    const limit = Math.max(1, Math.min(500, parseInt(input, 10) || 25));
    const estCost = (limit * 0.25).toFixed(2);
    if (!confirm('Run ' + limit + ' evaluations on Sonnet?\\n\\nEstimated cost: ~$' + estCost + '\\nEstimated time: ~' + Math.ceil(limit * 180 / 6 / 60) + ' min (parallel=6)\\n\\nThis is a long-running request — keep the tab open.')) return;
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⚡ Evaluating ' + limit + '…'; }
    try {
      const resp = await fetch('/evaluate-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit })
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Eval-all failed');
      alert('✅ Done. Completed: ' + data.completed + '  Failed: ' + data.failed + '\\n\\nReloading dashboard.');
      setTimeout(() => location.reload(), 400);
    } catch (err) {
      alert('Evaluate-all failed: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = original || '⚡ Evaluate all'; }
    }
  };
  window.evaluateJob = async function(url, btn) {
    if (!url) return;
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⚡ Evaluating…'; }
    try {
      const resp = await fetch('/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || ('Eval failed (completed=' + (data.completed || 0) + ', failed=' + (data.failed || 0) + ')'));
      // Reload so the new evaluated card replaces the pending one
      setTimeout(() => location.reload(), 300);
    } catch (err) {
      alert('Evaluate failed: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = original || '⚡ Evaluate'; }
    }
  };
  window.skipJob = async function(id) {
    const reason = prompt('Why are you skipping this? (optional)');
    if (reason === null) return;
    try {
      const resp = await fetch('/skip/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || '' })
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Skip failed');
      setTimeout(() => location.reload(), 200);
    } catch (err) {
      alert('Skip failed: ' + err.message);
    }
  };
</script>`;
      // Use a function replacer so $-tokens (e.g. $' in the injected JS) are not
      // interpreted as String.replace special patterns.
      html = html.replace('</body>', () => inject + '</body>');
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
      return;
    }

    // POST /apply/:id
    if (req.method === 'POST' && url.pathname.startsWith('/apply/')) {
      const id = url.pathname.split('/').pop();
      const result = await applyToJob(id);
      await syncDb();
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /unapply/:id
    if (req.method === 'POST' && url.pathname.startsWith('/unapply/')) {
      const id = url.pathname.split('/').pop();
      const result = await unapplyJob(id);
      await syncDb();
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /generate-pdf/:id
    if (req.method === 'POST' && url.pathname.startsWith('/generate-pdf/')) {
      const id = url.pathname.split('/').pop();
      const result = await generatePdfForJob(id);
      await syncDb();
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /reject/:id — body: { reason }
    if (req.method === 'POST' && url.pathname.startsWith('/reject/')) {
      const id = url.pathname.split('/').pop();
      let body = '';
      await new Promise((res2, rej2) => {
        req.on('data', chunk => body += chunk);
        req.on('end', res2);
        req.on('error', rej2);
      });
      let reason = '';
      try { reason = (JSON.parse(body || '{}').reason || '').toString(); } catch {}
      const result = await rejectJob(id, reason);
      await syncDb();
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /scan — run scan.mjs and return summary
    if (req.method === 'POST' && url.pathname === '/scan') {
      const result = await runScan();
      await syncDb();
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /evaluate-all — body: { limit } — run auto-evaluate --limit N for all unchecked
    if (req.method === 'POST' && url.pathname === '/evaluate-all') {
      let body = '';
      await new Promise((res2, rej2) => {
        req.on('data', chunk => body += chunk);
        req.on('end', res2);
        req.on('error', rej2);
      });
      let limit = 25;
      try { limit = parseInt(JSON.parse(body || '{}').limit, 10) || 25; } catch {}
      limit = Math.max(1, Math.min(500, limit));
      try {
        const { stdout } = await execAsync(
          `node auto-evaluate.mjs --limit ${limit}`,
          { cwd: __dirname, maxBuffer: 100 * 1024 * 1024, timeout: 120 * 60 * 1000 }
        );
        const compMatch = stdout.match(/Completed:\s+(\d+)\s+Failed:\s+(\d+)/);
        const completed = compMatch ? parseInt(compMatch[1], 10) : 0;
        const failed = compMatch ? parseInt(compMatch[2], 10) : 0;
        await syncDb();
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({
          ok: true,
          completed,
          failed,
          limit,
          tail: stdout.split('\n').slice(-30).join('\n'),
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // POST /evaluate — body: { url } — run auto-evaluate --url <URL>
    if (req.method === 'POST' && url.pathname === '/evaluate') {
      let body = '';
      await new Promise((res2, rej2) => {
        req.on('data', chunk => body += chunk);
        req.on('end', res2);
        req.on('error', rej2);
      });
      let targetUrl = '';
      try { targetUrl = (JSON.parse(body || '{}').url || '').toString(); } catch {}
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: 'missing url' }));
        return;
      }
      try {
        const { stdout } = await execAsync(
          `node auto-evaluate.mjs --url ${JSON.stringify(targetUrl)}`,
          { cwd: __dirname, maxBuffer: 50 * 1024 * 1024, timeout: 10 * 60 * 1000 }
        );
        const compMatch = stdout.match(/Completed:\s+(\d+)\s+Failed:\s+(\d+)/);
        const completed = compMatch ? parseInt(compMatch[1], 10) : 0;
        const failed = compMatch ? parseInt(compMatch[2], 10) : 0;
        await syncDb();
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({
          ok: completed > 0,
          completed,
          failed,
          tail: stdout.split('\n').slice(-15).join('\n'),
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // POST /skip/:id — body: { reason }
    if (req.method === 'POST' && url.pathname.startsWith('/skip/')) {
      const id = url.pathname.split('/').pop();
      let body = '';
      await new Promise((res2, rej2) => {
        req.on('data', chunk => body += chunk);
        req.on('end', res2);
        req.on('error', rej2);
      });
      let reason = '';
      try { reason = (JSON.parse(body || '{}').reason || '').toString(); } catch {}
      const result = await skipJob(id, reason);
      await syncDb();
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /onboarding/* — wizard endpoints
    if (req.method === 'POST' && url.pathname.startsWith('/onboarding/')) {
      let body = '';
      await new Promise((res2, rej2) => {
        req.on('data', chunk => body += chunk);
        req.on('end', res2);
        req.on('error', rej2);
      });
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      const step = url.pathname.split('/').pop();
      try {
        if (step === 'cv') {
          await writeCv(payload.content);
        } else if (step === 'profile') {
          await writeProfile(payload);
        } else if (step === 'portals') {
          await writePortals(payload);
          await ensureUserProfileMd();
        } else {
          throw new Error(`Unknown onboarding step: ${step}`);
        }
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // GET /output/<filename> → serve PDF/HTML
    if (req.method === 'GET' && url.pathname.startsWith('/output/')) {
      const filePath = resolve(__dirname, '.' + url.pathname);
      if (!filePath.startsWith(resolve(__dirname, 'output'))) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      const ext = extname(filePath);
      const content = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(content);
      return;
    }

    res.writeHead(404, { 'Content-Type': MIME['.html'] });
    res.end('<h1>404 Not Found</h1>');
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Career-Ops dashboard server`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Stop with Ctrl-C`);
});
