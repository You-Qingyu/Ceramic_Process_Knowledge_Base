/**
 * 陶瓷工艺知识库 - 本地服务端（静态站 + 知识库接口 + 账号/投稿/审核）
 * 用法: node server.js  (默认 http://localhost:3000)
 * 不预创建任何账号；账号数据存 data/runtime/users.json（本地，不入库）。
 * 管理员由使用者在本地把该用户 role 改为 admin 后重启生效。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const RUNTIME_DIR = path.join(DATA, 'runtime');
const USERS_FILE = path.join(RUNTIME_DIR, 'users.json');
const SUBS_FILE = path.join(RUNTIME_DIR, 'submissions.json');
const CATS_FILE = path.join(DATA, 'categories.json');
const FORUM_FILE = path.join(RUNTIME_DIR, 'forum.json');
const AI_CONFIG_FILE = path.join(ROOT, 'ai.config.json');
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ---------- 基础工具 ---------- */
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj));
}

function sendError(res, code, msg) {
  sendJSON(res, code, { ok: false, error: msg });
}

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function loadKB() {
  const index = readJSON(CATS_FILE, { meta: {}, categories: [], entryFiles: [] });
  const entries = [];
  for (const file of index.entryFiles) {
    const arr = readJSON(path.join(DATA, file), []);
    entries.push(...arr);
  }
  index.meta.total = entries.length;
  const counts = {};
  for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
  return { meta: index.meta, categories: index.categories, counts, entries };
}

/* ---------- 账号 ---------- */
const sessions = new Map(); // token -> { username, role, exp }

function hashPwd(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function verifyPwd(password, salt, hash) {
  const h = crypto.scryptSync(String(password), salt, 64);
  const b = Buffer.from(String(hash), 'hex');
  return b.length === h.length && crypto.timingSafeEqual(b, h);
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, contributions: u.contributions || 0 };
}

function loadUsers() {
  const users = readJSON(USERS_FILE, null);
  return Array.isArray(users) ? users : [];
}

function saveUsers(users) { writeJSON(USERS_FILE, users); }

function findUser(users, username) {
  return users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, role: user.role, exp: Date.now() + SESSION_TTL });
  return token;
}

function currentUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-token'] || '');
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  const users = loadUsers();
  const user = findUser(users, s.username);
  return user || null;
}

/* ---------- 校验 ---------- */
const USER_RE = /^[\w一-龥.\-]{2,20}$/;

function validateUsername(name) {
  if (!USER_RE.test(String(name || ''))) return '用户名需 2-20 位，限中文/字母/数字/. _ -';
  return null;
}

function validatePassword(pwd) {
  if (String(pwd || '').length < 6) return '密码至少 6 位';
  if (String(pwd || '').length > 72) return '密码过长';
  return null;
}

function validateSubmission(body, categories) {
  const title = String(body.title || '').trim();
  const summary = String(body.summary || '').trim();
  const content = String(body.content || '').trim();
  const category = String(body.category || '').trim();
  const tags = Array.isArray(body.tags) ? body.tags.map(t => String(t).trim()).filter(Boolean) : [];

  if (title.length < 2 || title.length > 80) return '标题需 2-80 字';
  if (!categories.some(c => c.id === category)) return '分类不存在';
  if (!summary || summary.length > 200) return '摘要需 1-200 字';
  if (content.length < 20 || content.length > 8000) return '正文需 20-8000 字';
  if (tags.length > 8) return '标签最多 8 个';

  let sources = [];
  if (body.sources) {
    if (!Array.isArray(body.sources)) return '来源格式错误';
    sources = body.sources
      .filter(s => s && typeof s === 'object')
      .map(s => ({ title: String(s.title || '').slice(0, 100), url: String(s.url || '').slice(0, 300) }))
      .filter(s => s.title && s.url);
    if (sources.length > 6) return '来源最多 6 条';
  }
  return { title, summary, content, category, tags, sources };
}

