const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const file = path.join(ROOT, 'dist', '陶瓷工艺知识库.html');
const html = fs.readFileSync(file, 'utf8');

const problems = [];

// 1. 无本地资源引用
if (/<link[^>]+href="\//.test(html)) problems.push('存在本地 css 引用');
if (/<script[^>]+src="/.test(html)) problems.push('存在本地 js 引用');
if (/url\(\s*['"]?\//.test(html)) problems.push('存在本地 css 图片引用');
const jpegCount = (html.match(/data:image\/jpeg;base64/g) || []).length;
if (jpegCount < 2) problems.push('固定背景图未全部内嵌（找到 ' + jpegCount + ' 张）');

// 2. 内嵌数据完整性（与 data/entries 实际条目数一致）
const expected = (() => {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'categories.json'), 'utf8'));
  return idx.entryFiles.reduce((n, f) =>
    n + JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')).length, 0);
})();
const m = html.match(/window\.__KB_DATA__=(\{[\s\S]*?\});<\/script>/);
if (!m) problems.push('未找到内嵌数据');
else {
  const kb = JSON.parse(m[1]);
  if (kb.entries.length !== expected) problems.push('条目数与数据文件不一致: ' + kb.entries.length + ' != ' + expected);
  if (kb.categories.length !== 12) problems.push('分类数异常: ' + kb.categories.length);
}

// 3. 所有 <script> 内容语法检查
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
scripts.forEach((s, i) => {
  try { new Function(s); } catch (e) { problems.push('script#' + i + ' 语法错误: ' + e.message); }
});

// 4. 关键 DOM 骨架
['id="main"', 'id="sidebar"', 'id="search-input"', 'id="auth-area"', '<style>', 'window.__KB_DATA__']
  .forEach(k => { if (!html.includes(k)) problems.push('缺少 ' + k); });

console.log('大小:', (fs.statSync(file).size / 1024).toFixed(1), 'KB, script 数:', scripts.length);
console.log(problems.length ? '问题: ' + problems.join('; ') : '单文件 HTML 校验通过');
