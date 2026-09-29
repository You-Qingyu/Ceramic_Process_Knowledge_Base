/**
 * AI 智能客服测试：
 *   A. 服务端 API：未配置降级 / 参数校验 / 限流 / 真实调用 OpenAI 兼容接口（本地 mock）
 *   B. 前端交互：悬浮按钮 → 面板 → 快捷问题 → 发送 → 回答与来源渲染 → 来源跳转
 * 用法: node tests/test-chat.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'kb-chat-test-' + Date.now());
const PORT = 3230;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0;
const failures = [];
function check(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label + (extra ? ' — ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(pathname, opts) {
  opts = opts || {};
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

function setupSandbox() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(TMP, 'server.js'));
  fs.cpSync(path.join(ROOT, 'data'), path.join(TMP, 'data'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(TMP, 'public'), { recursive: true });
}

function startServer(extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: TMP,
    env: Object.assign({}, process.env, { PORT: String(PORT) }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child._log = '';
  child.stdout.on('data', d => { child._log += d; });
  child.stderr.on('data', d => { child._log += d; });
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (e) { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

async function stopServer(child) {
  if (!child) return;
  child.kill();
  await sleep(350);
}

/* ---------- A. 服务端 API ---------- */
async function apiTests() {
  setupSandbox();
  let child = startServer();

  try {
    await waitForServer();
    console.log('\n[A1] 未配置时的降级回答');
    check(fs.existsSync(path.join(TMP, 'ai.config.json')), '自动生成 ai.config.json');

    let r = await req('/api/chat/config');
    check(r.status === 200 && r.data.configured === false && r.data.model === null, '/api/chat/config 返回未配置');

    r = await req('/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: '还原焰怎么判断？' }] } });
    check(r.status === 200 && r.data.fallback === true, '无 key 时返回降级回答');
    check(/AI 接口尚未配置/.test(r.data.answer || ''), '降级文案提示配置');
    check(Array.isArray(r.data.sources) && r.data.sources.length > 0, '带知识库来源 sources', JSON.stringify(r.data.sources));
    check(!!r.data.sources[0].id && !!r.data.sources[0].title, '来源含 id 与 title');

    r = await req('/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'zzqqxx 无关问题' }] } });
    check(r.status === 200 && r.data.sources.length === 0, '无匹配时 sources 为空');
    check(/没有找到相关资料/.test(r.data.answer || ''), '无匹配降级文案');

    console.log('\n[A2] 参数校验');
    r = await req('/api/chat', { method: 'POST', body: {} });
    check(r.status === 400, '缺少 messages → 400');
    r = await req('/api/chat', { method: 'POST', body: { messages: [] } });
    check(r.status === 400, '空 messages → 400');
    r = await req('/api/chat', { method: 'POST', body: { messages: [{ role: 'nobody', content: 'hi' }] } });
    check(r.status === 400, '非法 role → 400');
    r = await req('/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: '   ' }] } });
    check(r.status === 400, '空内容 → 400');
    r = await req('/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'x'.repeat(2001) }] } });
    check(r.status === 400, '超长消息 → 400');
    r = await req('/api/chat', { method: 'POST', body: { messages: [{ role: 'assistant', content: '我是助手' }] } });
    check(r.status === 400, '最后一条非用户消息 → 400');
    r = await req('/api/chat', { method: 'POST', body: { messages: Array.from({ length: 21 }, (_, i) => ({ role: 'user', content: 'm' + i })) } });
    check(r.status === 400, '对话过长 → 400');

    console.log('\n[A3] 限流（每 IP 每分钟 15 条）');
    let limited = false;
    for (let i = 0; i < 18; i++) {
      const q = await req('/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: '问题' + i }] } });
      if (q.status === 429) { limited = true; break; }
    }
    check(limited, '超过频次返回 429');
  } finally {
    await stopServer(child);
    child = null;
  }

  /* --- 真实调用 OpenAI 兼容接口（本地 mock） --- */
  let lastAI = null;
  const mock = http.createServer((req2, res2) => {
    if (req2.url !== '/v1/chat/completions') { res2.writeHead(404); return res2.end('{}'); }
    let buf = '';
    req2.on('data', d => { buf += d; });
    req2.on('end', () => {
      const body = JSON.parse(buf);
      lastAI = { auth: req2.headers.authorization, body };
      const last = body.messages[body.messages.length - 1];
      if (String(last.content).indexOf('FAILME') >= 0) {
        res2.writeHead(500, { 'Content-Type': 'application/json' });
        return res2.end(JSON.stringify({ error: { message: 'mock boom' } }));
      }
      res2.writeHead(200, { 'Content-Type': 'application/json' });
      res2.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'MOCK_ANSWER：还原焰可通过火焰颜色与烟囱烟色判断。' } }] }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  try {
    child = startServer({
      AI_API_KEY: 'test-key',
      AI_BASE_URL: 'http://127.0.0.1:' + mockPort + '/v1',
      AI_MODEL: 'test-model'
    });
    await waitForServer();

    console.log('\n[A4] 配置了 key 后的对话');
    let r = await req('/api/chat/config');
    check(r.status === 200 && r.data.configured === true && r.data.model === 'test-model', '/api/chat/config 返回已配置');
    check(r.data.apiKey === undefined, '配置接口不泄露 apiKey');

    r = await req('/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: '还原焰怎么判断？' }] } });
    check(r.status === 200 && r.data.fallback === false, '调用成功不降级');
    check(/^MOCK_ANSWER/.test(r.data.answer || ''), '回答来自 AI', r.data.answer);
    check(r.data.sources.length > 0, '仍附带知识库来源');

    check(!!lastAI, 'mock 收到请求');
    check(lastAI && lastAI.auth === 'Bearer test-key', '携带 Authorization Bearer');
    check(lastAI && lastAI.body.model === 'test-model', '请求体 model 正确');
    const msgs = lastAI.body.messages;
    check(msgs[0].role === 'system' && msgs[0].content.indexOf('知识库资料') >= 0, 'system 提示注入知识库资料');
    check(msgs[0].content.indexOf('还原焰') >= 0, 'system 提示含用户问题');
    check(msgs[msgs.length - 1].role === 'user', '末尾为用户消息');

    console.log('\n[A5] AI 接口失败时的兜底');
    r = await req('/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: '还原焰 FAILME 请失败' }] } });
    check(r.status === 200 && r.data.fallback === true, '上游 500 时降级返回 200');
    check(/AI 接口调用失败/.test(r.data.answer || ''), '降级文案说明失败');
    check(r.data.sources.length > 0, '失败时仍返回来源');
  } finally {
    await stopServer(child);
    await new Promise(r => mock.close(r));
  }
}

/* ---------- B. 前端交互 ---------- */
async function uiTests() {
  const calls = [];
  function fetchStub(url, opts) {
    opts = opts || {};
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    let data = { ok: true };
    if (url === '/api/kb') {
      const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/categories.json'), 'utf8'));
      const entries = [];
      for (const f of index.entryFiles) {
        entries.push(...JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')));
      }
      const counts = {};
      entries.forEach(e => { counts[e.category] = (counts[e.category] || 0) + 1; });
      data = { meta: index.meta, categories: index.categories, counts, entries };
    } else if (url === '/api/me') data = { ok: true, user: null };
    else if (url === '/api/forum' || /\/api\/forum/.test(url)) data = { ok: true, threads: [], count: 0, pendingReports: 0 };
    else if (url === '/api/chat/config') data = { ok: true, configured: false, model: null };
    else if (url === '/api/chat' && method === 'POST') {
      data = {
        ok: true, fallback: true, model: null,
        answer: '**AI 接口尚未配置**，先按知识库为你找到这些相关内容：\n\n1. **《氧化焰与还原焰》** — 烧成气氛判断。',
        sources: [{ id: 'oxidizing-reducing-flame', title: '氧化焰与还原焰', category: 'firing' }]
      };
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  }

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
    _d: {},
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

  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  vm.createContext(store);
  vm.runInContext(appSrc, store, { filename: 'app.js' });

  function clickAction(attrs) {
    const btn = { getAttribute: k => (k in attrs ? String(attrs[k]) : null) };
    docListeners['click']({ target: { closest: sel => (sel === '[data-action]' ? btn : null) } });
  }
  function submitForm(attrs, values) {
    const form = { getAttribute: k => (k in attrs ? String(attrs[k]) : null), elements: values };
    docListeners['submit']({ target: form, preventDefault: () => {} });
  }

  await sleep(80);
  const w = () => els['chat-widget']._html;

  console.log('\n[B1] 悬浮按钮与面板');
  check(w().includes('chat-fab') && w().includes('智能客服'), '页面渲染悬浮客服按钮');
  check(w().includes('data-action="chat-toggle"'), '按钮可点击展开');

  clickAction({ 'data-action': 'chat-toggle' });
  check(w().includes('chat-panel') && w().includes('data-form="chat"'), '展开客服面板与输入框');
  check(w().includes('知识库模式') && w().includes('ai.config.json'), '未配置时显示知识库模式提示');
  check(w().includes('什么是还原焰？'), '显示快捷问题');

  console.log('\n[B2] 发送问题与渲染回答');
  submitForm({ 'data-form': 'chat' }, { message: { value: '什么是还原焰？' } });
  await sleep(80);
  let call = calls.find(c => c.url === '/api/chat' && c.method === 'POST');
  check(!!call && call.body.messages.length === 1 && call.body.messages[0].content === '什么是还原焰？', '发出对话请求');
  check(call.body.messages[0].role === 'user', '消息 role=user');
  check(w().includes('AI 接口尚未配置'), '回答已渲染');
  check(w().includes('氧化焰与还原焰') && w().includes('data-action="chat-nav"'), '渲染来源链接');
  check(w().includes('chat-chip'), '有历史时显示快捷问题条');

  console.log('\n[B3] 来源跳转 / 关闭 / 清空');
  clickAction({ 'data-action': 'chat-nav', 'data-nav': '#/e/oxidizing-reducing-flame' });
  check(!w().includes('chat-panel'), '点击来源后关闭面板');
  check(store.location.hash === '#/e/oxidizing-reducing-flame', '跳转到条目页');

  clickAction({ 'data-action': 'chat-toggle' });
  check(w().includes('chat-panel'), '重新打开面板');
  check(JSON.parse(ls.getItem('kb_chat')).length === 2, '对话历史已持久化到 localStorage');

  clickAction({ 'data-action': 'chat-clear' });
  check(JSON.parse(ls.getItem('kb_chat')).length === 0, '清空对话');
  check(w().includes('你好！我是陶瓷工艺知识库的智能客服'), '清空后回到欢迎语');

  clickAction({ 'data-action': 'chat-close' });
  check(!w().includes('chat-panel'), '关闭按钮生效');
}

(async () => {
  try {
    await apiTests();
    await uiTests();
    console.log('\n结果: 通过 ' + passed + ' / 失败 ' + failures.length);
    if (failures.length) { console.log('失败项: ' + failures.join(' | ')); process.exitCode = 1; }
  } catch (e) {
    console.error('测试异常:', e.message);
    process.exitCode = 1;
  } finally {
    setTimeout(() => {
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      process.exit();
    }, 300);
  }
})();
