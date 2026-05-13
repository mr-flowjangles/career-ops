# Mode: docx — ATS-Optimized Word Export

Export a clean, ATS-friendly `.docx` of the CV using standard Calibri fonts, bold section headers, and bullet lists. No tables, colors, or images — maximum compatibility with applicant tracking systems and recruiter mail clients.

## When to use

- The user asks for a Word version of their CV.
- A target company or ATS requires `.docx` submission (some still reject PDF).
- A recruiter requests an editable copy.

For a tailored, visually-styled CV use `pdf` (HTML/Playwright) or `latex` (Tectonic/pdflatex) instead.

## Pipeline (generic CV)

1. Read `cv.md` as source of truth.
2. Run: `node generate-docx.mjs cv.md output/cv-{candidate}-{YYYY-MM-DD}.docx`
3. Report: output path, section count, file size.

`{candidate}` is `config/profile.yml → candidate.full_name` normalized to kebab-case lowercase (e.g. "Rob M. Rose" → "rob-rose").

## Pipeline (JD-tailored)

When tailoring to a specific posting:

1. Read `cv.md` and `config/profile.yml`.
2. Ask for the JD if not in context.
3. Extract 15-20 keywords from the JD; detect role archetype.
4. Build a tailored copy of `cv.md` at `/tmp/cv-{candidate}-{company}.md` — same content rewriting rules as `pdf` mode (rewrite the Professional Summary with JD keywords, reorder bullets by relevance, NEVER invent skills).
5. Run: `node generate-docx.mjs /tmp/cv-{candidate}-{company}.md output/cv-{candidate}-{company}-{YYYY-MM-DD}.docx`
6. Report: keyword coverage %, file size, page count estimate.

## What the script does

- Parses the CV markdown into a structured model (name, contact lines, sections, subsections, bullets, paragraphs).
- Normalizes Unicode (em-dashes, smart quotes, ellipses, non-breaking spaces) for ATS parsers — same rules as `generate-pdf.mjs`.
- Recognizes `**bold**` inline spans and emits them as bold runs.
- Outputs Calibri 11pt body, Calibri 12pt bold section headers with a thin bottom border, and standard Word bullets.
- 0.6" top/bottom margins, 0.7" left/right.

## ATS rules (kept clean for parsers)

- Single column, no sidebars, no tables for layout.
- Standard headings: "Professional Summary", "Work Experience", "Education", "Skills", "Honors", "Leadership", etc.
- No images, no SVGs, no text-in-graphics.
- No info in headers/footers (ATS parsers ignore them).
- UTF-8 text, no smart quotes or em-dashes after normalization.
- Standard fonts only — Calibri.

## Markdown structure expected

```markdown
# Candidate Name

Contact line 1 (city, email, phone)
Contact line 2 (linkedin, portfolio)

## Section Title

Optional section-level paragraph.

- Bullet under the section (used for Core Accomplishments).

### Subsection (job title or degree)
**Date range or location**

Optional intro paragraph for this entry.

- Bullet for this entry.
- Another bullet.
```

The parser is deliberately strict — keep `cv.md` aligned with this shape. If a heading is missed or a bullet is malformed, the renderer will still produce output but may put text in the wrong block.

## Output

- File: `output/cv-{candidate}-{company?}-{YYYY-MM-DD}.docx`
- Format: `.docx` (Office Open XML) — opens cleanly in Word, Pages, Google Docs, LibreOffice.
- Typical size: 10-20 KB.