function slugify(title) {
  const s = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length >= 3) return s.slice(0, 60);
  // 中文标题没有 ASCII 可用时，用内容哈希生成稳定 id
  const hash = crypto.createHash('sha1').update(String(title)).digest('hex').slice(0, 8);
  return 'entry-' + hash;
}

function uniqueEntryId(arr, title) {
  const base = slugify(title);
  let id = base;
  let n = 2;
  while (arr.some(e => e.id === id)) id = base + '-' + n++;
  return id;
}

function loadSubmissions() {
  const list = readJSON(SUBS_FILE, []);
  return Array.isArray(list) ? list : [];
}

function saveSubmissions(list) { writeJSON(SUBS_FILE, list); }

function canView(user, sub) {
  return user.role === 'admin' || sub.authorId === user.id;
}

/* ---------- 论坛 ---------- */
function loadForum() {
  const d = readJSON(FORUM_FILE, null);
  if (!d || typeof d !== 'object') return { threads: [], comments: [], reports: [] };
  return {
    threads: Array.isArray(d.threads) ? d.threads : [],
    comments: Array.isArray(d.comments) ? d.comments : [],
    reports: Array.isArray(d.reports) ? d.reports : []
  };
}

function saveForum(d) { writeJSON(FORUM_FILE, d); }

/* 改昵称：同步所有署名字段（昵称全局唯一，按旧名匹配即可） */
function renameUserRecords(oldName, newName) {
  const forum = loadForum();
  let fChanged = false;
  forum.threads.forEach(t => {
    if (t.author === oldName) { t.author = newName; fChanged = true; }
    if (t.deletedBy === oldName) { t.deletedBy = newName; fChanged = true; }
  });
  forum.comments.forEach(c => { if (c.author === oldName) { c.author = newName; fChanged = true; } });
  forum.reports.forEach(r => { if (r.reporter === oldName) { r.reporter = newName; fChanged = true; } });
  if (fChanged) saveForum(forum);

  const subs = loadSubmissions();
  let sChanged = false;
  subs.forEach(s => { if (s.author === oldName) { s.author = newName; sChanged = true; } });
  if (sChanged) saveSubmissions(subs);

  const cats = readJSON(CATS_FILE, { entryFiles: [] });
  const files = Array.from(new Set((cats.entryFiles || []).concat(
    (cats.categories || []).map(c => c.file).filter(Boolean)
  )));
  files.forEach(f => {
    const file = path.join(DATA, f);
    const arr = readJSON(file, []);
    if (!Array.isArray(arr)) return;
    let changed = false;
    arr.forEach(e => { if (e.contributor === oldName) { e.contributor = newName; changed = true; } });
    if (changed) writeJSON(file, arr);
  });
}

function pendingReportCount(forum) {
  return forum.reports.filter(r => r.status === 'pending').length;
}

function commentCountOf(forum, threadId) {
  return forum.comments.filter(c => c.threadId === threadId && c.status !== 'deleted').length;
}

function threadView(t, forum, user) {
  return {
    id: t.id,
    title: t.title,
    content: t.content,
    author: t.author,
    createdAt: t.createdAt,
    likes: (t.likes || []).length,
    liked: !!(user && (t.likes || []).indexOf(user.id) >= 0),
    commentCount: commentCountOf(forum, t.id),
    status: t.status || 'visible'
  };
}

function commentView(c) {
  return { id: c.id, threadId: c.threadId, content: c.content, author: c.author, createdAt: c.createdAt };
}

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/* ---------- AI 智能客服 ---------- */
function defaultAIConfig() {
  return {
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    temperature: 0.4,
    maxTokens: 900,
    systemPrompt: ''
  };
}

function aiConfig() {
  const file = Object.assign(defaultAIConfig(), readJSON(AI_CONFIG_FILE, {}));
  return {
    apiKey: process.env.AI_API_KEY || file.apiKey || '',
    baseUrl: String(process.env.AI_BASE_URL || file.baseUrl || '').replace(/\/+$/, ''),
    model: process.env.AI_MODEL || file.model || '',
    temperature: Number(process.env.AI_TEMPERATURE || file.temperature) || 0.4,
    maxTokens: Number(process.env.AI_MAX_TOKENS || file.maxTokens) || 900,
    systemPrompt: file.systemPrompt || ''
  };
}

