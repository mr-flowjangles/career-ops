# Mode: dashboard — Browser Dashboard for Evaluated Jobs

Render a visual dashboard of every evaluated job so the user can scan, filter, click Apply, and track applications without reading report markdown files individually.

Two modes:
- **Static** — generate a single HTML file, open in browser. Apply button just opens the JD URL.
- **Server (interactive)** — run a local Node server. Apply button marks job as Applied, copies your CV to a company-named PDF, switches the card into the Applied tab. Recommended.

## When to use

- The user wants a visual view of evaluated jobs ("show me the jobs", "where can I see these", "I can't read markdown files").
- After running `scan` + `pipeline` to evaluate a batch — close with a dashboard refresh so the user has somewhere to act on the results.
- Whenever the user wants to apply to a job and needs the PDF generated + status tracked.

For terminal users, the Go TUI (`./dashboard/career-dashboard`) is the alternative.

## Server mode (interactive — recommended)

```bash
node dashboard-server.mjs
# or
npm run dashboard:serve
```

Listens on `http://localhost:3030` (override with `PORT=4000`). Open in your browser.

**What the Apply button does:**
1. POSTs to `/apply/:id`
2. Server marks the report's `Status: Applied`, adds `Applied: {date}`
3. Server updates the corresponding row in `data/applications.md`
4. Server copies the latest generic CV PDF to `output/cv-rob-rose-{company-slug}-{date}.pdf`
5. Server returns `{ ok, pdfPath, appliedDate }`
6. Client opens the JD URL in a new tab AND reloads the dashboard so the card moves to the Applied tab with a "📄 View tailored CV" link

**JD-tailored PDFs:** The Apply button creates a *placeholder* (a copy of your generic CV with a company-named filename). For a real JD-tailored CV — keyword injection, archetype-adapted summary, bullet reordering — ask Claude in chat: "tailor the PDF for #16". Claude rewrites the file in place; the next dashboard load picks up the change.

## Static mode

```bash
node generate-dashboard.mjs [output.html]
npm run dashboard -- [output.html]
```

Default output: `output/dashboard.html`. Apply button just opens the JD URL — no state changes, no PDF copy.

## What it does

1. Reads every `reports/*.md` file.
2. Parses each report's front-block metadata (`URL`, `Score`, `Status`, `Legitimacy`, `TL;DR`, `Arquetipo`/`Archetype`, `Remote`, `Comp`).
3. Sorts by score descending (SKIPs sink to the bottom).
4. Renders one card per job with:
   - Company + role title
   - Color-coded score badge (top / strong / maybe / weak / SKIP)
   - TL;DR + archetype + comp + remote + status + legitimacy
   - **Apply →** button that opens the original posting in a new tab
   - **View details** toggle that expands the full A-G report inline
5. Filter tabs at the top: Actionable (default), Top, Strong, Maybe, Weak, SKIP, Show all. SKIP cards are hidden on initial load by design — they're noise once decided.

## Design notes

- Single self-contained HTML file. No build step, no external dependencies, no server.
- Embedded CSS uses the same cyan / purple palette as the PDF + CV template for consistency.
- Reports are rendered as `<pre>` inside the details toggle (preserves the markdown as-is). The full A-G report is readable but not styled — point users at the PDF/DOCX of their CV separately if they need rich formatting for a specific report.

## Tier thresholds

| Tier | Score range | Notes |
|------|-------------|-------|
| ✉️ Applied | Any with `Status: Applied` / Interview / Offer | Hidden from Actionable; own tab |
| 🏆 Top | ≥ 4.5 | Apply first |
| 🟢 Strong | 4.0 - 4.4 | Apply if energy + comp align |
| 🟡 Maybe | 3.5 - 3.9 | Worth a second look, often comp- or location-blocked otherwise |
| ⚠️ Weak | < 3.5 (not SKIP) | Borderline cases |
| 🔴 SKIP | Any with `Status: SKIP` | Hidden on initial load |

Match thresholds with the Ethical Use guidance in `AGENTS.md`: discourage applying to anything below 4.0/5.

## Regenerate after every batch

After `merge-tracker.mjs` runs, regenerate the dashboard so new reports show up:

```bash
node merge-tracker.mjs && node generate-dashboard.mjs && open output/dashboard.html
```
