/* 陶瓷工艺知识库 前端逻辑 */
(function () {
  'use strict';

  const OFFLINE = !!window.__KB_DATA__; // 单文件版：走浏览器内本地后端（local-backend.js），功能与服务器版一致

  const state = {
    meta: null,
    categories: [],
    counts: {},
    entries: [],
    byId: {},
    user: null,
    flash: '',
    authMode: 'login',
    threadCount: 0,
    reportPending: 0,
    chatOpen: false,
    chatBusy: false,
    chatFocus: false,
    chatMessages: [],
    chatConfig: null
  };

  const main = document.getElementById('main');
  const sidebar = document.getElementById('sidebar');
  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const authArea = document.getElementById('auth-area');

  /* ---------- 本地令牌 ---------- */
  function getToken() {
    try { return localStorage.getItem('kb_token'); } catch (e) { return null; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem('kb_token', t);
      else localStorage.removeItem('kb_token');
    } catch (e) { /* 忽略 */ }
  }

  function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const doFetch = (OFFLINE && window.__LOCAL_BACKEND__)
      ? () => window.__LOCAL_BACKEND__(path, { method: opts.method || 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
      : () => fetch(path, {
          method: opts.method || 'GET',
          headers: headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
        });
    return doFetch().then(r => r.json().then(data => {
      if (r.status === 401) { setToken(null); state.user = null; renderAuthArea(); }
      if (!r.ok || data.ok === false) throw new Error(data.error || ('请求失败 (' + r.status + ')'));
      return data;
    }));
  }

  function applyKB(data) {
    state.meta = data.meta;
    state.categories = data.categories;
    state.counts = data.counts || {};
    state.entries = data.entries || [];
    state.byId = {};
    state.entries.forEach(e => { state.byId[e.id] = e; });
    document.getElementById('header-meta').textContent =
      state.entries.length + ' 条知识 · ' + state.categories.length + ' 分类';
    document.getElementById('footer-meta').textContent =
      state.meta.name + ' v' + state.meta.version + ' · ';
  }

  function setFlash(msg) { state.flash = msg || ''; }

  function flashHtml() {
    if (!state.flash) return '';
    const html = '<div class="flash">' + esc(state.flash) + '</div>';
    state.flash = '';
    return html;
  }

  function needLogin(what) {
    main.innerHTML = '<div class="auth-card"><h2>请先登录</h2>' +
      '<p>' + esc(what || '该功能需要登录后使用') + '</p>' +
      '<div class="form-actions"><button class="btn primary" data-nav="#/login">去登录 / 注册</button></div></div>';
  }

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function catOf(id) {
    return state.categories.find(c => c.id === id) || { id: id, name: id, icon: '📄', desc: '' };
  }

  function plainText(entry) {
    return [entry.title, entry.summary, (entry.tags || []).join(' '), entry.content]
      .join(' \n ')
      .replace(/[#*|>`_-]/g, ' ');
  }

  /* ---------- 简易 Markdown 渲染 ---------- */
  function inline(text) {
    let out = esc(text);
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/`([^`]+?)`/g, '<code>$1</code>');
    out = out.replace(/\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return out;
  }

  function renderMarkdown(md) {
    const lines = String(md || '').split('\n');
    let html = '';
    let list = null;       // 'ul' | 'ol'
    let table = false;
    let para = [];

    function flushPara() {
      if (para.length) {
        html += '<p>' + inline(para.join(' ')) + '</p>';
        para = [];
      }
    }
    function closeList() {
      if (list) { html += '</' + list + '>'; list = null; }
    }
    function closeTable() {
      if (table) { html += '</tbody></table>'; table = false; }
    }
    function flushAll() { flushPara(); closeList(); closeTable(); }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();

      if (!line) { flushAll(); continue; }

      // 表格
      if (line.indexOf('|') === 0 || /^\|.*\|/.test(line)) {
        const cells = line.replace(/^\||\|$/g, '').split('|').map(s => s.trim());
        if (cells.every(c => /^-{2,}$/.test(c))) continue; // 分隔行
        if (!table) {
          flushPara(); closeList();
          html += '<table><tbody>';
          table = true;
          html += '<tr>' + cells.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr>';
        } else {
          html += '<tr>' + cells.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>';
        }
        continue;
      }
      if (table) closeTable();

      // 标题
      const h = line.match(/^(#{2,4})\s+(.*)$/);
      if (h) {
        flushAll();
        const lvl = h[1].length;
        html += '<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>';
        continue;
      }

      // 列表
      const ul = line.match(/^[-*]\s+(.*)$/);
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const want = ul ? 'ul' : 'ol';
        if (list && list !== want) closeList();
        if (!list) { closeTable(); html += '<' + want + '>'; list = want; }
        html += '<li>' + inline((ul || ol)[1]) + '</li>';
        continue;
      }
      closeList();

      // 其余视为段落
      para.push(line);
    }
    flushAll();
    return html;
  }

  function highlight(text, kw) {
    const safe = esc(text);
    if (!kw) return safe;
    try {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return safe.replace(re, m => '<span class="highlight">' + m + '</span>');
    } catch (e) {
      return safe;
    }
  }

  /* ---------- 搜索 ---------- */
  function search(kw) {
    const key = kw.trim().toLowerCase();
    if (!key) return [];
    return state.entries
      .map(e => {
        const hay = plainText(e).toLowerCase();
        const title = e.title.toLowerCase();
        let score = 0;
        if (title.indexOf(key) >= 0) score += 100;
        if ((e.tags || []).some(t => t.toLowerCase().indexOf(key) >= 0)) score += 40;
        if ((e.summary || '').toLowerCase().indexOf(key) >= 0) score += 20;
        const idx = hay.indexOf(key);
        if (idx >= 0) score += 10;
        return { e: e, score: score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(x => x.e);
  }

  /* ---------- 组件 ---------- */
  function entryCard(e, kw) {
    const c = catOf(e.category);
    return '<article class="entry-card" data-goto="' + esc(e.id) + '">' +
      '<h3>' + highlight(e.title, kw) + '</h3>' +
      '<p class="summary">' + highlight(e.summary || '', kw) + '</p>' +
      '<div class="entry-meta">' +
      '<span class="badge cat">' + esc(c.icon) + ' ' + esc(c.name) + '</span>' +
      (e.tags || []).slice(0, 5).map(t => '<span class="badge">' + highlight(t, kw) + '</span>').join('') +
      '</div></article>';
  }

  function renderSidebar(activeId, query) {
    let html = '<div class="side-title">知识分类</div>';
    html += '<div class="side-item' + (!activeId && !query ? ' active' : '') + '" data-nav="#/">' +
      '<span>📚 全部条目</span><span class="num">' + state.entries.length + '</span></div>';
    for (const c of state.categories) {
      html += '<div class="side-item' + (activeId === c.id ? ' active' : '') +
        '" data-nav="#/c/' + c.id + '"><span>' + c.icon + ' ' + esc(c.name) +
        '</span><span class="num">' + (state.counts[c.id] || 0) + '</span></div>';
    }
    if (query) {
      html += '<div class="side-divider"></div>' +
        '<div class="side-item active"><span>🔍 搜索结果</span><span class="num">' +
        search(query).length + '</span></div>';
    }
    if (!OFFLINE || window.__LOCAL_BACKEND__) {
      html += '<div class="side-divider"></div>' +
        '<div class="side-item' + (activeId === 'forum' ? ' active' : '') + '" data-nav="#/forum">' +
        '<span>💬 论坛</span><span class="num">' + (state.threadCount || 0) + '</span></div>';
      if (state.user && state.user.role === 'admin') {
        html += '<div class="side-item' + (activeId === 'reports' ? ' active' : '') + '" data-nav="#/forum/reports">' +
          '<span>🚨 举报箱</span><span class="num">' + (state.reportPending || 0) + '</span></div>';
      }
    }
    sidebar.innerHTML = html;
  }

  function refreshForumCounts() {
    if (OFFLINE && !window.__LOCAL_BACKEND__) return Promise.resolve();
    return api('/api/forum')
      .then(d => {
        state.threadCount = d.count || 0;
        if (d.pendingReports !== undefined) state.reportPending = d.pendingReports;
        renderHeaderNav();
      })
      .catch(() => { /* 忽略 */ });
  }

  /* ---------- 账号区（页头） ---------- */
  function renderHeaderNav() {
    const nav = document.getElementById('header-nav');
    if (!nav) return;
    if (OFFLINE && !window.__LOCAL_BACKEND__) { nav.innerHTML = ''; return; }
    let html = '<a href="#/forum">💬 论坛</a>';
    if (state.user && state.user.role === 'admin') {
      html += '<a href="#/forum/reports" class="admin">🚨 举报箱' +
        (state.reportPending ? ' · ' + state.reportPending : '') + '</a>';
    }
    nav.innerHTML = html;
  }

  function renderAuthArea() {
    renderHeaderNav();
    if (OFFLINE && !window.__LOCAL_BACKEND__) {
      authArea.innerHTML = '<span class="auth-chip offline" title="单文件展示版：注册/投稿/审核需运行 node server.js">📄 单文件版</span>';
      return;
    }
    if (!state.user) {
      authArea.innerHTML =
        '<button class="btn ghost" data-nav="#/login">登录</button>' +
        '<button class="btn ghost" data-nav="#/login?mode=register">注册</button>';
      return;
    }
    const admin = state.user.role === 'admin';
    authArea.innerHTML =
      '<span class="auth-chip user">👤 ' + esc(state.user.username) +
      (admin ? ' · 管理员' : '') + '</span>' +
      '<button class="btn ghost" data-nav="#/submit">投稿</button>' +
      '<button class="btn ghost" data-nav="#/mine">我的投稿</button>' +
      (admin ? '<button class="btn ghost warn" data-nav="#/admin">审核台' +
        (state.pendingCount ? ' · ' + state.pendingCount : '') + '</button>' : '') +
      '<button class="btn ghost" data-nav="#/settings">设置</button>' +
      '<button class="btn ghost" data-action="logout">退出</button>';
  }

  function refreshPendingCount() {
    if ((OFFLINE && !window.__LOCAL_BACKEND__) || !state.user || state.user.role !== 'admin') return Promise.resolve();
    return api('/api/submissions?status=pending')
      .then(d => { state.pendingCount = (d.submissions || []).length; renderAuthArea(); })
      .catch(() => { /* 忽略 */ });
  }

  /* ---------- 账号：登录 / 注册 ---------- */
  function renderLogin(query) {
    document.title = '登录 · 陶瓷工艺知识库';
    const isReg = state.authMode === 'register';
    main.innerHTML = '<div class="auth-card">' +
      '<h2>' + (isReg ? '注册账号' : '登录') + '</h2>' +
      '<p class="muted">' + (isReg
        ? '注册后即可投稿，审核通过的稿件会进入知识库。'
        : '登录后可投稿并查看审核进度。') + '</p>' +
      '<div class="tabs">' +
      '<button class="tab' + (isReg ? '' : ' active') + '" data-action="auth-mode" data-mode="login">登录</button>' +
      '<button class="tab' + (isReg ? ' active' : '') + '" data-action="auth-mode" data-mode="register">注册</button>' +
      '</div>' +
      '<form data-form="' + (isReg ? 'register' : 'login') + '">' +
      '<label>用户名<input name="username" maxlength="20" autocomplete="username" required placeholder="2-20 位，中英文/数字" /></label>' +
      '<label>密码<input name="password" type="password" maxlength="72" autocomplete="' +
      (isReg ? 'new-password' : 'current-password') + '" required placeholder="至少 6 位" /></label>' +
      (isReg ? '<label>确认密码<input name="password2" type="password" maxlength="72" autocomplete="new-password" required /></label>' : '') +
      '<div class="form-msg" id="form-msg"></div>' +
      '<div class="form-actions"><button class="btn primary" type="submit">' +
      (isReg ? '注册并登录' : '登录') + '</button></div>' +
      '</form>' +
      '<p class="muted small">管理员账号由管理员在服务器端创建，普通账号只能投稿。</p>' +
      '</div>';
  }

  /* ---------- 账号设置：改昵称 / 改密码 ---------- */
  function renderSettings() {
    document.title = '账号设置 · 陶瓷工艺知识库';
    if (!state.user) return needLogin('账号设置需要先登录账号。');
    const admin = state.user.role === 'admin';
    main.innerHTML = '<a class="back-link" href="#/">← 返回首页</a>' + flashHtml() +
      '<div class="form-card">' +
      '<h1>⚙️ 账号设置</h1>' +
      '<p class="muted">当前账号：<strong>' + esc(state.user.username) + '</strong>' +
      (admin ? '（管理员）' : '') +
      (state.user.createdAt ? ' · 注册于 ' + esc(String(state.user.createdAt).slice(0, 10)) : '') + '</p>' +
      '<h3>修改昵称</h3>' +
      '<form data-form="rename">' +
      '<label>新昵称<input name="username" maxlength="20" autocomplete="username" required placeholder="2-20 位，中英文/数字/._-" /></label>' +
      '<div class="form-msg" id="form-msg"></div>' +
      '<div class="form-actions"><button class="btn primary" type="submit">保存昵称</button></div>' +
      '</form>' +
      '<div class="form-divider"></div>' +
      '<h3>修改密码</h3>' +
      '<form data-form="password" data-msg="form-msg-pw">' +
      '<label>原密码<input name="oldPassword" type="password" maxlength="72" autocomplete="current-password" required /></label>' +
      '<label>新密码<input name="password" type="password" maxlength="72" autocomplete="new-password" required placeholder="至少 6 位" /></label>' +
      '<label>确认新密码<input name="password2" type="password" maxlength="72" autocomplete="new-password" required /></label>' +
      '<div class="form-msg" id="form-msg-pw"></div>' +
      '<div class="form-actions"><button class="btn primary" type="submit">修改密码</button></div>' +
      '</form>' +
      '<p class="muted small">昵称修改后，你在论坛与投稿中的署名会同步更新；修改密码后其他设备会自动退出登录。</p>' +
      '</div>';
  }

  /* ---------- 投稿表单 ---------- */
  function renderSubmit() {
    document.title = '我要投稿 · 陶瓷工艺知识库';
    if (!state.user) return needLogin('投稿需要先登录账号。');
    const opts = state.categories.map(c =>
      '<option value="' + esc(c.id) + '">' + c.icon + ' ' + esc(c.name) + '</option>').join('');
    main.innerHTML = '<a class="back-link" href="#/">← 返回首页</a>' +
      '<div class="form-card">' +
      '<h1>✍️ 投稿新条目</h1>' +
      '<p class="muted">提交后进入待审核队列，管理员审核通过会自动加入知识库并署名。</p>' +
      '<form data-form="submit">' +
      '<label>标题<input name="title" maxlength="80" required placeholder="如：电窑与气窑的烧成曲线对比" /></label>' +
      '<label>分类<select name="category" required><option value="">请选择…</option>' + opts + '</select></label>' +
      '<label>标签（用逗号分隔）<input name="tags" maxlength="120" placeholder="烧成, 窑炉, 温度曲线" /></label>' +
      '<label>摘要<textarea name="summary" maxlength="200" rows="2" required placeholder="一两句话概括本条内容（200 字内）"></textarea></label>' +
      '<label>正文（支持 Markdown：## 标题、- 列表、| 表格、**加粗**）' +
      '<textarea name="content" rows="14" required placeholder="## 小标题&#10;正文内容…&#10;- 要点一&#10;- 要点二"></textarea></label>' +
      '<label>参考来源（可选，每行一条：标题 | 链接）' +
      '<textarea name="sources" rows="3" placeholder="景德镇陶录 | https://example.com/xxx"></textarea></label>' +
      '<div class="form-msg" id="form-msg"></div>' +
      '<div class="form-actions"><button class="btn primary" type="submit">提交审核</button>' +
      '<button class="btn" type="button" data-nav="#/mine">查看我的投稿</button></div>' +
      '</form></div>';
  }

  /* ---------- 我的投稿 ---------- */
  const STATUS_LABEL = {
    pending: ['待审核', 'st-pending'],
    approved: ['已通过', 'st-approved'],
    rejected: ['已退回', 'st-rejected']
  };

  function statusBadge(s) {
    const meta = STATUS_LABEL[s.status] || [s.status, ''];
    let html = '<span class="status ' + meta[1] + '">' + meta[0] + '</span>';
    if (s.status === 'approved' && s.entryId) {
      html += ' <a href="#/e/' + encodeURIComponent(s.entryId) + '">查看已收录条目 →</a>';
    }
    if (s.status === 'rejected' && s.rejectReason) {
      html += '<div class="reason">退回原因：' + esc(s.rejectReason) + '</div>';
    }
    return html;
  }

  function subCard(s, admin) {
    const c = catOf(s.category);
    let html = '<article class="entry-card sub-card">' +
      '<h3>' + esc(s.title) + ' ' + statusBadge(s) + '</h3>' +
      '<p class="summary">' + esc(s.summary || '') + '</p>' +
      '<div class="entry-meta">' +
      '<span class="badge cat">' + c.icon + ' ' + esc(c.name) + '</span>' +
      (s.tags || []).map(t => '<span class="badge">' + esc(t) + '</span>').join('') +
      '<span class="badge">' + esc(s.author) + ' · ' + (s.createdAt || '').slice(0, 10) + '</span>' +
      '</div>' +
      '<div class="sub-actions">' +
      '<button class="btn small" data-action="preview-sub" data-id="' + esc(s.id) + '">预览</button>';
    if (admin && s.status === 'pending') {
      html += '<button class="btn small primary" data-action="approve" data-id="' + esc(s.id) + '">通过并入库</button>' +
        '<button class="btn small danger" data-action="reject" data-id="' + esc(s.id) + '">退回</button>';
    }
    html += '</div><div class="reject-box" id="rj-' + esc(s.id) + '"></div>' +
      '<div class="sub-preview" id="pv-' + esc(s.id) + '"></div></article>';
    return html;
  }

  function renderMine() {
    document.title = '我的投稿 · 陶瓷工艺知识库';
    if (!state.user) return needLogin('查看投稿记录需要登录。');
    main.innerHTML = '<div class="loading">加载投稿记录…</div>';
    api('/api/submissions').then(d => {
      const list = d.submissions || [];
      let html = '<a class="back-link" href="#/">← 返回首页</a>' +
        '<div class="page-head"><h1>📮 我的投稿</h1><p>共 ' + list.length + ' 篇 · ' +
        '待审核 ' + list.filter(s => s.status === 'pending').length +
        ' · 已通过 ' + list.filter(s => s.status === 'approved').length +
        ' · 已退回 ' + list.filter(s => s.status === 'rejected').length + '</p></div>';
      html += flashHtml();
      html += '<div class="form-actions"><button class="btn primary" data-nav="#/submit">＋ 新投稿</button></div>';
      if (!list.length) {
        html += '<div class="empty">还没有投稿，点击「新投稿」写下你的陶瓷工艺心得。</div>';
      } else {
        html += '<div class="entry-list">' + list.map(s => subCard(s, false)).join('') + '</div>';
      }
      main.innerHTML = html;
      window.scrollTo(0, 0);
    }).catch(err => {
      main.innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
    });
  }

  /* ---------- 管理员审核台 ---------- */
  function renderAdmin() {
    document.title = '审核台 · 陶瓷工艺知识库';
    if (!state.user) return needLogin('审核需要登录。');
    if (state.user.role !== 'admin') {
      main.innerHTML = '<div class="empty">当前账号不是管理员，无权审核。</div>';
      return;
    }
    main.innerHTML = '<div class="loading">加载待审核稿件…</div>';
    api('/api/submissions').then(d => {
      const all = d.submissions || [];
      const pending = all.filter(s => s.status === 'pending');
      const handled = all.filter(s => s.status !== 'pending');
      state.pendingCount = pending.length;
      renderAuthArea();

      let html = '<div class="page-head"><h1>🛡️ 投稿审核台</h1>' +
        '<p>待审核 ' + pending.length + ' · 已处理 ' + handled.length +
        '（通过后自动写入知识库）</p></div>' + flashHtml();

      html += '<div class="section-title">待审核</div>';
      html += pending.length
        ? '<div class="entry-list">' + pending.map(s => subCard(s, true)).join('') + '</div>'
        : '<div class="empty">暂无待审核稿件 🎉</div>';

      if (handled.length) {
        html += '<div class="section-title">已处理</div>' +
          '<div class="entry-list">' + handled.map(s => subCard(s, true)).join('') + '</div>';
      }
      main.innerHTML = html;
      window.scrollTo(0, 0);
    }).catch(err => {
      main.innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
    });
  }

  /* ---------- 论坛 ---------- */
  function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16);
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function threadRow(t) {
    return '<article class="thread-card" data-nav="#/forum/t/' + encodeURIComponent(t.id) + '">' +
      '<div class="thread-main"><h3>' + esc(t.title) + '</h3>' +
      '<div class="thread-meta">' +
      '<span class="badge">✍️ ' + esc(t.author) + '</span>' +
      '<span class="badge">' + timeAgo(t.createdAt) + '</span>' +
      '<span class="badge">💬 ' + t.commentCount + '</span>' +
      '<span class="badge' + (t.liked ? ' liked' : '') + '">👍 ' + t.likes + '</span>' +
      '</div></div></article>';
  }

  function renderForum() {
    document.title = '交流论坛 · 陶瓷工艺知识库';
    renderSidebar('forum', '');
    main.innerHTML = '<div class="loading">加载帖子…</div>';
    api('/api/forum').then(d => {
      state.threadCount = d.count || 0;
      if (d.pendingReports !== undefined) state.reportPending = d.pendingReports;
      renderSidebar('forum', '');
      renderHeaderNav();

      let html = '<div class="page-head"><h1>💬 交流论坛</h1>' +
        '<p>讨论陶瓷工艺问题、分享经验，可评论、点赞，违规内容可举报（' +
        state.threadCount + ' 个帖子）</p></div>';
      html += flashHtml();
      html += '<div class="form-actions">' + (state.user
        ? '<button class="btn primary" data-nav="#/forum/new">＋ 发新帖</button>'
        : '<button class="btn primary" data-nav="#/login">登录后发帖</button>') + '</div>';
      const list = d.threads || [];
      html += list.length
        ? '<div class="thread-list">' + list.map(threadRow).join('') + '</div>'
        : '<div class="empty">还没有帖子，来发第一帖吧。</div>';
      main.innerHTML = html;
      window.scrollTo(0, 0);
    }).catch(err => {
      main.innerHTML = '<div class="empty">论坛加载失败：' + esc(err.message) + '</div>';
    });
  }

  function commentRow(c) {
    let html = '<div class="comment-card">' +
      '<div class="comment-head"><strong>' + esc(c.author) + '</strong>' +
      '<span class="muted small">' + timeAgo(c.createdAt) + '</span><span class="comment-ops">';
    if (state.user) {
      html += '<button class="btn small" data-action="report-open" data-type="comment" data-id="' +
        esc(c.id) + '">举报</button>';
    }
    if (state.user && state.user.role === 'admin') {
      html += '<button class="btn small danger" data-action="delete-comment" data-id="' +
        esc(c.id) + '">删除</button>';
    }
    html += '</span></div>' +
      '<div class="comment-body content">' + renderMarkdown(c.content) + '</div>' +
      '<div class="report-box" id="rp-comment-' + esc(c.id) + '"></div></div>';
    return html;
  }

  function renderThread(id) {
    renderSidebar('forum', '');
    main.innerHTML = '<div class="loading">加载帖子…</div>';
    api('/api/forum/threads/' + encodeURIComponent(id)).then(d => {
      const t = d.thread;
      const comments = d.comments || [];
      document.title = t.title + ' · 论坛';
      renderSidebar('forum', '');

      let html = '<a class="back-link" href="#/forum">← 返回论坛</a>' + flashHtml();
      html += '<article class="detail thread-detail">' +
        '<h1>' + esc(t.title) + '</h1>' +
        '<div class="tags">' +
        '<span class="badge cat">✍️ ' + esc(t.author) + '</span>' +
        '<span class="badge">' + timeAgo(t.createdAt) + '</span>' +
        '<span class="badge' + (t.liked ? ' liked' : '') + '">👍 ' + t.likes + '</span>' +
        '<span class="badge">💬 ' + comments.length + '</span></div>' +
        '<div class="content">' + renderMarkdown(t.content) + '</div>' +
        '<div class="post-actions">' +
        '<button class="btn small" data-action="like" data-id="' + esc(t.id) + '">' +
        (t.liked ? '已赞 👍' : '👍 点赞') + '</button>';
      if (state.user) {
        html += '<button class="btn small" data-action="report-open" data-type="thread" data-id="' +
          esc(t.id) + '">举报</button>';
      }
      if (state.user && state.user.role === 'admin') {
        html += '<button class="btn small danger" data-action="delete-thread" data-id="' +
          esc(t.id) + '">删除帖子</button>';
      }
      html += '</div><div class="report-box" id="rp-thread-' + esc(t.id) + '"></div></article>';

      html += '<div class="section-title">评论 ' + comments.length + '</div>';
      html += comments.length
        ? comments.map(commentRow).join('')
        : '<div class="empty">还没有评论，来说两句。</div>';

      if (state.user) {
        html += '<form class="comment-form" data-form="forum-comment" data-id="' + esc(t.id) + '">' +
          '<textarea name="content" rows="3" maxlength="1000" required placeholder="写下你的评论…"></textarea>' +
          '<div class="form-msg" id="form-msg"></div>' +
          '<div class="form-actions"><button class="btn primary" type="submit">发表评论</button></div></form>';
      } else {
        html += '<div class="empty">登录后即可评论、点赞和举报。</div>';
      }
      main.innerHTML = html;
      window.scrollTo(0, 0);
    }).catch(err => {
      main.innerHTML = '<div class="empty">' + esc(err.message) +
        ' <a href="#/forum">返回论坛</a></div>';
    });
  }

  function renderNewThread() {
    document.title = '发帖 · 论坛';
    if (!state.user) return needLogin('发帖需要先登录账号。');
    main.innerHTML = '<a class="back-link" href="#/forum">← 返回论坛</a>' +
      '<div class="form-card"><h1>✏️ 发新帖</h1>' +
      '<p class="muted">发布后其他用户可以评论、点赞。</p>' +
      '<form data-form="forum-new">' +
      '<label>标题<input name="title" maxlength="60" required placeholder="如：龙窑烧成时如何控制还原气氛？" /></label>' +
      '<label>正文（支持 Markdown：## 标题、- 列表、| 表格）' +
      '<textarea name="content" rows="10" maxlength="4000" required placeholder="描述你的问题或经验…"></textarea></label>' +
      '<div class="form-msg" id="form-msg"></div>' +
      '<div class="form-actions"><button class="btn primary" type="submit">发布</button>' +
      '<button class="btn" type="button" data-nav="#/forum">取消</button></div>' +
      '</form></div>';
  }

  function reportCard(r) {
    const t = r.target;
    const typeLabel = r.targetType === 'thread' ? '帖子' : '评论';
    const st = r.status === 'pending'
      ? '<span class="status st-pending">待处理</span>'
      : (r.action === 'delete'
        ? '<span class="status st-rejected">已删除内容</span>'
        : '<span class="status st-approved">已忽略</span>');
    let html = '<article class="entry-card report-card">' +
      '<h3>举报' + typeLabel + '：' + esc(t ? t.title : '（内容已不存在）') + ' ' + st + '</h3>' +
      '<p class="summary">原因：' + esc(r.reason) + '</p>' +
      '<div class="entry-meta">' +
      '<span class="badge">举报人：' + esc(r.reporter) + '</span>' +
      (t ? '<span class="badge">作者：' + esc(t.author) + '</span>' : '') +
      '<span class="badge">' + timeAgo(r.createdAt) + '</span>' +
      (t && !t.deleted && t.threadId
        ? '<span class="badge"><a href="#/forum/t/' + encodeURIComponent(t.threadId) + '">查看原帖</a></span>'
        : '') +
      (r.handledBy ? '<span class="badge">处理人：' + esc(r.handledBy) + '</span>' : '') +
      '</div>';
    if (r.status === 'pending') {
      html += '<div class="sub-actions">' +
        '<button class="btn small danger" data-action="report-delete" data-id="' + esc(r.id) + '">删除内容并处理</button>' +
        '<button class="btn small" data-action="report-dismiss" data-id="' + esc(r.id) + '">忽略</button></div>';
    }
    html += '</article>';
    return html;
  }

  function renderReports() {
    document.title = '举报箱 · 论坛';
    if (!state.user) return needLogin('举报箱需要登录管理员账号。');
    if (state.user.role !== 'admin') {
      main.innerHTML = '<div class="empty">仅管理员可查看举报记录。</div>';
      return;
    }
    renderSidebar('reports', '');
    main.innerHTML = '<div class="loading">加载举报记录…</div>';
    api('/api/forum/reports').then(d => {
      state.reportPending = d.pending || 0;
      renderSidebar('reports', '');
      renderHeaderNav();
      const list = d.reports || [];
      const pending = list.filter(r => r.status === 'pending');
      const handled = list.filter(r => r.status !== 'pending');
      let html = '<div class="page-head"><h1>🚨 举报箱</h1>' +
        '<p>待处理 ' + pending.length + ' · 已处理 ' + handled.length +
        '（删除内容后帖子/评论立即从论坛消失）</p></div>';
      html += flashHtml();
      html += pending.length
        ? '<div class="report-list">' + pending.map(reportCard).join('') + '</div>'
        : '<div class="empty">暂无待处理举报 🎉</div>';
      if (handled.length) {
        html += '<div class="section-title">已处理</div>' +
          '<div class="report-list">' + handled.map(reportCard).join('') + '</div>';
      }
      main.innerHTML = html;
      window.scrollTo(0, 0);
    }).catch(err => {
      main.innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
    });
  }

  /* ---------- AI 智能客服 ---------- */
  const CHAT_QUICK = [
    '什么是还原焰？',
    '青花瓷是怎么烧成的？',
    '釉面针孔怎么解决？',
    '龙窑和隧道窑有什么区别？'
  ];
  const chatWidget = document.getElementById('chat-widget');

  function loadChatConfig() {
    return api('/api/chat/config')
      .then(d => { state.chatConfig = d; renderChat(); })
      .catch(() => { state.chatConfig = { configured: false }; renderChat(); });
  }

  function saveChat() {
    try { localStorage.setItem('kb_chat', JSON.stringify(state.chatMessages.slice(-20))); } catch (e) { /* 忽略 */ }
  }

  function restoreChat() {
    try {
      const v = JSON.parse(localStorage.getItem('kb_chat') || '[]');
      if (Array.isArray(v)) {
        state.chatMessages = v.filter(m => m &&
          (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
      }
    } catch (e) {
      state.chatMessages = [];
    }
  }

  function chatMsgHtml(m) {
    const side = m.role === 'user' ? 'me' : 'bot';
    let html = '<div class="chat-msg ' + side + (m.error ? ' err' : '') + '">' +
      '<div class="chat-bubble">' + renderMarkdown(m.content) + '</div>';
    if (m.sources && m.sources.length) {
      html += '<div class="chat-src">参考：' + m.sources.map(s =>
        '<a href="#/e/' + encodeURIComponent(s.id) + '" data-action="chat-nav" data-nav="#/e/' +
        encodeURIComponent(s.id) + '">' + esc(s.title) + '</a>').join('　') + '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderChat() {
    if (!chatWidget) return;
    if (OFFLINE && !window.__LOCAL_BACKEND__) { chatWidget.innerHTML = ''; return; }

    if (!state.chatOpen) {
      chatWidget.innerHTML = '<button class="chat-fab" type="button" data-action="chat-toggle" ' +
        'title="打开智能客服">💬 智能客服</button>';
      return;
    }

    const cfg = state.chatConfig || {};
    let html = '<div class="chat-panel" role="dialog" aria-label="智能客服">';
    html += '<div class="chat-head">' +
      '<span class="chat-title">🤖 智能客服</span>' +
      '<span class="chat-sub">' + (cfg.configured ? esc(cfg.model || 'AI 已接入') : '知识库模式') + '</span>' +
      '<button class="chat-x" type="button" data-action="chat-clear" title="清空对话">🗑</button>' +
      '<button class="chat-x" type="button" data-action="chat-close" title="关闭">×</button></div>';
    if (cfg.configured === false) {
      html += OFFLINE
        ? '<div class="chat-notice">AI 接口未生效：本单文件未嵌入 AI 配置。在 <code>ai.config.json</code> 填入 key 后重新 <code>node scripts/build.js</code>，当前仅返回知识库匹配结果。</div>'
        : '<div class="chat-notice">AI 接口未配置：在 <code>ai.config.json</code> 填入 apiKey/model 后自动启用，' +
          '当前仅返回知识库匹配结果。</div>';
    }
    html += '<div class="chat-msgs" id="chat-msgs">';
    if (!state.chatMessages.length) {
      html += '<div class="chat-msg bot"><div class="chat-bubble">你好！我是陶瓷工艺知识库的智能客服 🏺<br>可以问我陶瓷工艺问题，例如：</div></div>' +
        '<div class="chat-hints">' + CHAT_QUICK.map(q => '<span>' + esc(q) + '</span>').join('') + '</div>';
    }
    for (const m of state.chatMessages) html += chatMsgHtml(m);
    if (state.chatBusy) {
      html += '<div class="chat-msg bot"><div class="chat-bubble typing"><i></i><i></i><i></i></div></div>';
    }
    html += '</div>';

    if (state.chatMessages.length) {
      html += '<div class="chat-quick">' + CHAT_QUICK.map(q =>
        '<button class="chat-chip" type="button" data-action="chat-quick" data-q="' + esc(q) + '">' +
        esc(q) + '</button>').join('') + '</div>';
    }
    html += '<form class="chat-form" data-form="chat" id="chat-form">' +
      '<textarea id="chat-input" name="message" rows="1" maxlength="2000" ' +
      'placeholder="输入问题，Enter 发送 / Shift+Enter 换行"></textarea>' +
      '<button class="btn primary" type="submit"' + (state.chatBusy ? ' disabled' : '') + '>发送</button>' +
      '</form></div>';

    chatWidget.innerHTML = html;
    const box = document.getElementById('chat-msgs');
    if (box) box.scrollTop = box.scrollHeight;
    const input = document.getElementById('chat-input');
    if (input && state.chatFocus && input.focus) { input.focus(); state.chatFocus = false; }
  }

  function sendChat(text) {
    const q = String(text || '').trim();
    if (!q || state.chatBusy) return;
    state.chatOpen = true;
    state.chatFocus = false;
    state.chatMessages.push({ role: 'user', content: q });
    state.chatBusy = true;
    renderChat();

    api('/api/chat', {
      method: 'POST',
      body: {
        messages: state.chatMessages.slice(-12)
          .map(m => ({ role: m.role, content: m.content }))
      }
    })
      .then(d => {
        state.chatMessages.push({
          role: 'assistant',
          content: d.answer || '（AI 未返回内容）',
          sources: d.sources || [],
          fallback: !!d.fallback
        });
        saveChat();
      })
      .catch(e => {
        state.chatMessages.push({ role: 'assistant', content: '出错了：' + e.message, error: true });
      })
      .then(() => { state.chatBusy = false; renderChat(); });
  }

  /* ---------- 页面 ---------- */
  function renderHome() {
    document.title = '陶瓷工艺知识库';
    let html = flashHtml();
    html += '<div class="page-head">' +
      '<h1>🏺 陶瓷工艺知识库</h1>' +
      '<p>' + esc(state.meta.description || '') + '　当前共 ' + state.entries.length + ' 条 · ' +
      state.categories.length + ' 个分类　（更新：' + esc(state.meta.updated || '') + '）</p></div>';

    html += '<div class="cta-strip"><div class="cta-text">' +
      '<strong>✍️ 分享你的陶瓷工艺心得</strong>' +
      '<p>注册账号即可投稿，管理员审核通过后自动收录进知识库并署名。</p></div>' +
      '<button class="btn primary" data-nav="' +
      (state.user ? '#/submit' : '#/login') + '">' +
      (state.user ? '我要投稿' : '登录后投稿') + '</button></div>';

    html += '<div class="cat-grid">';
    for (const c of state.categories) {
      html += '<div class="cat-card" data-nav="#/c/' + c.id + '">' +
        '<div class="cat-icon">' + c.icon + '</div>' +
        '<h3>' + esc(c.name) + '</h3>' +
        '<p>' + esc(c.desc) + '</p>' +
        '<div class="cat-count">' + (state.counts[c.id] || 0) + ' 条 →</div></div>';
    }
    html += '</div>';

    html += '<div class="section-title">最新收录条目</div><div class="entry-list">';
    for (const e of state.entries) html += entryCard(e);
    html += '</div>';
    main.innerHTML = html;
  }

  function renderCategory(id) {
    const c = catOf(id);
    document.title = c.name + ' · 陶瓷工艺知识库';
    const list = state.entries.filter(e => e.category === id);
    let html = '<a class="back-link" href="#/">← 返回全部分类</a>';
    html += '<div class="page-head"><h1>' + c.icon + ' ' + esc(c.name) + '</h1>' +
      '<p>' + esc(c.desc) + '　·　' + list.length + ' 条</p></div>';
    html += '<div class="entry-list">';
    for (const e of list) html += entryCard(e);
    html += '</div>';
    main.innerHTML = html;
  }

  function renderSearch(kw) {
    document.title = '搜索：' + kw + ' · 陶瓷工艺知识库';
    const list = search(kw);
    let html = '<a class="back-link" href="#/">← 返回全部分类</a>';
    html += '<div class="page-head"><h1>🔍 搜索「' + esc(kw) + '」</h1>' +
      '<p>找到 ' + list.length + ' 条结果（按相关度排序）</p></div>';
    if (!list.length) {
      html += '<div class="empty">没有匹配的条目，试试「青花」「还原焰」「等静压」「干燥」等关键词。</div>';
    } else {
      html += '<div class="entry-list">';
      for (const e of list) html += entryCard(e, kw);
      html += '</div>';
    }
    main.innerHTML = html;
  }

  function renderEntry(id) {
    const e = state.byId[id];
    if (!e) {
      main.innerHTML = '<div class="empty">未找到该条目。<a href="#/">返回首页</a></div>';
      return;
    }
    const c = catOf(e.category);
    document.title = e.title + ' · 陶瓷工艺知识库';

    let html = '<a class="back-link" href="#/c/' + esc(e.category) + '">← 返回 ' + esc(c.name) + '</a>';
    html += '<article class="detail">';
    html += '<h1>' + esc(e.title) + '</h1>';
    html += '<div class="tags"><span class="badge cat">' + c.icon + ' ' + esc(c.name) + '</span>' +
      (e.tags || []).map(t => '<span class="badge">' + esc(t) + '</span>').join('') + '</div>';
    if (e.summary) html += '<div class="summary-box">' + esc(e.summary) + '</div>';
    if (e.contributor) {
      html += '<div class="contributor">📌 投稿人：' + esc(e.contributor) + '　收录于 ' + esc(e.addedAt || '') + '</div>';
    }
    html += '<div class="content">' + renderMarkdown(e.content) + '</div>';

    if (e.sources && e.sources.length) {
      html += '<div class="sources"><h4>📎 参考来源</h4><ul>' +
        e.sources.map(s => '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' +
          esc(s.title) + '</a></li>').join('') + '</ul></div>';
    }

    const related = state.entries
      .filter(x => x.id !== e.id && (x.category === e.category ||
        (x.tags || []).some(t => (e.tags || []).indexOf(t) >= 0)))
      .slice(0, 5);
    if (related.length) {
      html += '<div class="related"><h4>相关条目</h4><div class="entry-list">' +
        related.map(x => entryCard(x)).join('') + '</div></div>';
    }

    html += '</article>';
    main.innerHTML = html;
    window.scrollTo(0, 0);
  }

  /* ---------- 路由 ---------- */
  function route() {
    const hash = location.hash || '#/';
    const parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    let seg = parts[0] || '';
    const qi = seg.indexOf('?');
    const query = qi >= 0 ? seg.slice(qi + 1) : '';
    if (qi >= 0) seg = seg.slice(0, qi);

    if (seg === 'c' && parts[1]) {
      renderSidebar(parts[1], '');
      renderCategory(parts[1]);
    } else if (seg === 'q' && parts[1]) {
      const kw = parts.slice(1).join('/');
      searchInput.value = kw;
      renderSidebar('', kw);
      renderSearch(kw);
    } else if (seg === 'e' && parts[1]) {
      const e = state.byId[parts[1]];
      renderSidebar(e ? e.category : '', '');
      renderEntry(parts[1]);
    } else if (seg === 'login') {
      state.authMode = query.indexOf('mode=register') >= 0 ? 'register' : 'login';
      renderSidebar('', '');
      renderLogin(query);
    } else if (seg === 'submit') {
      renderSidebar('', '');
      renderSubmit();
    } else if (seg === 'settings') {
      renderSidebar('', '');
      renderSettings();
    } else if (seg === 'mine') {
      renderSidebar('', '');
      renderMine();
    } else if (seg === 'admin') {
      renderSidebar('', '');
      renderAdmin();
    } else if (seg === 'forum') {
      const sub = parts[1] || '';
      if (sub === 'new') {
        renderSidebar('forum', '');
        renderNewThread();
      } else if (sub === 'reports') {
        renderSidebar('reports', '');
        renderReports();
      } else if (sub === 't' && parts[2]) {
        renderSidebar('forum', '');
        renderThread(parts[2]);
      } else {
        renderSidebar('forum', '');
        renderForum();
      }
    } else {
      renderSidebar('', '');
      renderHome();
    }
  }

  function gotoSearch() {
    const kw = searchInput.value.trim();
    location.hash = kw ? '#/q/' + encodeURIComponent(kw) : '#/';
  }

  /* ---------- 账号/审核动作 ---------- */
  function formMsg(text, ok, form) {
    let target = null;
    if (form && form.getAttribute) {
      const mid = form.getAttribute('data-msg');
      if (mid) target = document.getElementById(mid);
    }
    if (!target) target = document.getElementById('form-msg');
    if (!target) return;
    target.textContent = text || '';
    target.className = 'form-msg' + (text ? (ok ? ' ok' : ' err') : '');
  }

  function previewSubmission(id) {
    const box = document.getElementById('pv-' + id);
    if (!box) return;
    if (box.innerHTML) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="loading">加载预览…</div>';
    api('/api/submissions/' + encodeURIComponent(id))
      .then(d => {
        const s = d.submission;
        box.innerHTML = '<div class="content">' + renderMarkdown(s.content) + '</div>' +
          (s.sources && s.sources.length
            ? '<div class="sources"><h4>📎 参考来源</h4><ul>' +
              s.sources.map(x => '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' +
                esc(x.title) + '</a></li>').join('') + '</ul></div>'
            : '');
      })
      .catch(e => { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  function afterReview(msg) {
    setFlash(msg);
    return api('/api/kb').then(applyKB).then(() => { route(); });
  }

  function approveSub(id) {
    if (window.confirm && !window.confirm('确认通过并写入知识库？')) return;
    api('/api/submissions/' + encodeURIComponent(id) + '/approve', { method: 'POST' })
      .then(d => afterReview('已通过并写入知识库（条目 id：' + d.entryId + '）'))
      .catch(e => { setFlash('操作失败：' + e.message); route(); })
      .then(refreshPendingCount);
  }

  function rejectSub(id, reason) {
    api('/api/submissions/' + encodeURIComponent(id) + '/reject',
      { method: 'POST', body: { reason: reason } })
      .then(() => afterReview('已退回该稿件'))
      .catch(e => { setFlash('操作失败：' + e.message); route(); })
      .then(refreshPendingCount);
  }

  function openRejectPanel(id) {
    const box = document.getElementById('rj-' + id);
    if (!box) return;
    box.innerHTML = '<form class="reject-form" data-form="reject" data-id="' + esc(id) + '">' +
      '<label>退回原因（投稿人可见）' +
      '<textarea name="reason" rows="2" maxlength="300" required ' +
      'placeholder="例如：与已有条目重复，请补充独特内容"></textarea></label>' +
      '<div class="form-actions">' +
      '<button class="btn small danger" type="submit">确认退回</button>' +
      '<button class="btn small" type="button" data-action="reject-cancel" data-id="' + esc(id) + '">取消</button>' +
      '</div></form>';
    const ta = box.querySelector && box.querySelector('textarea');
    if (ta && ta.focus) ta.focus();
  }

  function closeRejectPanel(id) {
    const box = document.getElementById('rj-' + id);
    if (box) box.innerHTML = '';
  }

  /* ---------- 论坛动作 ---------- */
  function likeThread(id) {
    if (!state.user) {
      setFlash('请先登录后再点赞');
      location.hash = '#/login';
      return;
    }
    api('/api/forum/threads/' + encodeURIComponent(id) + '/like', { method: 'POST' })
      .then(() => route())
      .catch(e => { setFlash('操作失败：' + e.message); route(); });
  }

  function openReportPanel(type, id) {
    const box = document.getElementById('rp-' + type + '-' + id);
    if (!box) return;
    box.innerHTML = '<form class="reject-form" data-form="forum-report" data-type="' + esc(type) +
      '" data-id="' + esc(id) + '">' +
      '<label>举报原因（管理员可见）' +
      '<textarea name="reason" rows="2" maxlength="200" required placeholder="如：内容与主题无关 / 含不当言论…"></textarea></label>' +
      '<div class="form-actions">' +
      '<button class="btn small danger" type="submit">提交举报</button>' +
      '<button class="btn small" type="button" data-action="report-cancel" data-type="' + esc(type) +
      '" data-id="' + esc(id) + '">取消</button></div></form>';
    const ta = box.querySelector && box.querySelector('textarea');
    if (ta && ta.focus) ta.focus();
  }

  function closeReportPanel(type, id) {
    const box = document.getElementById('rp-' + type + '-' + id);
    if (box) box.innerHTML = '';
  }

  function deleteThread(id) {
    if (window.confirm && !window.confirm('确认删除该帖子？此操作不可恢复。')) return;
    api('/api/forum/threads/' + encodeURIComponent(id) + '/delete', { method: 'POST' })
      .then(() => { setFlash('帖子已删除'); location.hash = '#/forum'; })
      .catch(e => { setFlash('操作失败：' + e.message); route(); })
      .then(refreshForumCounts);
  }

  function deleteComment(id) {
    if (window.confirm && !window.confirm('确认删除该评论？')) return;
    api('/api/forum/comments/' + encodeURIComponent(id) + '/delete', { method: 'POST' })
      .then(() => { setFlash('评论已删除'); route(); })
      .catch(e => { setFlash('操作失败：' + e.message); route(); });
  }

  function handleReport(id, action) {
    if (action === 'delete' && window.confirm && !window.confirm('确认删除被举报的内容？')) return;
    api('/api/forum/reports/' + encodeURIComponent(id) + '/handle',
      { method: 'POST', body: { action: action } })
      .then(() => { setFlash(action === 'delete' ? '已删除被举报内容' : '已忽略该举报'); route(); })
      .catch(e => { setFlash('操作失败：' + e.message); route(); })
      .then(refreshForumCounts);
  }

  function handleAction(action, el) {
    const id = el.getAttribute('data-id');
    switch (action) {
      case 'logout':
        api('/api/logout', { method: 'POST' }).catch(() => {}).then(() => {
          setToken(null);
          state.user = null;
          state.pendingCount = 0;
          renderAuthArea();
          setFlash('已退出登录');
          location.hash = '#/';
        });
        break;
      case 'auth-mode':
        state.authMode = el.getAttribute('data-mode') || 'login';
        renderLogin('');
        break;
      case 'enter-site': {
        const ld = document.getElementById('landing');
        if (!ld) break;
        ld.className = 'landing landing-out';
        const hideLd = () => { ld.style.display = 'none'; };
        if (typeof setTimeout === 'function') setTimeout(hideLd, 480); else hideLd();
        break;
      }
      case 'preview-sub': previewSubmission(id); break;
      case 'approve': approveSub(id); break;
      case 'reject': openRejectPanel(id); break;
      case 'reject-cancel': closeRejectPanel(id); break;
      case 'like': likeThread(id); break;
      case 'report-open': openReportPanel(el.getAttribute('data-type'), id); break;
      case 'report-cancel': closeReportPanel(el.getAttribute('data-type'), id); break;
      case 'delete-thread': deleteThread(id); break;
      case 'delete-comment': deleteComment(id); break;
      case 'report-delete': handleReport(id, 'delete'); break;
      case 'report-dismiss': handleReport(id, 'dismiss'); break;
      case 'chat-toggle': state.chatOpen = true; state.chatFocus = true; renderChat(); break;
      case 'chat-close': state.chatOpen = false; renderChat(); break;
      case 'chat-clear': state.chatMessages = []; saveChat(); renderChat(); break;
      case 'chat-quick': sendChat(el.getAttribute('data-q')); break;
      case 'chat-nav':
        state.chatOpen = false;
        renderChat();
        location.hash = el.getAttribute('data-nav');
        break;
      default: break;
    }
  }

  function handleForm(name, form) {
    const get = n => (form.elements && form.elements[n] ? form.elements[n].value : '');

    if (name === 'login' || name === 'register') {
      const username = get('username').trim();
      const password = get('password');
      if (name === 'register' && password !== get('password2')) {
        return formMsg('两次输入的密码不一致', false);
      }
      formMsg('提交中…', true);
      api('/api/' + name, { method: 'POST', body: { username: username, password: password } })
        .then(d => {
          setToken(d.token);
          state.user = d.user;
          renderAuthArea();
          setFlash(name === 'register' ? '注册成功，欢迎 ' + d.user.username : '欢迎回来，' + d.user.username);
          location.hash = '#/';
          refreshPendingCount();
        })
        .catch(e => formMsg(e.message, false));
      return;
    }

    if (name === 'rename') {
      const username = get('username').trim();
      if (!username) return formMsg('请输入新昵称', false, form);
      if (username === state.user.username) return formMsg('与当前昵称相同', false, form);
      formMsg('提交中…', true, form);
      api('/api/user/rename', { method: 'POST', body: { username: username } })
        .then(d => {
          state.user = d.user;
          renderAuthArea();
          setFlash('昵称已修改为「' + d.user.username + '」');
          route();
        })
        .catch(e => formMsg(e.message, false, form));
      return;
    }

    if (name === 'password') {
      const oldPassword = get('oldPassword');
      const newPassword = get('password');
      if (!oldPassword) return formMsg('请输入原密码', false, form);
      if (newPassword !== get('password2')) return formMsg('两次输入的新密码不一致', false, form);
      if (newPassword === oldPassword) return formMsg('新密码不能与原密码相同', false, form);
      formMsg('提交中…', true, form);
      api('/api/user/password', { method: 'POST', body: { oldPassword: oldPassword, newPassword: newPassword } })
        .then(() => {
          setFlash('密码已修改');
          route();
        })
        .catch(e => formMsg(e.message, false, form));
      return;
    }

    if (name === 'reject') {
      const subId = form.getAttribute('data-id');
      const reason = get('reason').trim() || '不符合收录要求';
      rejectSub(subId, reason);
      return;
    }

    if (name === 'chat') {
      const input = form.elements && form.elements.message;
      sendChat(input ? input.value : '');
      return;
    }

    if (name === 'forum-new') {
      formMsg('发布中…', true);
      api('/api/forum/threads', {
        method: 'POST',
        body: { title: get('title').trim(), content: get('content').trim() }
      })
        .then(d => {
          setFlash('帖子已发布');
          location.hash = '#/forum/t/' + encodeURIComponent(d.thread.id);
        })
        .catch(e => formMsg(e.message, false));
      return;
    }

    if (name === 'forum-comment') {
      const threadId = form.getAttribute('data-id');
      formMsg('提交中…', true);
      api('/api/forum/threads/' + encodeURIComponent(threadId) + '/comments',
        { method: 'POST', body: { content: get('content').trim() } })
        .then(() => { setFlash('评论已发表'); route(); })
        .catch(e => formMsg(e.message, false));
      return;
    }

    if (name === 'forum-report') {
      const type = form.getAttribute('data-type');
      const targetId = form.getAttribute('data-id');
      const path = type === 'comment'
        ? '/api/forum/comments/' + encodeURIComponent(targetId) + '/report'
        : '/api/forum/threads/' + encodeURIComponent(targetId) + '/report';
      formMsg('提交中…', true);
      api(path, { method: 'POST', body: { reason: get('reason').trim() } })
        .then(() => { setFlash('举报已提交，管理员会尽快处理'); route(); })
        .catch(e => formMsg(e.message, false));
      return;
    }

    if (name === 'submit') {
      const tags = get('tags').split(/[,，、]/).map(s => s.trim()).filter(Boolean);
      const sources = get('sources').split('\n').map(line => {
        line = line.trim();
        if (!line) return null;
        const i = line.search(/[|｜]/);
        if (i > 0) return { title: line.slice(0, i).trim(), url: line.slice(i + 1).trim() };
        const m = line.match(/^(.*?)\s+(https?:\/\/\S+)$/);
        return m ? { title: m[1].trim(), url: m[2] } : null;
      }).filter(Boolean);

      const body = {
        title: get('title').trim(),
        category: get('category'),
        tags: tags,
        summary: get('summary').trim(),
        content: get('content').trim(),
        sources: sources
      };
      formMsg('提交中…', true);
      api('/api/submissions', { method: 'POST', body: body })
        .then(() => {
          setFlash('投稿已提交，等待管理员审核');
          location.hash = '#/mine';
        })
        .catch(e => formMsg(e.message, false));
    }
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', function (ev) {
    const act = ev.target.closest('[data-action]');
    if (act) { handleAction(act.getAttribute('data-action'), act); return; }
    const nav = ev.target.closest('[data-nav]');
    if (nav) { location.hash = nav.getAttribute('data-nav'); return; }
    const goto = ev.target.closest('[data-goto]');
    if (goto) { location.hash = '#/e/' + encodeURIComponent(goto.getAttribute('data-goto')); }
  });

  document.addEventListener('submit', function (ev) {
    const form = ev.target;
    const name = form.getAttribute && form.getAttribute('data-form');
    if (!name) return;
    ev.preventDefault();
    handleForm(name, form);
  });

  document.addEventListener('keydown', function (ev) {
    const t = ev.target;
    if (!t || t.id !== 'chat-input') return;
    if (ev.key === 'Enter' && !ev.shiftKey) {
      if (ev.preventDefault) ev.preventDefault();
      const f = document.getElementById('chat-form');
      const input = f && f.elements && f.elements.message;
      sendChat(input ? input.value : '');
    }
  });

  searchBtn.addEventListener('click', gotoSearch);
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') gotoSearch();
  });
  window.addEventListener('hashchange', route);

  /* ---------- 启动：单文件版用内嵌数据，服务器版走接口 ---------- */
  const loader = window.__KB_DATA__
    ? Promise.resolve(window.__KB_DATA__)
    : fetch('/api/kb').then(r => r.json());

  loader
    .then(data => {
      applyKB(data);

      const authReady = getToken()
        ? api('/api/me').then(d => { state.user = d.user || null; }).catch(() => { state.user = null; })
        : Promise.resolve();

      return authReady
        .then(() => refreshForumCounts())
        .then(() => {
          renderAuthArea();
          route();
          refreshPendingCount();
          restoreChat();
          renderChat();
          loadChatConfig();
        });
    })
    .catch(err => {
      main.innerHTML = '<div class="empty">知识库加载失败：' + esc(err.message) +
        '<br>服务器版请运行 <code>node server.js</code> 后访问；单文件版请重新执行 <code>node scripts/build.js</code> 生成。</div>';
    });
})();
