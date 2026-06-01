# TASK.md — 当前任务

## 状态：运行正常（2026-05-14）

## 已完成
- [x] Flask 后端 + OP.GG 爬虫（克制英雄、符文）
- [x] Riot Data Dragon 英雄列表 + 图标
- [x] 置信度贝叶斯评分（低样本惩罚）
- [x] plat_to_emerald 分段数据推导
- [x] 前端单页面（选英雄、查克制、查符文）
- [x] TTL 内存缓存（避免重复请求）
- [x] **架构重构（2026-05-13）**：后端拆分为 cache / http_client / riot / opgg / app 五个模块；前端 main.js 改写为 IIFE + 防抖 + AbortController + 事件委托；pinyin.js 加入 PinyinSearch 评分索引；CSS 加入平板断点与 a11y 焦点环；HTML 加入 ARIA 与 preconnect
- [x] **前端 UI 美化（2026-05-14）**：响应式（375 / 768 / 1200+ 三档断点）、英雄卡片圆角阴影 + 悬浮鼠标光斑跟踪动效、胜率颜色编码细化（<49% 绿 / 49-52% 黄 / >52% 红）、符文图标网格化布局 + `data-tooltip` 名称提示、搜索框初始化期 loading spinner、整体配色与渐变背景升级；仅改动 `style.css` / `index.html` / `main.js` 三个文件

## 已完成（续）
- [x] **摇摆位双英雄克制（2026-06-01）**：新增 `/api/dual-counters/<a>/<b>` 路由 + `opgg.get_dual_counters()`，取两英雄克制列表交集、按 `max(score_a, score_b)` 升序排序；前端加“单个对手 / 摇摆位·两个对手”模式切换、双英雄选择槽、双对位胜率卡片。仅改 `app.py`/`opgg.py`/`index.html`/`main.js`/`style.css`，未改既有单英雄流程。**已端到端实跑验证**（盖伦+德莱厄斯，61 条结果，UI 截图正常）
- [x] **突破 OP.GG AWS WAF 反爬（2026-06-01）**：新增 `waf.py`，用 Playwright 浏览器解一次 JS 挑战拿 `aws-waf-token` cookie 注入 requests 会话；`_fetch_rsc` 检测到 202 挑战页时自动重新取令牌并重试。实测该 token 只认 cookie+UA、不校验 TLS 指纹，所以抓取主路径仍是快速 requests。浏览器优先用系统 `msedge → chrome`，回退自带 chromium
- [x] **打包成桌面软件（2026-06-01）**：`launcher.py` 入口 + `LOLCounter.spec` + `build.bat`，PyInstaller 出 `dist\LOLCounter\LOLCounter.exe`（双击开浏览器，无需装 Python）。靠系统 Edge 过 WAF 不打包 Chromium，包体 ~138MB / zip ~52MB。frozen exe 实测单英雄+双英雄查询均正常

## 待办 / 可改进
- [ ] 添加多语言支持（英文 / 中文切换）
- [ ] 支持多版本英雄数据（当前只取最新版）
- [ ] 考虑加入 Redis 持久化缓存（替代内存缓存）
- [ ] WAF token 可持久化到磁盘，避免每次重启都要重新启动浏览器解一次

## 已知问题
- OP.GG 非官方 API，数据结构可能随更新失效，需定期验证
- 若 OP.GG 把 WAF 升级成需人工点选的 CAPTCHA，无头方案会失效，届时需换数据源（U.GG / Riot 官方对位数据）
