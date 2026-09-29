/**
 * 集成测试：注册 → 登录 → 投稿 → 管理员审核 → 通过入库 / 退回
 * 在临时目录复制项目并以独立端口启动，不污染真实数据。
 * 用法: node tests/test-api.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'kb-api-test-' + Date.now());
const PORT = 3210;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0;
const failures = [];
function check(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + label + (extra ? ' — ' + extra : '')); }
}

async function req(pathname, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers,
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
  // 全新环境：不携带本机账号（代码不预创建任何账号）
  fs.rmSync(path.join(TMP, 'data', 'runtime', 'users.json'), { force: true });
}

// 模拟「仅在本地指定管理员」：直接把 users.json 里该用户的 role 改为 admin
function promoteLocal(username) {
  const p = path.join(TMP, 'data', 'runtime', 'users.json');
  const users = JSON.parse(fs.readFileSync(p, 'utf8'));
  const u = users.find(x => x.username === username);
  if (!u) throw new Error('找不到待提升账号: ' + username);
  u.role = 'admin';
  fs.writeFileSync(p, JSON.stringify(users, null, 2) + '\n', 'utf8');
}

async function waitForServer(child) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (e) { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('服务启动超时');
}

async function main() {
  setupSandbox();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: TMP,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });

  try {
    await waitForServer(child);
    console.log('\n[1] 服务与知识库');
    let r = await req('/api/health');
    check(r.status === 200 && r.data.ok, '/api/health 正常');

    r = await req('/api/kb');
    const baseCount = r.data.entries ? r.data.entries.length : 0;
    const baseDefects = (r.data.counts && r.data.counts.defects) || 0;
    check(r.status === 200 && baseCount >= 42, '/api/kb 条目数 >= 42', '实际 ' + baseCount);
    check(r.data.categories.length === 12, '12 个分类');

    console.log('\n[2] 注册与登录');
    r = await req('/api/register', { method: 'POST', body: { username: 'alice', password: 'alice123' } });
    check(r.status === 200 && r.data.token && r.data.user.role === 'user', '注册普通账号 alice');
    const alice = r.data.token;

    r = await req('/api/register', { method: 'POST', body: { username: 'alice', password: 'alice123' } });
    check(r.status === 409, '重复用户名返回 409');

    r = await req('/api/register', { method: 'POST', body: { username: 'x', password: '1' } });
    check(r.status === 400, '非法用户名/密码返回 400');

    r = await req('/api/login', { method: 'POST', body: { username: 'Alice', password: 'alice123' } });
    check(r.status === 200 && r.data.token, '登录成功（用户名大小写不敏感）');

    r = await req('/api/login', { method: 'POST', body: { username: 'alice', password: 'wrong' } });
    check(r.status === 401, '错误密码返回 401');

    r = await req('/api/me', { token: alice });
    check(r.status === 200 && r.data.user.username === 'alice', '/api/me 返回当前用户');

    r = await req('/api/me');
    check(r.status === 200 && r.data.user === null, '未登录时 user 为 null');

    console.log('\n[3] 投稿');
    r = await req('/api/submissions', { token: alice });
    check(r.status === 200 && r.data.submissions.length === 0, '普通账号初始无投稿');

    const draft = {
      title: '釉面针孔的成因与对策',
      category: 'defects',
      tags: ['针孔', '釉面缺陷'],
      summary: '针孔多因坯釉中有机物分解、釉层过厚或烧成升温过快所致。',
      content: '## 成因\n- 坯体有机物、碳酸盐分解产生气体\n- 釉浆过厚，排气不畅\n\n## 对策\n1. 降低坯料细度中的有机物含量\n2. 控制釉层厚度\n3. 适当延长氧化期保温',
      sources: [{ title: '陶瓷工艺学', url: 'https://example.com/ceramics' }]
    };
    r = await req('/api/submissions', { method: 'POST', token: alice, body: draft });
    check(r.status === 200 && r.data.submission.status === 'pending', '提交投稿，状态 pending');
    const subId = r.data.submission.id;

    r = await req('/api/submissions', { method: 'POST', token: alice, body: Object.assign({}, draft, { title: 'x' }) });
    check(r.status === 400, '标题过短被拒绝');

    r = await req('/api/submissions', { method: 'POST', token: alice, body: Object.assign({}, draft, { category: 'nope' }) });
    check(r.status === 400, '非法分类被拒绝');

    r = await req('/api/submissions');
    check(r.status === 401, '未登录投稿返回 401');

    console.log('\n[4] 权限');
    r = await req('/api/register', { method: 'POST', body: { username: 'root-admin', password: 'root-pw-9527' } });
    check(r.status === 200 && r.data.user.role === 'user', '注册账号默认为普通用户（不自动设置管理员）');
    promoteLocal('root-admin');
    r = await req('/api/login', { method: 'POST', body: { username: 'root-admin', password: 'root-pw-9527' } });
    check(r.status === 200 && r.data.user.role === 'admin', '本地把 role 改为 admin 后即为管理员');
    const admin = r.data.token;

    // 通用重名约束：任何两个用户不得重名（忽略首尾空格与大小写）
    r = await req('/api/register', { method: 'POST', body: { username: 'dup-user', password: 'dup-pw-666' } });
    check(r.status === 200, '注册 dup-user');
    r = await req('/api/register', { method: 'POST', body: { username: 'DUP-USER', password: 'dup-pw-666' } });
    check(r.status === 409, '大小写变体重名返回 409');
    r = await req('/api/register', { method: 'POST', body: { username: 'dup-user ', password: 'dup-pw-666' } });
    check(r.status === 409, '带空格变体重名返回 409', 'status=' + r.status);
    r = await req('/api/user/rename', { method: 'POST', token: alice, body: { username: 'DUP-USER' } });
    check(r.status === 409, '改名撞已占用昵称返回 409');

    r = await req('/api/submissions?status=pending', { token: admin });
    check(r.status === 200 && r.data.role === 'admin', '管理员可查看待审核列表');

    r = await req('/api/submissions/' + subId + '/approve', { method: 'POST', token: alice });
    check(r.status === 403, '普通账号审核被拒绝 403');

    r = await req('/api/submissions?status=pending', { token: alice });
    check(r.status === 200 && r.data.role === 'user', '普通账号查看自己的投稿');

    r = await req('/api/submissions?status=pending', { token: admin });
    check(r.status === 200 && r.data.submissions.length === 1 && r.data.role === 'admin', '管理员看到 1 条待审核');

    console.log('\n[5] 审核：通过入库');
    r = await req('/api/submissions/' + subId + '/approve', { method: 'POST', token: admin });
    check(r.status === 200 && r.data.entryId, '审核通过，返回 entryId: ' + r.data.entryId);
    const entryId = r.data.entryId;

    r = await req('/api/kb');
    check(r.data.entries.length === baseCount + 1, '知识库 +1 条', '现在 ' + r.data.entries.length);
    const added = r.data.entries.find(e => e.id === entryId);
    check(!!added && added.contributor === 'alice', '新条目带投稿人署名');
    check(added && added.category === 'defects', '新条目归入 defects 分类');
    check(r.data.counts.defects === baseDefects + 1, 'defects 分类计数 +1', '实际 ' + r.data.counts.defects + '，基数 ' + baseDefects);

    const fileOnDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'entries', 'defects-advanced.json'), 'utf8'));
    check(fileOnDisk.some(e => e.id === entryId), '已写入 defects-advanced.json 文件');

    r = await req('/api/submissions/' + subId + '/approve', { method: 'POST', token: admin });
    check(r.status === 400, '重复审核返回 400');

    r = await req('/api/submissions/' + subId, { token: alice });
    check(r.status === 200 && r.data.submission.status === 'approved', '投稿人看到已通过');

    r = await req('/api/me', { token: alice });
    check(r.data.user.contributions === 1, '投稿人贡献数 = 1', '实际 ' + r.data.user.contributions);

    console.log('\n[6] 审核：退回');
    const draft2 = Object.assign({}, draft, { title: '薄胎瓷的修坯要点' });
    r = await req('/api/submissions', { method: 'POST', token: alice, body: draft2 });
    const sub2 = r.data.submission.id;
    r = await req('/api/submissions/' + sub2 + '/reject', {
      method: 'POST', token: admin, body: { reason: '与已有条目重复，请补充独特内容' }
    });
    check(r.status === 200 && r.data.submission.status === 'rejected', '退回稿件');
    r = await req('/api/submissions/' + sub2, { token: alice });
    check(r.data.submission.rejectReason.includes('重复'), '投稿人可看到退回原因');

    r = await req('/api/kb');
    check(r.data.entries.length === baseCount + 1, '退回不改变知识库条数');

    console.log('\n[7] 越权访问他人投稿');
    r = await req('/api/register', { method: 'POST', body: { username: 'bob', password: 'bob12345' } });
    const bob = r.data.token;
    r = await req('/api/submissions/' + subId, { token: bob });
    check(r.status === 403, '他人投稿返回 403');

    console.log('\n[8] 论坛：发帖 / 评论 / 点赞 / 举报');
    r = await req('/api/forum');
    check(r.status === 200 && Array.isArray(r.data.threads), '未登录可浏览论坛');
    const baseThreads = r.data.threads.length;

    r = await req('/api/forum/threads', { method: 'POST', body: { title: 'x', content: 'y' } });
    check(r.status === 401, '未登录发帖返回 401');

    r = await req('/api/forum/threads', {
      method: 'POST', token: alice,
      body: { title: '论坛测试帖：还原焰怎么判断？', content: '## 问题\n- 想请教还原焰的判断方法\n- 谢谢大家' }
    });
    check(r.status === 200 && r.data.thread.id, 'alice 发帖成功');
    const tid = r.data.thread.id;

    r = await req('/api/forum/threads', { method: 'POST', token: alice, body: { title: 'a', content: 'b' } });
    check(r.status === 400, '标题过短发帖被拒');

    r = await req('/api/forum/threads/' + tid);
    check(r.status === 200 && r.data.comments.length === 0, '未登录可看帖子详情');

    r = await req('/api/forum/threads/' + tid + '/comments',
      { method: 'POST', token: bob, body: { content: '看火焰颜色和烟囱烟色判断' } });
    check(r.status === 200 && r.data.commentCount === 1, 'bob 评论成功');

    r = await req('/api/forum/threads/' + tid + '/comments', { method: 'POST', body: { content: 'x' } });
    check(r.status === 401, '未登录评论返回 401');

    r = await req('/api/forum/threads/' + tid + '/like', { method: 'POST', token: bob });
    check(r.status === 200 && r.data.liked === true && r.data.likes === 1, '点赞');
    r = await req('/api/forum/threads/' + tid + '/like', { method: 'POST', token: bob });
    check(r.data.liked === false && r.data.likes === 0, '再次点击取消点赞');

    r = await req('/api/forum/threads/' + tid + '/report',
      { method: 'POST', token: bob, body: { reason: '内容重复' } });
    check(r.status === 200, 'bob 举报帖子');
    r = await req('/api/forum/threads/' + tid + '/report',
      { method: 'POST', token: bob, body: { reason: '再报一次' } });
    check(r.status === 409, '重复举报返回 409');
    r = await req('/api/forum/threads/' + tid + '/report',
      { method: 'POST', token: bob, body: { reason: '' } });
    check(r.status === 400, '空举报原因被拒');

    r = await req('/api/forum/threads/' + tid);
    const cid = r.data.comments[0].id;
    r = await req('/api/forum/comments/' + cid + '/report',
      { method: 'POST', token: alice, body: { reason: '疑似广告' } });
    check(r.status === 200, 'alice 举报评论');

    console.log('\n[9] 论坛：管理员举报箱与删帖');
    r = await req('/api/forum/reports', { token: alice });
    check(r.status === 403, '普通账号不能查看举报箱');
    r = await req('/api/forum/reports', { token: admin });
    check(r.status === 200 && r.data.pending === 2, '管理员看到 2 条待处理', 'pending=' + r.data.pending);
    const repThread = r.data.reports.find(x => x.targetType === 'thread');
    const repComment = r.data.reports.find(x => x.targetType === 'comment');
    check(!!repThread && !!repThread.target && /还原焰/.test(repThread.target.title), '举报记录带原帖预览');
    check(!!repComment && !!repComment.target, '评论举报带预览');

    r = await req('/api/forum/reports/' + repThread.id + '/handle',
      { method: 'POST', token: alice, body: { action: 'delete' } });
    check(r.status === 403, '普通账号处理举报被拒');
    r = await req('/api/forum/reports/' + repThread.id + '/handle',
      { method: 'POST', token: admin, body: { action: 'wrong' } });
    check(r.status === 400, '非法 action 被拒');

    r = await req('/api/forum/reports/' + repComment.id + '/handle',
      { method: 'POST', token: admin, body: { action: 'delete' } });
    check(r.status === 200 && r.data.pending === 1, '处理举报：删除被举报评论');
    r = await req('/api/forum/threads/' + tid);
    check(r.status === 200 && r.data.comments.length === 0, '被举报评论已从帖子消失');

    r = await req('/api/forum/reports/' + repComment.id + '/handle',
      { method: 'POST', token: admin, body: { action: 'delete' } });
    check(r.status === 400, '重复处理同一举报返回 400');

    r = await req('/api/forum/threads/' + tid + '/delete', { method: 'POST', token: alice });
    check(r.status === 403, '普通账号直接删帖被拒');
    r = await req('/api/forum/threads/' + tid + '/delete', { method: 'POST', token: admin });
    check(r.status === 200, '管理员直接删帖');
    r = await req('/api/forum');
    check(r.data.threads.length === baseThreads, '帖子已从论坛列表消失');
    r = await req('/api/forum/threads/' + tid);
    check(r.status === 404, '被删帖子详情返回 404');

    r = await req('/api/forum/reports/' + repThread.id + '/handle',
      { method: 'POST', token: admin, body: { action: 'delete' } });
    check(r.status === 200 && r.data.pending === 0, '帖子举报也处理完毕，待处理归零');

    console.log('\n[10] 账号设置：改昵称 / 改密码');
    r = await req('/api/user/rename', { method: 'POST', body: { username: 'nope' } });
    check(r.status === 401, '未登录改昵称返回 401');

    r = await req('/api/register', { method: 'POST', body: { username: 'carol', password: 'carol123' } });
    check(r.status === 200 && r.data.token, '注册 carol');
    let carol = r.data.token;

    r = await req('/api/forum/threads', {
      method: 'POST', token: carol,
      body: { title: 'carol 的帖子：还原焰怎么判断', content: '## 问题\n请问还原焰烧成如何判断火候？' }
    });
    check(r.status === 200 && r.data.thread.id, 'carol 发帖');
    const carolTid = r.data.thread.id;

    r = await req('/api/user/rename', { method: 'POST', token: carol, body: { username: 'alice' } });
    check(r.status === 409, '改成已占用昵称返回 409');
    r = await req('/api/user/rename', { method: 'POST', token: carol, body: { username: 'x' } });
    check(r.status === 400, '非法昵称返回 400');
    r = await req('/api/user/rename', { method: 'POST', token: carol, body: { username: 'carol' } });
    check(r.status === 400, '与当前昵称相同返回 400');
    r = await req('/api/user/rename', { method: 'POST', token: carol, body: { username: 'carol2' } });
    check(r.status === 200 && r.data.user.username === 'carol2', '改昵称成功');

    r = await req('/api/me', { token: carol });
    check(r.status === 200 && r.data.user.username === 'carol2', '原会话同步为新昵称');
    r = await req('/api/forum/threads/' + carolTid);
    check(r.data.thread && r.data.thread.author === 'carol2', '论坛帖子署名同步更新', JSON.stringify(r.data.thread));
    r = await req('/api/login', { method: 'POST', body: { username: 'carol', password: 'carol123' } });
    check(r.status === 401, '旧昵称无法登录');
    r = await req('/api/login', { method: 'POST', body: { username: 'carol2', password: 'carol123' } });
    check(r.status === 200, '新昵称可登录');

    // 两个会话，改密码后另一会话应被踢下线
    r = await req('/api/login', { method: 'POST', body: { username: 'carol2', password: 'carol123' } });
    carol = r.data.token;
    r = await req('/api/login', { method: 'POST', body: { username: 'carol2', password: 'carol123' } });
    const carolOther = r.data.token;

    r = await req('/api/user/password', { method: 'POST', token: carol, body: { oldPassword: 'wrong99', newPassword: 'newpass123' } });
    check(r.status === 400 && /原密码/.test(r.data.error || ''), '原密码错误返回 400（不触发登出）', JSON.stringify(r.data));
    r = await req('/api/user/password', { method: 'POST', token: carol, body: { oldPassword: 'carol123', newPassword: '123' } });
    check(r.status === 400, '新密码过短返回 400');
    r = await req('/api/user/password', { method: 'POST', token: carol, body: { oldPassword: 'carol123', newPassword: 'carol123' } });
    check(r.status === 400, '新旧密码相同返回 400');
    r = await req('/api/user/password', { method: 'POST', token: carol, body: { oldPassword: 'carol123', newPassword: 'newpass123' } });
    check(r.status === 200, '修改密码成功');

    r = await req('/api/me', { token: carol });
    check(r.status === 200 && r.data.user && r.data.user.username === 'carol2', '当前会话保持登录');
    r = await req('/api/me', { token: carolOther });
    check(r.status === 200 && r.data.user === null, '其他会话被踢下线');
    r = await req('/api/login', { method: 'POST', body: { username: 'carol2', password: 'carol123' } });
    check(r.status === 401, '旧密码登录失败');
    r = await req('/api/login', { method: 'POST', body: { username: 'carol2', password: 'newpass123' } });
    check(r.status === 200, '新密码登录成功');

    console.log('\n结果: 通过 ' + passed + ' / 失败 ' + failures.length);
    if (failures.length) {
      console.log('失败项:\n - ' + failures.join('\n - '));
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('测试异常:', e.message);
    console.error('服务日志:\n' + serverLog);
    process.exitCode = 1;
  } finally {
    child.kill();
    setTimeout(() => {
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      process.exit();
    }, 300);
  }
}

main();
