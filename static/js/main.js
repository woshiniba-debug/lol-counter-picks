/* ── State ── */
let allChampions = [];
let champById = {};    // id -> champion
let ddVersion = "";
let selectedOpponent = null;
let selectedCounter = null;
let selectedPosition = "";   // "", "top", "jungle", "mid", "bottom", "support"
let selectedTier = "";       // "", "gold_minus", "plat_to_emerald", "diamond_plus"
let lastRawCounters = null;
let lastRawRunes = null;

const POSITION_LABELS = {
  "": "全部路线",
  top: "上路",
  jungle: "打野",
  mid: "中路",
  bottom: "下路",
  support: "辅助",
};

const TIER_LABELS = {
  "": "",
  gold_minus: "黄金及以下",
  plat_to_emerald: "铂金至翡翠",
  diamond_plus: "钻石及以上",
};

/* ── Init ── */
async function init() {
  try {
    const res = await fetch("/api/champions");
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    allChampions = json.data;
    ddVersion = json.version;
    allChampions.forEach((c) => (champById[c.id] = c));
  } catch (e) {
    console.error("加载英雄列表失败:", e);
  }
}

/* ── URLs ── */
function champIconUrl(champ) {
  return `https://ddragon.leagueoflegends.com/cdn/${ddVersion}/img/champion/${champ.image}`;
}
function opggChampionUrl(champId, position = "") {
  const pos = position ? `/${position}` : "";
  return `https://op.gg/lol/champions/${champId.toLowerCase()}/counters${pos}`;
}
function opggRuneUrl(champId, position = "") {
  const pos = position ? `/${position}` : "";
  return `https://op.gg/lol/champions/${champId.toLowerCase()}/runes${pos}`;
}

/* ── Search ── */
const searchInput = document.getElementById("champion-search");
const dropdown = document.getElementById("search-dropdown");

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  if (!q) { dropdown.classList.add("hidden"); return; }
  const qLower = q.toLowerCase();
  const matches = allChampions
    .filter((c) => {
      if (c.name.includes(q) || c.id.toLowerCase().includes(qLower) || c.title.includes(q)) return true;
      // Pinyin search
      const py = CHAMPION_PINYIN[c.id];
      if (py) {
        const [full, abbr] = py.split("|");
        if (full.includes(qLower) || abbr.includes(qLower)) return true;
      }
      return false;
    })
    .slice(0, 12);
  renderDropdown(matches);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") dropdown.classList.add("hidden");
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrapper")) dropdown.classList.add("hidden");
});

function renderDropdown(champions) {
  if (!champions.length) { dropdown.classList.add("hidden"); return; }
  dropdown.innerHTML = champions
    .map(
      (c) => `
    <div class="dropdown-item" data-id="${c.id}">
      <img src="${champIconUrl(c)}" alt="${c.name}" loading="lazy" />
      <div>
        <div class="champ-name">${c.name}</div>
        <div class="champ-title">${c.title}</div>
      </div>
    </div>`
    )
    .join("");
  dropdown.classList.remove("hidden");
  dropdown.querySelectorAll(".dropdown-item").forEach((el) => {
    el.addEventListener("click", () => {
      const champ = champById[el.dataset.id];
      if (champ) selectOpponent(champ);
    });
  });
}

/* ── Select opponent ── */
function selectOpponent(champ) {
  selectedOpponent = champ;
  searchInput.value = champ.name;
  dropdown.classList.add("hidden");

  // Banner
  const banner = document.getElementById("selected-banner");
  banner.querySelector("img").src = champIconUrl(champ);
  banner.querySelector("img").alt = champ.name;
  banner.querySelector(".info h3").textContent = champ.name;
  banner.querySelector(".info p").textContent = champ.title;
  banner.classList.add("visible");

  // Show position/tier bars and reset to defaults
  setPosition("", false);
  setTier("", false);
  document.getElementById("position-bar").classList.remove("hidden");
  document.getElementById("tier-bar").classList.remove("hidden");

  // Update subtitle
  document.getElementById("opponent-name").textContent = champ.name;

  loadCounters(champ, selectedPosition, selectedTier);
}

