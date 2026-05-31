/**
 * onboarding.mjs — First-run wizard for the dashboard.
 *
 * Detects missing user-layer files (cv.md, config/profile.yml, portals.yml)
 * and serves a browser wizard that collects them via a form, then writes
 * the files. The dashboard takes over once everything is in place.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CV_PATH = resolve(__dirname, 'cv.md');
const PROFILE_PATH = resolve(__dirname, 'config/profile.yml');
const PROFILE_EXAMPLE = resolve(__dirname, 'config/profile.example.yml');
const PORTALS_PATH = resolve(__dirname, 'portals.yml');
const PORTALS_EXAMPLE = resolve(__dirname, 'templates/portals.example.yml');
const USER_PROFILE_PATH = resolve(__dirname, 'modes/_profile.md');
const USER_PROFILE_TEMPLATE = resolve(__dirname, 'modes/_profile.template.md');

export function getOnboardingStatus() {
  const missing = [];
  if (!existsSync(CV_PATH)) missing.push('cv.md');
  if (!existsSync(PROFILE_PATH)) missing.push('config/profile.yml');
  if (!existsSync(PORTALS_PATH)) missing.push('portals.yml');
  return { needsOnboarding: missing.length > 0, missing };
}

export async function writeCv(content) {
  const text = (content || '').trim();
  if (!text) throw new Error('CV is empty');
  if (text.length < 50) throw new Error('CV looks too short (need at least 50 chars)');
  await writeFile(CV_PATH, text + '\n', 'utf-8');
}

function yamlString(s) {
  return JSON.stringify(String(s ?? ''));
}

export async function writeProfile(data) {
  const required = ['full_name', 'email', 'location', 'timezone'];
  for (const f of required) {
    if (!data[f] || !String(data[f]).trim()) throw new Error(`Missing required field: ${f}`);
  }

  // Roles are optional here; step 3 patches them in.
  const roles = (data.primary_roles || []).filter(r => String(r || '').trim());

  const salary = String(data.salary_target || '').trim() || '$150K-200K';
  const salaryMin = String(data.salary_min || '').trim() || '$120K';

  const yml = `# Career-Ops Profile Configuration
# Edit this file directly to update your details, or re-run onboarding.

candidate:
  full_name: ${yamlString(data.full_name)}
  email: ${yamlString(data.email)}
  phone: ${yamlString(data.phone || '')}
  location: ${yamlString(data.location)}
  linkedin: ${yamlString(data.linkedin || '')}
  portfolio_url: ${yamlString(data.portfolio_url || '')}
  github: ${yamlString(data.github || '')}

target_roles:
  primary:
${roles.map(r => `    - ${yamlString(r)}`).join('\n')}

narrative:
  headline: ${yamlString(data.headline || '')}
  exit_story: ${yamlString(data.exit_story || '')}
  superpowers: []
  proof_points: []

compensation:
  target_range: ${yamlString(salary)}
  currency: "USD"
  minimum: ${yamlString(salaryMin)}
  location_flexibility: ${yamlString(data.location_flexibility || 'Remote preferred')}

location:
  country: ${yamlString(data.country || 'United States')}
  city: ${yamlString(data.city || data.location)}
  timezone: ${yamlString(data.timezone)}
  visa_status: ${yamlString(data.visa_status || 'No sponsorship needed')}

cv:
  output_format: "html"
`;

  await mkdir(dirname(PROFILE_PATH), { recursive: true });
  await writeFile(PROFILE_PATH, yml, 'utf-8');
}

async function patchProfileRoles(roles) {
  if (!existsSync(PROFILE_PATH)) return;
  const text = await readFile(PROFILE_PATH, 'utf-8');
  const block = roles.map(r => `    - ${yamlString(r)}`).join('\n');
  const re = /(target_roles:\s*\n\s*primary:\s*\n)((?:\s{4,}-\s.+\n?)*)/;
  let updated;
  if (re.test(text)) {
    updated = text.replace(re, `$1${block}\n`);
  } else {
    updated = text + `\ntarget_roles:\n  primary:\n${block}\n`;
  }
  await writeFile(PROFILE_PATH, updated, 'utf-8');
}

export async function writePortals(data) {
  // Start from the example, then patch the title_filter.positive list with the
  // user's keywords. Everything else (companies, queries) is preserved so the
  // scanner has something to work with on day one.
  if (!existsSync(PORTALS_EXAMPLE)) {
    throw new Error('templates/portals.example.yml not found — cannot scaffold portals.yml');
  }
  let text = await readFile(PORTALS_EXAMPLE, 'utf-8');
  const keywords = (data.keywords || []).filter(k => String(k || '').trim());
  if (keywords.length > 0) {
    const block = keywords.map(k => `    - "${String(k).trim().replace(/"/g, '\\"')}"`).join('\n');
    // Replace the first positive: ... list under title_filter. The example uses
    // YAML lists indented 4 spaces under `title_filter:\n  positive:`.
    const re = /(title_filter:\s*\n\s*positive:\s*\n)((?:\s{4,}-\s.+\n)+)/;
    if (re.test(text)) {
      text = text.replace(re, `$1${block}\n`);
    }
  }
  await writeFile(PORTALS_PATH, text, 'utf-8');

  // Step 3 also owns the primary-roles list in profile.yml.
  const roles = (data.primary_roles || []).filter(r => String(r || '').trim());
  if (roles.length > 0) {
    await patchProfileRoles(roles);
  }
}

export async function ensureUserProfileMd() {
  if (existsSync(USER_PROFILE_PATH)) return;
  if (existsSync(USER_PROFILE_TEMPLATE)) {
    await copyFile(USER_PROFILE_TEMPLATE, USER_PROFILE_PATH);
  }
}

export function renderWizardHTML() {
  const status = getOnboardingStatus();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Career-Ops — Setup</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    --cyan: hsl(187, 74%, 32%);
    --purple: hsl(270, 70%, 45%);
    --text: #1a1a2e;
    --muted: #777;
    --border: #e2e2e2;
    --ok: hsl(140, 60%, 38%);
    --err: hsl(0, 70%, 50%);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #fafafa;
    color: var(--text);
    line-height: 1.5;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 {
    margin: 0 0 4px;
    font-size: 26px;
    background: linear-gradient(90deg, var(--cyan), var(--purple));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .subtitle { color: var(--muted); margin-bottom: 24px; }
  .steps {
    display: flex;
    gap: 4px;
    margin-bottom: 24px;
    font-size: 12px;
    color: var(--muted);
  }
  .step-pill {
    flex: 1;
    padding: 6px 10px;
    border-radius: 4px;
    background: #eee;
    text-align: center;
    font-weight: 600;
  }
  .step-pill.active { background: var(--cyan); color: white; }
  .step-pill.done { background: var(--ok); color: white; }
  .card {
    background: white;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 28px;
    margin-bottom: 16px;
  }
  .card h2 { margin: 0 0 4px; font-size: 18px; }
  .card .hint { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  label {
    display: block;
    font-weight: 600;
    font-size: 13px;
    margin: 14px 0 6px;
  }
  label .opt { color: var(--muted); font-weight: 400; }
  input, textarea {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 14px;
    font-family: inherit;
    background: white;
    color: var(--text);
  }
  textarea { resize: vertical; min-height: 220px; font-family: 'SF Mono', Menlo, monospace; font-size: 13px; }
  input:focus, textarea:focus { outline: none; border-color: var(--cyan); }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .actions { display: flex; gap: 8px; margin-top: 22px; }
  button {
    padding: 9px 18px;
    font-size: 14px;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s;
    font-family: inherit;
  }
  button.primary { background: var(--cyan); color: white; }
  button.primary:hover { background: hsl(187, 74%, 27%); }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: white; color: var(--text); border-color: var(--border); }
  button.secondary:hover { border-color: var(--cyan); color: var(--cyan); }
  .err { color: var(--err); font-size: 13px; margin-top: 10px; min-height: 18px; }
  .hidden { display: none; }
  .summary {
    background: hsl(140, 50%, 96%);
    border: 1px solid hsl(140, 40%, 70%);
    color: hsl(140, 60%, 22%);
    padding: 14px 16px;
    border-radius: 8px;
    margin-bottom: 20px;
    font-size: 13px;
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Welcome to Career-Ops</h1>
  <p class="subtitle">Quick setup — about 3 minutes. Your data stays on this machine.</p>

  <div class="summary">
    Missing config: ${status.missing.length === 0 ? '<em>(nothing — you can close this and go to the dashboard)</em>' : status.missing.map(m => '<code>' + m + '</code>').join(', ')}
  </div>

  <div class="steps">
    <div class="step-pill active" id="pill-1">1. CV</div>
    <div class="step-pill" id="pill-2">2. Profile</div>
    <div class="step-pill" id="pill-3">3. Targets</div>
    <div class="step-pill" id="pill-4">4. Done</div>
  </div>

  <!-- STEP 1 — CV -->
  <div class="card" id="step-1">
    <h2>Step 1 — Paste your CV</h2>
    <p class="hint">Markdown is best, but plain text works too. The system uses this as the source of truth for proof points and tailored CVs.</p>
    <textarea id="cv-content" placeholder="# Your Name&#10;&#10;## Summary&#10;...&#10;&#10;## Experience&#10;..."></textarea>
    <div class="err" id="err-1"></div>
    <div class="actions">
      <button class="primary" id="next-1">Save & continue →</button>
    </div>
  </div>

  <!-- STEP 2 — Profile -->
  <div class="card hidden" id="step-2">
    <h2>Step 2 — Your details</h2>
    <p class="hint">Used in tailored CVs, application forms, and salary negotiation. You can edit <code>config/profile.yml</code> later.</p>

    <div class="row">
      <div>
        <label>Full name</label>
        <input id="full_name" placeholder="Jane Smith" required>
      </div>
      <div>
        <label>Email</label>
        <input id="email" type="email" placeholder="jane@example.com" required>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Phone <span class="opt">(optional)</span></label>
        <input id="phone" placeholder="+1-555-0123">
      </div>
      <div>
        <label>LinkedIn <span class="opt">(optional)</span></label>
        <input id="linkedin" placeholder="linkedin.com/in/janesmith">
      </div>
    </div>

    <div class="row">
      <div>
        <label>Location (City, Region)</label>
        <input id="location" placeholder="Atlanta, GA" required>
      </div>
      <div>
        <label>Timezone</label>
        <input id="timezone" placeholder="ET" required>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Target salary range</label>
        <input id="salary_target" placeholder="$175K-225K">
      </div>
      <div>
        <label>Walk-away minimum</label>
        <input id="salary_min" placeholder="$150K">
      </div>
    </div>

    <div class="err" id="err-2"></div>
    <div class="actions">
      <button class="secondary" onclick="goStep(1)">← Back</button>
      <button class="primary" id="next-2">Save & continue →</button>
    </div>
  </div>

  <!-- STEP 3 — Portals/keywords -->
  <div class="card hidden" id="step-3">
    <h2>Step 3 — What roles are you targeting?</h2>
    <p class="hint">These keywords filter the portal scanner. One per line. The starter portals file ships with 45+ companies — you can prune it later.</p>

    <label>Target role titles (one per line)</label>
    <textarea id="primary_roles" style="min-height: 120px;" placeholder="Engineering Manager&#10;Director of Engineering&#10;Solutions Architect&#10;AI Engineering Lead"></textarea>

    <label>Title filter keywords <span class="opt">(used by scanner — defaults to your roles)</span></label>
    <textarea id="keywords" style="min-height: 80px;" placeholder="Leave blank to use your target roles"></textarea>

    <div class="err" id="err-3"></div>
    <div class="actions">
      <button class="secondary" onclick="goStep(2)">← Back</button>
      <button class="primary" id="next-3">Save & finish →</button>
    </div>
  </div>

  <!-- STEP 4 — Done -->
  <div class="card hidden" id="step-4">
    <h2>✅ You're set up</h2>
    <p class="hint">Your dashboard is ready. From here you can scan portals, evaluate jobs, and generate tailored CVs.</p>
    <p>Files written:</p>
    <ul style="font-size: 13px; color: var(--muted);">
      <li><code>cv.md</code></li>
      <li><code>config/profile.yml</code></li>
      <li><code>portals.yml</code></li>
      <li><code>modes/_profile.md</code></li>
    </ul>
    <div class="actions">
      <button class="primary" onclick="location.href='/'">Open dashboard →</button>
    </div>
  </div>
</div>

<script>
  function goStep(n) {
    for (let i = 1; i <= 4; i++) {
      const s = document.getElementById('step-' + i);
      const p = document.getElementById('pill-' + i);
      if (s) s.classList.toggle('hidden', i !== n);
      if (p) {
        p.classList.toggle('active', i === n);
        p.classList.toggle('done', i < n);
      }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function post(path, body) {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function showErr(n, msg) {
    const el = document.getElementById('err-' + n);
    if (el) el.textContent = msg || '';
  }

  document.getElementById('next-1').addEventListener('click', async (e) => {
    e.preventDefault();
    showErr(1, '');
    const content = document.getElementById('cv-content').value;
    e.target.disabled = true;
    e.target.textContent = 'Saving…';
    try {
      await post('/onboarding/cv', { content });
      goStep(2);
    } catch (err) {
      showErr(1, err.message);
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Save & continue →';
    }
  });

  document.getElementById('next-2').addEventListener('click', async (e) => {
    e.preventDefault();
    showErr(2, '');
    const payload = {
      full_name: document.getElementById('full_name').value.trim(),
      email: document.getElementById('email').value.trim(),
      phone: document.getElementById('phone').value.trim(),
      linkedin: document.getElementById('linkedin').value.trim(),
      location: document.getElementById('location').value.trim(),
      timezone: document.getElementById('timezone').value.trim(),
      salary_target: document.getElementById('salary_target').value.trim(),
      salary_min: document.getElementById('salary_min').value.trim(),
    };
    e.target.disabled = true;
    e.target.textContent = 'Saving…';
    try {
      await post('/onboarding/profile', payload);
      goStep(3);
    } catch (err) {
      showErr(2, err.message);
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Save & continue →';
    }
  });

  document.getElementById('next-3').addEventListener('click', async (e) => {
    e.preventDefault();
    showErr(3, '');
    const rolesRaw = document.getElementById('primary_roles').value;
    const keywordsRaw = document.getElementById('keywords').value;
    const primary_roles = rolesRaw.split('\\n').map(s => s.trim()).filter(Boolean);
    const keywords = (keywordsRaw.trim()
      ? keywordsRaw.split('\\n').map(s => s.trim()).filter(Boolean)
      : primary_roles);
    if (primary_roles.length === 0) { showErr(3, 'Add at least one target role.'); return; }
    e.target.disabled = true;
    e.target.textContent = 'Saving…';
    try {
      await post('/onboarding/portals', { primary_roles, keywords });
      goStep(4);
    } catch (err) {
      showErr(3, err.message);
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Save & finish →';
    }
  });
</script>
</body>
</html>`;
}
