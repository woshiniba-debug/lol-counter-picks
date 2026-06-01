# lol-counter-picks — AI 规则 & 长期记忆

## 项目概述
一键查询 OP.GG 克制英雄与符文推荐，Counter 位选手必备工具。
本地路径：`C:\Users\LYJ\lol-counter-picks\`

## 技术栈
- **后端**：Python 3 + Flask，爬取 OP.GG RSC 格式数据，CORS + TTL 内存缓存
- **前端**：原生 HTML / CSS / JavaScript（单页）
- **数据源**：Riot Data Dragon（英雄图鉴）+ OP.GG 非官方 API（胜率、符文）

## 关键文件
| 文件 | 说明 |
|------|------|
| `app.py` | Flask 路由层（仅路由，逻辑在各模块） |
| `opgg.py` | OP.GG RSC 爬虫：克制 / 双英雄克制 / 符文 |
| `waf.py` | AWS WAF 挑战求解器（Playwright 拿 aws-waf-token） |
| `http_client.py` | 共享 requests 会话（连接池、UA、重试） |
| `riot.py` | Riot Data Dragon 英雄列表 / 版本 |
| `cache.py` | TTL 内存缓存 |
| `templates/index.html`、`static/` | 前端单页面 + JS / CSS |
| `requirements.txt` | 依赖：flask, requests, playwright（+ `playwright install chromium`） |

## API 路由
- `GET /api/champions` — 从 Data Dragon 获取英雄列表（缓存 24h）
- `GET /api/counters/<champion_id>?position=&tier=` — OP.GG 克制列表（缓存 30min）
- `GET /api/dual-counters/<champion_a>/<champion_b>?position=&tier=` — 摇摆位双英雄：同时克制两个英雄的公共反制英雄（缓存 30min）
- `GET /api/runes/<champion_id>?position=` — OP.GG 符文推荐（缓存 30min）

## 核心算法
- **置信度评分**：贝叶斯平均（基准权重 200，向 50% 胜率收缩），低样本英雄排名靠后
- **OP.GG 爬虫**：解析 `__next_f.push([1,"..."])` RSC 格式，正则提取 JSON 块
- **plat_to_emerald**：platinum_plus 数据减去 diamond_plus 数据，重算胜率
- **dual-counters（摇摆位）**：取两个英雄克制列表的交集，按两个对位中“较弱一方”的 confidence_score（即 `max(score_a, score_b)`）升序排序——保证推荐英雄对两个对手都稳，而非只克制其中一个

## 开发注意事项
- **OP.GG AWS WAF 反爬（2026-06-01 解决）**：OP.GG 在 `op.gg/lol/...` 前加了 AWS WAF，直接 `requests` 会拿到 `202` + JS 挑战页（`gokuProps`/`awsWafCookieDomainList`），无业务数据。解决方案见 `waf.py`：用 **Playwright 无头 Chromium 当"令牌发放器"**——解一次挑战拿到 `aws-waf-token` cookie 注入到共享 `requests` 会话，之后全部抓取仍走快速 `requests` 路径（实测该 token 只认 cookie+UA，不校验 TLS 指纹）。仅在 `_fetch_rsc` 检测到挑战页（202）时才唤醒浏览器重新拿令牌，加锁 + 30s 去重避免并发时重复启动浏览器。
- **首次部署需装浏览器**：`pip install -r requirements.txt` 后必须再跑一次 `playwright install chromium`，否则过不了 WAF。
- `Accept-Encoding` 不能含 `br`（brotli），requests 不解，会乱码（见 http_client.py）
- OP.GG 页面结构可能随版本更新变化，爬虫需定期验证
- `Accept-Encoding` 不能包含 `br`（brotli），requests 不支持，会导致乱码
- 运行：`python app.py` → `http://localhost:5000`