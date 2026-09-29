/**
 * 论坛前端交互回归测试（最小 DOM 模拟 + fetch 桩）：
 * 列表 → 详情 → 评论 → 点赞 → 举报（页内表单）→ 管理员举报箱处理
 * 用法: node tests/test-forum.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label + (extra ? ' — ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 数据桩 ---------- */
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/categories.json'), 'utf8'));
const entries = [];
for (const f of index.entryFiles) {
  entries.push(...JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')));
}
const counts = {};
entries.forEach(e => { counts[e.category] = (counts[e.category] || 0) + 1; });
const kb = { meta: index.meta, categories: index.categories, counts, entries };

const threads = [{
  id: 't1', title: '还原焰怎么判断？', content: '## 问题\n- 请教还原焰判断方法',
  author: 'alice', authorId: 'u1', createdAt: '2026-09-27T10:00:00.000Z',
  likes: ['u3'], status: 'visible'
}];
const comments = [{
  id: 'c1', threadId: 't1', content: '看火焰颜色和烟色', author: 'bob', authorId: 'u2',
  createdAt: '2026-09-27T10:05:00.000Z', status: 'visible'
}];
const reports = [{
  id: 'r1', targetType: 'thread', targetId: 't1', threadId: 't1',
  reason: '内容重复', reporter: 'bob', reporterId: 'u2',
  createdAt: '2026-09-27T10:10:00.000Z', status: 'pending',
  target: { title: '还原焰怎么判断？', author: 'alice', threadId: 't1', deleted: false }
}];

const calls = [];
function fetchStub(url, opts) {
  opts = opts || {};
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url, method, body });

  let data = { ok: true };
  if (url === '/api/kb') data = kb;
  else if (url === '/api/me') data = { ok: true, user: { id: 'u-admin', username: 'admin', role: 'admin' } };
  else if (url === '/api/forum/reports' && method === 'GET') {
    data = { ok: true, reports, pending: reports.filter(r => r.status === 'pending').length };
  } else if (/^\/api\/forum\/reports\/[^/]+\/handle$/.test(url) && method === 'POST') {
    const r = reports.find(x => url.indexOf(x.id) >= 0);
    if (r) {
      r.status = 'handled';
      r.action = body.action;
      if (body.action === 'delete' && r.targetType === 'thread') {
        const t = threads.find(x => x.id === r.targetId);
        if (t) { t.status = 'deleted'; t.deletedBy = 'admin'; }
        if (r.target) r.target.deleted = true;
      }
    }
    data = { ok: true, report: r, pending: reports.filter(x => x.status === 'pending').length };
  } else if (url === '/api/forum/threads' && method === 'POST') {
    const t = {
      id: 't-new', title: body.title, content: body.content, author: 'admin', authorId: 'u-admin',
      createdAt: new Date().toISOString(), likes: [], status: 'visible'
    };
    threads.push(t);
    data = { ok: true, thread: { id: t.id, title: t.title, commentCount: 0, likes: 0, liked: false } };
  } else if (/^\/api\/forum\/threads\/[^/]+\/comments$/.test(url) && method === 'POST') {
    const t = threads.find(x => url.indexOf(x.id) >= 0);
    comments.push({ id: 'c-new', threadId: t.id, content: body.content, author: 'admin', authorId: 'u-admin', createdAt: new Date().toISOString(), status: 'visible' });
    data = { ok: true, commentCount: comments.filter(c => c.threadId === t.id && c.status !== 'deleted').length };
  } else if (/^\/api\/forum\/threads\/[^/]+\/like$/.test(url) && method === 'POST') {
    const t = threads.find(x => url.indexOf(x.id) >= 0);
    const i = t.likes.indexOf('u-admin');
    if (i >= 0) t.likes.splice(i, 1); else t.likes.push('u-admin');
    data = { ok: true, liked: i < 0, likes: t.likes.length };
  } else if (/^\/api\/forum\/threads\/[^/]+\/report$/.test(url) && method === 'POST') {
    const t = threads.find(x => url.indexOf(x.id) >= 0);
    reports.push({
      id: 'r-new', targetType: 'thread', targetId: t.id, threadId: t.id,
      reason: body.reason, reporter: 'admin', reporterId: 'u-admin',
      createdAt: new Date().toISOString(), status: 'pending',
      target: { title: t.title, author: t.author, threadId: t.id, deleted: false }
    });
    data = { ok: true };
  } else if (/^\/api\/forum\/threads\/[^/]+\/delete$/.test(url) && method === 'POST') {
    const t = threads.find(x => url.indexOf(x.id) >= 0);
    if (t) { t.status = 'deleted'; t.deletedBy = 'admin'; }
    data = { ok: true };
  } else if (/^\/api\/forum\/threads\/[^/]+$/.test(url) && method === 'GET') {
    const t = threads.find(x => url.indexOf(x.id) >= 0);
    if (!t || t.status === 'deleted') return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false, error: '帖子不存在或已删除' }) });
    data = {
      ok: true,
      thread: {
        id: t.id, title: t.title, content: t.content, author: t.author, createdAt: t.createdAt,
        likes: t.likes.length, liked: t.likes.indexOf('u-admin') >= 0,
        commentCount: comments.filter(c => c.threadId === t.id && c.status !== 'deleted').length
      },
      comments: comments.filter(c => c.threadId === t.id && c.status !== 'deleted')
        .map(c => ({ id: c.id, threadId: c.threadId, content: c.content, author: c.author, createdAt: c.createdAt }))
    };
  } else if (url === '/api/forum' && method === 'GET') {
    const list = threads.filter(t => t.status !== 'deleted').map(t => ({
      id: t.id, title: t.title, author: t.author, createdAt: t.createdAt,
      likes: t.likes.length, liked: t.likes.indexOf('u-admin') >= 0,
      commentCount: comments.filter(c => c.threadId === t.id && c.status !== 'deleted').length,
      status: t.status
    }));
    data = { ok: true, threads: list, count: list.length, pendingReports: reports.filter(r => r.status === 'pending').length };
  } else if (url === '/api/logout') data = { ok: true };

  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

