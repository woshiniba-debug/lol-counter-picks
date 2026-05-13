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

## 待办 / 可改进
- [ ] 添加多语言支持（英文 / 中文切换）
- [ ] 支持多版本英雄数据（当前只取最新版）
- [ ] 考虑加入 Redis 持久化缓存（替代内存缓存）

## 已知问题
- OP.GG 非官方 API，数据结构可能随更新失效，需定期验证
