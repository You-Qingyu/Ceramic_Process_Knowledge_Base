/**
 * 构建单文件版 HTML（数据/样式/脚本全部内嵌，双击即可打开，无需服务器）
 * 用法: node scripts/build.js   → 输出 dist/陶瓷工艺知识库.html
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, '陶瓷工艺知识库.html');

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

function guard(code) {
  // 防止内嵌内容里的 </script> 提前结束脚本标签
  return code.replace(/<\/script/gi, '<\\/script');
}

const index = JSON.parse(read('data/categories.json'));
const entries = [];
for (const f of index.entryFiles) {
  entries.push(...JSON.parse(read('data/' + f)));
}
index.meta.total = entries.length;
const counts = {};
for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;

const kb = { meta: index.meta, categories: index.categories, counts, entries };

let css = read('public/style.css');
const js = read('public/app.js');

// 固定背景图内嵌：单文件版把 /xxx.jpg 换成 data URI，离线双击也能显示
for (const name of ['bg.jpg', 'landing-bg.jpg']) {
  const p = path.join(ROOT, 'public', name);
  if (!fs.existsSync(p)) continue;
  const b64 = fs.readFileSync(p).toString('base64');
  css = css.split("url('/" + name + "')").join('url(data:image/jpeg;base64,' + b64 + ')');
}
const backend = read('public/local-backend.js');
let html = read('public/index.html');

// AI 配置内嵌：单文件版浏览器直连 OpenAI 兼容接口（DeepSeek 等）
let ai = {};
try { ai = JSON.parse(read('ai.config.json')); } catch (e) { /* 无配置则留空 */ }
const aiCfg = {
  apiKey: ai.apiKey || '',
  baseUrl: ai.baseUrl || 'https://api.deepseek.com/v1',
  model: ai.model || '',
  temperature: typeof ai.temperature === 'number' ? ai.temperature : 0.4,
  maxTokens: ai.maxTokens || 900,
  systemPrompt: ai.systemPrompt || ''
};

// 注意：必须用函数式替换，否则替换文本中的 $& / $` 等会被 String.replace 特殊解释
html = html
  .replace(/<link rel="stylesheet"[^>]*>/, () => '<style>\n' + guard(css) + '\n</style>')
  .replace(/<script src="\/app\.js"><\/script>/, () =>
    '<script>window.__KB_DATA__=' + guard(JSON.stringify(kb)) + ';</script>\n' +
    '<script>window.__AI_CONFIG__=' + guard(JSON.stringify(aiCfg)) + ';</script>\n' +
    '<script>\n' + guard(backend) + '\n</script>\n' +
    '<script>\n' + guard(js) + '\n</script>')
  .replace(/<title>[^<]*<\/title>/, () => '<title>陶瓷工艺知识库（单文件版）</title>');

if (!html.includes('window.__KB_DATA__')) {
  console.error('构建失败: 未找到 app.js 注入点');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成: dist/' + path.basename(OUT) + '  (' +
  (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB, ' + entries.length + ' 条)');