/* ---------- DOM 桩 ---------- */
const els = {};
function el(id) {
  if (!els[id]) {
    els[id] = {
      _html: '', textContent: '', value: '',
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
      addEventListener() {},
      querySelector() { return null; },
      getAttribute() { return null; }
    };
  }
  return els[id];
}
const docListeners = {};
const winListeners = {};
const ls = {
  _d: { kb_token: 'tok-admin' },
  getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};
const store = {
  window: {
    addEventListener: (t, fn) => { winListeners[t] = fn; },
    scrollTo: () => {},
    confirm: () => true
  },
  document: {
    getElementById: el,
    addEventListener: (t, fn) => { docListeners[t] = fn; },
    title: ''
  },
  location: { hash: '#/' },
  fetch: fetchStub,
  localStorage: ls,
  console
};

const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
vm.createContext(store);
vm.runInContext(appSrc, store, { filename: 'app.js' });

function go(hash) { store.location.hash = hash; winListeners['hashchange'](); }
function clickAction(attrs) {
  const btn = { getAttribute: k => (k in attrs ? String(attrs[k]) : null) };
  docListeners['click']({ target: { closest: sel => (sel === '[data-action]' ? btn : null) } });
}
function clickNav(hash) {
  const btn = { getAttribute: k => (k === 'data-nav' ? hash : null) };
  docListeners['click']({ target: { closest: sel => (sel === '[data-nav]' ? btn : null) } });
}
function submitForm(attrs, values) {
  const form = {
    getAttribute: k => (k in attrs ? String(attrs[k]) : null),
    elements: values
  };
  docListeners['submit']({ target: form, preventDefault: () => {} });
}

