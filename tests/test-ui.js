/* 最小 DOM 模拟：验证单文件版渲染 + 浏览器内本地后端交互 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'dist', '陶瓷工艺知识库.html'), 'utf8');
const dataJson = html.match(/window\.__KB_DATA__=(\{[\s\S]*?\});<\/script>/)[1];
const kbEntries = JSON.parse(dataJson).entries.length;
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const aiCfgSrc = scripts.find(s => /window\.__AI_CONFIG__=/.test(s));
const backendSrc = scripts.find(s => /__LOCAL_BACKEND__/.test(s));
const appSrc = scripts.find(s => /前端逻辑/.test(s));
const aiCfg = JSON.parse(aiCfgSrc.match(/window\.__AI_CONFIG__=(\{[\s\S]*?\});/)[1]);

const els = {};
function el(id) {
  if (!els[id]) {
    els[id] = {
      _html: '', textContent: '', value: '',
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
      style: {},
      addEventListener() {},
      querySelector() { return null; },
      getAttribute() { return null; }
    };
  }
  return els[id];
}

const docListeners = {};
const winListeners = {};
const lsData = {};
const localStorage = {
  getItem(k) { return k in lsData ? lsData[k] : null; },
  setItem(k, v) { lsData[k] = String(v); },
  removeItem(k) { delete lsData[k]; }
};
const store = {
  window: {
    __KB_DATA__: JSON.parse(dataJson),
    __AI_CONFIG__: aiCfg,
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
  fetch: () => Promise.reject(new Error('单文件版不应请求网络')),
  localStorage,
  console
};

vm.createContext(store);

/* 预埋测试脏数据：验证单文件版启动时一次性清理 */
function hp(pwd, salt) {
  const s = String(pwd) + '::' + String(salt);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  let h2 = 52711;
  for (let j = s.length - 1; j >= 0; j--) h2 = ((h2 << 5) + h2) ^ s.charCodeAt(j);
  return (h >>> 0).toString(16) + (h2 >>> 0).toString(16);
}
// 测试自造密码（仅本测试内使用，非任何真实账号凭据）
const TEST_PWD = 'ui-test-pwd-1';
const NEW_PWD = 'ui-new-pwd-2';
const MISMATCH_PWD = 'ui-mismatch-3';
lsData['kb_l_forum'] = JSON.stringify({
  threads: [{ id: 't-dirty', title: '测试论坛是否可以使用', content: '# 测试', author: '测试小号', authorId: 'u-junk', likes: [], status: 'visible' }],
  comments: [{ id: 'c-dirty', threadId: 't-dirty', content: '测试评论', author: '测试小号', authorId: 'u-junk', status: 'visible' }],
  reports: [{ id: 'r-dirty', targetType: 'thread', targetId: 't-dirty', reason: '测试举报', reporter: '测试小号', reporterId: 'u-junk', status: 'pending' }]
});
lsData['kb_chat'] = JSON.stringify([{ role: 'user', content: '测试问题' }, { role: 'assistant', content: '测试回答' }]);
lsData['kb_l_subs'] = JSON.stringify([{ id: 's-dirty', title: '测试投稿', status: 'pending', author: '测试小号', authorId: 'u-junk' }]);
lsData['kb_l_entries'] = JSON.stringify([{ id: 'e-dirty', title: '测试并入条目' }]);
lsData['kb_l_users'] = JSON.stringify([
  { id: 'u-admin', username: 'admin', role: 'admin', salt: 's-seed', hash: hp(TEST_PWD, 's-seed'), createdAt: '2026-01-01T00:00:00Z', contributions: 0 },
  { id: 'u-junk', username: '测试小号', role: 'user', salt: 's-junk', hash: 'junk', createdAt: '2026-01-01T00:00:00Z', contributions: 0 },
  { id: 'u-plain', username: '普通小号', role: 'user', salt: 's-plain', hash: 'plainhash', createdAt: '2026-01-01T00:00:00Z', contributions: 0 }
]);
lsData['kb_l_sessions'] = JSON.stringify({
  tokA: { username: '测试小号', exp: Date.now() + 86400000 },
  tokB: { username: 'admin', exp: Date.now() + 86400000 }
});

