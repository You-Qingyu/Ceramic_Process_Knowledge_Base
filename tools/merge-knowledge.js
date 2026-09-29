/**
 * 校验并把 tools/generated/*.json 草稿合并进 data/entries/*.json（只增不改）
 * 用法: node tools/merge-knowledge.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GEN_DIR = path.join(__dirname, 'generated');
const DRY = process.argv.includes('--dry');

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'categories.json'), 'utf8'));
const fileOf = {};
index.categories.forEach(c => { fileOf[c.id] = c.file; });

const loaded = {}; // file -> entries
const ids = new Set();
const titles = new Set();
for (const f of index.entryFiles) {
  const arr = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
  loaded[f] = arr;
  arr.forEach(e => { ids.add(e.id); titles.add(e.title.trim()); });
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function uniqueId(id) {
  let base = id, n = 2;
  while (ids.has(base)) base = id + '-' + (n++);
  return base;
}

const stats = { added: 0, dupTitle: 0, invalid: 0 };
const perFile = {};

const genFiles = fs.readdirSync(GEN_DIR).filter(f => f.endsWith('.json')).sort();
for (const gf of genFiles) {
  const cat = gf.replace(/\.json$/, '');
  const file = fileOf[cat];
  if (!file) { console.log('跳过 ' + gf + '（未知分类）'); continue; }
  if (!loaded[file]) loaded[file] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', file), 'utf8'));
  const arr = JSON.parse(fs.readFileSync(path.join(GEN_DIR, gf), 'utf8'));
  let added = 0;
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') { stats.invalid++; continue; }
    const title = String(raw.title || '').trim();
    const summary = String(raw.summary || '').trim();
    const content = String(raw.content || '').trim();
    if (title.length < 2 || !summary || !/##/.test(content)) { stats.invalid++; continue; }
    if (titles.has(title)) { stats.dupTitle++; continue; }
    let id = slugify(raw.id || '') || slugify(title);
    if (!id) { stats.invalid++; continue; }
    id = uniqueId(id);
    const tags = (Array.isArray(raw.tags) ? raw.tags : []).map(t => String(t).trim()).filter(Boolean).slice(0, 6);
    const sources = (Array.isArray(raw.sources) ? raw.sources : [])
      .filter(s => s && s.title && s.url)
      .map(s => ({ title: String(s.title), url: String(s.url) })).slice(0, 6);
    const entry = { id, title, category: cat, tags, summary: summary.slice(0, 200), content, sources };
    loaded[file].push(entry);
    ids.add(id);
    titles.add(title);
    stats.added++;
    added++;
  }
  perFile[file] = (perFile[file] || 0) + added;
}

console.log('\n新增 ' + stats.added + ' 条，跳过重复标题 ' + stats.dupTitle + ' 条，无效 ' + stats.invalid + ' 条');
for (const f of index.entryFiles) {
  console.log('  ' + f + ': ' + (fs.existsSync(path.join(ROOT, 'data', f)) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')).length : 0) +
    ' → ' + (DRY ? '(dry)' : loaded[f].length) + (perFile[f] ? '（+' + perFile[f] + '）' : ''));
}

if (DRY) { console.log('\n[dry-run] 未写入'); process.exit(0); }
if (!stats.added) { console.log('无可新增，退出'); process.exit(0); }

for (const f of index.entryFiles) {
  const p = path.join(ROOT, 'data', f);
  const before = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (loaded[f].length === before.length) continue;
  fs.writeFileSync(p, JSON.stringify(loaded[f], null, 2) + '\n', 'utf8');
}
const total = index.entryFiles.reduce((n, f) => n + JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')).length, 0);
console.log('\n写入完成，知识库总计 ' + total + ' 条');