(async () => {
  console.log('\n[1] 启动与入口');
  await sleep(60);
  check(els['sidebar']._html.includes('💬 论坛'), '侧栏显示论坛入口');
  check(els['sidebar']._html.includes('举报箱'), '管理员侧栏显示举报箱');
  check(els['header-nav']._html.includes('#/forum'), '页头显示论坛链接');
  check(els['header-nav']._html.includes('举报箱'), '页头显示举报箱（含数）');

  console.log('\n[2] 论坛列表');
  go('#/forum');
  await sleep(60);
  let html = els['main']._html;
  check(html.includes('交流论坛'), '论坛页标题');
  check(html.includes('还原焰怎么判断？'), '帖子出现在列表');
  check(html.includes('👍 1') && html.includes('💬 1'), '点赞/评论数显示');
  check(html.includes('发新帖'), '发帖按钮');
  check(els['sidebar']._html.includes('active') && els['sidebar']._html.indexOf('论坛') > 0, '侧栏论坛高亮');

  console.log('\n[3] 帖子详情与评论');
  go('#/forum/t/t1');
  await sleep(60);
  html = els['main']._html;
  check(html.includes('还原焰怎么判断？') && html.includes('data-form="forum-comment"'), '详情含评论表单');
  check(html.includes('看火焰颜色和烟色'), '评论渲染');
  check(html.includes('data-action="like"') && html.includes('👍 点赞'), '点赞按钮（未赞状态）');
  check(html.includes('data-action="report-open"'), '举报按钮（管理员可见）');
  check(html.includes('data-action="delete-thread"'), '管理员删除帖子按钮');

  submitForm({ 'data-form': 'forum-comment', 'data-id': 't1' }, { content: { value: '补充：看烟囱冒白烟的时机' } });
  await sleep(80);
  let call = calls.find(c => /\/comments$/.test(c.url) && c.method === 'POST');
  check(!!call && call.body.content.indexOf('补充') === 0, '发出评论请求');
  check(els['main']._html.includes('评论已发表'), '评论成功提示');

  console.log('\n[4] 点赞');
  clickAction({ 'data-action': 'like', 'data-id': 't1' });
  await sleep(60);
  call = calls.find(c => /\/like$/.test(c.url) && c.method === 'POST');
  check(!!call, '发出点赞请求');
  check(els['main']._html.includes('已赞') && els['main']._html.includes('👍 2'), '点赞后按钮与计数更新');

  console.log('\n[5] 举报（页内表单，无弹窗）');
  clickAction({ 'data-action': 'report-open', 'data-type': 'thread', 'data-id': 't1' });
  const box = els['rp-thread-t1']._html;
  check(box.includes('data-form="forum-report"'), '展开举报表单');
  submitForm({ 'data-form': 'forum-report', 'data-type': 'thread', 'data-id': 't1' },
    { reason: { value: '疑似重复发帖' } });
  await sleep(80);
  call = calls.find(c => /\/report$/.test(c.url) && c.method === 'POST');
  check(!!call && call.body.reason === '疑似重复发帖', '携带举报原因');
  check(els['main']._html.includes('举报已提交'), '举报成功提示');

  console.log('\n[6] 管理员举报箱');
  go('#/forum/reports');
  await sleep(60);
  html = els['main']._html;
  check(html.includes('举报箱') && html.includes('待处理'), '举报箱页头');
  check(html.includes('内容重复') && html.includes('疑似重复发帖'), '显示举报原因');
  check(html.includes('report-delete') && html.includes('report-dismiss'), '删除/忽略按钮');

  clickAction({ 'data-action': 'report-delete', 'data-id': 'r1' });
  await sleep(80);
  call = calls.find(c => /\/handle$/.test(c.url) && c.method === 'POST');
  check(!!call && call.body.action === 'delete', '发出删除处理请求');
  check(els['main']._html.includes('已删除被举报内容'), '处理成功提示');
  check(threads[0].status === 'deleted', '原帖已从数据中删除');

  go('#/forum');
  await sleep(60);
  check(!els['main']._html.includes('还原焰怎么判断？'), '被删帖子不再出现在列表');

  console.log('\n结果: 通过 ' + passed + ' / 失败 ' + failures.length);
  if (failures.length) { console.log('失败项: ' + failures.join(' | ')); process.exit(1); }
})();
