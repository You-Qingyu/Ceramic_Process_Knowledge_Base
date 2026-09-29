# 陶瓷工艺知识库

本地运行的陶瓷工艺知识库网站：知识条目从公开网络资料收集整理后存入本地 JSON 数据库，通过浏览器浏览、按分类筛选与全文检索；支持**账号注册登录、普通用户投稿、管理员审核入库**、**交流论坛（发帖/评论/点赞/举报，管理员删帖）**，以及**AI 智能客服**（右下角悬浮窗，基于知识库检索 + 大模型回答）。

## 快速开始

```bash
node server.js
# 或
npm start
```

浏览器访问：<http://localhost:3000>（可用 `PORT=8080 node server.js` 换端口）

Windows 也可直接双击 `scripts/启动.bat`。

### 账号

- 自行注册（用户名 2-20 位、限中文/字母/数字/`. _ -`，密码 ≥6 位）；**任何两个用户不得重名**（忽略首尾空格与大小写差异）。
- 账号数据（用户名 + 密码哈希）存于本地 `data/runtime/users.json`，**已 gitignore，不随仓库提交**；代码不预创建任何账号、不内置任何管理员。
- 普通用户：登录、投稿、查看投稿结果、论坛发帖/评论/点赞/举报。
- **指定管理员（仅在本地操作）**：编辑 `data/runtime/users.json`，把目标用户的 `"role"` 改为 `"admin"` 后重启服务；管理员额外拥有审核（通过/退回）、论坛删帖、举报箱处理权限。此操作只发生在你本地，代码中不存在任何自动设置管理员的机制。

流程：**注册 → 投稿 → 管理员在「审核台」通过 → 条目自动写入对应分类数据文件并署名**；退回时填写原因，投稿人可见。

论坛：**发帖 → 他人评论/点赞 → 发现违规可举报 → 管理员在「举报箱」删除内容或忽略**（举报、删帖均在页内完成，不用浏览器弹窗）。

### AI 智能客服

右下角悬浮窗，基于知识库检索结果 + 大模型（OpenAI 兼容接口）回答提问，并附站内参考条目。

- **未配置 key 也能用**：自动降级为知识库检索结果（列出最相关的条目），回复中提示如何配置。
- 配置方法：项目根目录 `ai.config.json`（首次启动自动生成），填入即可（当前已配置 DeepSeek）：

```json
{
  "apiKey": "sk-xxxx",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "temperature": 0.4,
  "maxTokens": 900,
  "systemPrompt": ""
}
```

- 也支持环境变量覆盖：`AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`、`AI_TEMPERATURE`、`AI_MAX_TOKENS`。
- 任何 OpenAI 兼容服务均可（把 `baseUrl` 换成对应地址、`model` 换成对应模型名）。
- 限流：每 IP 每分钟 15 条；上游超时 45 秒，失败时自动降级为知识库检索结果。

### 展示用单文件版（含全套功能）

```bash
node scripts/build.js
```

生成 `dist/陶瓷工艺知识库.html`（约 180 KB，样式/脚本/全部数据内嵌），**双击即可打开**，无需启动服务。数据更新后重新执行 `node scripts/build.js`。

单文件版内置浏览器内本地后端（`public/local-backend.js`），**全部功能可临时运行**：

- 注册 / 登录 / 退出（无内置账号，注册即普通用户；数据存浏览器 localStorage，仅本机可见）
- 账号设置：改昵称（署名同步）、改密码（其他会话下线）
- 网站入口页：中英双语简介，滚动到底「进入网站」
- 投稿 → 管理员审核台通过入库 / 退回附原因
- 论坛发帖 / 评论 / 点赞 / 举报 / 管理员删帖与举报箱
- **AI 智能客服直连 DeepSeek**（构建时把 `ai.config.json` 内嵌 HTML，浏览器直接调用 API，已验证跨域可用）

演示数据存浏览器 localStorage（换浏览器/清缓存即重置）。**注意：内嵌 key 的 HTML 会暴露 API key，不要把 `dist/` 下构建出的 HTML 公开发布（已 gitignore）。**

## 目录结构

```bash
陶瓷工艺知识库/
├─ server.js                 # 服务端：静态托管 + 知识库/账号/投稿/论坛/客服接口（零依赖）
├─ ai.config.json            # AI 客服配置（首次启动自动生成，填 apiKey 即启用）
├─ package.json
├─ public/                   # 网站前端（纯静态，无第三方依赖）
│  ├─ index.html
│  ├─ style.css
│  ├─ app.js
│  └─ local-backend.js       # 单文件版浏览器内本地后端（账号/投稿/论坛/AI 直连）
├─ data/                     # 知识库数据
│  ├─ categories.json        # 元信息 + 分类定义 + 条目文件清单
│  ├─ runtime/               # 运行时数据（首次启动自动创建目录，gitignore，不入库）
│  │  ├─ users.json          # 账号（用户名 + 密码哈希，仅存于本地）
│  │  ├─ submissions.json    # 投稿队列（待审核/已通过/已退回）
│  │  └─ forum.json          # 论坛（帖子 / 评论 / 举报记录）
│  └─ entries/               # 知识条目（按主题分文件存放）
│     ├─ overview.json       # 概述与历史
│     ├─ materials.json      # 原料与泥料
│     ├─ forming.json        # 成型工艺
│     ├─ drying.json         # 干燥工艺
│     ├─ glazing.json        # 釉料与施釉
│     ├─ decoration.json     # 装饰工艺
│     ├─ firing-kiln.json    # 烧成工艺 + 窑炉
│     ├─ famous-crafts.json  # 名窑名瓷 + 传统特种工艺
│     └─ defects-advanced.json # 缺陷与质量 + 先进陶瓷
├─ tests/                    # 测试
│  ├─ test-api.js            # 集成测试：注册→投稿→审核→入库 →论坛/举报
│  ├─ test-forum.js / test-review.js / test-chat.js
│  └─ test-render.js / test-singlefile.js / test-ui.js
├─ scripts/
│  ├─ build.js               # 构建单文件版 HTML → dist/
│  ├─ 启动.bat                # Windows 一键启动（打开浏览器 + node server.js）
│  └─ start-public.ps1       # 本地服务 + Cloudflare 隧道公网访问
├─ tools/                    # 知识条目生成脚本（gen-knowledge / merge-knowledge）
│  └─ generated/             # 生成缓存（gitignore，换机需先跑 gen-knowledge 才能 merge）
├─ assets/design/            # 设计原稿（封面 / 背景）
└─ dist/                     # 构建产物：单文件版 HTML（gitignore，内嵌 key）
```

