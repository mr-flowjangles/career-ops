# Mode: dashboard — Browser Dashboard for Evaluated Jobs

Render a single-file HTML dashboard of every evaluated job so the user can scan, filter, and click "Apply" without opening report markdown files individually.

## When to use

- The user wants a visual view of evaluated jobs ("show me the jobs", "where can I see these", "I can't read markdown files").
- After running `scan` + `pipeline` to evaluate a batch — close with a dashboard refresh so the user has somewhere to act on the results.
- Whenever a new report is added to `reports/`, offer to regenerate.

For terminal users, the Go TUI (`./dashboard/career-dashboard`) is the alternative. The HTML dashboard is friendlier for non-CLI users and supports clickable apply links.

## Run

```bash
node generate-dashboard.mjs [output.html]
# or
npm run dashboard -- [output.html]
```

Default output: `output/dashboard.html`. After generating, suggest opening:

```bash
open output/dashboard.html
```

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
