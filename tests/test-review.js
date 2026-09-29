/**
 * 前端审核交互回归测试（最小 DOM 模拟 + fetch 桩）：
 * 管理员打开审核台 → 点「退回」→ 页内填写原因 → 提交 → 收到接口调用与结果提示
 * 同时覆盖「通过并入库」按钮。
 * 用法: node tests/test-review.js
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

/* ---------- 知识库数据（模拟 /api/kb） ---------- */
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/categories.json'), 'utf8'));
const entries = [];
for (const f of index.entryFiles) {
  entries.push(...JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')));
}
const counts = {};
entries.forEach(e => { counts[e.category] = (counts[e.category] || 0) + 1; });
const originalKiln = counts.kiln;
const kb = { meta: index.meta, categories: index.categories, counts, entries };

const submissions = [
  {
    id: 's-test1', title: '待退回的稿件', category: 'kiln', tags: ['测试'],
    summary: '第一条：测试退回流程。', content: '## 内容\n- 用于测试退回',
    sources: [], author: 'alice', authorId: 'u1',
    status: 'pending', rejectReason: '', createdAt: '2026-09-27T10:00:00.000Z'
  },
  {
    id: 's-test2', title: '待通过的稿件', category: 'kiln', tags: ['测试'],
    summary: '第二条：测试通过流程。', content: '## 内容\n- 用于测试通过入库',
    sources: [], author: 'alice', authorId: 'u1',
    status: 'pending', rejectReason: '', createdAt: '2026-09-27T10:05:00.000Z'
  }
];

/* ---------- fetch 桩 ---------- */
const calls = [];
function fetchStub(url, opts) {
  opts = opts || {};
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url, method, body });

  let data = { ok: true };
  if (url === '/api/kb') data = kb;
  else if (url === '/api/me') data = { ok: true, user: { id: 'u-admin', username: 'admin', role: 'admin' } };
  else if (url.indexOf('/api/submissions?') === 0) data = { ok: true, role: 'admin', submissions: submissions };
  else if (url === '/api/submissions' && method === 'GET') data = { ok: true, role: 'admin', submissions: submissions };
  else if (url === '/api/submissions' && method === 'POST') data = { ok: true, submission: { id: 's-new', status: 'pending' } };
  else if (/^\/api\/submissions\/[^/]+\/reject$/.test(url) && method === 'POST') {
    const s = submissions.find(x => url.indexOf(x.id) >= 0);
    if (s) { s.status = 'rejected'; s.rejectReason = body.reason; s.reviewer = 'admin'; }
    data = { ok: !!s, submission: s };
  } else if (/^\/api\/submissions\/[^/]+\/approve$/.test(url) && method === 'POST') {
    const s = submissions.find(x => url.indexOf(x.id) >= 0);
    if (s && s.status === 'pending') {
      s.status = 'approved'; s.entryId = 'entry-test'; s.reviewer = 'admin';
      entries.push(Object.assign({}, s, { id: 'entry-test', contributor: s.author, addedAt: '2026-09-27' }));
      counts[s.category] = (counts[s.category] || 0) + 1;
    }
    data = { ok: !!s, entryId: 'entry-test', submission: s };
  } else if (/^\/api\/submissions\/[^/]+$/.test(url)) {
    data = { ok: true, submission: submissions.find(x => url.indexOf(x.id) >= 0) };
  } else if (url === '/api/logout') data = { ok: true };

  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

/* ---------- DOM / 环境桩 ---------- */
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

/* ---------- 启动 ---------- */
const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
vm.createContext(store);
vm.runInContext(appSrc, store, { filename: 'app.js' });

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
  console.log('\n[1] 启动与审核台');
  await sleep(60);
  check(els['main']._html.includes('cta-strip'), '首页渲染成功');
  check(els['auth-area']._html.includes('审核台'), '页头显示审核台（管理员）');

  store.location.hash = '#/admin';
  winListeners['hashchange']();
  await sleep(60);
  const adminHtml = els['main']._html;
  check(adminHtml.includes('待审核 2'), '待审核列表渲染（2 条）', adminHtml.slice(0, 120));
  check(adminHtml.includes('data-action="reject"'), '存在「退回」按钮');
  check(adminHtml.includes('data-action="approve"'), '存在「通过并入库」按钮');

  console.log('\n[2] 点击退回：页内展开原因输入框（不使用浏览器弹窗）');
  clickAction({ 'data-action': 'reject', 'data-id': 's-test1' });
  const boxHtml = els['rj-s-test1']._html;
  check(boxHtml.includes('data-form="reject"'), '展开退回表单');
  check(boxHtml.includes('确认退回') && boxHtml.includes('取消'), '含确认/取消按钮');

  console.log('\n[3] 填写原因并提交');
  submitForm({ 'data-form': 'reject', 'data-id': 's-test1' }, { reason: { value: '与已有条目重复' } });
  await sleep(80);
  const call = calls.find(c => /\/reject$/.test(c.url) && c.method === 'POST');
  check(!!call, '发出 POST /api/submissions/s-test1/reject');
  check(call && call.body && call.body.reason === '与已有条目重复', '携带退回原因', JSON.stringify(call && call.body));
  check(els['main']._html.includes('已退回该稿件'), '显示成功提示');
  check(els['main']._html.includes('已退回'), '稿件状态更新为已退回');
  check(els['main']._html.includes('与已有条目重复'), '列表展示退回原因');

  console.log('\n[4] 取消按钮关闭输入框');
  store.location.hash = '#/admin';
  winListeners['hashchange']();
  await sleep(60);
  clickAction({ 'data-action': 'reject', 'data-id': 's-test2' });
  check(els['rj-s-test2']._html.length > 0, '再次展开表单');
  clickAction({ 'data-action': 'reject-cancel', 'data-id': 's-test2' });
  check(els['rj-s-test2']._html === '', '取消后关闭');

  console.log('\n[5] 通过并入库仍正常');
  clickAction({ 'data-action': 'approve', 'data-id': 's-test2' });
  await sleep(80);
  const ok = calls.find(c => /\/approve$/.test(c.url) && c.method === 'POST');
  check(!!ok, '发出 POST …/approve');
  check(els['main']._html.includes('已通过并写入知识库'), '显示通过提示');
  check(kb.counts.kiln === originalKiln + 1, '分类计数 +1', kb.counts.kiln + '/' + originalKiln);
  check(kb.entries.some(e => e.id === 'entry-test'), '新条目已进入知识库数据');

  console.log('\n结果: 通过 ' + passed + ' / 失败 ' + failures.length);
  if (failures.length) { console.log('失败项: ' + failures.join(' | ')); process.exit(1); }
})();
