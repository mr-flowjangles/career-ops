#!/usr/bin/env node

/**
 * generate-html.mjs — Markdown CV to styled HTML for the PDF pipeline.
 *
 * Usage:
 *   node generate-html.mjs <input.md> <output.html>
 *
 * Reads cv.md, parses it (shared parser with generate-docx.mjs), and emits
 * a single self-contained HTML file styled to match templates/cv-template.html.
 * generate-pdf.mjs then renders this HTML to PDF.
 *
 * Both PDF and DOCX consume cv.md through cv-parser.mjs so the wording in
 * each output is guaranteed identical.
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseMarkdown, inlineSegments, parseContact } from './cv-parser.mjs';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineHTML(text) {
  return inlineSegments(text)
    .map(seg => seg.bold ? `<strong>${esc(seg.text)}</strong>` : esc(seg.text))
    .join('');
}

function renderContact(contact) {
  const c = parseContact(contact);
  const parts = [];
  if (c.phone) parts.push(`<span>${esc(c.phone)}</span>`);
  if (c.email) parts.push(`<span>${esc(c.email)}</span>`);
  for (const link of c.links) {
    parts.push(`<a href="${esc(link.url)}">${esc(link.display)}</a>`);
  }
  if (c.location) parts.push(`<span>${esc(c.location)}</span>`);
  return parts.join('<span class="separator">|</span>');
}

function renderSubsection(s) {
  const bullets = s.bullets.map(b => `<li>${inlineHTML(b)}</li>`).join('\n        ');
  const meta = s.meta ? `<span class="job-period">${esc(s.meta)}</span>` : '';
  const intro = s.intro ? `<div class="job-intro">${inlineHTML(s.intro)}</div>` : '';
  const ul = s.bullets.length ? `<ul>\n        ${bullets}\n      </ul>` : '';
  return `
    <div class="job">
      <div class="job-header">
        <span class="job-company">${inlineHTML(s.heading)}</span>
        ${meta}
      </div>
      ${intro}
      ${ul}
    </div>`;
}

function renderSection(section) {
  const parts = [`    <div class="section-title">${esc(section.title)}</div>`];
  for (const block of section.blocks) {
    if (block.type === 'sub') {
      parts.push(renderSubsection(block.data));
    } else if (block.type === 'bullet') {
      // Stand-alone bullets at section scope (e.g. Skills, Honors)
      parts.push(`    <ul class="section-list"><li>${inlineHTML(block.text)}</li></ul>`);
    } else if (block.type === 'paragraph') {
      parts.push(`    <p class="section-text">${inlineHTML(block.text)}</p>`);
    }
  }
  return `  <div class="section">\n${parts.join('\n')}\n  </div>`;
}

// Merge consecutive bullets at section scope into a single <ul>
function compactBullets(html) {
  return html.replace(
    /(<ul class="section-list"><li>[^]*?<\/li><\/ul>\s*)+/g,
    (match) => {
      const items = [...match.matchAll(/<ul class="section-list"><li>([^]*?)<\/li><\/ul>/g)]
        .map(m => `<li>${m[1]}</li>`)
        .join('\n      ');
      return `    <ul class="section-list">\n      ${items}\n    </ul>\n`;
    }
  );
}

export function buildHTML(doc) {
  const contactHTML = renderContact(doc.contact);
  const sectionsHTML = compactBullets(doc.sections.map(renderSection).join('\n\n'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(doc.name)} - CV</title>
<style>
  @font-face {
    font-family: 'Space Grotesk';
    src: url('./fonts/space-grotesk-latin.woff2') format('woff2');
    font-weight: 300 700;
    font-style: normal;
    font-display: swap;
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face {
    font-family: 'DM Sans';
    src: url('./fonts/dm-sans-latin.woff2') format('woff2');
    font-weight: 100 1000;
    font-style: normal;
    font-display: swap;
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'DM Sans', sans-serif;
    font-size: 11px;
    line-height: 1.5;
    color: #1a1a2e;
    background: #ffffff;
  }
  .page { width: 100%; max-width: 8.5in; margin: 0 auto; padding: 2px 0; }

  .header { margin-bottom: 14px; }
  .header h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 28px;
    font-weight: 700;
    color: #1a1a2e;
    letter-spacing: -0.02em;
    margin-bottom: 6px;
    line-height: 1.1;
  }
  .header-gradient {
    height: 2px;
    background: linear-gradient(to right, hsl(187, 74%, 32%), hsl(270, 70%, 45%));
    border-radius: 1px;
    margin-bottom: 10px;
  }
  .contact-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    font-family: 'DM Sans', sans-serif;
    font-size: 10.5px;
    line-height: 1.4;
    color: #555;
  }
  .contact-row a { color: #555; text-decoration: none; white-space: nowrap; }
  .contact-row .separator { color: #ccc; }

  .section { margin-bottom: 12px; }
  .section-title {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: hsl(187, 74%, 32%);
    border-bottom: 1.5px solid #e2e2e2;
    padding-bottom: 4px;
    margin-bottom: 10px;
    line-height: 1.2;
  }

  .section-text {
    font-size: 11px;
    line-height: 1.6;
    color: #2f2f2f;
    margin-bottom: 8px;
  }
  .section-list {
    padding-left: 18px;
    margin-bottom: 8px;
  }
  .section-list li {
    font-size: 10.5px;
    line-height: 1.55;
    color: #333;
    margin-bottom: 4px;
  }

  .job { margin-bottom: 10px; }
  .job-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 4px;
  }
  .job-company {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 12.5px;
    font-weight: 600;
    color: hsl(270, 70%, 45%);
  }
  .job-period { font-size: 10.5px; color: #777; white-space: nowrap; }
  .job-intro { font-size: 10.5px; color: #444; margin-bottom: 6px; line-height: 1.55; }
  .job ul { padding-left: 18px; margin-top: 6px; }
  .job li {
    font-size: 10.5px;
    line-height: 1.6;
    color: #333;
    margin-bottom: 4px;
  }
  .job li strong { font-weight: 600; }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { padding: 0; }
  }

  .avoid-break, .edu-item {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .job-header, .job-intro { break-after: avoid; page-break-after: avoid; }
</style>
</head>
<body>
<div class="page">

  <div class="header avoid-break">
    <h1>${esc(doc.name)}</h1>
    <div class="header-gradient"></div>
    <div class="contact-row">
      ${contactHTML}
    </div>
  </div>

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
    console.error('Usage: node generate-html.mjs <input.md> <output.html>');
    process.exit(1);
  }

  const absIn = resolve(inputPath);
  const absOut = resolve(outputPath);

  const md = await readFile(absIn, 'utf-8');
  const model = parseMarkdown(md);
  if (!model.name) {
    console.error('No # Name heading found in the markdown. Aborting.');
    process.exit(1);
  }

  const html = buildHTML(model);
  await writeFile(absOut, html);
  console.log(`HTML written: ${absOut} (${model.sections.length} sections)`);
}

// Only run main() when this file is invoked directly, not when imported.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('HTML generation failed:', err.message);
    process.exit(1);
  });
}