## 测试

```bash
npm test          # 先构建单文件 HTML，再依次跑全部测试
# 或单独运行
node tests/test-api.js         # API 集成测试（临时目录起独立服务，不污染数据）
node tests/test-forum.js       # 论坛前端交互测试（发帖/评论/点赞/举报/删帖）
node tests/test-review.js      # 投稿审核交互测试（通过/退回）
node tests/test-chat.js        # AI 客服测试（降级/校验/限流 + mock 大模型 + 前端对话交互）
node tests/test-render.js      # 全部正文 Markdown 渲染校验
node tests/test-singlefile.js  # 单文件 HTML 完整性校验
node tests/test-ui.js          # 单文件版路由/搜索 + 本地后端交互测试（最小 DOM 模拟）
```

## 数据条目格式

```json
{
  "id": "unique-id",
  "title": "条目标题",
  "category": "分类 id",
  "tags": ["标签1", "标签2"],
  "summary": "一句话摘要",
  "content": "正文（Markdown：## 标题、- 列表、| 表格、**加粗**）",
  "sources": [{ "title": "来源名称", "url": "https://..." }]
}
```

- 新增条目：在 `data/entries/*.json` 中追加对象即可，重启服务生效。
- 新增分类：在 `data/categories.json` 的 `categories` 中添加（`file` 字段为该分类写入的文件）。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/kb` | 全部知识库数据（条目/分类/计数） |
| GET | `/api/health` | 健康检查 |
| POST | `/api/register` | 注册 `{username,password}`，返回 token |
| POST | `/api/login` | 登录，返回 token（7 天有效） |
| POST | `/api/logout` | 退出（`Authorization: Bearer <token>`） |
| GET | `/api/me` | 当前用户 |
| POST | `/api/user/rename` | 改昵称 `{username}`，同步论坛/投稿/收录署名（登录） |
| POST | `/api/user/password` | 改密码 `{oldPassword,newPassword}`，其他会话下线（登录） |
| GET | `/api/submissions?status=` | 我的投稿；管理员看全部 |
| POST | `/api/submissions` | 提交投稿（需登录） |
| GET | `/api/submissions/:id` | 稿件详情（本人或管理员） |
| POST | `/api/submissions/:id/approve` | 通过并写入知识库（管理员） |
| POST | `/api/submissions/:id/reject` | 退回并附原因（管理员） |
| GET | `/api/forum` | 帖子列表（公开，含点赞/评论数与举报待处理数） |
| POST | `/api/forum/threads` | 发帖（登录） |
| GET | `/api/forum/threads/:id` | 帖子详情 + 评论（公开） |
| POST | `/api/forum/threads/:id/comments` | 评论（登录） |
| POST | `/api/forum/threads/:id/like` | 点赞/取消点赞（登录） |
| POST | `/api/forum/threads/:id/report` | 举报帖子 `{reason}`（登录） |
| POST | `/api/forum/threads/:id/delete` | 删除帖子（管理员） |
| POST | `/api/forum/comments/:id/report` | 举报评论 `{reason}`（登录） |
| POST | `/api/forum/comments/:id/delete` | 删除评论（管理员） |
| GET | `/api/forum/reports` | 举报记录 + 目标预览（管理员） |
| POST | `/api/forum/reports/:id/handle` | 处理举报 `{action: delete\|dismiss}`（管理员） |
| GET | `/api/chat/config` | 客服是否已配置（不泄露 key） |
| POST | `/api/chat` | 智能客服 `{messages:[{role,content}]}`，返回 `{answer,sources,fallback}` |

## 功能

- 网站入口页：打开先见全屏入口（青玉色主题，中英双语简介与功能说明），向下滚动到底点「进入网站」进入
- 12 个分类导航 + 分类卡片统计
- 全文检索（标题/摘要/标签/正文加权排序，关键词高亮）
- 条目详情页：Markdown 渲染、标签、投稿人署名、参考来源、相关条目推荐
- 账号体系：注册/登录/退出，密码 scrypt 加盐存储，会话 token 鉴权；账号设置页可改昵称（论坛/投稿/收录署名同步更新）与改密码（改密后其他设备自动下线）
- 投稿：表单校验（标题/摘要/字数/分类/标签/来源），状态跟踪（待审核/已通过/已退回）
- 审核台：预览、通过入库（自动分类+署名+计数）、退回附原因；页头显示待审数
- 论坛：发帖、评论、点赞（可取消）、举报（页内原因表单），浏览无需登录
- 举报箱：管理员查看举报记录与原帖预览，一键删除内容或忽略；侧栏/页头显示待处理数
- AI 智能客服：右下角悬浮窗，快捷问题、Enter 发送、历史本地保存、来源一键跳转条目；未配置 key 时降级为知识库检索
- 响应式布局，零第三方依赖，无需公网

## 说明

内容整理自公开网络资料（各条目 `sources` 字段标注出处），仅供学习参考。