if (backendSrc) vm.runInContext(backendSrc, store, { filename: 'local-backend.js' });
vm.runInContext(appSrc, store, { filename: 'app.js' });

function clickAction(attrs) {
  const btn = { getAttribute: k => (k in attrs ? String(attrs[k]) : null) };
  docListeners['click']({ target: { closest: sel => (sel === '[data-action]' ? btn : null) } });
}
function submitForm(attrs, values) {
  const form = { getAttribute: k => (k in attrs ? String(attrs[k]) : null), elements: values };
  docListeners['submit']({ target: form, preventDefault: () => {} });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const go = async hash => {
  store.location.hash = hash;
  winListeners['hashchange'] && winListeners['hashchange']();
  await sleep(60);
};

(async () => {
  await sleep(80);
  const ok = [];
  const bad = [];
  const t = (cond, label) => (cond ? ok : bad).push(label);
  const main = () => els['main']._html;
  const side = () => els['sidebar']._html;

  console.log('\n[1] 启动渲染');
  t(main().includes('陶瓷工艺知识库'), '首页标题');
  t(main().includes('cat-card'), '分类卡片');
  t(main().includes('entry-card'), '条目列表');
  t(side().includes('全部条目') && side().includes(String(kbEntries)), '侧边栏统计');
  t(store.document.title.includes('陶瓷工艺知识库'), '页面标题');
  t(!!backendSrc, '内嵌本地后端脚本');
  t(/"apiKey"\s*:\s*"sk-/.test(aiCfgSrc), '内嵌 AI 配置（含 key）');

  console.log('\n[2] 一次性清理测试脏数据');
  const parseK = k => (k in lsData ? JSON.parse(lsData[k]) : null);
  const fdata = parseK('kb_l_forum');
  t(!fdata || (fdata.threads.length === 0 && fdata.comments.length === 0 && fdata.reports.length === 0), '测试帖子/评论/举报已删除');
  t(parseK('kb_chat') == null || parseK('kb_chat').length === 0, '测试聊天记录已删除');
  t(parseK('kb_l_subs') == null || parseK('kb_l_subs').length === 0, '测试投稿已删除');
  t(parseK('kb_l_entries') == null || parseK('kb_l_entries').length === 0, '测试并入条目已删除');
  const cleanUsers = parseK('kb_l_users');
  t(cleanUsers && !cleanUsers.some(u => u.username === '测试小号') && !cleanUsers.some(u => u.username === '普通小号'), '测试账号已删除');
  t(cleanUsers && cleanUsers.length === 1 && cleanUsers[0].username === 'admin' && cleanUsers[0].role === 'admin', '仅保留管理员账号');
  const cleanSess = parseK('kb_l_sessions');
  t(cleanSess && !('tokA' in cleanSess) && 'tokB' in cleanSess, '仅保留管理员的登录态');
  t(parseK('kb_l_clean') === 'v1', '清理标记已写入（只清一次）');

  console.log('\n[3] 账号区与论坛入口（单文件版功能全开）');
  t(els['auth-area']._html.includes('登录'), '账号区显示登录按钮');
  t(side().includes('#/forum'), '侧栏显示论坛入口');
  t(els['header-nav']._html.includes('#/forum'), '页头显示论坛链接');

  console.log('\n[4] 路由');
  await go('#/c/glazing');
  t(main().includes('长石釉与石灰釉'), '分类页渲染');
  await go('#/e/oxidizing-reducing-flame');
  t(main().includes('氧化焰') && main().includes('<h2>'), '详情页');
  await go('#/q/' + encodeURIComponent('青花'));
  t(main().includes('搜索「青花」') && main().includes('highlight'), '搜索+高亮');
  await go('#/');
  t(main().includes('cta-strip'), '投稿 CTA');
  t(main().includes('登录后投稿'), '未登录 CTA 文案');

  console.log('\n[5] 登录/注册页');
  await go('#/login?mode=register');
  t(main().includes('data-form="register"'), '注册表单');
  await go('#/login');
  t(main().includes('data-form="login"'), '登录表单');

  console.log('\n[6] 未登录访问受保护页面 → 登录引导');
  await go('#/submit');
  t(main().includes('请先登录'), '投稿页登录引导');
  await go('#/admin');
  t(main().includes('请先登录'), '审核台登录引导');
  await go('#/forum');
  t(main().includes('交流论坛') && main().includes('还没有帖子'), '论坛页正常渲染（本地后端）');

  console.log('\n[7] 本地后端：注册 → 登录 → 发帖');
  await go('#/login?mode=register');
  submitForm({ 'data-form': 'register' },
    { username: { value: '小陶' }, password: { value: 'tao12345' }, password2: { value: 'tao12345' } });
  await sleep(80);
  t(els['auth-area']._html.includes('小陶'), '注册后账号区显示用户名');
  t(main().includes('小陶') || store.location.hash === '#/', '注册成功跳转首页');

  await go('#/forum/new');
  t(main().includes('data-form="forum-new"'), '发帖页（已登录）');
  submitForm({ 'data-form': 'forum-new' },
    { title: { value: '龙窑怎么控制还原气氛？' }, content: { value: '## 问题\n- 求教龙窑烧成时的还原焰控制方法' } });
  await sleep(100);
  t(store.location.hash.indexOf('#/forum/t/') === 0, '发帖后跳转帖子详情');
  await go(store.location.hash);
  t(main().includes('龙窑怎么控制还原气氛'), '帖子内容渲染');

  await go('#/forum');
  t(main().includes('龙窑怎么控制还原气氛'), '论坛列表出现新帖');
  t(side().includes('论坛') && side().includes('1'), '侧栏论坛计数更新');

  console.log('\n[8] 本地后端：投稿 → 管理员审核');
  await go('#/submit');
  t(main().includes('data-form="submit"'), '投稿表单（已登录）');
  submitForm({ 'data-form': 'submit' }, {
    title: { value: '还原焰的操作要点' },
    category: { value: 'firing' },
    tags: { value: '还原焰, 烧成' },
    summary: { value: '还原焰阶段的火焰控制与判断方法。' },
    content: { value: '## 要点\n- 维持窑内微正压\n- 观察火焰颜色与烟囱烟色\n- 避免冷空气涌入导致氧化' },
    sources: { value: '陶瓷工艺学 | https://example.com/ceramics' }
  });
  await sleep(100);
  t(store.location.hash === '#/mine', '投稿后跳转我的投稿');
  await go(store.location.hash);
  t(main().includes('还原焰的操作要点') && main().includes('待审核'), '我的投稿显示待审核');

  // 退出并切换管理员
  clickAction({ 'data-action': 'logout' });
  await sleep(100);
  await go('#/login');
  submitForm({ 'data-form': 'login' }, { username: { value: 'admin' }, password: { value: TEST_PWD } });
  await sleep(100);
  t(els['auth-area']._html.includes('admin'), '管理员登录成功');
  t(els['auth-area']._html.includes('审核台'), '页头出现审核台入口');

  await go('#/admin');
  t(main().includes('还原焰的操作要点'), '审核台看到待审核稿件');
  const subs = JSON.parse(lsData['kb_l_subs'] || '[]');
  const pend = subs.find(s => s.status === 'pending');
  t(!!pend, '本地投稿数据已持久化');
  clickAction({ 'data-action': 'approve', 'data-id': pend.id });
  await sleep(120);
  const kbAfter = store.window.__KB_DATA__;
  t(kbAfter.entries.some(e => e.title === '还原焰的操作要点'), '审核通过后条目并入知识库');
  t(main().includes('已通过并写入知识库'), '审核通过提示');

  console.log('\n[9] 客服窗');
  t(els['chat-widget']._html.includes('chat-fab'), '悬浮客服按钮');
  clickAction({ 'data-action': 'chat-toggle' });
  t(els['chat-widget']._html.includes('chat-panel'), '客服面板展开');

  console.log('\n[10] 通用重名约束（任何两个用户不得重名）');
  const B = store.window.__LOCAL_BACKEND__;
  let rr = await B('/api/register', { method: 'POST', body: JSON.stringify({ username: 'dup-user', password: 'dup-pw-666' }) });
  t(rr.status === 200, '注册 dup-user 成功');
  rr = await B('/api/register', { method: 'POST', body: JSON.stringify({ username: 'dup-user', password: 'dup-pw-666' }) });
  t(rr.status === 409, '重复注册返回 409');
  rr = await B('/api/register', { method: 'POST', body: JSON.stringify({ username: 'DUP-USER', password: 'dup-pw-666' }) });
  t(rr.status === 409, '大小写变体重名返回 409');
  rr = await B('/api/register', { method: 'POST', body: JSON.stringify({ username: 'dup-user ', password: 'dup-pw-666' }) });
  t(rr.status === 409, '带空格变体重名返回 409');
  const seeded = JSON.parse(lsData['kb_l_users']).filter(u => u.username === 'dup-user');
  t(seeded.length === 1, '本地用户名单中 dup-user 唯一');

  console.log('\n[11] 账号设置页（改昵称 / 改密码）');
  await go('#/settings');
  t(main().includes('data-form="rename"') && main().includes('data-form="password"'), '设置页含两个表单');
  t(main().includes('当前账号'), '显示当前账号');
  t(els['auth-area']._html.includes('#/settings'), '账号区显示设置入口');

  submitForm({ 'data-form': 'rename' }, { username: { value: 'dup-user' } });
  await sleep(80);
  t(els['form-msg'].textContent.includes('已被占用'), '改成已占用昵称显示 409 错误');

  submitForm({ 'data-form': 'rename' }, { username: { value: 'admin' } });
  await sleep(80);
  t(els['form-msg'].textContent.includes('与当前昵称相同'), '同名提示');

  submitForm({ 'data-form': 'rename' }, { username: { value: '青花匠人' } });
  await sleep(100);
  t(els['auth-area']._html.includes('青花匠人'), '页头昵称即时更新');
  t(main().includes('青花匠人') && main().includes('昵称已修改'), '设置页显示改名成功');

  submitForm({ 'data-form': 'password', 'data-msg': 'form-msg-pw' },
    { oldPassword: { value: 'wrong99' }, password: { value: NEW_PWD }, password2: { value: NEW_PWD } });
  await sleep(80);
  t(els['form-msg-pw'].textContent.includes('原密码不正确'), '原密码错误提示');

  submitForm({ 'data-form': 'password', 'data-msg': 'form-msg-pw' },
    { oldPassword: { value: TEST_PWD }, password: { value: NEW_PWD }, password2: { value: MISMATCH_PWD } });
  await sleep(80);
  t(els['form-msg-pw'].textContent.includes('不一致'), '两次新密码不一致提示');

  submitForm({ 'data-form': 'password', 'data-msg': 'form-msg-pw' },
    { oldPassword: { value: TEST_PWD }, password: { value: NEW_PWD }, password2: { value: NEW_PWD } });
  await sleep(100);
  t(main().includes('密码已修改'), '改密成功提示');

  clickAction({ 'data-action': 'logout' });
  await sleep(80);
  await go('#/login');
  submitForm({ 'data-form': 'login' }, { username: { value: '青花匠人' }, password: { value: TEST_PWD } });
  await sleep(80);
  t(els['form-msg'].textContent.includes('错误') || !els['auth-area']._html.includes('青花匠人'), '旧密码登录失败');
  submitForm({ 'data-form': 'login' }, { username: { value: '青花匠人' }, password: { value: NEW_PWD } });
  await sleep(80);
  t(els['auth-area']._html.includes('青花匠人'), '新昵称+新密码登录成功');

  console.log('\n[12] 网站入口页（landing）');
  t(html.includes('id="landing"'), '内嵌入口层标记');
  t(html.includes('进入网站') && html.includes('Enter the Site'), '含中英文进入按钮');
  t(html.includes('关于本站') && html.includes('About This Site'), '含中英文简介');
  t(html.includes('站内功能') && html.includes('Features'), '含中英文功能介绍');
  t(html.includes('landing-hero') && html.includes('landing-cta'), '入口页含首屏与按钮区');
  clickAction({ 'data-action': 'enter-site' });
  t(els['landing'] && els['landing'].style.display === 'none', '点击进入网站后入口层隐藏');

  console.log('\n通过: ' + ok.length + ' 项');
  if (bad.length) { console.log('失败: ' + bad.join(' / ')); process.exit(1); }
  console.log('单文件版 UI 与本地后端测试全部通过');
})();
