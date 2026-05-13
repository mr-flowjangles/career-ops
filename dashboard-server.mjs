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
  if (status !== 'Applied') {
    // Remove the Applied date line if reverting
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
  const pdfName = `cv-rob-rose-${slug}-${date}.pdf`;
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
  const pdfName = `cv-rob-rose-${slug}-${date}.pdf`;
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

async function unapplyJob(id) {
  const report = await findReportPath(id);
  if (!report) throw new Error(`Report not found for id ${id}`);

  await updateReportStatus(report.path, 'Evaluated');
  await updateApplicationsRow(id, 'Evaluated', '❌');

  // Remove the placeholder PDF if it exists
  const slug = slugFromReportFilename(report.filename);
  try {
    const outDir = resolve(__dirname, 'output');
    const files = await readdir(outDir);
    const matches = files.filter(f => f.startsWith(`cv-rob-rose-${slug}-`) && f.endsWith('.pdf'));
    for (const m of matches) {
      await (await import('node:fs/promises')).unlink(resolve(outDir, m));
    }
  } catch {}

  return { ok: true, id, slug, status: 'Evaluated' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // GET / → regenerate + serve dashboard
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      let html = await regenerateDashboard();
      // Inject server-mode flag and apply-button JS into the page
      const inject = `
<script>
  window.CAREER_OPS_SERVER = true;
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
</script>`;
      html = html.replace('</body>', inject + '</body>');
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
      return;
    }

    // POST /apply/:id
    if (req.method === 'POST' && url.pathname.startsWith('/apply/')) {
      const id = url.pathname.split('/').pop();
      const result = await applyToJob(id);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /unapply/:id
    if (req.method === 'POST' && url.pathname.startsWith('/unapply/')) {
      const id = url.pathname.split('/').pop();
      const result = await unapplyJob(id);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /generate-pdf/:id
    if (req.method === 'POST' && url.pathname.startsWith('/generate-pdf/')) {
      const id = url.pathname.split('/').pop();
      const result = await generatePdfForJob(id);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(result));
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