function aiReady(cfg) {
  return !!(cfg.apiKey && cfg.baseUrl && cfg.model);
}

const chatHits = new Map();
function rateOk(key, limit, windowMs) {
  const now = Date.now();
  const arr = (chatHits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { chatHits.set(key, arr); return false; }
  arr.push(now);
  chatHits.set(key, arr);
  return true;
}

function ngrams(str) {
  const runs = String(str || '').toLowerCase().match(/[一-龥]+|[a-z0-9]+/g) || [];
  const set = new Set();
  for (const r of runs) {
    if (r.length === 1) { set.add(r); continue; }
    for (let i = 0; i < r.length - 1; i++) set.add(r.slice(i, i + 2));
  }
  return Array.from(set);
}

function searchKB(kw, limit) {
  const question = String(kw || '').toLowerCase();
  const grams = ngrams(question);
  if (!grams.length) return [];
  const kb = loadKB();
  const scored = kb.entries.map(e => {
    const title = String(e.title || '').toLowerCase();
    const tags = (e.tags || []).join(' ').toLowerCase();
    const summary = String(e.summary || '').toLowerCase();
    const content = String(e.content || '').toLowerCase();
    let s = 0;
    for (const g of grams) {
      if (title.indexOf(g) >= 0) s += 3;
      if (tags.indexOf(g) >= 0) s += 2;
      if (summary.indexOf(g) >= 0) s += 1.5;
      if (content.indexOf(g) >= 0) s += 0.5;
    }
    return { e, s };
  })
    .filter(x => x.s >= 2)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  return scored.map(x => x.e);
}

function buildSystemPrompt(cfg, question, sources) {
  const custom = cfg.systemPrompt
    ? cfg.systemPrompt + '\n\n'
    : '';
  let kb = '';
  if (sources.length) {
    kb = '【知识库资料】回答时优先依据以下站内条目：\n' +
      sources.map((e, i) => {
        const body = String(e.content || '').replace(/\n{3,}/g, '\n').slice(0, 700);
        return (i + 1) + '. 《' + e.title + '》（分类：' + e.category + '）\n' +
          '   摘要：' + (e.summary || '') + '\n' +
          '   正文节选：' + body;
      }).join('\n\n') + '\n\n';
  } else {
    kb = '【知识库资料】本次未在知识库中找到明显相关条目。\n\n';
  }
  return custom +
    '你是「陶瓷工艺知识库」网站的智能客服，用简体中文友好、简洁地回答用户关于陶瓷工艺的问题。\n' +
    '规则：\n' +
    '1. 只依据下方知识库资料回答；资料不足时明确说明"知识库暂无相关资料"，可给一般性常识并建议用户在站内搜索。\n' +
    '2. 不要编造具体数据（温度、配比、年代等），不确定就直说。\n' +
    '3. 回答控制在 200 字以内，可用 Markdown 列表。\n' +
    '4. 用户闲聊时简短回应并引导回陶瓷工艺话题。\n\n' +
    kb + '【本次用户问题】' + question;
}

async function callAI(cfg, messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens
      }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('AI 接口错误 ' + res.status + '：' + text.slice(0, 200));
    }
    const data = await res.json();
    const answer = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (!answer) throw new Error('AI 返回格式异常');
    return String(answer).trim();
  } finally {
    clearTimeout(timer);
  }
}

