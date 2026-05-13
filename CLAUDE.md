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
| `app.py` | Flask 主程序，全部后端逻辑 |
| `templates/index.html` | 前端单页面 |
| `requirements.txt` | 依赖：flask, requests |

## API 路由
- `GET /api/champions` — 从 Data Dragon 获取英雄列表（缓存 24h）
- `GET /api/counters/<champion_id>?position=&tier=` — OP.GG 克制列表（缓存 30min）
- `GET /api/runes/<champion_id>?position=` — OP.GG 符文推荐（缓存 30min）

## 核心算法
- **置信度评分**：贝叶斯平均（基准权重 200，向 50% 胜率收缩），低样本英雄排名靠后
- **OP.GG 爬虫**：解析 `__next_f.push([1,"..."])` RSC 格式，正则提取 JSON 块
- **plat_to_emerald**：platinum_plus 数据减去 diamond_plus 数据，重算胜率

## 开发注意事项
- OP.GG 页面结构可能随版本更新变化，爬虫需定期验证
- `Accept-Encoding` 不能包含 `br`（brotli），requests 不支持，会导致乱码
- 运行：`python app.py` → `http://localhost:5000`