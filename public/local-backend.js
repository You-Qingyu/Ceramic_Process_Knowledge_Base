/**
 * 单文件版本地后端：把所有 /api/* 请求在浏览器内完成，无需服务器。
 * - 账号 / 投稿审核 / 论坛数据存 localStorage（换电脑或清缓存会重置）
 * - 审核通过的稿件并入内嵌知识库并持久化
 * - AI 客服直连 OpenAI 兼容接口（key 由 scripts/build.js 内嵌 window.__AI_CONFIG__）
 * 仅当 window.__KB_DATA__ 存在（单文件版）时启用。
 */
(function () {
  'use strict';
  if (!window.__KB_DATA__) return;

  var mem = {};
  function lsGet(k, def) {
    try { var v = localStorage.getItem(k); if (v != null) return JSON.parse(v); } catch (e) { /* 忽略 */ }
    return (k in mem) ? mem[k] : def;
  }
  function lsSet(k, v) {
    mem[k] = v;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 忽略 */ }
  }
  function resp(status, data) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      json: function () { return Promise.resolve(data); }
    };
  }
  function err(status, msg) { return resp(status, { ok: false, error: msg }); }
  function now() { return new Date().toISOString(); }
  function newId(p) { return p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* ---------- 密码（演示级散列，非加密强度） ---------- */
  function hp(pwd, salt) {
    var s = String(pwd) + '::' + String(salt);
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    var h2 = 52711;
    for (var j = s.length - 1; j >= 0; j--) h2 = ((h2 << 5) + h2) ^ s.charCodeAt(j);
    return (h >>> 0).toString(16) + (h2 >>> 0).toString(16);
  }

  /* ---------- 一次性清理：删除测试期间产生的论坛/投稿/客服记录 ----------
   * 仅首次打开新版本时执行一次；保留管理员账号（role=admin）及其登录态，
   * 删除其他测试账号、测试帖子/评论/举报、测试投稿、并入的知识条目、
   * 测试期间的聊天记录与测试会话。 */
  function cleanTestRecords() {
    if (lsGet('kb_l_clean', null)) return;
    var wipe = ['kb_l_forum', 'kb_chat', 'kb_l_subs', 'kb_l_entries'];
    for (var i = 0; i < wipe.length; i++) {
      delete mem[wipe[i]];
      try { localStorage.removeItem(wipe[i]); } catch (e) { /* 忽略 */ }
    }
    var users = lsGet('kb_l_users', null);
    var keep = {};
    if (Array.isArray(users)) {
      users = users.filter(function (u) {
        return u && u.role === 'admin';
      });
      for (var j = 0; j < users.length; j++) keep[users[j].username] = 1;
      lsSet('kb_l_users', users);
    }
    var ss = lsGet('kb_l_sessions', {});
    Object.keys(ss).forEach(function (t) {
      if (!ss[t] || !keep[ss[t].username]) delete ss[t];
    });
    lsSet('kb_l_sessions', ss);
    lsSet('kb_l_clean', 'v1');
  }
  cleanTestRecords();

  /* ---------- 账号 ---------- */
  function loadUsers() {
    var users = lsGet('kb_l_users', null);
    return Array.isArray(users) ? users : [];
  }
  function saveUsers(u) { lsSet('kb_l_users', u); }
  function findUser(users, name) {
    name = String(name || '').toLowerCase();
    for (var i = 0; i < users.length; i++) {
      if (users[i].username.toLowerCase() === name) return users[i];
    }
    return null;
  }
  function publicUser(u) {
    return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, contributions: u.contributions || 0 };
  }
  function currentUser(headers) {
    var auth = (headers && headers['Authorization']) || '';
    var token = auth.indexOf('Bearer ') === 0 ? auth.slice(7) : '';
    if (!token) return null;
    var sessions = lsGet('kb_l_sessions', {});
    var s = sessions[token];
    if (!s || s.exp < Date.now()) return null;
    var user = findUser(loadUsers(), s.username);
    return user || null;
  }
  function createSession(user) {
    var token = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    var sessions = lsGet('kb_l_sessions', {});
    sessions[token] = { username: user.username, exp: Date.now() + 7 * 864e5 };
    lsSet('kb_l_sessions', sessions);
    return token;
  }

  var USER_RE = /^[\w一-龥.\-]{2,20}$/;

  /* ---------- 知识库（内嵌数据 + 本地已通过稿件） ---------- */
  var KB = window.__KB_DATA__;
  function mergeLocalEntries() {
    var extra = lsGet('kb_l_entries', []);
    extra.forEach(function (e) {
      if (!KB.entries.some(function (x) { return x.id === e.id; })) KB.entries.push(e);
    });
    recount();
  }
  function recount() {
    var counts = {};
    KB.entries.forEach(function (e) { counts[e.category] = (counts[e.category] || 0) + 1; });
    KB.counts = counts;
    if (KB.meta) KB.meta.total = KB.entries.length;
  }
  mergeLocalEntries();

  function slugify(title) {
    var s = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (s.length >= 3) return s.slice(0, 60);
    var h = 5381;
    var t = String(title);
    for (var i = 0; i < t.length; i++) h = ((h << 5) + h) ^ t.charCodeAt(i);
    return 'entry-' + (h >>> 0).toString(16);
  }

  function validateSubmission(body) {
    var title = String(body.title || '').trim();
    var summary = String(body.summary || '').trim();
    var content = String(body.content || '').trim();
    var category = String(body.category || '').trim();
    var tags = Array.isArray(body.tags) ? body.tags.map(function (t) { return String(t).trim(); }).filter(Boolean) : [];
    if (title.length < 2 || title.length > 80) return '标题需 2-80 字';
    if (!KB.categories.some(function (c) { return c.id === category; })) return '分类不存在';
    if (!summary || summary.length > 200) return '摘要需 1-200 字';
    if (content.length < 20 || content.length > 8000) return '正文需 20-8000 字';
    if (tags.length > 8) return '标签最多 8 个';
    var sources = [];
    if (body.sources) {
      if (!Array.isArray(body.sources)) return '来源格式错误';
      sources = body.sources
        .map(function (s) { return { title: String((s && s.title) || '').slice(0, 100), url: String((s && s.url) || '').slice(0, 300) }; })
        .filter(function (s) { return s.title && s.url; });
      if (sources.length > 6) return '来源最多 6 条';
    }
    return { title: title, summary: summary, content: content, category: category, tags: tags, sources: sources };
  }

  function approveSubmission(sub, reviewer) {
    var base = slugify(sub.title);
    var id = base;
    var n = 2;
    while (KB.entries.some(function (e) { return e.id === id; })) id = base + '-' + (n++);
    var entry = {
      id: id, title: sub.title, category: sub.category, tags: sub.tags || [],
      summary: sub.summary, content: sub.content, sources: sub.sources || [],
      contributor: sub.author, addedAt: now().slice(0, 10), fromSubmission: sub.id
    };
    KB.entries.push(entry);
    var extra = lsGet('kb_l_entries', []);
    extra.push(entry);
    lsSet('kb_l_entries', extra);
    recount();

    sub.status = 'approved';
    sub.entryId = id;
    sub.reviewer = reviewer;
    sub.reviewedAt = now();

    var users = loadUsers();
    var u = users.filter(function (x) { return x.id === sub.authorId; })[0];
    if (u) { u.contributions = (u.contributions || 0) + 1; saveUsers(users); }
    return entry;
  }

  /* ---------- 投稿 ---------- */
  function loadSubs() { var l = lsGet('kb_l_subs', []); return Array.isArray(l) ? l : []; }
  function saveSubs(l) { lsSet('kb_l_subs', l); }

  /* ---------- 论坛 ---------- */
  function loadForum() {
    var d = lsGet('kb_l_forum', null);
    if (!d || typeof d !== 'object') d = { threads: [], comments: [], reports: [] };
    return {
      threads: Array.isArray(d.threads) ? d.threads : [],
      comments: Array.isArray(d.comments) ? d.comments : [],
      reports: Array.isArray(d.reports) ? d.reports : []
    };
  }
  function saveForum(d) { lsSet('kb_l_forum', d); }

  /* 改昵称：同步所有署名字段（昵称全局唯一，按旧名匹配即可） */
  function renameUserRecords(oldName, newName) {
    var forum = loadForum();
    var fChanged = false;
    forum.threads.forEach(function (t) {
      if (t.author === oldName) { t.author = newName; fChanged = true; }
      if (t.deletedBy === oldName) { t.deletedBy = newName; fChanged = true; }
    });
    forum.comments.forEach(function (c) { if (c.author === oldName) { c.author = newName; fChanged = true; } });
    forum.reports.forEach(function (r) { if (r.reporter === oldName) { r.reporter = newName; fChanged = true; } });
    if (fChanged) saveForum(forum);

    var subs = loadSubs();
    var sChanged = false;
    subs.forEach(function (s) { if (s.author === oldName) { s.author = newName; sChanged = true; } });
    if (sChanged) saveSubs(subs);

    var extra = lsGet('kb_l_entries', []);
    var eChanged = false;
    extra.forEach(function (e) { if (e.contributor === oldName) { e.contributor = newName; eChanged = true; } });
    if (eChanged) {
      lsSet('kb_l_entries', extra);
      // 同步当前页面内存中的知识库（同一对象引用已合并，逐条兜底）
      KB.entries.forEach(function (e) {
        if (e.contributor === oldName) e.contributor = newName;
      });
    }
  }
  function commentCountOf(f, tid) {
    return f.comments.filter(function (c) { return c.threadId === tid && c.status !== 'deleted'; }).length;
  }
  function threadView(t, f, user) {
    return {
      id: t.id, title: t.title, content: t.content, author: t.author, createdAt: t.createdAt,
      likes: (t.likes || []).length,
      liked: !!(user && (t.likes || []).indexOf(user.id) >= 0),
      commentCount: commentCountOf(f, t.id),
      status: t.status || 'visible'
    };
  }
  function commentView(c) {
    return { id: c.id, threadId: c.threadId, content: c.content, author: c.author, createdAt: c.createdAt };
  }

  /* ---------- AI 检索与调用 ---------- */
  function ngrams(str) {
    var runs = String(str || '').toLowerCase().match(/[一-龥]+|[a-z0-9]+/g) || [];
    var set = {};
    runs.forEach(function (r) {
      if (r.length === 1) { set[r] = 1; return; }
      for (var i = 0; i < r.length - 1; i++) set[r.slice(i, i + 2)] = 1;
    });
    return Object.keys(set);
  }
  function searchKB(kw, limit) {
    var question = String(kw || '').toLowerCase();
    var grams = ngrams(question);
    if (!grams.length) return [];
    var scored = KB.entries.map(function (e) {
      var title = String(e.title || '').toLowerCase();
      var tags = (e.tags || []).join(' ').toLowerCase();
      var summary = String(e.summary || '').toLowerCase();
      var content = String(e.content || '').toLowerCase();
      var s = 0;
      grams.forEach(function (g) {
        if (title.indexOf(g) >= 0) s += 3;
        if (tags.indexOf(g) >= 0) s += 2;
        if (summary.indexOf(g) >= 0) s += 1.5;
        if (content.indexOf(g) >= 0) s += 0.5;
      });
      return { e: e, s: s };
    }).filter(function (x) { return x.s >= 2; })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, limit);
    return scored.map(function (x) { return x.e; });
  }

  function aiConfig() {
    var c = window.__AI_CONFIG__ || {};
    return {
      apiKey: c.apiKey || '',
      baseUrl: String(c.baseUrl || '').replace(/\/+$/, ''),
      model: c.model || '',
      temperature: typeof c.temperature === 'number' ? c.temperature : 0.4,
      maxTokens: c.maxTokens || 900,
      systemPrompt: c.systemPrompt || ''
    };
  }
  function aiReady(c) { return !!(c.apiKey && c.baseUrl && c.model); }

  function buildSystemPrompt(cfg, question, sources) {
    var kb;
    if (sources.length) {
      kb = '【知识库资料】回答时优先依据以下站内条目：\n' +
        sources.map(function (e, i) {
          var body = String(e.content || '').replace(/\n{3,}/g, '\n').slice(0, 700);
          return (i + 1) + '. 《' + e.title + '》（分类：' + e.category + '）\n' +
            '   摘要：' + (e.summary || '') + '\n' +
            '   正文节选：' + body;
        }).join('\n\n') + '\n\n';
    } else {
      kb = '【知识库资料】本次未在知识库中找到明显相关条目。\n\n';
    }
    return (cfg.systemPrompt ? cfg.systemPrompt + '\n\n' : '') +
      '你是「陶瓷工艺知识库」网站的智能客服，用简体中文友好、简洁地回答用户关于陶瓷工艺的问题。\n' +
      '规则：\n' +
      '1. 只依据下方知识库资料回答；资料不足时明确说明"知识库暂无相关资料"，可给一般性常识并建议用户在站内搜索。\n' +
      '2. 不要编造具体数据（温度、配比、年代等），不确定就直说。\n' +
      '3. 回答控制在 200 字以内，可用 Markdown 列表。\n' +
      '4. 用户闲聊时简短回应并引导回陶瓷工艺话题。\n\n' +
      kb + '【本次用户问题】' + question;
  }

  function fallbackAnswer(sources) {
    if (!sources.length) {
      return '我暂时无法作答：知识库中没有找到相关资料。\n\n' +
        '可以换个关键词（如「还原焰」「青花」「龙窑」「针孔」）在站内搜索，或换个问法再试试。';
    }
    return '**AI 接口尚未生效**，先按知识库为你找到这些相关内容：\n\n' +
      sources.map(function (e, i) { return (i + 1) + '. **《' + e.title + '》** — ' + (e.summary || ''); }).join('\n') +
      '\n\n点击下方"参考"里的条目查看完整内容。';
  }

  var chatHits = [];
  function rateOk(limit, windowMs) {
    var t = Date.now();
    chatHits = chatHits.filter(function (x) { return t - x < windowMs; });
    if (chatHits.length >= limit) return false;
    chatHits.push(t);
    return true;
  }

  function doChat(body) {
    var raw = Array.isArray(body.messages) ? body.messages : null;
    if (!raw || !raw.length) return Promise.resolve(err(400, 'messages 不能为空'));
    if (raw.length > 20) return Promise.resolve(err(400, '对话过长，请刷新页面重新开始'));
    var history = [];
    for (var i = 0; i < raw.length; i++) {
      var m = raw[i];
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) return Promise.resolve(err(400, '消息 role 非法'));
      var content = String(m.content || '').trim();
      if (!content) return Promise.resolve(err(400, '消息内容不能为空'));
      if (content.length > 2000) return Promise.resolve(err(400, '单条消息过长（≤2000 字）'));
      history.push({ role: m.role, content: content.slice(0, 2000) });
    }
    if (history[history.length - 1].role !== 'user') return Promise.resolve(err(400, '最后一条消息需为用户消息'));

    if (!rateOk(15, 60000)) return Promise.resolve(err(429, '提问太频繁，请稍后再试（每分钟 15 条）'));

    var question = history[history.length - 1].content;
    var sources = searchKB(question, 4);
    var sourceList = sources.map(function (e) { return { id: e.id, title: e.title, category: e.category }; });
    var cfg = aiConfig();

    if (!aiReady(cfg)) {
      return Promise.resolve(resp(200, {
        ok: true, fallback: true, model: null,
        answer: fallbackAnswer(sources), sources: sourceList
      }));
    }

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 45000);
    var messages = [{ role: 'system', content: buildSystemPrompt(cfg, question, sources) }].concat(history);

    return fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model, messages: messages,
        temperature: cfg.temperature, max_tokens: cfg.maxTokens
      }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) return res.text().catch(function () { return ''; }).then(function (text) {
        throw new Error('AI 接口错误 ' + res.status + '：' + String(text).slice(0, 200));
      });
      return res.json();
    }).then(function (data) {
      var answer = data && data.choices && data.choices[0] &&
        data.choices[0].message && data.choices[0].message.content;
      if (!answer) throw new Error('AI 返回格式异常');
      return resp(200, { ok: true, fallback: false, model: cfg.model, answer: String(answer).trim(), sources: sourceList });
    }).catch(function (e) {
      return resp(200, {
        ok: true, fallback: true, model: cfg.model, error: String((e && e.message) || e),
        answer: 'AI 接口调用失败：' + String((e && e.message) || e) + '\n\n' + fallbackAnswer(sources),
        sources: sourceList
      });
    }).then(function (r) { clearTimeout(timer); return r; }, function (e) {
      clearTimeout(timer);
      return resp(200, {
        ok: true, fallback: true, model: cfg.model, error: String((e && e.message) || e),
        answer: 'AI 接口调用失败：' + String((e && e.message) || e) + '\n\n' + fallbackAnswer(sources),
        sources: sourceList
      });
    });
  }

  /* ---------- 路由 ---------- */
  window.__LOCAL_BACKEND__ = function (path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var headers = opts.headers || {};
    var body = null;
    try { body = opts.body ? JSON.parse(opts.body) : {}; } catch (e) { body = {}; }
    var q = path.indexOf('?');
    var pathname = q >= 0 ? path.slice(0, q) : path;
    var query = q >= 0 ? path.slice(q + 1) : '';
    var user = currentUser(headers);

    if (pathname === '/api/health') return Promise.resolve(resp(200, { ok: true, name: '陶瓷工艺知识库' }));

    if (pathname === '/api/kb' && method === 'GET') return Promise.resolve(resp(200, KB));

    /* 账号 */
    if (pathname === '/api/register' && method === 'POST') {
      var username = String(body.username || '').trim();
      if (!USER_RE.test(username)) return Promise.resolve(err(400, '用户名需 2-20 位，限中文/字母/数字/. _ -'));
      if (String(body.password || '').length < 6) return Promise.resolve(err(400, '密码至少 6 位'));
      if (String(body.password || '').length > 72) return Promise.resolve(err(400, '密码过长'));
      var users0 = loadUsers();
      if (findUser(users0, username)) return Promise.resolve(err(409, '用户名已被注册'));
      var salt = newId('s');
      var nu = {
        id: newId('u'), username: username, role: 'user', salt: salt,
        hash: hp(body.password, salt), createdAt: now(), contributions: 0
      };
      users0.push(nu);
      saveUsers(users0);
      return Promise.resolve(resp(200, { ok: true, token: createSession(nu), user: publicUser(nu) }));
    }

    if (pathname === '/api/login' && method === 'POST') {
      var users1 = loadUsers();
      var u1 = findUser(users1, body.username);
      if (!u1 || u1.hash !== hp(body.password, u1.salt)) return Promise.resolve(err(401, '用户名或密码错误'));
      return Promise.resolve(resp(200, { ok: true, token: createSession(u1), user: publicUser(u1) }));
    }

    if (pathname === '/api/logout' && method === 'POST') {
      var auth = (headers['Authorization'] || '');
      var tk = auth.indexOf('Bearer ') === 0 ? auth.slice(7) : '';
      if (tk) {
        var ss = lsGet('kb_l_sessions', {});
        delete ss[tk];
        lsSet('kb_l_sessions', ss);
      }
      return Promise.resolve(resp(200, { ok: true }));
    }

    if (pathname === '/api/me' && method === 'GET') {
      return Promise.resolve(resp(200, { ok: true, user: user ? publicUser(user) : null }));
    }

    /* 账号设置：改昵称 */
    if (pathname === '/api/user/rename' && method === 'POST') {
      if (!user) return Promise.resolve(err(401, '请先登录'));
      var newName = String(body.username || '').trim();
      if (!USER_RE.test(newName)) return Promise.resolve(err(400, '用户名需 2-20 位，限中文/字母/数字/. _ -'));
      if (newName === user.username) return Promise.resolve(err(400, '与当前昵称相同'));
      var usersR = loadUsers();
      var uR = findUser(usersR, user.username);
      if (!uR) return Promise.resolve(err(401, '请先登录'));
      var dupR = findUser(usersR, newName);
      if (dupR && dupR.id !== uR.id) return Promise.resolve(err(409, '该昵称已被占用'));
      var oldName = uR.username;
      uR.username = newName;
      saveUsers(usersR);
      var sessR = lsGet('kb_l_sessions', {});
      Object.keys(sessR).forEach(function (t) {
        if (sessR[t] && sessR[t].username === oldName) sessR[t].username = newName;
      });
      lsSet('kb_l_sessions', sessR);
      renameUserRecords(oldName, newName);
      return Promise.resolve(resp(200, { ok: true, user: publicUser(uR) }));
    }

    /* 账号设置：改密码 */
    if (pathname === '/api/user/password' && method === 'POST') {
      if (!user) return Promise.resolve(err(401, '请先登录'));
      var oldp = String(body.oldPassword || '');
      var newp = String(body.newPassword || '');
      if (user.hash !== hp(oldp, user.salt)) return Promise.resolve(err(400, '原密码不正确'));
      if (String(newp).length < 6) return Promise.resolve(err(400, '密码至少 6 位'));
      if (String(newp).length > 72) return Promise.resolve(err(400, '密码过长'));
      if (newp === oldp) return Promise.resolve(err(400, '新密码不能与原密码相同'));
      var usersP = loadUsers();
      var uP = findUser(usersP, user.username);
      if (!uP) return Promise.resolve(err(401, '请先登录'));
      var saltP = newId('s');
      uP.salt = saltP;
      uP.hash = hp(newp, saltP);
      saveUsers(usersP);
      // 保留当前会话，踢掉其他登录
      var authP = (headers['Authorization'] || '');
      var curTk = authP.indexOf('Bearer ') === 0 ? authP.slice(7) : '';
      var sessP = lsGet('kb_l_sessions', {});
      Object.keys(sessP).forEach(function (t) {
        if (t !== curTk && sessP[t] && sessP[t].username === uP.username) delete sessP[t];
      });
      lsSet('kb_l_sessions', sessP);
      return Promise.resolve(resp(200, { ok: true }));
    }

    /* 投稿 */
    if (pathname === '/api/submissions' && method === 'GET') {
      if (!user) return Promise.resolve(err(401, '请先登录'));
      var st = /status=([^&]+)/.exec(query);
      var stv = st ? decodeURIComponent(st[1]) : '';
      var list0 = loadSubs();
      if (user.role !== 'admin') list0 = list0.filter(function (s) { return s.authorId === user.id; });
      else if (stv && stv !== 'all') list0 = list0.filter(function (s) { return s.status === stv; });
      list0 = list0.slice().sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
      return Promise.resolve(resp(200, { ok: true, submissions: list0, role: user.role }));
    }

    if (pathname === '/api/submissions' && method === 'POST') {
      if (!user) return Promise.resolve(err(401, '请先登录'));
      var v = validateSubmission(body);
      if (typeof v === 'string') return Promise.resolve(err(400, v));
      var sub = Object.assign(v, {
        id: newId('s'), author: user.username, authorId: user.id,
        status: 'pending', rejectReason: '', createdAt: now()
      });
      var list1 = loadSubs();
      list1.push(sub);
      saveSubs(list1);
      return Promise.resolve(resp(200, { ok: true, submission: sub }));
    }

    var sm = pathname.match(/^\/api\/submissions\/([^/]+)(\/approve|\/reject)?$/);
    if (sm) {
      var sid = decodeURIComponent(sm[1]);
      var action = sm[2] || '';
      if (!user) return Promise.resolve(err(401, '请先登录'));
      var list2 = loadSubs();
      var sub2 = list2.filter(function (s) { return s.id === sid; })[0];
      if (!sub2) return Promise.resolve(err(404, '投稿不存在'));
      if (!(user.role === 'admin' || sub2.authorId === user.id)) return Promise.resolve(err(403, '无权查看该投稿'));
      if (!action && method === 'GET') return Promise.resolve(resp(200, { ok: true, submission: sub2 }));
      if (user.role !== 'admin') return Promise.resolve(err(403, '仅管理员可审核'));
      if (sub2.status !== 'pending') return Promise.resolve(err(400, '该稿件已处理'));
      if (action === '/approve' && method === 'POST') {
        var entry = approveSubmission(sub2, user.username);
        saveSubs(list2);
        return Promise.resolve(resp(200, { ok: true, entryId: entry.id, submission: sub2 }));
      }
      if (action === '/reject' && method === 'POST') {
        sub2.status = 'rejected';
        sub2.rejectReason = String(body.reason || '').slice(0, 300);
        sub2.reviewer = user.username;
        sub2.reviewedAt = now();
        saveSubs(list2);
        return Promise.resolve(resp(200, { ok: true, submission: sub2 }));
      }
      if (method === 'POST') return Promise.resolve(err(404, '未知操作'));
    }

    /* 论坛 */
    if (pathname === '/api/forum' && method === 'GET') {
      var f0 = loadForum();
      var threads0 = f0.threads
        .filter(function (t) { return t.status !== 'deleted'; })
        .slice()
        .sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); })
        .map(function (t) { return threadView(t, f0, user); });
      var out0 = { ok: true, threads: threads0, count: threads0.length };
      if (user && user.role === 'admin') {
        out0.pendingReports = f0.reports.filter(function (r) { return r.status === 'pending'; }).length;
      }
      return Promise.resolve(resp(200, out0));
    }

    if (pathname === '/api/forum/threads' && method === 'POST') {
      if (!user) return Promise.resolve(err(401, '请先登录'));
      var title = String(body.title || '').trim();
      var content = String(body.content || '').trim();
      if (title.length < 2 || title.length > 60) return Promise.resolve(err(400, '标题需 2-60 字'));
      if (content.length < 2 || content.length > 4000) return Promise.resolve(err(400, '内容需 2-4000 字'));
      var f1 = loadForum();
      var t1 = {
        id: newId('t'), title: title, content: content,
        author: user.username, authorId: user.id,
        createdAt: now(), likes: [], status: 'visible'
      };
      f1.threads.push(t1);
      saveForum(f1);
      return Promise.resolve(resp(200, { ok: true, thread: threadView(t1, f1, user) }));
    }

    var tm;
    if ((tm = pathname.match(/^\/api\/forum\/threads\/([^/]+)$/)) && method === 'GET') {
      var tid = decodeURIComponent(tm[1]);
      var f2 = loadForum();
      var t2 = f2.threads.filter(function (x) { return x.id === tid; })[0];
      if (!t2 || t2.status === 'deleted') return Promise.resolve(err(404, '帖子不存在或已删除'));
      var comments2 = f2.comments
        .filter(function (c) { return c.threadId === tid && c.status !== 'deleted'; })
        .slice()
        .sort(function (a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')); })
        .map(commentView);
      return Promise.resolve(resp(200, { ok: true, thread: threadView(t2, f2, user), comments: comments2 }));
    }

    if ((tm = pathname.match(/^\/api\/forum\/threads\/([^/]+)\/comments$/)) && method === 'POST') {
      if (!user) return Promise.resolve(err(401, '请先登录'));
      var ccontent = String(body.content || '').trim();
      if (ccontent.length < 1 || ccontent.length > 1000) return Promise.resolve(err(400, '评论需 1-1000 字'));
      var f3 = loadForum();
      var t3 = f3.threads.filter(function (x) { return x.id === decodeURIComponent(tm[1]); })[0];
      if (!t3 || t3.status === 'deleted') return Promise.resolve(err(404, '帖子不存在或已删除'));
      var c3 = {
        id: newId('c'), threadId: t3.id, content: ccontent,
        author: user.username, authorId: user.id, createdAt: now(), status: 'visible'
      };
      f3.comments.push(c3);
      saveForum(f3);
      return Promise.resolve(resp(200, { ok: true, comment: commentView(c3), commentCount: commentCountOf(f3, t3.id) }));
    }

    if ((tm = pathname.match(/^\/api\/forum\/threads\/([^/]+)\/(like|report|delete)$/)) && method === 'POST') {
      if (!user) return Promise.resolve(err(401, '请先登录'));
      var taction = tm[2];
      var f4 = loadForum();
      var t4 = f4.threads.filter(function (x) { return x.id === decodeURIComponent(tm[1]); })[0];
      if (!t4 || t4.status === 'deleted') return Promise.resolve(err(404, '帖子不存在或已删除'));

      if (taction === 'like') {
        var idx = (t4.likes || []).indexOf(user.id);
        if (idx >= 0) t4.likes.splice(idx, 1); else t4.likes.push(user.id);
        saveForum(f4);
        return Promise.resolve(resp(200, { ok: true, liked: idx < 0, likes: t4.likes.length }));
      }
      if (taction === 'delete') {
        if (user.role !== 'admin') return Promise.resolve(err(403, '仅管理员可删帖'));
        t4.status = 'deleted';
        t4.deletedBy = user.username;
        t4.deletedAt = now();
        saveForum(f4);
        return Promise.resolve(resp(200, { ok: true }));
      }
      if (taction === 'report') {
        var reason = String(body.reason || '').trim();
        if (!reason || reason.length > 200) return Promise.resolve(err(400, '请填写举报原因（1-200 字）'));
        var dup = f4.reports.filter(function (r) {
          return r.status === 'pending' && r.targetType === 'thread' && r.targetId === t4.id && r.reporterId === user.id;
        })[0];
        if (dup) return Promise.resolve(err(409, '你已举报过该帖子，管理员正在处理'));
        f4.reports.push({
          id: newId('r'), targetType: 'thread', targetId: t4.id, threadId: t4.id,
          reason: reason, reporter: user.username, reporterId: user.id,
          createdAt: now(), status: 'pending'
        });
        saveForum(f4);
        return Promise.resolve(resp(200, { ok: true }));
      }
    }

    if ((tm = pathname.match(/^\/api\/forum\/comments\/([^/]+)\/(report|delete)$/)) && method === 'POST') {
      if (!user) return Promise.resolve(err(401, '请先登录'));
      var caction = tm[2];
      var f5 = loadForum();
      var c5 = f5.comments.filter(function (x) { return x.id === decodeURIComponent(tm[1]); })[0];
      if (!c5 || c5.status === 'deleted') return Promise.resolve(err(404, '评论不存在或已删除'));

      if (caction === 'delete') {
        if (user.role !== 'admin') return Promise.resolve(err(403, '仅管理员可删除评论'));
        c5.status = 'deleted';
        c5.deletedBy = user.username;
        saveForum(f5);
        return Promise.resolve(resp(200, { ok: true }));
      }
      if (caction === 'report') {
        var creason = String(body.reason || '').trim();
        if (!creason || creason.length > 200) return Promise.resolve(err(400, '请填写举报原因（1-200 字）'));
        var cdup = f5.reports.filter(function (r) {
          return r.status === 'pending' && r.targetType === 'comment' && r.targetId === c5.id && r.reporterId === user.id;
        })[0];
        if (cdup) return Promise.resolve(err(409, '你已举报过该评论，管理员正在处理'));
        f5.reports.push({
          id: newId('r'), targetType: 'comment', targetId: c5.id, threadId: c5.threadId,
          reason: creason, reporter: user.username, reporterId: user.id,
          createdAt: now(), status: 'pending'
        });
        saveForum(f5);
        return Promise.resolve(resp(200, { ok: true }));
      }
    }

    if (pathname === '/api/forum/reports' && method === 'GET') {
      if (!user) return Promise.resolve(err(401, '请先登录'));
      if (user.role !== 'admin') return Promise.resolve(err(403, '仅管理员可查看举报记录'));
      var f6 = loadForum();
      var reports6 = f6.reports
        .slice()
        .sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); })
        .map(function (r) {
          var target = null;
          if (r.targetType === 'thread') {
            var tt = f6.threads.filter(function (x) { return x.id === r.targetId; })[0];
            target = tt ? { title: tt.title, author: tt.author, threadId: tt.id, deleted: tt.status === 'deleted' } : null;
          } else {
            var cc = f6.comments.filter(function (x) { return x.id === r.targetId; })[0];
            target = cc ? {
              title: cc.content.slice(0, 60), author: cc.author,
              threadId: cc.threadId, deleted: cc.status === 'deleted'
            } : null;
          }
          return Object.assign({}, r, { target: target });
        });
      return Promise.resolve(resp(200, {
        ok: true, reports: reports6,
        pending: f6.reports.filter(function (r) { return r.status === 'pending'; }).length
      }));
    }

    var rm;
    if ((rm = pathname.match(/^\/api\/forum\/reports\/([^/]+)\/handle$/)) && method === 'POST') {
      if (!user) return Promise.resolve(err(401, '请先登录'));
      if (user.role !== 'admin') return Promise.resolve(err(403, '仅管理员可处理举报'));
      var action2 = String(body.action || '');
      if (action2 !== 'delete' && action2 !== 'dismiss') return Promise.resolve(err(400, 'action 需为 delete 或 dismiss'));
      var f7 = loadForum();
      var r7 = f7.reports.filter(function (x) { return x.id === decodeURIComponent(rm[1]); })[0];
      if (!r7) return Promise.resolve(err(404, '举报不存在'));
      if (r7.status !== 'pending') return Promise.resolve(err(400, '该举报已处理'));

      if (action2 === 'delete') {
        if (r7.targetType === 'thread') {
          var dt = f7.threads.filter(function (x) { return x.id === r7.targetId; })[0];
          if (dt && dt.status !== 'deleted') {
            dt.status = 'deleted';
            dt.deletedBy = user.username;
            dt.deletedAt = now();
          }
        } else {
          var dc = f7.comments.filter(function (x) { return x.id === r7.targetId; })[0];
          if (dc && dc.status !== 'deleted') {
            dc.status = 'deleted';
            dc.deletedBy = user.username;
          }
        }
      }
      r7.status = 'handled';
      r7.action = action2;
      r7.handledBy = user.username;
      r7.handledAt = now();
      saveForum(f7);
      return Promise.resolve(resp(200, {
        ok: true, report: r7,
        pending: f7.reports.filter(function (x) { return x.status === 'pending'; }).length
      }));
    }

    /* AI 客服 */
    if (pathname === '/api/chat/config' && method === 'GET') {
      var cfg = aiConfig();
      return Promise.resolve(resp(200, { ok: true, configured: aiReady(cfg), model: cfg.model || null }));
    }

    if (pathname === '/api/chat' && method === 'POST') return doChat(body);

    return Promise.resolve(err(404, 'unknown api'));
  };
})();
