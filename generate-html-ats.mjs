#!/usr/bin/env node

/**
 * generate-html-ats.mjs — ATS-clean HTML variant of the CV.
 *
 * Produces a parser-friendly HTML rendering optimized for ATS systems
 * (Greenhouse, Lever, Ashby, Workable, iCIMS). Differences vs.
 * generate-html.mjs:
 *   - System fonts only (Helvetica, Arial) — no custom @font-face
 *   - Pure black text — no colored accents
 *   - Plain section headers — bold + uppercase, no gradient bar
 *   - Single column, no flex layout for job-header (parser-safer)
 *   - Standard section names ("Professional Summary", "Work Experience",
 *     "Education", "Skills") so parsers recognize them
 *
 * Both styles share the same cv-parser.mjs so wording is identical.
 *
 * Usage:
 *   node generate-html-ats.mjs <input.md> <output.html>
 *   import { buildATSHTML } from './generate-html-ats.mjs'
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseMarkdown, inlineSegments, parseContact } from './cv-parser.mjs';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineHTML(text) {
  return inlineSegments(text)
    .map(seg => seg.bold ? `<strong>${esc(seg.text)}</strong>` : esc(seg.text))
    .join('');
}

function renderContact(contact) {
  const c = parseContact(contact);
  const parts = [];
  if (c.location) parts.push(esc(c.location));
  if (c.email) parts.push(esc(c.email));
  if (c.phone) parts.push(esc(c.phone));
  for (const link of c.links) {
    parts.push(`<a href="${esc(link.url)}">${esc(link.display)}</a>`);
  }
  return parts.join(' &middot; ');
}

function renderSubsection(s) {
  const bullets = s.bullets.map(b => `<li>${inlineHTML(b)}</li>`).join('\n      ');
  return `
  <div class="job">
    <div class="job-line">
      <span class="job-company">${inlineHTML(s.heading)}</span>${s.meta ? ` &mdash; <span class="job-period">${esc(s.meta)}</span>` : ''}
    </div>
    ${s.intro ? `<p class="job-intro">${inlineHTML(s.intro)}</p>` : ''}
    ${s.bullets.length ? `<ul>\n      ${bullets}\n    </ul>` : ''}
  </div>`;
}

function renderSection(section) {
  const parts = [`  <h2 class="section-title">${esc(section.title)}</h2>`];
  for (const block of section.blocks) {
    if (block.type === 'sub') parts.push(renderSubsection(block.data));
    else if (block.type === 'bullet') parts.push(`  <ul class="section-list"><li>${inlineHTML(block.text)}</li></ul>`);
    else if (block.type === 'paragraph') parts.push(`  <p>${inlineHTML(block.text)}</p>`);
  }
  return `<section>\n${parts.join('\n')}\n</section>`;
}

function compactBullets(html) {
  return html.replace(
    /(<ul class="section-list"><li>[^]*?<\/li><\/ul>\s*)+/g,
    (match) => {
      const items = [...match.matchAll(/<ul class="section-list"><li>([^]*?)<\/li><\/ul>/g)]
        .map(m => `<li>${m[1]}</li>`)
        .join('\n      ');
      return `  <ul class="section-list">\n      ${items}\n    </ul>\n`;
    }
  );
}

export function buildATSHTML(doc) {
  const contactHTML = renderContact(doc.contact);
  const sectionsHTML = compactBullets(doc.sections.map(renderSection).join('\n\n'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(doc.name)} - Resume</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.45;
    color: #000000;
    background: #ffffff;
    padding: 0;
  }
  .page {
    width: 100%;
    max-width: 8.5in;
    margin: 0 auto;
  }
  header.candidate {
    text-align: left;
    margin-bottom: 14pt;
  }
  header.candidate h1 {
    font-size: 22pt;
    font-weight: 700;
    color: #000;
    margin-bottom: 4pt;
    letter-spacing: 0;
  }
  header.candidate .contact {
    font-size: 10.5pt;
    color: #000;
  }
  header.candidate .contact a {
    color: #000;
    text-decoration: none;
    white-space: nowrap;
  }
  section { margin-bottom: 10pt; }
  h2.section-title {
    font-size: 12pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #000;
    border-bottom: 1pt solid #000;
    padding-bottom: 2pt;
    margin: 10pt 0 6pt;
    break-after: avoid;
    page-break-after: avoid;
  }
  p { font-size: 11pt; margin-bottom: 6pt; }
  ul { padding-left: 18pt; margin-top: 4pt; margin-bottom: 6pt; }
  li { font-size: 11pt; line-height: 1.4; margin-bottom: 3pt; }
  .job { margin-bottom: 8pt; break-inside: avoid-page; page-break-inside: avoid; }
  .job-line {
    font-size: 11pt;
    font-weight: 700;
    color: #000;
    margin-bottom: 2pt;
  }
  .job-period {
    font-weight: 400;
  }
  .job-intro {
    font-size: 11pt;
    margin-bottom: 4pt;
  }
  .section-list { padding-left: 18pt; }
  .section-list li { font-size: 11pt; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { padding: 0; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="candidate">
    <h1>${esc(doc.name)}</h1>
    <div class="contact">${contactHTML}</div>
  </header>

  ${sectionsHTML}
</div>
</body>
</html>
`;
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args[0];
  const outputPath = args[1];

  if (!inputPath || !outputPath) {
    console.error('Usage: node generate-html-ats.mjs <input.md> <output.html>');
    process.exit(1);
  }

  const md = await readFile(resolve(inputPath), 'utf-8');
  const model = parseMarkdown(md);
  if (!model.name) {
    console.error('No # Name heading found in markdown input.');
    process.exit(1);
  }

  const html = buildATSHTML(model);
  await writeFile(resolve(outputPath), html);
  console.log(`ATS HTML written: ${outputPath} (${model.sections.length} sections)`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error('ATS HTML generation failed:', err.message);
    process.exit(1);
  });
}
