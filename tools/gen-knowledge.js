/**
 * 批量生成知识条目草稿（DeepSeek API）
 * 用法: node tools/gen-knowledge.js [分类id ...]   不带参数则生成全部未满分类
 * 输出: tools/generated/<分类id>.json （可重复执行，自动续写去重）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'generated');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'ai.config.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'categories.json'), 'utf8'));

const PLAN = {
  overview: { n: 12, hints: ['新石器时代陶器（仰韶彩陶、龙山黑陶）', '原始瓷的出现与成熟青瓷', '唐代陶瓷格局：南青北白', '宋代五大名窑格局', '元青花的兴起', '明代官窑与御器厂', '清代彩瓷发展（珐琅彩、广彩）', '外销瓷与克拉克瓷', '近现代陶瓷工业化', '按用途分类：日用瓷/建筑陶瓷/电瓷/艺术陶瓷', '陶器与瓷器的核心区别', '中国陶瓷外销路线与海上丝绸之路'] },
  materials: { n: 14, hints: ['高岭土的性质与应用', '瓷石与二元配方', '长石族原料', '石英的晶型转变', '膨润土与粘土可塑性', '坯料组成表示方法（配料三角图）', '原料加工流程：配料—球磨—过筛—除铁', '泥浆性能指标（细度、触变性）', '杂质对白度的影响（铁、钛）', '硅灰石与透辉石等低温熔剂', '骨灰瓷原料组成', '坯料可塑性与结合性评价', '陶瓷原料的化学全分析', '锂辉石与低膨胀原料'] },
  forming: { n: 12, hints: ['拉坯与利坯', '注浆成型与石膏模型', '滚压成型', '等静压成型', '干压成型', '挤制成型（挤出成型）', '塑性成型坯体含水率控制', '注浆成型常见缺陷（厚薄不匀、塌形）', '模型注浆的负压与吸水原理', '成型方法选择对比表', '盘车印坯与可塑成型指标', '流延成型与薄膜坯体制备'] },
  drying: { n: 8, hints: ['干燥的等速阶段与降速阶段', '临界含水率', '干燥制度与干燥曲线', '干燥开裂与翘曲的原因', '红外干燥与微波干燥', '坯体含水率的测定', '隧道式干燥窑', '季节与环境湿度对干燥的影响'] },
  glazing: { n: 14, hints: ['釉按光泽与外观分类', '石灰釉与碱釉', '釉的高温粘度与表面张力', '坯釉膨胀系数匹配（坯釉适应性）', '釉浆制备与性能指标', '施釉方法：浸釉、喷釉、浇釉、荡釉', '釉层厚度的影响', '铁系青釉与铜红釉', '结晶釉与窑变', '乳浊釉与析晶乳浊', '色釉装饰分类', '缩釉与滚釉的成因', '釉面针孔与棕眼', '施釉缺陷全解（缺釉、釉缕、波纹）'] },
  decoration: { n: 12, hints: ['青花装饰', '釉里红', '五彩与斗彩', '粉彩', '釉下彩与釉上彩的区别', '刻花、划花与印花', '剔花与贴花', '绞胎装饰', '颜色釉装饰（单色釉）', '贴花纸与烤花', '堆塑与镂雕装饰', '描金与矾红装饰'] },
  firing: { n: 12, hints: ['烧成制度（升温—保温—冷却）', '氧化焰与还原焰的判定', '素烧与本烧', '冷却制度与晶型转变', '烧成收缩与烧成收缩率', '气氛的物理化学作用（烟气分析）', '一次烧成与二次烧成', '快烧技术', '烧成能耗与余热利用', '碳素沉积与渗碳', '低温快烧技术', '烧成温度的测量与测温锥'] },
  kiln: { n: 10, hints: ['梭式窑（车窑）', '辊道窑', '隧道窑', '龙窑', '馒头窑与倒焰窑', '电窑与气窑对比', '明焰裸烧与匣钵装烧', '窑内温差与均匀性', '窑具与棚板', '密封、气氛与压力控制'] },
  famous: { n: 12, hints: ['汝窑', '官窑', '哥窑', '钧窑', '定窑', '越窑与邢窑', '磁州窑', '德化窑', '吉州窑', '建窑与建盏', '景德镇青花瓷', '景德镇颜色釉与薄胎瓷'] },
  crafts: { n: 8, hints: ['唐三彩', '钧瓷工艺', '釉下五彩', '木叶天目与剪纸贴花', '法华与琉璃', '陶瓷雕塑（捏塑、镂雕）', '辽瓷与西夏陶瓷', '广彩与外销工艺瓷'] },
  defects: { n: 14, hints: ['针孔', '棕眼', '桔釉', '釉泡（釉面气泡）', '缩釉', '色差', '落渣', '缺釉与釉缕', '生烧', '烟熏与阴黄', '火刺', '惊裂（惊釉）', '坯体起泡（坯泡）', '斑点与黑点'] },
  advanced: { n: 10, hints: ['氧化铝陶瓷', '氮化硅陶瓷', '碳化硅陶瓷', '压电陶瓷', '介电陶瓷与电容器陶瓷', '透明陶瓷', '蜂窝陶瓷与载体', '陶瓷基复合材料', '热障涂层', '固体氧化物燃料电池电解质陶瓷'] }
};

const BATCH = 4;
const CONCURRENCY = 3;
const MAX_TOKENS = 4000;
const TEMPERATURE = 0.5;

function existingTitles() {
  const titles = new Set();
  for (const f of index.entryFiles) {
    const arr = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
    arr.forEach(e => titles.add(e.title.trim()));
  }
  return titles;
}

function readGenerated(cat) {
  const p = path.join(OUT_DIR, cat + '.json');
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return []; }
}

function writeGenerated(cat, arr) {
  fs.writeFileSync(path.join(OUT_DIR, cat + '.json'), JSON.stringify(arr, null, 2), 'utf8');
}

function log(msg) {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg;
  console.log(line);
  fs.appendFileSync(path.join(OUT_DIR, 'gen.log'), line + '\n');
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function chat(userMsg) {
  const body = {
    model: cfg.model || 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是陶瓷工艺领域的资深专家与百科撰稿人，只输出严格的 JSON 数组，不输出任何解释文字、前后缀或 Markdown 代码围栏。' },
      { role: 'user', content: userMsg }
    ],
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS
  };
  const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message.content || '';
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('响应中未找到 JSON 数组: ' + text.slice(0, 120));
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr) || !arr.length) throw new Error('JSON 数组为空');
  return arr;
}

function normalize(e, cat) {
  if (!e || typeof e !== 'object') return null;
  const title = String(e.title || '').trim();
  if (title.length < 2) return null;
  const content = String(e.content || '').trim();
  if (!/##/.test(content)) return null;
  const tags = Array.isArray(e.tags) ? e.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 6) : [];
  const summary = String(e.summary || '').trim();
  if (!summary) return null;
  let id = slugify(e.id || '');
  if (!id) id = slugify(title) || 'kb-entry';
  return {
    id, title, category: cat,
    tags, summary: summary.slice(0, 160),
    content,
    sources: Array.isArray(e.sources) ? e.sources.filter(s => s && s.title && s.url).slice(0, 6) : []
  };
}

async function runCategory(cat) {
  const plan = PLAN[cat];
  const catInfo = index.categories.find(c => c.id === cat);
  if (!plan || !catInfo) { log('跳过未知分类 ' + cat); return; }

  let out = readGenerated(cat);
  const seen = new Set(out.map(e => e.title.trim()));
  const baseTitles = existingTitles();
  const target = plan.n;
  let attempts = 0;

  while (out.length < target && attempts < 8) {
    attempts++;
    const need = Math.min(BATCH, target - out.length);
    const userMsg = [
      '分类：' + catInfo.name + '（' + catInfo.desc + '），分类 id：' + cat,
      '本分类已有条目（严禁重复其主题）：' + Array.from(baseTitles).join('、'),
      '已生成（也不要重复）：' + (Array.from(seen).join('、') || '无'),
      '',
      '请撰写 ' + need + ' 条新知识条目，主题优先从以下方向选取（也可自行补充本分类其他重要主题，避免与上面重复）：',
      plan.hints.map(h => '- ' + h).join('\n'),
      '',
      '每条对象格式：',
      '{"id":"全小写英文连字符的短id","title":"中文标题","category":"' + cat + '","tags":["3~6个中文标签"],"summary":"80字以内概述","content":"Markdown正文，用##分节，250~450字，可含列表与表格","sources":[]}',
      '',
      '要求：只输出 JSON 数组；事实准确、术语规范；不编造网址与来源；术语解释类条目也要写成完整正文。'
    ].join('\n');

    let arr;
    try {
      arr = await chat(userMsg);
    } catch (err) {
      log(cat + ' 第' + attempts + '轮失败: ' + err.message);
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }
    let added = 0;
    for (const raw of arr) {
      const e = normalize(raw, cat);
      if (!e) continue;
      if (seen.has(e.title) || baseTitles.has(e.title)) continue;
      seen.add(e.title);
      out.push(e);
      added++;
      if (out.length >= target) break;
    }
    writeGenerated(cat, out);
    log(cat + ' + ' + added + '（合计 ' + out.length + '/' + target + '）');
    if (added === 0) await new Promise(r => setTimeout(r, 2000));
  }
  log(cat + ' 完成: ' + out.length + '/' + target);
}

async function pool(tasks, n) {
  const queue = tasks.slice();
  const workers = Array.from({ length: n }, async () => {
    while (queue.length) {
      const t = queue.shift();
      await t();
    }
  });
  await Promise.all(workers);
}

(async () => {
  const args = process.argv.slice(2).filter(a => PLAN[a]);
  const cats = args.length ? args : Object.keys(PLAN);
  log('开始生成: ' + cats.join(', '));
  await pool(cats.map(cat => () => runCategory(cat)), CONCURRENCY);
  log('全部结束');
})().catch(e => { log(' fatal: ' + e.message); process.exit(1); });
