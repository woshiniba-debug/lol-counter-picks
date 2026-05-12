/* ── State ── */
let allChampions = [];
let champById = {};    // id -> champion
let ddVersion = "";
let selectedOpponent = null;
let selectedCounter = null;
let lastRawCounters = null;
let lastRawRunes = null;

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
function opggChampionUrl(champId) {
  return `https://www.op.gg/champions/${champId.toLowerCase()}/counters`;
}
function opggRuneUrl(champId) {
  return `https://www.op.gg/champions/${champId.toLowerCase()}/runes`;
}

/* ── Search ── */
const searchInput = document.getElementById("champion-search");
const dropdown = document.getElementById("search-dropdown");

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  if (!q) { dropdown.classList.add("hidden"); return; }
  const matches = allChampions
    .filter(
      (c) =>
        c.name.includes(q) ||
        c.id.toLowerCase().includes(q.toLowerCase()) ||
        c.title.includes(q)
    )
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

  loadCounters(champ);
}

/* ── Load counters ── */
async function loadCounters(champ) {
  const section = document.getElementById("counters-section");
  const grid = document.getElementById("counters-grid");
  const title = document.getElementById("counters-title");

  section.classList.add("visible");
  title.textContent = `克制 ${champ.name} 的英雄推荐`;
  grid.innerHTML = loadingHtml();

  // Hide runes
  document.getElementById("runes-section").classList.remove("visible");
  selectedCounter = null;
  lastRawRunes = null;

  try {
    const res = await fetch(`/api/counters/${champ.id}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    lastRawCounters = json.data;
    const counters = parseCounters(json.data);

    if (!counters.length) {
      grid.innerHTML = `<div class="error-msg">暂无克制数据，请查看 <a class="opgg-link" href="${opggChampionUrl(champ.id)}" target="_blank">OP.GG</a></div>`;
      return;
    }

    renderCounters(counters, champ);
  } catch (e) {
    grid.innerHTML = `
      <div>
        <div class="error-msg">${e.message}</div>
        <a class="opgg-link" href="${opggChampionUrl(champ.id)}" target="_blank">前往 OP.GG 查看</a>
        <div id="raw-toggle" style="display:block" onclick="toggleRaw('raw-panel')">查看原始数据</div>
        <div id="raw-panel">${JSON.stringify(lastRawCounters, null, 2)}</div>
      </div>`;
  }
}

/* ── Parse OP.GG counter response ── */
function parseCounters(raw) {
  // Try multiple response shapes OP.GG might use
  let list = [];

  if (Array.isArray(raw)) list = raw;
  else if (raw.data && Array.isArray(raw.data)) list = raw.data;
  else if (raw.counters && Array.isArray(raw.counters)) list = raw.counters;

  return list
    .map((item) => {
      const champion = item.champion || item;
      const champId =
        champion.key || champion.champion_key || champion.id_name || item.champion_key || item.id_name;
      const name =
        champion.name || item.name || champId;
      const image =
        champion.image_url || champion.imageUrl || champion.image ||
        (champId ? `${champId}.png` : null);

      const wr =
        item.win_rate ?? item.winRate ?? item.win ?? item.stats?.win_rate ?? null;
      const games =
        item.game_count ?? item.gameCount ?? item.play_count ?? item.count ?? item.stats?.game_count ?? null;

      if (!champId && !name) return null;
      return { champId, name, image, winRate: wr, gameCount: games, raw: item };
    })
    .filter(Boolean)
    .filter((c) => c.winRate !== null)
    .sort((a, b) => a.winRate - b.winRate); // ascending: lowest wr first = best counter
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

      const games = c.gameCount !== null
        ? `${formatNum(c.gameCount)} 场对局`
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
  if (!c.champId) return "";
  const local = champById[c.champId] || findChampByKey(c.champId);
  if (local) return champIconUrl(local);
  // OP.GG CDN fallback
  if (c.image && c.image.startsWith("http")) return c.image;
  return `https://opgg-static.akamaized.net/meta/images/lol/champion/${c.champId}.png`;
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
  loadRunes(c);
}

/* ── Load runes ── */
async function loadRunes(c) {
  const section = document.getElementById("runes-section");
  const body = document.getElementById("runes-body");
  section.classList.add("visible");

  const local = c.champId ? (champById[c.champId] || findChampByKey(c.champId)) : null;
  const name = local ? local.name : c.name;
  const imgSrc = local ? champIconUrl(local) : "";
  const champId = c.champId || (local && local.id) || "";

  document.getElementById("rune-champ-img").src = imgSrc;
  document.getElementById("rune-champ-img").alt = name;
  document.getElementById("rune-champ-name").textContent = name;
  document.getElementById("rune-opgg-link").href = opggRuneUrl(champId);

  body.innerHTML = loadingHtml();

  try {
    const res = await fetch(`/api/runes/${champId}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    lastRawRunes = json.data;
    renderRunes(json.data, name, champId);
  } catch (e) {
    body.innerHTML = `
      <div class="error-msg">${e.message}</div>
      <div id="raw-toggle" style="display:block" onclick="toggleRaw('raw-rune-panel')">查看原始数据</div>
      <div id="raw-rune-panel" class="raw-panel">${JSON.stringify(lastRawRunes, null, 2)}</div>`;
  }
}

/* ── Render runes ── */
function renderRunes(raw, champName, champId) {
  const body = document.getElementById("runes-body");

  // Parse OP.GG rune response shapes
  let pages = [];
  if (Array.isArray(raw)) pages = raw;
  else if (raw.data && Array.isArray(raw.data)) pages = raw.data;
  else if (raw.rune_pages) pages = raw.rune_pages;

  if (!pages.length) {
    body.innerHTML = `<div class="error-msg">暂无符文数据</div>
      <a class="opgg-link" href="${opggRuneUrl(champId)}" target="_blank">前往 OP.GG 查看符文</a>`;
    return;
  }

  // Use top rune page (highest pick rate / win rate)
  const page = pages[0];

  const primary = page.primary_page || page.primaryPage || page.primary || {};
  const secondary = page.secondary_page || page.secondaryPage || page.secondary || {};
  const statPerks = page.stat_perks || page.statPerks || page.stat_shards || [];
  const wr = page.win_rate ?? page.winRate;
  const plays = page.play_count ?? page.pickCount ?? page.count;

  const primarySlots = primary.slots || primary.runes || [];
  const secondarySlots = secondary.slots || secondary.runes || [];

  function renderSlots(slots, isSecondary = false) {
    return slots.map((slot, si) => {
      const runes = slot.runes || slot.picks || (Array.isArray(slot) ? slot : [slot]);
      const pickedRune = runes[0];
      if (!pickedRune) return "";
      const isKey = si === 0 && !isSecondary;
      const img = runeImg(pickedRune);
      const runeName = pickedRune.name || pickedRune.rune_name || "未知";
      return `
        <div class="rune-slot">
          <img class="rune-icon${isKey ? " keystone" : ""}" src="${img}" alt="${runeName}" onerror="this.style.display='none'" loading="lazy"/>
          <div>
            <div class="rune-name">${runeName}</div>
          </div>
        </div>`;
    }).join("");
  }

  const statsHtml = wr != null || plays != null
    ? `<div class="rune-stats">
        ${wr != null ? `<span>胜率 <span class="rune-stat-val">${(wr <= 1 ? wr * 100 : wr).toFixed(1)}%</span></span>` : ""}
        ${plays != null ? `<span>场次 <span class="rune-stat-val">${formatNum(plays)}</span></span>` : ""}
      </div>` : "";

  const statShardsHtml = statPerks.length
    ? `<div class="stat-shards">${statPerks.slice(0, 3).map((s) => `<div class="stat-shard">${s.name || s}</div>`).join("")}</div>`
    : "";

  body.innerHTML = `
    ${statsHtml}
    <div class="rune-page">
      <div class="rune-path-block">
        <div class="rune-path-name">${primary.name || primary.page_name || "主系符文"}</div>
        ${renderSlots(primarySlots)}
      </div>
      <div class="rune-path-block">
        <div class="rune-path-name">${secondary.name || secondary.page_name || "副系符文"}</div>
        ${renderSlots(secondarySlots, true)}
      </div>
    </div>
    ${statShardsHtml}`;
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
