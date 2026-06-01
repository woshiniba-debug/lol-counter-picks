/* LOL Counter Picks — frontend controller
 *
 * Refactor goals:
 *   1. No top-level globals. Everything lives inside the IIFE; only the
 *      DOM-attribute handlers we still need (selectCounter via delegation)
 *      stay accessible internally.
 *   2. Cache DOM lookups once at boot — `document.getElementById` in hot
 *      paths (every keystroke, every render) is wasteful.
 *   3. Debounce search input so we score the index ≤1 time per ~120ms
 *      typing burst instead of every keystroke.
 *   4. AbortController cancels stale fetches when the user changes
 *      opponent/position/tier mid-flight. Without this, a slow OP.GG
 *      response could clobber the UI with outdated data after the user
 *      already moved on.
 *   5. Event delegation for grid clicks (counter cards) — one listener
 *      on the parent instead of one per card.
 *   6. Inline `onclick=` handlers removed (CSP-friendly, easier to test).
 */
(function () {
  "use strict";

  /* ── Constants ─────────────────────────────────────────────────────── */
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

  const SEARCH_DEBOUNCE_MS = 120;
  const SEARCH_LIMIT = 12;
  // Win-rate thresholds (operate on the displayed value, which is the
  // opponent's WR vs the counter pick).
  //   < 49 %  → good (counter is strong)   → green
  //   49–52 % → neutral                    → yellow
  //   > 52 %  → bad (counter is weak)      → red
  const WR_GOOD_BELOW = 49;
  const WR_BAD_ABOVE = 52;
  const LOW_SAMPLE_THRESHOLD = 100;

  const PLACEHOLDER_IMG = "/static/img/placeholder.png";
  const OPGG_FALLBACK_IMG_BASE =
    "https://opgg-static.akamaized.net/meta/images/lol/champion/";

  /* ── State ─────────────────────────────────────────────────────────── */
  // All state in one place — easier to reason about than the original
  // scattered `let` declarations.
  const state = {
    champions: [],
    champById: {},
    searchIndex: null,
    ddVersion: "",
    // "single": one opponent → counters. "dual": two opponents (swing lane) →
    // picks that counter both.
    mode: "single",
    opponent: null,     // slot A in dual mode
    opponentB: null,    // slot B (dual mode only)
    countersRaw: null,
    // Parsed list currently rendered in the grid (single- or dual-shaped).
    // selectCounter indexes into this so it stays mode-agnostic.
    countersParsed: [],
    selectedCounterIdx: null,
    position: "",
    tier: "",
    // AbortControllers for in-flight fetches; canceled when user changes selection.
    activeFetch: { counters: null, runes: null },
  };

  /* ── DOM refs (populated on DOMContentLoaded) ───────────────────────── */
  const dom = {};

  function cacheDom() {
    dom.modeBar       = document.querySelector(".mode-bar");
    dom.searchWrapper = document.querySelector(".search-wrapper");
    dom.searchLabel   = document.querySelector(".search-label");
    dom.searchInput   = document.getElementById("champion-search");
    dom.dropdown      = document.getElementById("search-dropdown");
    dom.banner        = document.getElementById("selected-banner");
    dom.dualBanner    = document.getElementById("dual-banner");
    dom.positionBar   = document.getElementById("position-bar");
    dom.tierBar       = document.getElementById("tier-bar");
    dom.countersSect  = document.getElementById("counters-section");
    dom.countersTitle = document.getElementById("counters-title");
    dom.countersGrid  = document.getElementById("counters-grid");
    dom.singleSubtitle = document.getElementById("single-subtitle");
    dom.dualSubtitle  = document.getElementById("dual-subtitle");
    dom.opponentName  = document.getElementById("opponent-name");
    dom.positionDesc  = document.getElementById("position-desc");
    dom.tierDesc      = document.getElementById("tier-desc");
    dom.runesSect     = document.getElementById("runes-section");
    dom.runesBody     = document.getElementById("runes-body");
    dom.runeChampImg  = document.getElementById("rune-champ-img");
    dom.runeChampName = document.getElementById("rune-champ-name");
    dom.runeOpgg      = document.getElementById("rune-opgg-link");
    dom.runePosDesc   = document.getElementById("rune-position-desc");
  }

  /* ── Utilities ─────────────────────────────────────────────────────── */

  /** HTML-escape user-derived strings before injecting via innerHTML.
   *  The original code interpolated champion names directly — fine while
   *  they come from Riot's CDN, but defense-in-depth costs nothing.
   */
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function formatNum(n) {
    if (!n) return "0";
    if (n >= 10000) return (n / 10000).toFixed(1) + " 万";
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /** Normalize a win rate to a percentage (handles legacy 0–1 sources). */
  function normWr(wr) {
    const n = wr ?? 50;
    return n <= 1 ? n * 100 : n;
  }

  /** Map an (opponent) win rate to a {cls, fill} colour pair. Shared by the
   *  single- and dual-counter cards so the thresholds stay in one place. */
  function wrColor(wrNum) {
    if (wrNum < WR_GOOD_BELOW) return { cls: "good", fill: "#2ecc71" };
    if (wrNum > WR_BAD_ABOVE)  return { cls: "bad",  fill: "#ff5252" };
    return { cls: "neutral", fill: "#f5c518" };
  }

  function loadingHtml() {
    return `<div class="loading"><div class="spinner" role="status" aria-label="加载中"></div>加载中...</div>`;
  }

  function errorHtml(message, opggUrl) {
    return `
      <div>
        <div class="error-msg">${escapeHtml(message)}</div>
        ${opggUrl ? `<a class="opgg-link" href="${opggUrl}" target="_blank" rel="noopener">前往 OP.GG 查看</a>` : ""}
      </div>`;
  }

  /** Cancel a previous fetch (if any) and return a new AbortController. */
  function rotateAbort(slot) {
    const prev = state.activeFetch[slot];
    if (prev) prev.abort();
    const ctrl = new AbortController();
    state.activeFetch[slot] = ctrl;
    return ctrl;
  }

  /* ── URL builders ──────────────────────────────────────────────────── */
  function champIconUrl(champ) {
    return `https://ddragon.leagueoflegends.com/cdn/${state.ddVersion}/img/champion/${champ.image}`;
  }
  function opggCounterUrl(champId, position = "") {
    const p = position ? `/${position}` : "";
    return `https://op.gg/lol/champions/${champId.toLowerCase()}/counters${p}`;
  }
  function opggRuneUrl(champId, position = "") {
    const p = position ? `/${position}` : "";
    return `https://op.gg/lol/champions/${champId.toLowerCase()}/runes${p}`;
  }

  function resolveCounterImg(c) {
    // Prefer OP.GG's CDN image (already absolute), fall back to Data Dragon
    // by looking up the local champion record. Avoids broken icons when
    // OP.GG returns a champ we haven't cached locally for some reason.
    if (c.image && c.image.startsWith("http")) return c.image;
    if (c.champId) {
      const local = state.champById[c.champId] || findChampByKey(c.champId);
      if (local) return champIconUrl(local);
      return `${OPGG_FALLBACK_IMG_BASE}${encodeURIComponent(c.champId)}.png`;
    }
    return "";
  }

  function findChampByKey(key) {
    const k = String(key).toLowerCase();
    return state.champions.find((c) => c.id.toLowerCase() === k) || null;
  }

  /* ── Boot ──────────────────────────────────────────────────────────── */
  async function init() {
    cacheDom();
    wireEvents();

    // Show the inline search spinner while we fetch the champion list +
    // build the pinyin index. The whole thing usually finishes in <500ms
    // (cached) — the spinner mostly matters on cold loads / slow networks.
    dom.searchWrapper.classList.add("is-loading");
    dom.searchInput.disabled = true;
    dom.searchInput.placeholder = "正在加载英雄列表…";

    try {
      const res = await fetch("/api/champions");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "加载英雄列表失败");

      state.champions = json.data;
      state.ddVersion = json.version;
      // Build the lookup map and the search index up front; both are O(N)
      // but only run once.
      for (const c of state.champions) state.champById[c.id] = c;
      state.searchIndex = (typeof PinyinSearch !== "undefined")
        ? PinyinSearch.buildIndex(state.champions)
        : null;

      dom.searchInput.disabled = false;
      dom.searchInput.placeholder = "搜索英雄名称（中文 / 英文 / 拼音皆可）...";
    } catch (e) {
      console.error("加载英雄列表失败:", e);
      dom.searchInput.placeholder = "英雄列表加载失败，请刷新重试";
      dom.searchInput.disabled = true;
    } finally {
      dom.searchWrapper.classList.remove("is-loading");
    }
  }

  /* ── Event wiring ──────────────────────────────────────────────────── */
  function wireEvents() {
    // Search input — debounced so a fast typist only triggers one render
    // per pause, not one per keystroke.
    dom.searchInput.addEventListener(
      "input",
      debounce(handleSearchInput, SEARCH_DEBOUNCE_MS)
    );
    dom.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") dom.dropdown.classList.add("hidden");
    });

    // Close dropdown when clicking outside the search wrapper.
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-wrapper")) dom.dropdown.classList.add("hidden");
    });

    // Dropdown clicks via event delegation — one listener, not N.
    dom.dropdown.addEventListener("click", (e) => {
      const item = e.target.closest(".dropdown-item");
      if (!item) return;
      const champ = state.champById[item.dataset.id];
      if (champ) selectOpponent(champ);
    });

    // Mode toggle (single vs. swing-lane dual).
    dom.modeBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".mode-btn");
      if (btn) setMode(btn.dataset.mode);
    });

    // Dual-banner slot removal (× buttons), delegated.
    dom.dualBanner.addEventListener("click", (e) => {
      const rm = e.target.closest(".dual-slot-remove");
      if (rm) clearDualSlot(rm.dataset.slot);
    });

    // Position & tier buttons — also delegated. The original code attached
    // one listener per button at boot, which was fine; delegation here is
    // a minor cleanup and lets us re-render the buttons safely later.
    document.querySelectorAll(".pos-btn").forEach((btn) => {
      btn.addEventListener("click", () => setPosition(btn.dataset.position));
    });
    document.querySelectorAll(".tier-btn").forEach((btn) => {
      btn.addEventListener("click", () => setTier(btn.dataset.tier));
    });

    // Counter card clicks — delegated so re-rendering the grid doesn't
    // re-bind every card. Also frees us from `onclick=` inline handlers.
    dom.countersGrid.addEventListener("click", (e) => {
      const card = e.target.closest(".counter-card");
      if (!card) return;
      const idx = parseInt(card.dataset.idx, 10);
      if (!Number.isNaN(idx)) selectCounter(idx);
    });

    // Cursor-tracking hover effect: set --mx / --my custom properties so
    // the CSS radial-gradient highlight follows the mouse. Delegated and
    // rAF-throttled to keep the cost negligible even on huge grids.
    let trackingRaf = 0;
    dom.countersGrid.addEventListener("pointermove", (e) => {
      const card = e.target.closest(".counter-card");
      if (!card) return;
      if (trackingRaf) return;
      trackingRaf = requestAnimationFrame(() => {
        const rect = card.getBoundingClientRect();
        const mx = ((e.clientX - rect.left) / rect.width) * 100;
        const my = ((e.clientY - rect.top) / rect.height) * 100;
        card.style.setProperty("--mx", mx + "%");
        card.style.setProperty("--my", my + "%");
        trackingRaf = 0;
      });
    });

    // Keyboard activation for counter cards (Enter / Space) since the
    // cards are role="button".
    dom.countersGrid.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest(".counter-card");
      if (!card) return;
      e.preventDefault();
      const idx = parseInt(card.dataset.idx, 10);
      if (!Number.isNaN(idx)) selectCounter(idx);
    });
  }

  /* ── Search handling ───────────────────────────────────────────────── */
  function handleSearchInput() {
    const q = dom.searchInput.value.trim();
    if (!q) {
      dom.dropdown.classList.add("hidden");
      return;
    }
    const matches = state.searchIndex
      ? PinyinSearch.search(q, state.searchIndex, SEARCH_LIMIT)
      : fallbackSearch(q);
    renderDropdown(matches);
  }

  /** Fallback used when pinyin.js failed to load. Same shape, simpler scoring. */
  function fallbackSearch(q) {
    const qLower = q.toLowerCase();
    return state.champions
      .filter((c) =>
        c.name.includes(q) ||
        c.id.toLowerCase().includes(qLower) ||
        (c.title || "").includes(q)
      )
      .slice(0, SEARCH_LIMIT);
  }

  function renderDropdown(champions) {
    if (!champions.length) {
      dom.dropdown.classList.add("hidden");
      return;
    }
    dom.dropdown.innerHTML = champions
      .map(
        (c) => `
        <div class="dropdown-item" data-id="${escapeHtml(c.id)}" role="option" tabindex="0">
          <img src="${escapeHtml(champIconUrl(c))}" alt="" loading="lazy" />
          <div>
            <div class="champ-name">${escapeHtml(c.name)}</div>
            <div class="champ-title">${escapeHtml(c.title || "")}</div>
          </div>
        </div>`
      )
      .join("");
    dom.dropdown.classList.remove("hidden");
  }

  /* ── Mode switching ────────────────────────────────────────────────── */
  function setMode(mode) {
    if ((mode !== "single" && mode !== "dual") || mode === state.mode) return;
    state.mode = mode;
    for (const btn of dom.modeBar.querySelectorAll(".mode-btn")) {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }

    dom.searchLabel.textContent =
      mode === "dual" ? "选择对方可能的两个英雄" : "选择对方英雄";
    dom.searchInput.value = "";
    dom.dropdown.classList.add("hidden");

    if (mode === "dual") {
      dom.banner.classList.remove("visible");
      dom.dualBanner.classList.remove("hidden");
      renderDualBanner();
    } else {
      dom.dualBanner.classList.add("hidden");
      if (state.opponent) {
        renderSingleBanner(state.opponent);
        dom.banner.classList.add("visible");
        dom.opponentName.textContent = state.opponent.name;
      }
    }

    refreshFiltersVisibility();
    reloadCounters();
  }

  /* ── Opponent selection ────────────────────────────────────────────── */
  function selectOpponent(champ) {
    dom.dropdown.classList.add("hidden");

    if (state.mode === "dual") {
      const wasEmpty = !state.opponent && !state.opponentB;
      assignDualSlot(champ);
      dom.searchInput.value = "";  // clear so the next pick is easy to search
      renderDualBanner();
      if (wasEmpty) resetFilters();
    } else {
      state.opponent = champ;
      dom.searchInput.value = champ.name;
      renderSingleBanner(champ);
      dom.banner.classList.add("visible");
      dom.opponentName.textContent = champ.name;
      resetFilters();
    }

    refreshFiltersVisibility();
    reloadCounters();
  }

  function renderSingleBanner(champ) {
    const img = dom.banner.querySelector("img");
    img.src = champIconUrl(champ);
    img.alt = champ.name;
    dom.banner.querySelector(".info h3").textContent = champ.name;
    dom.banner.querySelector(".info p").textContent = champ.title || "";
  }

  /* ── Dual-opponent slots ───────────────────────────────────────────── */
  function assignDualSlot(champ) {
    if (!state.opponent) state.opponent = champ;
    else if (!state.opponentB) state.opponentB = champ;
    else state.opponentB = champ;  // both full → replace the second pick
  }

  function clearDualSlot(slot) {
    if (slot === "a") {
      // Promote B into A so slot A stays the "first" pick.
      state.opponent = state.opponentB;
      state.opponentB = null;
    } else {
      state.opponentB = null;
    }
    renderDualBanner();
    refreshFiltersVisibility();
    reloadCounters();
  }

  function renderDualBanner() {
    renderDualSlot("a", state.opponent);
    renderDualSlot("b", state.opponentB);
  }

  function renderDualSlot(slot, champ) {
    const el = dom.dualBanner.querySelector(`.dual-slot[data-slot="${slot}"]`);
    if (!el) return;
    if (!champ) {
      el.classList.remove("filled");
      const hint = slot === "a"
        ? "点击上方搜索，添加可能的英雄 ①"
        : "再添加可能的英雄 ②";
      el.innerHTML = `<div class="dual-slot-empty">${hint}</div>`;
      return;
    }
    el.classList.add("filled");
    el.innerHTML = `
      <img src="${escapeHtml(champIconUrl(champ))}" alt="${escapeHtml(champ.name)}" />
      <div class="dual-slot-info">
        <div class="dual-slot-name">${escapeHtml(champ.name)}</div>
        <div class="dual-slot-title">${escapeHtml(champ.title || "")}</div>
      </div>
      <button type="button" class="dual-slot-remove" data-slot="${slot}"
              aria-label="移除 ${escapeHtml(champ.name)}">×</button>`;
  }

  /* ── Filter selection ──────────────────────────────────────────────── */
  function resetFilters() {
    setPosition("", /* reload */ false);
    setTier("", /* reload */ false);
  }

  function refreshFiltersVisibility() {
    const ready = state.mode === "dual"
      ? !!(state.opponent || state.opponentB)
      : !!state.opponent;
    dom.positionBar.classList.toggle("hidden", !ready);
    dom.tierBar.classList.toggle("hidden", !ready);
  }

  /** Fetch whatever the current mode + selection supports, or hide results
   *  if the selection is incomplete (e.g. dual mode with only one pick). */
  function reloadCounters() {
    state.selectedCounterIdx = null;
    dom.runesSect.classList.remove("visible");

    if (state.mode === "dual") {
      if (state.opponent && state.opponentB) {
        loadDualCounters(state.opponent, state.opponentB, state.position, state.tier);
      } else {
        dom.countersSect.classList.remove("visible");
      }
    } else if (state.opponent) {
      loadCounters(state.opponent, state.position, state.tier);
    } else {
      dom.countersSect.classList.remove("visible");
    }
  }

  function setPosition(position, reload = true) {
    state.position = position;
    for (const btn of document.querySelectorAll(".pos-btn")) {
      btn.classList.toggle("active", btn.dataset.position === position);
      btn.setAttribute("aria-pressed", btn.dataset.position === position ? "true" : "false");
    }
    dom.positionDesc.textContent = position ? `（${POSITION_LABELS[position]}）` : "";
    if (reload) reloadCounters();
  }

  function setTier(tier, reload = true) {
    state.tier = tier;
    for (const btn of document.querySelectorAll(".tier-btn")) {
      btn.classList.toggle("active", btn.dataset.tier === tier);
      btn.setAttribute("aria-pressed", btn.dataset.tier === tier ? "true" : "false");
    }
    dom.tierDesc.textContent = TIER_LABELS[tier] ? `（${TIER_LABELS[tier]}）` : "";
    if (reload) reloadCounters();
  }

  /* ── Counter loading ───────────────────────────────────────────────── */
  async function loadCounters(champ, position = "", tier = "") {
    const posLabel = POSITION_LABELS[position] || "全部路线";
    dom.countersSect.classList.add("visible");
    dom.singleSubtitle.classList.remove("hidden");
    dom.dualSubtitle.classList.add("hidden");
    dom.countersTitle.textContent = `克制 ${champ.name}（${posLabel}）的英雄推荐`;
    dom.countersGrid.innerHTML = loadingHtml();

    // Hide runes — previous selection is no longer relevant.
    dom.runesSect.classList.remove("visible");
    state.selectedCounterIdx = null;

    // Build query string only with non-empty params (cleaner cache keys).
    const params = new URLSearchParams();
    if (position) params.set("position", position);
    if (tier) params.set("tier", tier);
    const qs = params.toString() ? `?${params}` : "";

    const ctrl = rotateAbort("counters");
    try {
      const res = await fetch(`/api/counters/${encodeURIComponent(champ.id)}${qs}`, {
        signal: ctrl.signal,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "加载失败");

      state.countersRaw = json.data;
      const counters = parseCounters(json.data);

      if (!counters.length) {
        dom.countersGrid.innerHTML = `<div class="error-msg">暂无该路线克制数据，请查看 <a class="opgg-link" href="${opggCounterUrl(champ.id, position)}" target="_blank" rel="noopener">OP.GG</a></div>`;
        return;
      }
      renderCounters(counters, champ);
    } catch (e) {
      if (e.name === "AbortError") return;  // user moved on; silently drop
      dom.countersGrid.innerHTML = errorHtml(e.message, opggCounterUrl(champ.id, position));
    }
  }

  /** Backend returns list pre-sorted by confidence_score ascending. */
  function parseCounters(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
    return list
      .filter((item) => item && item.champion)
      .map((item) => ({
        champId: item.champion.key || "",
        name: item.champion.name || "",
        image: item.champion.image_url || "",
        winRate: item.win_rate ?? 50,
        confidenceScore: item.confidence_score ?? item.win_rate ?? 50,
        gameCount: item.play ?? null,
      }));
  }

  function renderCounters(counters, opponent) {
    // Build the entire grid HTML in one pass then assign — single reflow
    // instead of N appends.
    state.countersParsed = counters;
    const html = counters.map((c, i) => renderCounterCard(c, i, opponent)).join("");
    dom.countersGrid.innerHTML = html;
  }

  function renderCounterCard(c, i, opponent) {
    // OP.GG returns WR as a percentage (e.g. 47.3); some legacy data
    // sources used 0–1. normWr handles both.
    const wrNum = normWr(c.winRate);
    const wrPct = wrNum.toFixed(1);
    // Class + colour for both the value text and the bar fill. The bar fill
    // uses an inline style attribute for the dynamic width, so we need the
    // hex too (not just the CSS class).
    const { cls: wrClass, fill: fillColor } = wrColor(wrNum);
    const fillPct = Math.min(100, Math.max(0, wrNum));

    const gameCount = c.gameCount ?? 0;
    const lowSample = gameCount > 0 && gameCount < LOW_SAMPLE_THRESHOLD;
    const games = gameCount > 0
      ? `${formatNum(gameCount)} 场对局${lowSample ? " ⚠" : ""}`
      : "";

    const imgSrc = resolveCounterImg(c);
    const safeName = escapeHtml(c.name);

    return `
      <div class="counter-card" data-idx="${i}" role="button" tabindex="0"
           aria-label="选择 ${safeName} 作为反制英雄">
        <div class="counter-card-inner">
          <div class="rank-badge">${i + 1}</div>
          <img src="${escapeHtml(imgSrc)}" alt="${safeName}"
               onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'" loading="lazy" />
          <div class="champ-name">${safeName}</div>
          <div class="wr-label">${escapeHtml(opponent.name)} 对位胜率</div>
          <div class="wr-value ${wrClass}">${wrPct}%</div>
          <div class="wr-bar-bg" role="progressbar" aria-valuenow="${wrNum.toFixed(1)}" aria-valuemin="0" aria-valuemax="100">
            <div class="wr-bar-fill" style="width:${fillPct}%;background:${fillColor}"></div>
          </div>
          ${games ? `<div class="games-count">${escapeHtml(games)}</div>` : ""}
        </div>
      </div>`;
  }

  /* ── Dual counters (swing lane) ────────────────────────────────────── */
  async function loadDualCounters(a, b, position = "", tier = "") {
    const posLabel = POSITION_LABELS[position] || "全部路线";
    dom.countersSect.classList.add("visible");
    dom.singleSubtitle.classList.add("hidden");
    dom.dualSubtitle.classList.remove("hidden");
    dom.countersTitle.textContent =
      `同时克制 ${a.name} 与 ${b.name}（${posLabel}）的英雄推荐`;
    dom.dualSubtitle.innerHTML =
      `以下英雄对 <strong>${escapeHtml(a.name)}</strong> 和 ` +
      `<strong>${escapeHtml(b.name)}</strong> 的对位胜率都较低，` +
      `按两个对位中“较弱的一方”加权排序——越靠前，无论对方最终锁定谁都越稳。` +
      `点击英雄卡片查看符文推荐。`;
    dom.countersGrid.innerHTML = loadingHtml();

    dom.runesSect.classList.remove("visible");
    state.selectedCounterIdx = null;

    const params = new URLSearchParams();
    if (position) params.set("position", position);
    if (tier) params.set("tier", tier);
    const qs = params.toString() ? `?${params}` : "";

    const ctrl = rotateAbort("counters");
    try {
      const url =
        `/api/dual-counters/${encodeURIComponent(a.id)}/${encodeURIComponent(b.id)}${qs}`;
      const res = await fetch(url, { signal: ctrl.signal });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "加载失败");

      state.countersRaw = json.data;
      const counters = parseDualCounters(json.data);
      if (!counters.length) {
        dom.countersGrid.innerHTML =
          `<div class="error-msg">这两个英雄没有公共的高胜率克制英雄。试试分别单独查询，或更换路线 / 段位。</div>`;
        return;
      }
      renderDualCounters(counters, a, b);
    } catch (e) {
      if (e.name === "AbortError") return;  // user moved on; silently drop
      dom.countersGrid.innerHTML = errorHtml(e.message, opggCounterUrl(a.id, position));
    }
  }

  /** Backend returns list pre-sorted by combined_score ascending. */
  function parseDualCounters(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list
      .filter((item) => item && item.champion)
      .map((item) => ({
        champId: item.champion.key || "",
        name: item.champion.name || "",
        image: item.champion.image_url || "",
        combined: item.combined_score ?? 50,
        wrA: item.vs_a ? (item.vs_a.win_rate ?? 50) : 50,
        playA: item.vs_a ? (item.vs_a.play ?? null) : null,
        wrB: item.vs_b ? (item.vs_b.win_rate ?? 50) : 50,
        playB: item.vs_b ? (item.vs_b.play ?? null) : null,
      }));
  }

  function renderDualCounters(counters, a, b) {
    state.countersParsed = counters;
    const html = counters.map((c, i) => renderDualCounterCard(c, i, a, b)).join("");
    dom.countersGrid.innerHTML = html;
  }

  function renderDualCounterCard(c, i, a, b) {
    const imgSrc = resolveCounterImg(c);
    const safeName = escapeHtml(c.name);
    return `
      <div class="counter-card dual" data-idx="${i}" role="button" tabindex="0"
           aria-label="选择 ${safeName} 作为反制英雄">
        <div class="counter-card-inner">
          <div class="rank-badge">${i + 1}</div>
          <img src="${escapeHtml(imgSrc)}" alt="${safeName}"
               onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'" loading="lazy" />
          <div class="champ-name">${safeName}</div>
          <div class="dual-wr-rows">
            ${dualWrRow(a.name, c.wrA, c.playA)}
            ${dualWrRow(b.name, c.wrB, c.playB)}
          </div>
        </div>
      </div>`;
  }

  /** One opponent's WR row inside a dual card: name + value + mini bar. */
  function dualWrRow(opponentName, wr, play) {
    const wrNum = normWr(wr);
    const { cls, fill } = wrColor(wrNum);
    const fillPct = Math.min(100, Math.max(0, wrNum));
    const lowSample = play != null && play > 0 && play < LOW_SAMPLE_THRESHOLD;
    return `
      <div class="dual-wr-row">
        <div class="dual-wr-head">
          <span class="dual-wr-name">vs ${escapeHtml(opponentName)}${lowSample ? " ⚠" : ""}</span>
          <span class="dual-wr-val ${cls}">${wrNum.toFixed(1)}%</span>
        </div>
        <div class="wr-bar-bg" role="progressbar" aria-valuenow="${wrNum.toFixed(1)}"
             aria-valuemin="0" aria-valuemax="100">
          <div class="wr-bar-fill" style="width:${fillPct}%;background:${fill}"></div>
        </div>
      </div>`;
  }

  /* ── Counter selection → runes ─────────────────────────────────────── */
  function selectCounter(idx) {
    for (const el of dom.countersGrid.querySelectorAll(".counter-card")) {
      el.classList.toggle("selected", parseInt(el.dataset.idx, 10) === idx);
    }
    const c = state.countersParsed[idx];
    if (!c) return;
    state.selectedCounterIdx = idx;
    loadRunes(c, state.position);
  }

  async function loadRunes(c, position = "") {
    dom.runesSect.classList.add("visible");

    const local = c.champId ? (state.champById[c.champId] || findChampByKey(c.champId)) : null;
    const name = local ? local.name : c.name;
    const imgSrc = local ? champIconUrl(local) : (c.image || "");
    const champId = c.champId || (local && local.id) || "";

    dom.runeChampImg.src = imgSrc;
    dom.runeChampImg.alt = name;
    dom.runeChampName.textContent = name;
    dom.runeOpgg.href = opggRuneUrl(champId, position);
    dom.runePosDesc.textContent =
      `来源：OP.GG 高胜率符文页（${POSITION_LABELS[position] || "全部路线"}）`;

    dom.runesBody.innerHTML = loadingHtml();

    const params = new URLSearchParams();
    if (position) params.set("position", position);
    const qs = params.toString() ? `?${params}` : "";

    const ctrl = rotateAbort("runes");
    try {
      const res = await fetch(`/api/runes/${encodeURIComponent(champId)}${qs}`, {
        signal: ctrl.signal,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "加载失败");
      renderRunes(json.data, champId);
    } catch (e) {
      if (e.name === "AbortError") return;
      dom.runesBody.innerHTML = errorHtml(e.message, opggRuneUrl(champId, position));
    }
  }

  /* ── Rune rendering ────────────────────────────────────────────────── */
  // OP.GG rune data shape:
  //   rune_pages: [{ id, play, pick_rate, builds: [{
  //     primary_perk_style, perk_sub_style,
  //     main_runes:  [[{id,name,image_url,isActive},…], …],
  //     sub_runes:   [[…], …],
  //     stat_perks:  [[…], …],
  //     win, play, pick_rate
  //   }]}]
  function renderRunes(raw, champId) {
    const pages = Array.isArray(raw) ? raw : [];
    if (!pages.length) {
      dom.runesBody.innerHTML = `<div class="error-msg">暂无符文数据</div>
        <a class="opgg-link" href="${opggRuneUrl(champId)}" target="_blank" rel="noopener">前往 OP.GG 查看符文</a>`;
      return;
    }

    // Highest pick_rate page → first build is the canonical recommendation.
    const build = (pages[0].builds || [])[0];
    if (!build) {
      dom.runesBody.innerHTML = `<div class="error-msg">暂无构建数据</div>`;
      return;
    }

    const primaryStyle = build.primary_perk_style || {};
    const secondaryStyle = build.perk_sub_style || {};
    const mainRunes = build.main_runes || [];
    const subRunes = build.sub_runes || [];
    const statPerks = build.stat_perks || [];

    const wr = build.win != null && build.play ? (build.win / build.play * 100) : null;
    const plays = build.play ?? null;

    const primaryHtml = mainRunes.map((row, i) => renderRuneRow(row, i === 0)).join("");
    const secondaryHtml = subRunes.map((row) => renderRuneRow(row, false)).join("");
    const statHtml = statPerks.map(renderStatShard).join("");

    const statsLineHtml = (wr != null || plays != null) ? `
      <div class="rune-stats">
        ${wr != null ? `<span>胜率 <span class="rune-stat-val">${wr.toFixed(1)}%</span></span>` : ""}
        ${plays != null ? `<span>场次 <span class="rune-stat-val">${escapeHtml(formatNum(plays))}</span></span>` : ""}
      </div>` : "";

    dom.runesBody.innerHTML = `
      ${statsLineHtml}
      <div class="rune-page">
        <div class="rune-path-block">
          <div class="rune-path-name">
            ${primaryStyle.image_url ? `<img src="${escapeHtml(primaryStyle.image_url)}" alt="" class="rune-path-icon">` : ""}
            ${escapeHtml(primaryStyle.name || "主系")}
          </div>
          ${primaryHtml}
        </div>
        <div class="rune-path-block">
          <div class="rune-path-name">
            ${secondaryStyle.image_url ? `<img src="${escapeHtml(secondaryStyle.image_url)}" alt="" class="rune-path-icon">` : ""}
            ${escapeHtml(secondaryStyle.name || "副系")}
          </div>
          ${secondaryHtml}
        </div>
      </div>
      ${statHtml ? `<div class="stat-shards">${statHtml}</div>` : ""}`;
  }

  function renderRuneRow(row, isKeystone) {
    if (!row || !row.length) return "";
    // Each row is a slot with multiple choices; `isActive=true` marks the
    // recommended pick. Fall back to row[0] if no active flag (defensive).
    const active = row.find((r) => r.isActive) || row[0];
    if (!active) return "";
    const cls = isKeystone ? "rune-icon keystone" : "rune-icon";
    const name = active.name || "";
    // `data-tooltip` on the wrapping span lets the CSS show a hover bubble
    // with the full rune name — useful when the name truncates on mobile
    // or the user just wants confirmation of which rune the icon is.
    return `
      <div class="rune-slot">
        <span data-tooltip="${escapeHtml(name)}" tabindex="0">
          <img class="${cls}" src="${escapeHtml(active.image_url || "")}"
               alt="${escapeHtml(name)}"
               onerror="this.style.display='none'" loading="lazy"/>
        </span>
        <div class="rune-name">${escapeHtml(name)}</div>
      </div>`;
  }

  function renderStatShard(row) {
    const active = (row || []).find((r) => r.isActive) || (row || [])[0];
    if (!active) return "";
    const name = active.name || "";
    return `<div class="stat-shard" data-tooltip="${escapeHtml(name)}" tabindex="0">${escapeHtml(name)}</div>`;
  }

  /* ── Boot ──────────────────────────────────────────────────────────── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