function fallbackAnswer(sources) {
  if (!sources.length) {
    return '我暂时无法作答：知识库中没有找到相关资料。\n\n' +
      '可以换个关键词（如「还原焰」「青花」「龙窑」「针孔」）在站内搜索，或换个问法再试试。';
  }
  return '**AI 接口尚未配置**（在项目根目录 `ai.config.json` 填入 apiKey 即可启用），先按知识库为你找到这些相关内容：\n\n' +
    sources.map((e, i) => (i + 1) + '. **《' + e.title + '》** — ' + (e.summary || '')).join('\n') +
    '\n\n点击下方"参考"里的条目查看完整内容。';
}

/* ---------- 审核通过：写入知识库 ---------- */
function approveSubmission(sub, reviewer) {
  const cats = readJSON(CATS_FILE, { categories: [], entryFiles: [] });
  const cat = cats.categories.find(c => c.id === sub.category);
  let rel = cat && cat.file;
  if (!rel) {
    // 回退：找到包含该分类条目的数据文件
    rel = cats.entryFiles.find(f => {
      const arr = readJSON(path.join(DATA, f), []);
      return arr.some(e => e.category === sub.category);
    });
  }
  if (!rel) throw new Error('找不到该分类的数据文件');

  const file = path.join(DATA, rel);
  const arr = readJSON(file, []);
  const id = uniqueEntryId(arr, sub.title);
  const entry = {
    id,
    title: sub.title,
    category: sub.category,
    tags: sub.tags || [],
    summary: sub.summary,
    content: sub.content,
    sources: sub.sources || [],
    contributor: sub.author,
    addedAt: new Date().toISOString().slice(0, 10),
    fromSubmission: sub.id
  };
  arr.push(entry);
  writeJSON(file, arr);

  sub.status = 'approved';
  sub.entryId = id;
  sub.reviewer = reviewer;
  sub.reviewedAt = new Date().toISOString();
  saveSubmissions(loadSubmissions().map(s => s.id === sub.id ? sub : s));

  const users = loadUsers();
  const u = users.find(x => x.id === sub.authorId);
  if (u) {
    u.contributions = (u.contributions || 0) + 1;
    saveUsers(users);
  }
  return entry;
}

/* ---------- 静态站 ---------- */
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC, 'index.html');
  }
  const ext = path.extname(file).toLowerCase();
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    send(res, 200, buf, MIME[ext] || 'application/octet-stream');
  });
}