/* ── Position selection ── */
function setPosition(position, reload = true) {
  selectedPosition = position;

  // Update button active state
  document.querySelectorAll(".pos-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.position === position);
  });

  // Update position description in subtitle
  const desc = document.getElementById("position-desc");
  desc.textContent = position ? `（${POSITION_LABELS[position]}）` : "";

  if (reload && selectedOpponent) {
    loadCounters(selectedOpponent, position, selectedTier);
  }
}

// Wire position buttons
document.querySelectorAll(".pos-btn").forEach((btn) => {
  btn.addEventListener("click", () => setPosition(btn.dataset.position));
});

/* ── Tier selection ── */
function setTier(tier, reload = true) {
  selectedTier = tier;
  document.querySelectorAll(".tier-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tier === tier);
  });
  const desc = document.getElementById("tier-desc");
  desc.textContent = TIER_LABELS[tier] ? `（${TIER_LABELS[tier]}）` : "";
  if (reload && selectedOpponent) {
    loadCounters(selectedOpponent, selectedPosition, selectedTier);
  }
}

// Wire tier buttons
document.querySelectorAll(".tier-btn").forEach((btn) => {
  btn.addEventListener("click", () => setTier(btn.dataset.tier));
});

/* ── Load counters ── */
async function loadCounters(champ, position = "", tier = "") {
  const section = document.getElementById("counters-section");
  const grid = document.getElementById("counters-grid");
  const title = document.getElementById("counters-title");
  const posLabel = POSITION_LABELS[position] || "全部路线";

  section.classList.add("visible");
  title.textContent = `克制 ${champ.name}（${posLabel}）的英雄推荐`;
  grid.innerHTML = loadingHtml();

  // Hide runes
  document.getElementById("runes-section").classList.remove("visible");
  selectedCounter = null;
  lastRawRunes = null;

  const params = new URLSearchParams();
  if (position) params.set("position", position);
  if (tier) params.set("tier", tier);
  const qs = params.toString() ? `?${params.toString()}` : "";

  try {
    const res = await fetch(`/api/counters/${champ.id}${qs}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    lastRawCounters = json.data;
    const counters = parseCounters(json.data);

    if (!counters.length) {
      grid.innerHTML = `<div class="error-msg">暂无该路线克制数据，请查看 <a class="opgg-link" href="${opggChampionUrl(champ.id, position)}" target="_blank">OP.GG</a></div>`;
      return;
    }

    renderCounters(counters, champ);
  } catch (e) {
    grid.innerHTML = `
      <div>
        <div class="error-msg">${e.message}</div>
        <a class="opgg-link" href="${opggChampionUrl(champ.id, position)}" target="_blank">前往 OP.GG 查看</a>
      </div>`;
  }
}

/* ── Parse counter response ── */
// Backend returns list sorted ascending by confidence_score (best counter first).
// Each item: {play, win, win_rate, confidence_score, champion:{name, key, image_url}}
function parseCounters(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.data)) list = raw.data;

  return list
    .filter((item) => item && item.champion)
    .map((item) => ({
      champId: item.champion.key || "",
      name: item.champion.name || "",
      image: item.champion.image_url || "",
      winRate: item.win_rate ?? 50,
      confidenceScore: item.confidence_score ?? item.win_rate ?? 50,
      gameCount: item.play ?? null,
      raw: item,
    }));
  // Already sorted by backend (confidence_score ascending)
}

/* ── Render counter grid ── */
function renderCounters(counters, opponent) {
  const grid = document.getElementById("counters-grid");

  grid.innerHTML = counters
    .map((c, i) => {
      const wr = c.winRate;
      const wrPct = wr <= 1 ? (wr * 100).toFixed(1) : wr.toFixed(1);
      const wrNum = parseFloat(wrPct);

      let wrClass = "neutral";
      let fillColor = "#c89b3c";
      if (wrNum < 46) { wrClass = "good"; fillColor = "#00c853"; }
      else if (wrNum > 54) { wrClass = "bad"; fillColor = "#e53935"; }

      const fillPct = Math.min(100, Math.max(0, wrNum));

      const gameCount = c.gameCount ?? 0;
      const lowSample = gameCount > 0 && gameCount < 100;
      const games = gameCount > 0
        ? `${formatNum(gameCount)} 场对局${lowSample ? " ⚠" : ""}`
        : "";

      const imgSrc = resolveChampImg(c);

      return `
      <div class="counter-card" data-idx="${i}" onclick="selectCounter(${i})">
        <div class="counter-card-inner">
          <div class="rank-badge">${i + 1}</div>
          <img src="${imgSrc}" alt="${c.name}" onerror="this.src='/static/img/placeholder.png'" loading="lazy" />
          <div class="champ-name">${c.name}</div>
          <div class="wr-label">${opponent.name} 对位胜率</div>
          <div class="wr-value ${wrClass}">${wrPct}%</div>
          <div class="wr-bar-bg">
            <div class="wr-bar-fill" style="width:${fillPct}%;background:${fillColor}"></div>
          </div>
          ${games ? `<div class="games-count">${games}</div>` : ""}
        </div>
      </div>`;
    })
    .join("");
}

function resolveChampImg(c) {
  // Prefer OP.GG's own CDN image (already a full URL from scraping)
  if (c.image && c.image.startsWith("http")) return c.image;
  // Fallback: Data Dragon
  if (c.champId) {
    const local = champById[c.champId] || findChampByKey(c.champId);
    if (local) return champIconUrl(local);
    return `https://opgg-static.akamaized.net/meta/images/lol/champion/${c.champId}.png`;
  }
  return "";
}

function findChampByKey(key) {
  const k = key.toLowerCase();
  return allChampions.find((c) => c.id.toLowerCase() === k) || null;
}

/* ── Select counter → load runes ── */
function selectCounter(idx) {
  document.querySelectorAll(".counter-card").forEach((el) => el.classList.remove("selected"));
  const card = document.querySelector(`.counter-card[data-idx="${idx}"]`);
  if (card) card.classList.add("selected");

  const counters = parseCounters(lastRawCounters);
  const c = counters[idx];
  if (!c) return;
  selectedCounter = c;
  loadRunes(c, selectedPosition, selectedTier);
}

/* ── Load runes ── */
async function loadRunes(c, position = "", tier = "") {
  const section = document.getElementById("runes-section");
  const body = document.getElementById("runes-body");
  section.classList.add("visible");

  const local = c.champId ? (champById[c.champId] || findChampByKey(c.champId)) : null;
  const name = local ? local.name : c.name;
  const imgSrc = local ? champIconUrl(local) : (c.image || "");
  const champId = c.champId || (local && local.id) || "";

  document.getElementById("rune-champ-img").src = imgSrc;
  document.getElementById("rune-champ-img").alt = name;
  document.getElementById("rune-champ-name").textContent = name;
  document.getElementById("rune-opgg-link").href = opggRuneUrl(champId, position);

  // Show which position's rune this is
  const posLabel = POSITION_LABELS[position] || "全部路线";
  document.getElementById("rune-position-desc").textContent =
    `来源：OP.GG 高胜率符文页（${posLabel}）`;

  body.innerHTML = loadingHtml();

  const runeParams = new URLSearchParams();
  if (position) runeParams.set("position", position);
  const runeQs = runeParams.toString() ? `?${runeParams.toString()}` : "";
  try {
    const res = await fetch(`/api/runes/${champId}${runeQs}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    lastRawRunes = json.data;
    renderRunes(json.data, name, champId);
  } catch (e) {
    body.innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

/* ── Render runes ── */
// OP.GG rune data shape (from RSC scraping):
// rune_pages: [{id, play, pick_rate, builds: [{
//   primary_perk_style:{id,name,image_url}, perk_sub_style:{...},
//   main_runes: [[{id,name,image_url,isActive},…], …],   ← rows; pick isActive=true
//   sub_runes:  [[{id,name,image_url,isActive},…], …],
//   stat_perks: [[{id,name,image_url,isActive},…], …],
//   win, play, pick_rate
// }]}
function renderRunes(raw, champName, champId) {
  const body = document.getElementById("runes-body");

  // raw is the direct array returned by /api/runes (= rune_pages)
  const pages = Array.isArray(raw) ? raw : [];

  if (!pages.length) {
    body.innerHTML = `<div class="error-msg">暂无符文数据</div>
      <a class="opgg-link" href="${opggRuneUrl(champId)}" target="_blank">前往 OP.GG 查看符文</a>`;
    return;
  }

  // Pick the build with highest pick_rate from the top page
  const topPage = pages[0];
  const builds = topPage.builds || [];
  const build = builds[0];

  if (!build) {
    body.innerHTML = `<div class="error-msg">暂无构建数据</div>`;
    return;
  }

  const primaryStyle = build.primary_perk_style || {};
  const secondaryStyle = build.perk_sub_style || {};
  const mainRunes = build.main_runes || [];   // array of rows, each row = array of rune choices
  const subRunes = build.sub_runes || [];
  const statPerks = build.stat_perks || [];

  // Win rate and game count
  const wr = build.win != null && build.play ? (build.win / build.play * 100) : null;
  const plays = build.play ?? null;

  function renderRuneRow(row, isKeystone = false) {
    if (!row || !row.length) return "";
    const active = row.find((r) => r.isActive) || row[0];
    if (!active) return "";
    const cls = isKeystone ? "rune-icon keystone" : "rune-icon";
    return `
      <div class="rune-slot">
        <img class="${cls}" src="${active.image_url || ""}" alt="${active.name || ""}"
             onerror="this.style.display='none'" loading="lazy"/>
        <div class="rune-name">${active.name || ""}</div>
      </div>`;
  }

  const primaryHtml = mainRunes.map((row, i) => renderRuneRow(row, i === 0)).join("");
  const secondaryHtml = subRunes.map((row) => renderRuneRow(row, false)).join("");

  const statHtml = statPerks.map((row) => {
    const active = (row || []).find((r) => r.isActive) || (row || [])[0];
    return active ? `<div class="stat-shard">${active.name || ""}</div>` : "";
  }).join("");

  const statsLineHtml = (wr != null || plays != null) ? `
    <div class="rune-stats">
      ${wr != null ? `<span>胜率 <span class="rune-stat-val">${wr.toFixed(1)}%</span></span>` : ""}
      ${plays != null ? `<span>场次 <span class="rune-stat-val">${formatNum(plays)}</span></span>` : ""}
    </div>` : "";

  body.innerHTML = `
    ${statsLineHtml}
    <div class="rune-page">
      <div class="rune-path-block">
        <div class="rune-path-name">
          ${primaryStyle.image_url ? `<img src="${primaryStyle.image_url}" style="width:18px;height:18px;vertical-align:middle;margin-right:4px">` : ""}
          ${primaryStyle.name || "主系"}
        </div>
        ${primaryHtml}
      </div>
      <div class="rune-path-block">
        <div class="rune-path-name">
          ${secondaryStyle.image_url ? `<img src="${secondaryStyle.image_url}" style="width:18px;height:18px;vertical-align:middle;margin-right:4px">` : ""}
          ${secondaryStyle.name || "副系"}
        </div>
        ${secondaryHtml}
      </div>
    </div>
    ${statHtml ? `<div class="stat-shards">${statHtml}</div>` : ""}`;
}

function runeImg(rune) {
  if (rune.image_url) return rune.image_url;
  if (rune.image && rune.image.startsWith("http")) return rune.image;
  if (rune.icon) return `https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`;
  if (rune.id) return `https://opgg-static.akamaized.net/meta/images/lol/perk/${rune.id}.png`;
  return "";
}

/* ── Helpers ── */
function loadingHtml() {
  return `<div class="loading"><div class="spinner"></div>加载中...</div>`;
}

function formatNum(n) {
  if (!n) return "0";
  if (n >= 10000) return (n / 10000).toFixed(1) + " 万";
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function toggleRaw(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === "block" ? "none" : "block";
}

/* ── Boot ── */
init();
