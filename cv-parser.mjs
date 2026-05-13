/**
 * cv-parser.mjs — Shared Markdown CV parser.
 *
 * Used by generate-docx.mjs and generate-pdf.mjs to ensure both outputs
 * derive from the same parse of cv.md and never drift in wording.
 */

export function sanitize(text) {
  if (!text) return text;
  return text
    .replace(/—/g, '-')
    .replace(/–/g, '-')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/…/g, '...')
    .replace(/[​‌‍⁠﻿]/g, '')
    .replace(/ /g, ' ');
}

/**
 * Parse a CV in markdown form into a structured model.
 *
 * Recognised structure:
 *   # Name
 *   contact line 1
 *   contact line 2
 *
 *   ## Section
 *   Optional section paragraph(s).
 *   - bullet
 *
 *   ### Subsection
 *   **meta line (date range, etc.)**
 *   Optional intro paragraph.
 *   - bullet
 *
 * The header (name + contact lines) runs until the first `## Section`.
 */
export function parseMarkdown(md) {
  const lines = md.split('\n');
  const doc = { name: '', contact: [], sections: [] };
  let section = null;
  let sub = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('# ') && !doc.name) {
      doc.name = sanitize(line.slice(2).trim());
      continue;
    }

    if (line.startsWith('## ')) {
      section = { title: sanitize(line.slice(3).trim()), blocks: [] };
      sub = null;
      doc.sections.push(section);
      continue;
    }

    if (line.startsWith('### ')) {
      sub = { heading: sanitize(line.slice(4).trim()), meta: '', intro: '', bullets: [] };
      if (section) section.blocks.push({ type: 'sub', data: sub });
      continue;
    }

    // Header (lines after the name, before the first ## section)
    if (doc.name && !section) {
      doc.contact.push(sanitize(line));
      continue;
    }

    if (line.startsWith('- ')) {
      const text = line.slice(2).trim();
      if (sub) sub.bullets.push(text);
      else if (section) section.blocks.push({ type: 'bullet', text });
      continue;
    }

    if (sub && !sub.meta && /^\*\*.+\*\*$/.test(line)) {
      sub.meta = sanitize(line.slice(2, -2));
      continue;
    }

    if (sub && !sub.intro) {
      sub.intro = line;
    } else if (section) {
      section.blocks.push({ type: 'paragraph', text: line });
    }
  }

  return doc;
}

/**
 * Split inline markdown (just **bold** spans) into segments.
 * Returns [{ text, bold }, ...] for renderers to map to their own runs.
 */
export function inlineSegments(text) {
  const clean = sanitize(text);
  const out = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(clean)) !== null) {
    if (m.index > last) out.push({ text: clean.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < clean.length) out.push({ text: clean.slice(last), bold: false });
  return out.length ? out : [{ text: clean, bold: false }];
}

/**
 * Parse the contact lines into a structured object.
 * Each contact line is " · "-separated. We bucket items by shape:
 *   - email-looking
 *   - phone-looking
 *   - URL/host with a slash
 *   - everything else (location, etc.)
 */
export function parseContact(contactLines) {
  const out = { location: '', email: '', phone: '', links: [] };
  const joined = contactLines.join(' · ');
  const parts = joined.split(/\s+[·|]\s+/).map(s => s.trim()).filter(Boolean);

  for (const p of parts) {
    if (/@/.test(p) && /\./.test(p)) { out.email = out.email || p; continue; }
    if (/^[+\d][\d\s().-]+$/.test(p)) { out.phone = out.phone || p; continue; }
    if (/\//.test(p) || /^https?:\/\//i.test(p)) {
      const url = /^https?:\/\//i.test(p) ? p : `https://${p}`;
      const display = p.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      out.links.push({ url, display });
      continue;
    }
    out.location = out.location || p;
  }
  return out;
}
