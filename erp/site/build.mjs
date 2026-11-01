// Builds the public website (B7a) into site/dist. No dependencies; Node 22.
//   node site/build.mjs            draft: empty fields show as "[to be filled: …]" and every page says "Draft"
//   node site/build.mjs --release  refuses to build while a required field in site.config.json is empty
// Templates use {{key}} (HTML-escaped; dotted paths like {{plans.store.name}}), {{#if key}}…{{/if}} and
// {{#unless key}}…{{/unless}} (not nested). An unknown key stops the build.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'src');
const out = join(here, 'dist');
const release = process.argv.includes('--release');

// Fields a published site must have: who you are, where you are, how to reach you (Contact page, policies, IT Rules
// grievance officer). gstin and addressLine2 are optional; lines that use them disappear when empty.
const REQUIRED = ['domain', 'appUrl', 'signupUrl', 'loginUrl', 'supportEmail', 'whatsappNumber', 'whatsappDisplay',
  'legalName', 'legalForm', 'addressLine1', 'city', 'state', 'pin', 'grievanceOfficerName', 'grievanceEmail',
  'effectiveDate', 'jurisdictionCity'];

const config = JSON.parse(readFileSync(join(here, 'site.config.json'), 'utf8'));
const empty = REQUIRED.filter((k) => String(config[k] ?? '').trim() === '');
if (release && empty.length) {
  console.error(`site.config.json: fill these before a release build:\n  ${empty.join('\n  ')}`);
  process.exit(1);
}
if (config.whatsappNumber && !/^\d{10,15}$/.test(config.whatsappNumber)) {
  console.error('site.config.json: whatsappNumber is digits only, with the country code (e.g. 91 and the number)');
  process.exit(1);
}

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
const ctx = {
  ...config,
  year: String(new Date().getFullYear()),
  whatsappLink: config.whatsappNumber ? `https://wa.me/${config.whatsappNumber}` : '',
  plans: Object.fromEntries(Object.entries(config.plans).map(([id, p]) => [id, {
    ...p, priceMonthText: rupees(p.priceMonth), priceYearText: rupees(p.priceYear),
    yearSavingText: rupees(p.priceMonth * 12 - p.priceYear),
  }])),
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lookup = (key, file) => {
  let v = ctx;
  for (const part of key.split('.')) {
    if (v === null || typeof v !== 'object' || !(part in v)) throw new Error(`${file}: unknown placeholder {{${key}}}`);
    v = v[part];
  }
  return v;
};
const truthy = (v) => v !== false && v !== null && v !== undefined && String(v).trim() !== '';

function render(text, file, raw = {}) {
  text = text.replace(/\{\{#(if|unless) ([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, kind, key, body) =>
    (truthy(lookup(key, file)) === (kind === 'if') ? body : ''));
  return text.replace(/\{\{([\w.]+)\}\}/g, (_m, key, offset, whole) => {
    if (key in raw) return raw[key];
    const v = lookup(key, file);
    if (typeof v === 'object') throw new Error(`${file}: {{${key}}} is not a single value`);
    if (truthy(v)) return esc(v);
    if (!REQUIRED.includes(key)) return '';
    const before = whole.slice(0, offset);
    const insideTag = before.lastIndexOf('<') > before.lastIndexOf('>');
    return insideTag ? esc(`[to be filled: ${key}]`) : `<mark class="todo">[to be filled: ${key}]</mark>`;
  });
}

function meta(text, file) {
  const m = /^\s*<!--\s*title:\s*(.*?);\s*(?:summary|description):\s*(.*?)\s*-->\s*/s.exec(text);
  if (!m) throw new Error(`${file}: must start with <!-- title: …; summary: … -->`);
  return { title: m[1].trim(), summary: m[2].trim(), body: text.slice(m[0].length) };
}

const layout = readFileSync(join(src, 'layout.html'), 'utf8');
const draftBanner = release ? ''
  : '<div class="draft-banner" role="note">Draft: not for publishing. Fill site.config.json and build with --release.</div>';
const lawyerBox = config.lawyerReviewed ? ''
  : '<aside class="lawyer-box" role="note"><strong>Draft for review by a lawyer. Not legal advice.</strong> This text is a starting point. Have it checked for your business before you rely on it.</aside>';

function page(file, relOut, root, extraRaw = {}) {
  const { title, summary, body } = meta(readFileSync(file, 'utf8'), file);
  const content = render(body, file, { lawyerBox, root, ...extraRaw });
  const html = render(layout, 'layout.html', { content, draftBanner, root, pageTitle: esc(title), pageDescription: esc(summary) });
  const dest = join(out, relOut);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
  return { title, summary };
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Help articles first, so the help index can list them.
const helpDir = join(src, 'help');
const articles = readdirSync(helpDir).filter((f) => f.endsWith('.html') && f !== 'index.html').sort()
  .map((f) => ({ slug: f, ...page(join(helpDir, f), join('help', f), '../') }));
const articleList = `<ol class="article-list">${articles.map((a) =>
  `<li><a href="${esc(a.slug)}">${esc(a.title)}</a><p>${esc(a.summary)}</p></li>`).join('')}</ol>`;
page(join(helpDir, 'index.html'), join('help', 'index.html'), '../', { articleList });

for (const f of readdirSync(join(src, 'pages')).filter((f) => f.endsWith('.html'))) page(join(src, 'pages', f), f, '');

cpSync(join(src, 'assets'), join(out, 'assets'), { recursive: true });
if (existsSync(join(src, '_headers'))) cpSync(join(src, '_headers'), join(out, '_headers'));

console.log(`${release ? 'release' : 'draft'} build: ${articles.length} help articles, site/dist ready` +
  (empty.length && !release ? ` (to fill: ${empty.join(', ')})` : ''));
