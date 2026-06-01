# 英雄联盟 Counter 克制查询 / LOL Counter Picks

<div align="center">

**🌐 Language / 语言：** [English](#english) | [中文](#chinese)

</div>

---

<a id="english"></a>
## LOL Counter Pick Tool

A one-click tool to query counter picks and rune recommendations from OP.GG, helping players quickly find the best counter during champion select.

### Features

- **Champion Search** — Fuzzy search by Chinese or English name
- **Counter Rankings** — Real-time data from OP.GG, sorted by the enemy champion's win rate against each counter (lower win rate = harder counter), showing match count
- **Swing Lane (Two Opponents)** — When you don't know which of two champions the enemy will lock, pick both and find champions that counter *both* (ranked by the weaker of the two matchups, so your blind pick holds up no matter which they choose)
- **Rune Recommendations** — Click any counter champion to display the highest win-rate rune page from OP.GG
- **Data Sources** — Champion list from Riot Data Dragon; win rates and runes from the OP.GG unofficial API

### Tech Stack

- **Backend**: Python + Flask (proxies OP.GG requests to bypass CORS; TTL cache to reduce repeated calls)
- **Frontend**: Vanilla HTML / CSS / JavaScript (no framework)
- **Data**: Riot Data Dragon (champion icons) + OP.GG API (win rates, runes)
- **WAF bypass**: Playwright headless Chromium auto-solves OP.GG's AWS WAF challenge (used only to mint a token; scraping stays on plain requests)

### Deployment

#### Option 1 — Local (Recommended for personal use)

**Requirements:** Python 3.8+

```bash
git clone https://github.com/woshiniba-debug/lol-counter-picks.git
cd lol-counter-picks
pip install -r requirements.txt
playwright install chromium    # one-time: headless browser to clear OP.GG's AWS WAF
python app.py
# Open http://localhost:5000
```

> OP.GG now sits behind AWS WAF, which blocks plain requests with a challenge page. This project uses a headless browser to solve the challenge once, grab the token, and keep scraping with plain requests — fully transparent, just like opening OP.GG in your own browser.

#### Option 2 — Docker

```bash
docker build -t lol-counter-picks .
docker run -p 5000:5000 lol-counter-picks
# Open http://localhost:5000
```

Or with Docker Compose:

```yaml
# docker-compose.yml
services:
  app:
    build: .
    ports:
      - "5000:5000"
    restart: unless-stopped
```

```bash
docker compose up -d
```

#### Option 3 — Self-hosted Server (Linux)

```bash
git clone https://github.com/woshiniba-debug/lol-counter-picks.git
cd lol-counter-picks
pip install -r requirements.txt gunicorn
playwright install chromium
gunicorn -w 2 -b 0.0.0.0:5000 app:app
```

As a systemd service:

```ini
[Unit]
Description=LOL Counter Picks
After=network.target

[Service]
WorkingDirectory=/path/to/lol-counter-picks
ExecStart=/usr/bin/gunicorn -w 2 -b 0.0.0.0:5000 app:app
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now lol-counter
```

### Usage

1. Type the enemy champion's name in the search box
2. Select the champion from the dropdown
3. The page shows a ranked list of counters sorted by lowest enemy win rate (hardest counters first)
4. Click any counter champion on the right to view the recommended rune setup

**Swing lane (enemy might pick one of two champions):**

1. Click the "Swing Lane · Two Opponents" toggle above the search box
2. Search and pick the two possible enemy champions (two slots, each removable with ×)
3. The page lists champions that counter both, each card showing the win rate against each opponent

### Notes

- The OP.GG data endpoint is an unofficial usage. If data fails to load, the page provides a direct link to OP.GG as a fallback.
- If you skip `playwright install chromium`, the first request will fail because it can't clear the WAF challenge.
- If OP.GG upgrades the challenge to an interactive CAPTCHA, the automated approach will break and you'll need a different data source.

---

<a id="chinese"></a>
## 英雄联盟 Counter 位克制查询

一键查询 OP.GG 上的克制英雄，帮助玩家在选英雄阶段快速找到克制对手的最佳 Counter。

### 功能

- **搜索对方英雄**：支持中文名、英文名模糊搜索
- **克制英雄排行**：从 OP.GG 获取实时数据，以对方英雄对位胜率**由低到高**排序（胜率越低 = 被克制越明显），并展示对局场次
- **摇摆位 · 两个对手**：不知道对面会锁哪个英雄时，选两个英雄，找出**同时克制这两个**的高胜率英雄（按两个对位里较弱的一方加权排序，无论对方最终选谁都稳）
- **符文推荐**：点击任意克制英雄，自动展示该英雄在 OP.GG 上胜率最高的符文配置
- **数据源**：英雄列表来自 Riot Data Dragon，胜率与符文数据来自 OP.GG 非官方 API

### 技术栈

- **后端**：Python + Flask（代理 OP.GG 请求，规避 CORS；TTL 缓存减少重复请求）
- **前端**：原生 HTML / CSS / JavaScript，无需额外框架
- **数据**：Riot Data Dragon（英雄图标）+ OP.GG API（胜率、符文）
- **过墙**：Playwright 无头 Chromium 自动通过 OP.GG 的 AWS WAF 验证（仅作令牌发放，抓取仍走普通请求）

### 部署方法

#### 方式一 — 本地运行（个人使用推荐）

**环境要求：** Python 3.8+

```bash
git clone https://github.com/woshiniba-debug/lol-counter-picks.git
cd lol-counter-picks
pip install -r requirements.txt
playwright install chromium    # 装一次无头浏览器，用于自动通过 OP.GG 的 AWS WAF 验证
python app.py
# 访问 http://localhost:5000
```

> OP.GG 现在挂在 AWS WAF 后面，普通请求会被拦在验证页。本项目用 Playwright 无头浏览器自动解一次验证、拿到令牌后继续用普通请求抓取，对你完全透明——就像你自己用浏览器打开 OP.GG 一样。

#### 方式二 — Docker

```bash
docker build -t lol-counter-picks .
docker run -p 5000:5000 lol-counter-picks
```

#### 方式三 — Linux 服务器自托管

```bash
pip install gunicorn
playwright install chromium    # 同样需要装一次无头浏览器
gunicorn -w 2 -b 0.0.0.0:5000 app:app
```

配合 Nginx 反代并配置 HTTPS 即可公网访问。

### 使用方法

1. 在搜索框输入对方选择的英雄
2. 从下拉列表选择英雄
3. 页面展示克制英雄列表，按"对方英雄对该英雄的胜率"升序排列
4. 点击某个克制英雄，右侧展示 OP.GG 推荐符文

**摇摆位（对面可能选两个英雄之一）**：

1. 点搜索框上方的「摇摆位 · 两个对手」切换模式
2. 依次搜索并选择两个可能的对方英雄（两个槽位，可单独 × 移除）
3. 页面展示同时克制这两个英雄的推荐列表，每张卡片分别显示对两人的对位胜率

### 注意事项

- OP.GG 的数据接口属于非官方使用，如遇数据加载失败，页面会提供直接跳转 OP.GG 的链接。
- 若没跑 `playwright install chromium`，首次请求会因无法通过 WAF 验证而报错。
- 若 OP.GG 把验证升级为需人工点选的图形 CAPTCHA，自动方案会失效，需改用其它数据源。
