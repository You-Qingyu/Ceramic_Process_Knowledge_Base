const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const start = src.indexOf('function inline');
const end = src.indexOf('function highlight');
const escFn = "function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}";
const renderMarkdown = eval('(function(){' + escFn + src.slice(start, end) + '; return renderMarkdown;})()');

const dir = path.join(ROOT, 'data/entries');
let checked = 0, problems = [];
for (const f of fs.readdirSync(dir)) {
  const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const e of arr) {
    const html = renderMarkdown(e.content);
    checked++;
    if (!html.includes('<h2>')) problems.push(e.id + ': no h2');
    if (/<(script|iframe)/i.test(html)) problems.push(e.id + ': unsafe tag');
    if (html.includes('&amp;lt;')) problems.push(e.id + ': double escape');
    if (e.content.includes('| ---') && !html.includes('<table>')) problems.push(e.id + ': table missing');
  }
}
console.log('checked:', checked, 'problems:', problems.length ? problems : 'none');