/* ---------- 路由 ---------- */
async function handleAPI(req, res, url, pathname) {
  const method = req.method || 'GET';

  if (pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, name: '陶瓷工艺知识库' });
  }

  if (pathname === '/api/kb' && method === 'GET') {
    return sendJSON(res, 200, loadKB());
  }

  /* --- 注册/登录 --- */
  if (pathname === '/api/register' && method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const err = validateUsername(username) || validatePassword(body.password);
    if (err) return sendError(res, 400, err);
    const users = loadUsers();
    if (findUser(users, username)) return sendError(res, 409, '用户名已被注册');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: 'u-' + crypto.randomBytes(6).toString('hex'),
      username,
      role: 'user',
      salt,
      hash: hashPwd(body.password, salt),
      createdAt: new Date().toISOString(),
      contributions: 0
    };
    users.push(user);
    saveUsers(users);
    const token = createSession(user);
    return sendJSON(res, 200, { ok: true, token, user: publicUser(user) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const users = loadUsers();
    const user = findUser(users, body.username);
    if (!user || !verifyPwd(body.password, user.salt, user.hash)) {
      return sendError(res, 401, '用户名或密码错误');
    }
    const token = createSession(user);
    return sendJSON(res, 200, { ok: true, token, user: publicUser(user) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-token'] || '');
    if (token) sessions.delete(token);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && method === 'GET') {
    const user = currentUser(req);
    return sendJSON(res, 200, { ok: true, user: user ? publicUser(user) : null });
  }

  /* --- 账号设置：改昵称 --- */
  if (pathname === '/api/user/rename' && method === 'POST') {
    const cur = currentUser(req);
    if (!cur) return sendError(res, 401, '请先登录');
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const vErr = validateUsername(username);
    if (vErr) return sendError(res, 400, vErr);
    if (username === cur.username) return sendError(res, 400, '与当前昵称相同');
    const users = loadUsers();
    const u = findUser(users, cur.username);
    if (!u) return sendError(res, 401, '请先登录');
    const dup = findUser(users, username);
    if (dup && dup.id !== u.id) return sendError(res, 409, '该昵称已被占用');
    const oldName = u.username;
    u.username = username;
    saveUsers(users);
    for (const s of sessions.values()) {
      if (s.username === oldName) s.username = username;
    }
    renameUserRecords(oldName, username);
    return sendJSON(res, 200, { ok: true, user: publicUser(u) });
  }

  /* --- 账号设置：改密码 --- */
  if (pathname === '/api/user/password' && method === 'POST') {
    const cur = currentUser(req);
    if (!cur) return sendError(res, 401, '请先登录');
    const body = await readBody(req);
    const oldPassword = String(body.oldPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!verifyPwd(oldPassword, cur.salt, cur.hash)) return sendError(res, 400, '原密码不正确');
    const vErr = validatePassword(newPassword);
    if (vErr) return sendError(res, 400, vErr);
    if (newPassword === oldPassword) return sendError(res, 400, '新密码不能与原密码相同');
    const users = loadUsers();
    const u = findUser(users, cur.username);
    if (!u) return sendError(res, 401, '请先登录');
    const salt = crypto.randomBytes(16).toString('hex');
    u.salt = salt;
    u.hash = hashPwd(newPassword, salt);
    saveUsers(users);
    // 保留当前会话，踢掉该账号在其他设备的登录
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    for (const [t, s] of sessions) {
      if (s.username === u.username && t !== token) sessions.delete(t);
    }
    return sendJSON(res, 200, { ok: true });
  }

  /* --- 投稿 --- */
  if (pathname === '/api/submissions' && method === 'GET') {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '请先登录');
    const status = url.searchParams.get('status');
    let list = loadSubmissions();
    if (user.role !== 'admin') list = list.filter(s => s.authorId === user.id);
    else if (status && status !== 'all') list = list.filter(s => s.status === status);
    list = list.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return sendJSON(res, 200, { ok: true, submissions: list, role: user.role });
  }

  if (pathname === '/api/submissions' && method === 'POST') {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '请先登录');
    const body = await readBody(req);
    const cats = readJSON(CATS_FILE, { categories: [] });
    const v = validateSubmission(body, cats.categories);
    if (typeof v === 'string') return sendError(res, 400, v);

    const sub = Object.assign(v, {
      id: 's-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      author: user.username,
      authorId: user.id,
      status: 'pending',
      rejectReason: '',
      createdAt: new Date().toISOString()
    });
    const list = loadSubmissions();
    list.push(sub);
    saveSubmissions(list);
    return sendJSON(res, 200, { ok: true, submission: sub });
  }

  const m = pathname.match(/^\/api\/submissions\/([^/]+)(\/approve|\/reject)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const action = m[2] || '';
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '请先登录');
    const list = loadSubmissions();
    const sub = list.find(s => s.id === id);
    if (!sub) return sendError(res, 404, '投稿不存在');
    if (!canView(user, sub)) return sendError(res, 403, '无权查看该投稿');

    if (!action && method === 'GET') {
      return sendJSON(res, 200, { ok: true, submission: sub });
    }

    if (user.role !== 'admin') return sendError(res, 403, '仅管理员可审核');

    if (action === '/approve' && method === 'POST') {
      if (sub.status !== 'pending') return sendError(res, 400, '该稿件已处理');
      try {
        const entry = approveSubmission(sub, user.username);
        return sendJSON(res, 200, { ok: true, entryId: entry.id, submission: sub });
      } catch (e) {
        return sendError(res, 500, '入库失败: ' + e.message);
      }
    }

    if (action === '/reject' && method === 'POST') {
      if (sub.status !== 'pending') return sendError(res, 400, '该稿件已处理');
      const body = await readBody(req);
      sub.status = 'rejected';
      sub.rejectReason = String(body.reason || '').slice(0, 300);
      sub.reviewer = user.username;
      sub.reviewedAt = new Date().toISOString();
      saveSubmissions(list.map(s => s.id === sub.id ? sub : s));
      return sendJSON(res, 200, { ok: true, submission: sub });
    }

    if (method === 'POST') return sendError(res, 404, '未知操作');
  }

  /* --- 论坛 --- */
  if (pathname === '/api/forum' && method === 'GET') {
    const user = currentUser(req);
    const forum = loadForum();
    const threads = forum.threads
      .filter(t => t.status !== 'deleted')
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .map(t => threadView(t, forum, user));
    const out = { ok: true, threads, count: threads.length };
    if (user && user.role === 'admin') out.pendingReports = pendingReportCount(forum);
    return sendJSON(res, 200, out);
  }

  if (pathname === '/api/forum/threads' && method === 'POST') {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '请先登录');
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    if (title.length < 2 || title.length > 60) return sendError(res, 400, '标题需 2-60 字');
    if (content.length < 2 || content.length > 4000) return sendError(res, 400, '内容需 2-4000 字');
    const forum = loadForum();
    const t = {
      id: newId('t'), title, content,
      author: user.username, authorId: user.id,
      createdAt: new Date().toISOString(), likes: [], status: 'visible'
    };
    forum.threads.push(t);
    saveForum(forum);
    return sendJSON(res, 200, { ok: true, thread: threadView(t, forum, user) });
  }

  let fm;
  if ((fm = pathname.match(/^\/api\/forum\/threads\/([^/]+)$/)) && method === 'GET') {
    const threadId = decodeURIComponent(fm[1]);
    const forum = loadForum();
    const t = forum.threads.find(x => x.id === threadId);
    if (!t || t.status === 'deleted') return sendError(res, 404, '帖子不存在或已删除');
    const user = currentUser(req);
    const comments = forum.comments
      .filter(c => c.threadId === threadId && c.status !== 'deleted')
      .slice()
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .map(commentView);
    return sendJSON(res, 200, { ok: true, thread: threadView(t, forum, user), comments });
  }

  if ((fm = pathname.match(/^\/api\/forum\/threads\/([^/]+)\/comments$/)) && method === 'POST') {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '请先登录');
    const body = await readBody(req);
    const content = String(body.content || '').trim();
    if (content.length < 1 || content.length > 1000) return sendError(res, 400, '评论需 1-1000 字');
    const forum = loadForum();
    const t = forum.threads.find(x => x.id === decodeURIComponent(fm[1]));
    if (!t || t.status === 'deleted') return sendError(res, 404, '帖子不存在或已删除');
    const c = {
      id: newId('c'), threadId: t.id, content,
      author: user.username, authorId: user.id,
      createdAt: new Date().toISOString(), status: 'visible'
    };
    forum.comments.push(c);
    saveForum(forum);
    return sendJSON(res, 200, { ok: true, comment: commentView(c), commentCount: commentCountOf(forum, t.id) });
  }

  if ((fm = pathname.match(/^\/api\/forum\/threads\/([^/]+)\/(like|report|delete)$/)) && method === 'POST') {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '请先登录');
    const action = fm[2];
    const forum = loadForum();
    const t = forum.threads.find(x => x.id === decodeURIComponent(fm[1]));
    if (!t || t.status === 'deleted') return sendError(res, 404, '帖子不存在或已删除');

    if (action === 'like') {
      const i = (t.likes || []).indexOf(user.id);
      if (i >= 0) t.likes.splice(i, 1);
      else t.likes.push(user.id);
      saveForum(forum);
      return sendJSON(res, 200, { ok: true, liked: i < 0, likes: t.likes.length });
    }

    if (action === 'delete') {
      if (user.role !== 'admin') return sendError(res, 403, '仅管理员可删帖');
      t.status = 'deleted';
      t.deletedBy = user.username;
      t.deletedAt = new Date().toISOString();
      saveForum(forum);
      return sendJSON(res, 200, { ok: true });
    }

    if (action === 'report') {
      const body = await readBody(req);
      const reason = String(body.reason || '').trim();
      if (!reason || reason.length > 200) return sendError(res, 400, '请填写举报原因（1-200 字）');
      const dup = forum.reports.find(r => r.status === 'pending' &&
        r.targetType === 'thread' && r.targetId === t.id && r.reporterId === user.id);
      if (dup) return sendError(res, 409, '你已举报过该帖子，管理员正在处理');
      forum.reports.push({
        id: newId('r'), targetType: 'thread', targetId: t.id, threadId: t.id,
        reason, reporter: user.username, reporterId: user.id,
        createdAt: new Date().toISOString(), status: 'pending'
      });
      saveForum(forum);
      return sendJSON(res, 200, { ok: true });
    }
  }

  if ((fm = pathname.match(/^\/api\/forum\/comments\/([^/]+)\/(report|delete)$/)) && method === 'POST') {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '请先登录');
    const action = fm[2];
    const forum = loadForum();
    const c = forum.comments.find(x => x.id === decodeURIComponent(fm[1]));
    if (!c || c.status === 'deleted') return sendError(res, 404, '评论不存在或已删除');

    if (action === 'delete') {
      if (user.role !== 'admin') return sendError(res, 403, '仅管理员可删除评论');
      c.status = 'deleted';
      c.deletedBy = user.username;
      saveForum(forum);
      return sendJSON(res, 200, { ok: true });
    }

    if (action === 'report') {
      const body = await readBody(req);
      const reason = String(body.reason || '').trim();
      if (!reason || reason.length > 200) return sendError(res, 400, '请填写举报原因（1-200 字）');
      const dup = forum.reports.find(r => r.status === 'pending' &&
        r.targetType === 'comment' && r.targetId === c.id && r.reporterId === user.id);
      if (dup) return sendError(res, 409, '你已举报过该评论，管理员正在处理');
      forum.reports.push({
        id: newId('r'), targetType: 'comment', targetId: c.id, threadId: c.threadId,
        reason, reporter: user.username, reporterId: user.id,
        createdAt: new Date().toISOString(), status: 'pending'
      });
      saveForum(forum);
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/forum/reports' && method === 'GET') {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '请先登录');
    if (user.role !== 'admin') return sendError(res, 403, '仅管理员可查看举报记录');
    const forum = loadForum();
    const reports = forum.reports
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .map(r => {
        let target = null;
        if (r.targetType === 'thread') {
          const t = forum.threads.find(x => x.id === r.targetId);
          target = t ? { title: t.title, author: t.author, threadId: t.id, deleted: t.status === 'deleted' } : null;
        } else {
          const c = forum.comments.find(x => x.id === r.targetId);
          target = c ? {
            title: c.content.slice(0, 60), author: c.author, threadId: c.threadId, deleted: c.status === 'deleted'
          } : null;
        }
        return Object.assign({}, r, { target });
      });
    return sendJSON(res, 200, { ok: true, reports, pending: pendingReportCount(forum) });
  }

  if ((fm = pathname.match(/^\/api\/forum\/reports\/([^/]+)\/handle$/)) && method === 'POST') {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '请先登录');
    if (user.role !== 'admin') return sendError(res, 403, '仅管理员可处理举报');
    const body = await readBody(req);
    const action = String(body.action || '');
    if (action !== 'delete' && action !== 'dismiss') return sendError(res, 400, 'action 需为 delete 或 dismiss');
    const forum = loadForum();
    const r = forum.reports.find(x => x.id === decodeURIComponent(fm[1]));
    if (!r) return sendError(res, 404, '举报记录不存在');
    if (r.status !== 'pending') return sendError(res, 400, '该举报已处理');

    if (action === 'delete') {
      if (r.targetType === 'thread') {
        const t = forum.threads.find(x => x.id === r.targetId);
        if (t && t.status !== 'deleted') {
          t.status = 'deleted';
          t.deletedBy = user.username;
          t.deletedAt = new Date().toISOString();
        }
      } else {
        const c = forum.comments.find(x => x.id === r.targetId);
        if (c && c.status !== 'deleted') {
          c.status = 'deleted';
          c.deletedBy = user.username;
        }
      }
    }
    r.status = 'handled';
    r.action = action;
    r.handledBy = user.username;
    r.handledAt = new Date().toISOString();
    saveForum(forum);
    return sendJSON(res, 200, { ok: true, report: r, pending: pendingReportCount(forum) });
  }

  /* --- AI 智能客服 --- */
  if (pathname === '/api/chat/config' && method === 'GET') {
    const cfg = aiConfig();
    return sendJSON(res, 200, { ok: true, configured: aiReady(cfg), model: cfg.model || null });
  }

  if (pathname === '/api/chat' && method === 'POST') {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    if (!rateOk('chat:' + ip, 15, 60000)) {
      return sendError(res, 429, '提问太频繁，请稍后再试（每分钟 15 条）');
    }
    const body = await readBody(req);
    const raw = Array.isArray(body.messages) ? body.messages : null;
    if (!raw || !raw.length) return sendError(res, 400, 'messages 不能为空');
    if (raw.length > 20) return sendError(res, 400, '对话过长，请刷新页面重新开始');
    const history = [];
    for (const m of raw) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) return sendError(res, 400, '消息 role 非法');
      const content = String(m.content || '').trim();
      if (!content) return sendError(res, 400, '消息内容不能为空');
      if (content.length > 2000) return sendError(res, 400, '单条消息过长（≤2000 字）');
      history.push({ role: m.role, content: content.slice(0, 2000) });
    }
    if (history[history.length - 1].role !== 'user') {
      return sendError(res, 400, '最后一条消息需为用户消息');
    }
    const question = history[history.length - 1].content;
    const sources = searchKB(question, 4);
    const sourceList = sources.map(e => ({ id: e.id, title: e.title, category: e.category }));
    const cfg = aiConfig();

    if (!aiReady(cfg)) {
      return sendJSON(res, 200, {
        ok: true, fallback: true, model: null,
        answer: fallbackAnswer(sources), sources: sourceList
      });
    }

    try {
      const sys = buildSystemPrompt(cfg, question, sources);
      const answer = await callAI(cfg, [{ role: 'system', content: sys }].concat(history));
      return sendJSON(res, 200, {
        ok: true, fallback: false, model: cfg.model,
        answer: answer, sources: sourceList
      });
    } catch (e) {
      return sendJSON(res, 200, {
        ok: true, fallback: true, model: cfg.model, error: String(e && e.message || e),
        answer: 'AI 接口调用失败：' + String(e && e.message || e) + '\n\n' + fallbackAnswer(sources),
        sources: sourceList
      });
    }
  }

  if (pathname.startsWith('/data/')) {
    const file = path.normalize(path.join(DATA, pathname.slice(6)));
    if (!file.startsWith(DATA)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    if (!fs.existsSync(file)) return send(res, 404, '{"error":"not found"}');
    return send(res, 200, fs.readFileSync(file), 'application/json; charset=utf-8');
  }

  return sendError(res, 404, 'unknown api');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith('/api/')) return await handleAPI(req, res, url, pathname);
    return serveStatic(req, res, pathname);
  } catch (e) {
    return sendError(res, 500, String(e && e.message || e));
  }
});

fs.mkdirSync(RUNTIME_DIR, { recursive: true });
loadUsers();
loadSubmissions();
if (!fs.existsSync(FORUM_FILE)) saveForum(loadForum());
if (!fs.existsSync(AI_CONFIG_FILE)) writeJSON(AI_CONFIG_FILE, defaultAIConfig());
server.listen(PORT, () => {
  console.log('陶瓷工艺知识库已启动: http://localhost:' + PORT);
});
