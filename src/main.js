const { invoke } = window.__TAURI__.core;

const QUEUES = {
  420: "Ranked Solo/Duo",
  440: "Ranked Flex",
  400: "Normal Draft",
  430: "Normal Blind",
  490: "Quickplay",
  450: "ARAM",
  1700: "Arena",
  1900: "URF",
  900: "ARURF",
  0: "Custom",
};
// Match-history filter chips, like leagueofgraphs.
const QUEUE_FILTERS = [
  { key: "all", label: "All" },
  { key: "solo", label: "Solo/Duo", ids: [420] },
  { key: "flex", label: "Flex", ids: [440] },
  { key: "normal", label: "Normal", ids: [400, 430, 490] },
  { key: "aram", label: "ARAM", ids: [450] },
  { key: "other", label: "Other" },
];
const KNOWN_QUEUES = QUEUE_FILTERS.flatMap((f) => f.ids ?? []);
const RANK_QUEUES = { RANKED_SOLO_5x5: "Solo / Duo", RANKED_FLEX_SR: "Flex" };
const ROLES = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", UTILITY: "Support" };
const APEX = ["MASTER", "GRANDMASTER", "CHALLENGER"];
const MULTI = ["", "", "Double kill", "Triple kill", "Quadra kill", "Penta kill"];
// Match data and Data Dragon disagree on a few champion ids.
const CHAMP_ID_FIX = { FiddleSticks: "Fiddlesticks" };

const view = document.querySelector("#view");
const form = document.querySelector("#search");
const idInput = document.querySelector("#riot-id");
const regionSelect = document.querySelector("#region");
const searchMenu = document.querySelector("#search-menu");
const clientChip = document.querySelector("#client-chip");
const settingsDialog = document.querySelector("#settings");
const tip = document.querySelector("#tip");

// App state for the current profile.
let S = null; // static data: version, champions, spells, runes, items
let P = null; // profile
let platform = "euw1";
let matches = [];
let nextStart = 0;
let hasMore = false;
let tab = "overview";
let queueFilter = "all";
let selectedChamp = null;
const expanded = new Set();
let liveRanks = null;
let client = null; // League client status
// Background loading of older games up to the "Games to load" setting.
let loadToken = 0;
let filling = false;
let fillStatus = null;
let fillTarget = 0; // load older games until nextStart reaches this
// Match rows drawn in the history; grows as you scroll (all loaded games still count in stats).
const ROW_STEP = 20;
let shownRows = ROW_STEP;

/* ---------- storage ---------- */
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`riftlens.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`riftlens.${key}`, JSON.stringify(value));
    } catch {}
  },
};

const settings = {
  region: "euw1",
  size: "1280x720",
  motion: true,
  autoProfile: true,
  autoLive: true,
  autoUpdate: true,
  gamesToLoad: 0, // 0 = all available (default, so champion stats cover the whole history)
  ...store.get("settings", {}),
};
const saveSettings = () => store.set("settings", settings);

/* ---------- helpers ---------- */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const title = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : "");
const pct = (w, n) => (n ? Math.round((100 * w) / n) : 0);
const ratio = (k, d, a) => (d ? ((k + a) / d).toFixed(2) : "Perfect");
const ratioNum = (p) => (p.kills + p.assists) / Math.max(p.deaths, 1);
const avg = (n, d) => (d ? (n / d).toFixed(1) : "0.0");
const thousands = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sameId = (a, b) => a.toLowerCase().replace(/\s/g, "") === b.toLowerCase().replace(/\s/g, "");
const regionLabel = (p) => regionSelect.querySelector(`option[value="${p}"]`)?.text ?? p;

function timeAgo(ms) {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const mins = Math.round((ms - Date.now()) / 60000);
  if (Math.abs(mins) < 60) return rtf.format(mins, "minute");
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  return rtf.format(Math.round(hours / 24), "day");
}

const DD = "https://ddragon.leagueoflegends.com/cdn";
const CD = "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images";
const champKey = (name) => CHAMP_ID_FIX[name] ?? name;
const champSrc = (name) => `${DD}/${S.version}/img/champion/${champKey(name)}.png`;
const champById = (id) => S.champions[id] ?? { id: "", name: "Unknown" };
const champName = (apiName) => Object.values(S.champions).find((c) => c.id === champKey(apiName))?.name ?? apiName;
const itemSrc = (id) => `${DD}/${S.version}/img/item/${id}.png`;
const iconSrc = (id) => `${DD}/${S.version}/img/profileicon/${id}.png`;
const emblemSrc = (tier) => `${CD}/ranked-emblem/emblem-${tier.toLowerCase()}.png`;
const crestSrc = (tier) => `${CD}/ranked-mini-crests/${tier.toLowerCase()}.svg`;

const hide = `onerror="this.style.visibility='hidden'"`;
const champImg = (name, cls = "champ") =>
  `<img class="${cls}" src="${champSrc(name)}" alt="${esc(champName(name))}" title="${esc(champName(name))}" loading="lazy" ${hide} />`;
function spellImg(id) {
  const s = S.spells[id];
  return s
    ? `<img class="mini" src="${DD}/${S.version}/img/spell/${s.id}.png" alt="${esc(s.name)}" data-tip="spell:${id}" loading="lazy" />`
    : `<span class="mini mini--empty"></span>`;
}
function runeImg(id, cls = "mini mini--rune") {
  const r = S.runes[id];
  return r
    ? `<img class="${cls}" src="${DD}/img/${r.icon}" alt="${esc(r.name)}" data-tip="rune:${id}" loading="lazy" />`
    : `<span class="mini mini--empty"></span>`;
}
const loadout = (spells, keystone, subStyle) =>
  `<div class="loadout">${spellImg(spells[0])}${runeImg(keystone, "mini mini--keystone")}${spellImg(spells[1])}${runeImg(subStyle)}</div>`;
const itemImg = (id, cls = "item") => `<img class="${cls}" src="${itemSrc(id)}" alt="" data-tip="item:${id}" loading="lazy" ${hide} />`;
function itemsRow(items) {
  return `<div class="items">${items
    .map((id, i) => {
      const trinket = i === 6 ? " item--trinket" : "";
      return id ? itemImg(id, `item${trinket}`) : `<span class="item item--empty${trinket}"></span>`;
    })
    .join("")}</div>`;
}
const nameLink = (riotId, cls = "player-link") =>
  riotId && riotId !== "#"
    ? `<button type="button" class="${cls}" data-action="search" data-riot-id="${esc(riotId)}" title="Open ${esc(riotId)}">${esc(riotId.split("#")[0])}</button>`
    : `<span class="${cls}">Hidden</span>`;

const me = (m) => m.players.find((p) => p.puuid === P.puuid);
const teamOf = (m, teamId) => m.teams.find((t) => t.id === teamId) ?? { kills: 0 };

function inFilter(m, key = queueFilter) {
  const f = QUEUE_FILTERS.find((x) => x.key === key);
  if (!f || f.key === "all") return true;
  if (f.key === "other") return !KNOWN_QUEUES.includes(m.queueId);
  return f.ids.includes(m.queueId);
}
const visibleMatches = () => matches.filter((m) => me(m) && inFilter(m));
const playedMatches = () => visibleMatches().filter((m) => !m.remake);

/* ---------- toasts ---------- */
function toast(message, action) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button" class="btn btn--small" data-action="${action.action}">${esc(action.label)}</button>` : ""}`;
  document.body.append(el);
  if (!action) setTimeout(() => el.remove(), 5000);
}

/* ---------- tooltips ---------- */
const plainText = (html) =>
  String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(li|p)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function tipContent(spec) {
  const [kind, id] = spec.split(":");
  if (kind === "item") {
    const it = S.items[id];
    if (!it) return null;
    return `<p class="tip__title">${esc(it.name)}</p>${it.gold ? `<p class="tip__meta num">${it.gold} gold</p>` : ""}<p class="tip__body">${esc(plainText(it.desc))}</p>`;
  }
  if (kind === "spell") {
    const s = S.spells[id];
    return s && `<p class="tip__title">${esc(s.name)}</p><p class="tip__body">${esc(plainText(s.desc))}</p>`;
  }
  if (kind === "rune") {
    const r = S.runes[id];
    return r && `<p class="tip__title">${esc(r.name)}</p>${r.desc ? `<p class="tip__body">${esc(plainText(r.desc))}</p>` : ""}`;
  }
  return null;
}

document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (!el || !S) return;
  const html = tipContent(el.dataset.tip);
  if (!html) return;
  tip.innerHTML = html;
  tip.hidden = false;
  // Positions are in the 1280x720 design frame; the whole app is zoomed to the window.
  const scale = window.innerWidth / BASE_WIDTH;
  const r = el.getBoundingClientRect();
  const box = { left: r.left / scale, right: r.right / scale, top: r.top / scale, bottom: r.bottom / scale };
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = Math.min(Math.max(8, box.left + (box.right - box.left) / 2 - w / 2), BASE_WIDTH - w - 8);
  let top = box.top - h - 8;
  if (top < 8) top = box.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest("[data-tip]")) tip.hidden = true;
});

/* ---------- recent searches and favourites ---------- */
const recents = () => store.get("recents", []);
const favourites = () => store.get("favourites", []);
const isFav = (riotId, plat) => favourites().some((f) => sameId(f.riotId, riotId) && f.platform === plat);

function addRecent(riotId, plat) {
  const list = recents().filter((r) => !(sameId(r.riotId, riotId) && r.platform === plat));
  store.set("recents", [{ riotId, platform: plat }, ...list].slice(0, 8));
}

function toggleFav(riotId, plat) {
  const list = favourites();
  const next = isFav(riotId, plat)
    ? list.filter((f) => !(sameId(f.riotId, riotId) && f.platform === plat))
    : [...list, { riotId, platform: plat }];
  store.set("favourites", next);
}

function renderSearchMenu() {
  const favs = favourites();
  const recent = recents().filter((r) => !isFav(r.riotId, r.platform));
  const row = (r, fav) => `
    <li class="menu-row">
      <button type="button" class="menu-row__main" data-action="search" data-riot-id="${esc(r.riotId)}" data-platform="${esc(r.platform)}">
        <span>${esc(r.riotId)}</span><span class="tiny">${esc(regionLabel(r.platform))}</span>
      </button>
      <button type="button" class="star${fav ? " is-on" : ""}" data-action="fav" data-riot-id="${esc(r.riotId)}" data-platform="${esc(r.platform)}"
        aria-label="${fav ? "Remove from" : "Add to"} favourites" title="${fav ? "Remove from" : "Add to"} favourites">${starSvg}</button>
    </li>`;
  if (!favs.length && !recent.length) {
    searchMenu.hidden = true;
    return;
  }
  searchMenu.innerHTML = `
    ${favs.length ? `<p class="micro menu-label">Favourites</p><ul>${favs.map((r) => row(r, true)).join("")}</ul>` : ""}
    ${recent.length ? `<p class="micro menu-label">Recent</p><ul>${recent.map((r) => row(r, false)).join("")}</ul>` : ""}`;
  searchMenu.hidden = false;
}

const starSvg = `<svg class="icon icon--star" viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>`;

idInput.addEventListener("focus", renderSearchMenu);
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".search__field")) searchMenu.hidden = true;
});
idInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") searchMenu.hidden = true;
});

/* ---------- simple states ---------- */
function chapter(label, head, accent, lede, extra = "") {
  return `
    <section class="chapter">
      <p class="micro chapter-label"><span class="signal"></span>${label}</p>
      <h1 class="display">${head} <em>${accent}</em></h1>
      ${lede ? `<p class="lede">${lede}</p>` : ""}
      ${extra}
    </section>`;
}

async function renderEmpty() {
  let info = null;
  try {
    info = await invoke("app_info");
  } catch {}
  view.innerHTML = info && !info.keySource
    ? chapter(
        "01 / Setup",
        "Add your key.",
        "Then search anyone.",
        "RiftLens reads League data with your own Riot API key. Get a development key at developer.riotgames.com and paste it in Settings.",
        `<div><button type="button" class="btn" data-action="open-settings">Open settings<span class="btn__glyph" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span></button></div>`
      )
    : chapter(
        "01 / Search",
        "Find a player.",
        "Read their games.",
        "Enter a Riot ID like <strong>Name#TAG</strong>, pick the region they play on, and RiftLens pulls their rank, mastery, live game and match history."
      );
}

const renderLoading = (what) =>
  (view.innerHTML = `
    <div class="status glass">
      <span class="signal signal--pulse"></span>
      <p>${what}</p>
    </div>`);

const renderError = (message) =>
  (view.innerHTML = `
    <div class="status glass status--error" role="alert">
      <p class="micro">Search failed</p>
      <p>${esc(message)}</p>
      ${/API key|Settings/.test(message) ? `<button type="button" class="btn btn--small" data-action="open-settings">Open settings</button>` : ""}
    </div>`);

/* ---------- sidebar ---------- */
function rankCard(queueKey) {
  const r = P.ranks.find((x) => x.queue === queueKey);
  const label = RANK_QUEUES[queueKey];
  if (!r) {
    return `
      <div class="rank">
        <div class="rank__emblem rank__emblem--none"></div>
        <div><p class="micro">${label}</p><p class="rank__tier rank__tier--none">Unranked</p></div>
      </div>`;
  }
  const games = r.wins + r.losses;
  return `
    <div class="rank">
      <img class="rank__emblem" src="${emblemSrc(r.tier)}" alt="" ${hide} />
      <div class="rank__body">
        <p class="micro">${label}</p>
        <p class="rank__tier">${title(r.tier)}${APEX.includes(r.tier) ? "" : ` ${r.division}`} <span class="rank__lp num">${r.lp} LP</span></p>
        <p class="tiny">${r.wins}W ${r.losses}L · <span class="num">${pct(r.wins, games)}%</span></p>
        <div class="bar"><span style="width:${pct(r.wins, games)}%"></span></div>
      </div>
    </div>`;
}

const sideCard = (label, body) =>
  `<section class="card"><p class="micro chapter-label"><span class="signal"></span>${label}</p>${body}</section>`;

function recentCard(played) {
  const mine = played.map(me);
  const n = played.length;
  const wins = mine.filter((p) => p.win).length;
  const k = mine.reduce((s, p) => s + p.kills, 0);
  const d = mine.reduce((s, p) => s + p.deaths, 0);
  const a = mine.reduce((s, p) => s + p.assists, 0);
  const kp = played.reduce((s, m, i) => s + pct(mine[i].kills + mine[i].assists, teamOf(m, mine[i].teamId).kills), 0);
  const csm = played.reduce((s, m, i) => s + mine[i].cs / Math.max(m.duration / 60, 1), 0);
  return sideCard(
    `Last ${plural(n, "game")}`,
    n
      ? `<div class="summary">
          <div class="summary__wr">
            <span class="big num">${pct(wins, n)}%</span>
            <span class="tiny">${wins}W ${n - wins}L</span>
          </div>
          <dl class="stats">
            <div><dt>KDA</dt><dd class="num">${avg(k, n)} / ${avg(d, n)} / ${avg(a, n)}</dd></div>
            <div><dt>Ratio</dt><dd class="num">${ratio(k, d, a)}</dd></div>
            <div><dt>Kill part.</dt><dd class="num">${Math.round(kp / n)}%</dd></div>
            <div><dt>CS / min</dt><dd class="num">${(csm / n).toFixed(1)}</dd></div>
          </dl>
        </div>`
      : `<p class="tiny">No games in this filter.</p>`
  );
}

function rolesCard(played) {
  const by = {};
  for (const m of played) {
    const p = me(m);
    if (!ROLES[p.position]) continue;
    by[p.position] ??= { games: 0, wins: 0 };
    by[p.position].games++;
    by[p.position].wins += p.win ? 1 : 0;
  }
  const rows = Object.entries(by).sort((a, b) => b[1].games - a[1].games);
  const max = Math.max(1, ...rows.map(([, r]) => r.games));
  return sideCard(
    "Roles",
    rows.length
      ? `<ul class="list">${rows
          .map(
            ([role, r]) => `
          <li class="role-row">
            <span class="role-row__name">${ROLES[role]}</span>
            <div class="bar bar--muted"><span style="width:${(100 * r.games) / max}%"></span></div>
            <span class="tiny num">${r.games} · ${pct(r.wins, r.games)}%</span>
          </li>`
          )
          .join("")}</ul>`
      : `<p class="tiny">No ranked or normal games here.</p>`
  );
}

/** Per-champion totals over a set of games. */
function championStats(played) {
  const by = new Map();
  for (const m of played) {
    const p = me(m);
    const c = by.get(p.champion) ?? { name: p.champion, games: 0, wins: 0, k: 0, d: 0, a: 0, cs: 0, dmg: 0, mins: 0 };
    c.games++;
    c.wins += p.win ? 1 : 0;
    c.k += p.kills;
    c.d += p.deaths;
    c.a += p.assists;
    c.cs += p.cs;
    c.dmg += p.damage;
    c.mins += m.duration / 60;
    by.set(p.champion, c);
  }
  return [...by.values()].sort((a, b) => b.games - a.games || b.wins - a.wins);
}

function championsCard(played) {
  const top = championStats(played).slice(0, 6);
  return sideCard(
    "Champions",
    top.length
      ? `<ul class="list">${top
          .map(
            (c) => `
          <li>
            <button type="button" class="champ-row champ-row--button" data-action="champ" data-champ="${esc(champKey(c.name))}" title="Open ${esc(champName(c.name))}">
              ${champImg(c.name, "champ champ--sm")}
              <div><p class="champ-row__name">${esc(champName(c.name))}</p><p class="tiny num">${(c.cs / Math.max(c.mins, 1)).toFixed(1)} CS/m</p></div>
              <div class="champ-row__right"><p class="num">${ratio(c.k, c.d, c.a)}</p><p class="tiny num">${plural(c.games, "game")} · ${pct(c.wins, c.games)}%</p></div>
            </button>
          </li>`
          )
          .join("")}</ul>`
      : `<p class="tiny">No games in this filter.</p>`
  );
}

function masteryCard() {
  return sideCard(
    "Mastery",
    P.mastery.length
      ? `<ul class="list">${P.mastery
          .slice(0, 5)
          .map((m) => {
            const c = champById(m.championId);
            return `
          <li class="champ-row">
            ${champImg(c.id, "champ champ--sm")}
            <div><p class="champ-row__name">${esc(c.name)}</p><p class="tiny">Level <span class="num">${m.level}</span></p></div>
            <p class="champ-row__right num">${thousands(m.points)} pts</p>
          </li>`;
          })
          .join("")}</ul>`
      : `<p class="tiny">No mastery yet.</p>`
  );
}

function duosCard(played) {
  const by = new Map();
  for (const m of played) {
    const mine = me(m);
    for (const p of m.players) {
      if (p.teamId !== mine.teamId || p.puuid === P.puuid) continue;
      const d = by.get(p.puuid) ?? { riotId: p.riotId, games: 0, wins: 0 };
      d.games++;
      d.wins += p.win ? 1 : 0;
      by.set(p.puuid, d);
    }
  }
  const duos = [...by.values()].filter((d) => d.games > 1).sort((a, b) => b.games - a.games).slice(0, 5);
  return sideCard(
    "Played with",
    duos.length
      ? `<ul class="list">${duos
          .map(
            (d) => `
          <li class="duo-row">
            ${nameLink(d.riotId)}
            <span class="tiny num">${plural(d.games, "game")} · ${pct(d.wins, d.games)}%</span>
          </li>`
          )
          .join("")}</ul>`
      : `<p class="tiny">No repeat teammates in these games.</p>`
  );
}

/* ---------- matches ---------- */
function badges(m, p) {
  const out = [];
  if (p.multikill >= 2) out.push(MULTI[Math.min(p.multikill, 5)]);
  if (m.players.every((x) => x.damage <= p.damage)) out.push("Top damage");
  if (m.players.filter((x) => x.teamId === p.teamId).every((x) => ratioNum(x) <= ratioNum(p))) out.push("Best KDA");
  if (p.firstBlood) out.push("First blood");
  return out.length ? `<div class="tags">${out.map((t) => `<span class="tag">${t}</span>`).join("")}</div>` : "";
}

function queueChips() {
  const counts = Object.fromEntries(QUEUE_FILTERS.map((f) => [f.key, matches.filter((m) => me(m) && inFilter(m, f.key)).length]));
  return `
    <div class="filters" role="group" aria-label="Filter by queue">
      ${QUEUE_FILTERS.filter((f) => f.key === "all" || counts[f.key])
        .map(
          (f) => `
        <button type="button" class="filter${queueFilter === f.key ? " is-on" : ""}" data-action="queue" data-queue="${f.key}" aria-pressed="${queueFilter === f.key}">
          ${f.label} <span class="num">${counts[f.key]}</span>
        </button>`
        )
        .join("")}
      ${loadingNote()}
    </div>`;
}

function matchRow(m) {
  const p = me(m);
  const result = m.remake ? "Remake" : p.win ? "Win" : "Loss";
  const team = teamOf(m, p.teamId);
  const mins = Math.max(m.duration / 60, 1);
  const open = expanded.has(m.id);
  const side = (teamId) =>
    `<ul class="mini-team">${m.players
      .filter((x) => x.teamId === teamId)
      .map(
        (x) => `
        <li class="${x.puuid === P.puuid ? "is-me" : ""}">${champImg(x.champion, "champ champ--xs")}${nameLink(x.riotId)}</li>`
      )
      .join("")}</ul>`;

  return `
    <li class="match match--${result.toLowerCase()}${open ? " is-open" : ""}">
      <div class="match__row">
        <div class="match__meta">
          <span class="match__result">${result}</span>
          <span class="tiny">${esc(QUEUES[m.queueId] ?? "Other mode")}</span>
          <span class="tiny">${timeAgo(m.startedAt)}</span>
          <span class="tiny num">${clock(m.duration)}</span>
        </div>
        <div class="match__champ">
          <div class="champ-wrap">${champImg(p.champion)}<span class="champ__level num">${p.champLevel}</span></div>
          ${loadout(p.spells, p.keystone, p.subStyle)}
        </div>
        <div class="match__kda">
          <span class="kda num">${p.kills} / <span class="deaths">${p.deaths}</span> / ${p.assists}</span>
          <span class="tiny"><span class="num">${ratio(p.kills, p.deaths, p.assists)}</span> KDA</span>
          ${m.remake ? "" : badges(m, p)}
        </div>
        <div class="match__stats tiny">
          <span>KP <span class="num">${pct(p.kills + p.assists, team.kills)}%</span></span>
          <span><span class="num">${p.cs}</span> CS (<span class="num">${(p.cs / mins).toFixed(1)}</span>)</span>
          <span>Vision <span class="num">${p.vision}</span></span>
        </div>
        ${itemsRow(p.items)}
        <div class="match__teams">${side(100)}${side(200)}</div>
        <button type="button" class="expand" data-action="expand" data-id="${esc(m.id)}" aria-expanded="${open}" aria-label="Show match details">
          <svg class="icon" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </div>
      ${open ? matchDetails(m) : ""}
    </li>`;
}

function matchDetails(m) {
  const maxDmg = Math.max(1, ...m.players.map((p) => p.damage));
  const table = (team) => {
    const players = m.players.filter((p) => p.teamId === team.id);
    return `
      <table class="scoreboard">
        <thead>
          <tr>
            <th class="${team.win ? "won" : "lost"}">${m.remake ? "Remake" : team.win ? "Victory" : "Defeat"} · ${team.id === 100 ? "Blue" : "Red"} side</th>
            <th>KDA</th><th>Damage</th><th>Gold</th><th>CS</th><th>Wards</th><th>Items</th>
          </tr>
        </thead>
        <tbody>${players
          .map(
            (p) => `
          <tr class="${p.puuid === P.puuid ? "is-me" : ""}">
            <td>
              <div class="sb-player">
                <div class="champ-wrap">${champImg(p.champion, "champ champ--sm")}<span class="champ__level num">${p.champLevel}</span></div>
                ${loadout(p.spells, p.keystone, p.subStyle)}
                <div class="sb-name">${nameLink(p.riotId)}<span class="tiny">${ROLES[p.position] ?? ""}</span></div>
              </div>
            </td>
            <td><span class="num">${p.kills}/${p.deaths}/${p.assists}</span><span class="tiny num">${ratio(p.kills, p.deaths, p.assists)} · ${pct(p.kills + p.assists, team.kills)}%</span></td>
            <td><span class="num">${thousands(p.damage)}</span><div class="bar bar--thin"><span style="width:${(100 * p.damage) / maxDmg}%"></span></div></td>
            <td class="num">${thousands(p.gold)}</td>
            <td><span class="num">${p.cs}</span><span class="tiny num">${(p.cs / Math.max(m.duration / 60, 1)).toFixed(1)}/m</span></td>
            <td><span class="num">${p.vision}</span><span class="tiny num">${p.wards} placed</span></td>
            <td>${itemsRow(p.items)}</td>
          </tr>`
          )
          .join("")}</tbody>
      </table>
      <p class="team-line tiny">
        <span class="num">${team.kills}</span> kills · <span class="num">${thousands(team.gold)}</span> gold ·
        <span class="num">${team.towers}</span> towers · <span class="num">${team.dragons}</span> dragons · <span class="num">${team.barons}</span> barons
      </p>`;
  };
  return `<div class="details">${m.teams.map(table).join("")}</div>`;
}

const moreButton = () => {
  if (filling) return "";
  if (hasMore) return `<button type="button" class="btn btn--ghost more" data-action="more">Load more games</button>`;
  return matches.length > MATCH_PAGE ? `<p class="tiny note">That's all of this player's available games.</p>` : "";
};

const MATCH_PAGE = 20; // first page from get_profile, and each page after
// How far back the Champions tab loads (Settings; 0 = all available).
const championTarget = () => settings.gamesToLoad || Infinity;

function loadingNote() {
  if (!filling) return "";
  const text =
    fillStatus ?? `Loading games… ${matches.length}${Number.isFinite(fillTarget) ? ` / ${fillTarget}` : ""}`;
  return `<span class="loading-note"><span class="signal signal--pulse"></span>${esc(text)}</span>`;
}

/* ---------- champions tab ---------- */
function topCounts(values, n) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function isCoreItem(id) {
  const it = S.items[id];
  if (!it || !it.final) return false;
  const tags = it.tags ?? [];
  if (tags.includes("Consumable") || tags.includes("Trinket")) return false;
  return tags.includes("Boots") || it.gold >= 1000;
}

/** Every champion the player has played: mastery (one request, whole account)
    merged with stats from the games loaded so far. Keyed by Data Dragon id. */
function championRows(played) {
  const rows = new Map();
  for (const m of P.mastery) {
    const id = champById(m.championId).id;
    if (id) rows.set(id, { key: id, stats: null, mastery: m });
  }
  for (const c of championStats(played)) {
    const key = champKey(c.name);
    rows.set(key, { key, mastery: rows.get(key)?.mastery ?? null, stats: c });
  }
  return [...rows.values()].sort(
    (a, b) => (b.stats?.games ?? 0) - (a.stats?.games ?? 0) || (b.mastery?.points ?? 0) - (a.mastery?.points ?? 0)
  );
}

function championsTab() {
  const played = playedMatches();
  const rows = championRows(played);
  if (!rows.length) return `<p class="status glass">No champions played yet.</p>`;
  if (!selectedChamp || !rows.some((r) => r.key === selectedChamp)) selectedChamp = rows[0].key;

  const list = `
    <table class="champ-table">
      <thead><tr><th>Champion</th><th>Games</th><th>Win</th><th>KDA</th><th>CS/m</th><th>Mastery</th></tr></thead>
      <tbody>${rows
        .map(({ key, stats: c, mastery: m }) => {
          const dash = `<td class="num muted-cell">–</td>`;
          return `
        <tr class="${key === selectedChamp ? "is-on" : ""}${c ? "" : " is-empty"}" data-action="champ" data-champ="${esc(key)}" tabindex="0">
          <td><div class="champ-cell">${champImg(key, "champ champ--sm")}<span>${esc(champName(key))}</span></div></td>
          ${c ? `<td class="num">${c.games}</td>` : dash}
          ${c ? `<td class="num">${pct(c.wins, c.games)}%</td>` : dash}
          ${c ? `<td class="num">${ratio(c.k, c.d, c.a)}</td>` : dash}
          ${c ? `<td class="num">${(c.cs / Math.max(c.mins, 1)).toFixed(1)}</td>` : dash}
          <td class="num">${m ? thousands(m.points) : "–"}</td>
        </tr>`;
        })
        .join("")}</tbody>
    </table>`;

  return `
    <div class="champs-view">
      <section class="champs-view__list">${list}</section>
      <section class="champs-view__detail">${championDetail(rows.find((r) => r.key === selectedChamp), played)}</section>
    </div>`;
}

function championDetail(row, played) {
  const name = row.key;
  const games = played.filter((m) => champKey(me(m).champion) === name);
  const c = row.stats;
  const m = row.mastery;
  const masteryLine = m
    ? `Mastery ${m.level} · ${thousands(m.points)} pts${m.lastPlayed ? ` · last played ${timeAgo(m.lastPlayed)}` : ""}`
    : "";

  if (!c) {
    return `
      <div class="champ-hero">
        ${champImg(name, "champ champ--lg")}
        <div>
          <p class="micro">${esc(masteryLine)}</p>
          <h2 class="champ-hero__name">${esc(champName(name))}</h2>
        </div>
      </div>
      <p class="status glass">${
        filling
          ? "Still loading this player's games. Stats for this champion appear once a game with it loads."
          : queueFilter !== "all"
            ? "No games on this champion in this filter."
            : "No games on this champion in Riot's available match history (it only goes back about two years). Mastery counts older games too."
      }</p>`;
  }
  const mine = games.map(me);

  const core = topCounts(mine.flatMap((p) => [...new Set(p.items.filter(isCoreItem))]), 6);
  const runes = topCounts(mine.map((p) => `${p.keystone}:${p.subStyle}`), 3);
  const spells = topCounts(mine.map((p) => [...p.spells].sort((a, b) => a - b).join(":")), 2);
  const roles = topCounts(mine.map((p) => p.position).filter((r) => ROLES[r]), 2);

  // Lane opponent: the enemy in the same position.
  const vs = new Map();
  for (const m of games) {
    const p = me(m);
    const opp = m.players.find((x) => x.teamId !== p.teamId && x.position && x.position === p.position);
    if (!opp) continue;
    const row = vs.get(opp.champion) ?? { name: opp.champion, games: 0, wins: 0, k: 0, d: 0, a: 0 };
    row.games++;
    row.wins += p.win ? 1 : 0;
    row.k += p.kills;
    row.d += p.deaths;
    row.a += p.assists;
    vs.set(opp.champion, row);
  }
  const matchups = [...vs.values()].sort((a, b) => b.games - a.games).slice(0, 8);
  const share = (n) => `<span class="tiny num">${pct(n, games.length)}%</span>`;

  return `
    <div class="champ-hero">
      ${champImg(name, "champ champ--lg")}
      <div>
        <p class="micro">${plural(c.games, "game")}${roles.length ? ` · ${roles.map(([r]) => ROLES[r]).join(" / ")}` : ""}</p>
        ${masteryLine ? `<p class="tiny">${esc(masteryLine)}</p>` : ""}
        <h2 class="champ-hero__name">${esc(champName(name))}</h2>
      </div>
      <dl class="champ-hero__stats">
        <div><dt>Win rate</dt><dd class="num">${pct(c.wins, c.games)}%</dd></div>
        <div><dt>KDA</dt><dd class="num">${ratio(c.k, c.d, c.a)}</dd></div>
        <div><dt>Avg K/D/A</dt><dd class="num">${avg(c.k, c.games)} / ${avg(c.d, c.games)} / ${avg(c.a, c.games)}</dd></div>
        <div><dt>CS / min</dt><dd class="num">${(c.cs / Math.max(c.mins, 1)).toFixed(1)}</dd></div>
      </dl>
    </div>

    <div class="champ-grid">
      ${sideCard(
        "Core items",
        core.length
          ? `<ul class="core-items">${core.map(([id, n]) => `<li>${itemImg(id, "item item--lg")}${share(n)}</li>`).join("")}</ul>`
          : `<p class="tiny">No finished items yet.</p>`
      )}
      ${sideCard(
        "Runes and spells",
        `<ul class="list">${runes
          .map(([key, n]) => {
            const [ks, sub] = key.split(":");
            return `<li class="pick-row">${runeImg(ks, "mini mini--keystone mini--md")}${runeImg(sub, "mini mini--rune mini--md")}<span>${esc(S.runes[ks]?.name ?? "")}</span>${share(n)}</li>`;
          })
          .join("")}
        ${spells
          .map(([key, n]) => {
            const [a, b] = key.split(":");
            return `<li class="pick-row">${spellImg(a)}${spellImg(b)}<span>${esc(S.spells[a]?.name ?? "")} + ${esc(S.spells[b]?.name ?? "")}</span>${share(n)}</li>`;
          })
          .join("")}</ul>`
      )}
      ${sideCard(
        "Matchups",
        matchups.length
          ? `<ul class="list">${matchups
              .map(
                (r) => `
            <li class="pick-row">
              ${champImg(r.name, "champ champ--sm")}
              <span>vs ${esc(champName(r.name))}</span>
              <span class="tiny num">${plural(r.games, "game")} · ${pct(r.wins, r.games)}% · ${ratio(r.k, r.d, r.a)}</span>
            </li>`
              )
              .join("")}</ul>`
          : `<p class="tiny">No lane opponents found (ARAM or unknown roles).</p>`
      )}
      ${sideCard(
        "Recent games",
        `<ul class="list">${games
          .slice(0, 8)
          .map((m) => {
            const p = me(m);
            return `
            <li class="pick-row">
              <span class="result-dot ${p.win ? "is-win" : ""}">${p.win ? "W" : "L"}</span>
              <span class="num">${p.kills}/${p.deaths}/${p.assists}</span>
              <span class="tiny">${esc(QUEUES[m.queueId] ?? "Other")} · ${timeAgo(m.startedAt)}</span>
            </li>`;
          })
          .join("")}</ul>`
      )}
    </div>
    <p class="tiny note">Based on ${plural(played.length, "game")}${filling ? ", still loading older games" : hasMore ? " (Settings limits how far back the Champions tab loads)" : ", the whole available history"}.</p>`;
}

/* ---------- live game ---------- */
function liveTab() {
  const g = P.live;
  if (!g) {
    return `
      <div class="status glass">
        <p>${esc(P.gameName)} isn't in a game right now.</p>
        <button type="button" class="btn btn--small" data-action="refresh">Check again</button>
      </div>`;
  }
  const elapsed = g.startedAt ? Math.max(0, Math.round((Date.now() - g.startedAt) / 1000)) : 0;
  const bans = (teamId) =>
    g.bans
      .filter((b) => b.teamId === teamId)
      .map((b) => champImg(champById(b.championId).id, "champ champ--xs champ--ban"))
      .join("");
  const rankCell = (puuid) => {
    if (!liveRanks) return `<span class="tiny">Loading…</span>`;
    const r = (liveRanks[puuid] ?? []).find((x) => x.queue === "RANKED_SOLO_5x5");
    if (!r) return `<span class="tiny">Unranked</span>`;
    const games = r.wins + r.losses;
    return `
      <div class="live-rank">
        <img class="crest" src="${crestSrc(r.tier)}" alt="" ${hide} />
        <span>${title(r.tier)}${APEX.includes(r.tier) ? "" : ` ${r.division}`} <span class="tiny num">${r.lp} LP</span></span>
      </div>
      <span class="tiny num">${pct(r.wins, games)}% · ${plural(games, "game")}</span>`;
  };
  const team = (teamId) => `
    <section class="live-team">
      <div class="live-team__head">
        <p class="micro chapter-label"><span class="signal"></span>${teamId === 100 ? "Blue" : "Red"} side</p>
        <div class="bans" title="Bans">${bans(teamId)}</div>
      </div>
      <ul class="list">${g.players
        .filter((p) => p.teamId === teamId)
        .map((p) => {
          const c = champById(p.championId);
          return `
        <li class="live-row${p.puuid === P.puuid ? " is-me" : ""}">
          ${champImg(c.id)}
          ${loadout(p.spells, p.keystone, p.subStyle)}
          <div class="sb-name">${nameLink(p.riotId)}<span class="tiny">${esc(c.name)}</span></div>
          <div class="live-row__rank">${rankCell(p.puuid)}</div>
        </li>`;
        })
        .join("")}</ul>
    </section>`;
  return `
    <div class="live">
      <p class="live__meta"><span class="chip chip--live"><span class="signal signal--pulse"></span>Live</span>
        ${esc(QUEUES[g.queueId] ?? "Other mode")}${elapsed ? ` · <span class="num">${clock(elapsed)}</span> in` : " · loading screen"}</p>
      <div class="live__teams">${team(100)}${team(200)}</div>
    </div>`;
}

async function loadLiveRanks() {
  if (!P?.live || liveRanks) return;
  try {
    liveRanks = await invoke("get_ranks", { puuids: P.live.players.map((p) => p.puuid).filter(Boolean), platform });
  } catch (err) {
    liveRanks = {};
    console.warn(err);
  }
  if (tab === "live") renderProfile();
}

/* ---------- profile ---------- */
function renderProfile() {
  const played = playedMatches();
  const fav = isFav(`${P.gameName}#${P.tagLine}`, platform);
  let body;
  if (tab === "live") body = liveTab();
  else if (tab === "champions") body = `${queueChips()}${championsTab()}`;
  else
    body = `<div class="overview">
      <aside class="sidebar">
        <section class="card ranks">${rankCard("RANKED_SOLO_5x5")}${rankCard("RANKED_FLEX_SR")}</section>
        ${recentCard(played)}
        ${rolesCard(played)}
        ${championsCard(played)}
        ${masteryCard()}
        ${duosCard(played)}
      </aside>
      <section class="history">
        ${queueChips()}
        ${visibleMatches().length ? `<ol class="matches">${visibleMatches().slice(0, shownRows).map(matchRow).join("")}</ol>` : `<p class="status glass">No games in this filter.</p>`}
        ${shownRows < visibleMatches().length ? `<p class="tiny note scroll-more">Scroll for more games</p>` : moreButton()}
      </section>
    </div>`;

  // Re-rendering replaces the panes, so keep where each one was scrolled to.
  const scrolled = SCROLL_PANES.map((sel) => [sel, view.querySelector(sel)?.scrollTop ?? 0]);
  tip.hidden = true;

  view.innerHTML = `
    <section class="profile-head">
      <img class="profile-head__icon" src="${iconSrc(P.iconId)}" alt="" />
      <div class="profile-head__id">
        <h1 class="profile-head__name">${esc(P.gameName)}<span class="profile-head__tag">#${esc(P.tagLine)}</span>
          <button type="button" class="star star--lg${fav ? " is-on" : ""}" data-action="fav" data-riot-id="${esc(`${P.gameName}#${P.tagLine}`)}" data-platform="${platform}"
            aria-label="${fav ? "Remove from" : "Add to"} favourites" title="${fav ? "Remove from" : "Add to"} favourites">${starSvg}</button>
        </h1>
        <div class="profile-head__chips">
          <span class="chip">${esc(regionLabel(platform))}</span>
          <span class="chip">Level <span class="num">${P.level}</span></span>
          ${P.live ? `<button type="button" class="chip chip--live" data-action="tab" data-tab="live"><span class="signal signal--pulse"></span>In game now</button>` : ""}
        </div>
      </div>
      <button type="button" class="btn btn--small" data-action="refresh">Update</button>
    </section>

    <nav class="tabs" role="tablist">
      ${[
        ["overview", "Overview"],
        ["champions", "Champions"],
        ["live", `Live game${P.live ? ` <span class="signal"></span>` : ""}`],
      ]
        .map(
          ([key, label]) =>
            `<button type="button" role="tab" class="tab" data-action="tab" data-tab="${key}" aria-selected="${tab === key}">${label}</button>`
        )
        .join("")}
    </nav>
    ${body}`;

  for (const [sel, top] of scrolled) {
    const pane = view.querySelector(sel);
    if (pane) pane.scrollTop = top;
  }
}

const SCROLL_PANES = [".sidebar", ".history", ".champs-view__list", ".champs-view__detail", ".live"];

/* ---------- actions ---------- */
async function ensureStatic() {
  if (!S) S = await invoke("get_static");
}

async function search(riotId, plat = regionSelect.value, nextTab = "overview") {
  const token = ++loadToken; // cancels background loading for the previous profile
  filling = false;
  fillStatus = null;
  fillTarget = 0;
  platform = plat;
  regionSelect.value = plat;
  idInput.value = riotId;
  searchMenu.hidden = true;
  form.setAttribute("aria-busy", "true");
  renderLoading(`Reading match history for <strong>${esc(riotId)}</strong>…`);
  try {
    await ensureStatic();
    P = await invoke("get_profile", { riotId, platform });
    matches = P.page.matches;
    nextStart = MATCH_PAGE;
    hasMore = P.page.hasMore;
    expanded.clear();
    liveRanks = null;
    selectedChamp = null;
    queueFilter = "all";
    shownRows = ROW_STEP;
    tab = nextTab === "live" && !P.live ? "overview" : nextTab;
    addRecent(`${P.gameName}#${P.tagLine}`, platform);
    renderProfile();
    if (P.page.skipped) toast(`${plural(P.page.skipped, "game")} couldn't load. Update in a minute.`);
    if (tab === "live") loadLiveRanks();
    if (tab === "champions") requestGames(championTarget());
    return true;
  } catch (err) {
    renderError(typeof err === "string" ? err : "Something went wrong. Try again.");
    return false;
  } finally {
    form.removeAttribute("aria-busy");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keep loading older games in the background until the target is reached.
    Stats re-render as each batch arrives; Riot's rate limit is waited out. */
async function fillGames(token) {
  if (!hasMore || nextStart >= fillTarget) return;
  filling = true;
  if (tab !== "live") renderProfile();
  while (token === loadToken && hasMore && nextStart < fillTarget) {
    const count = Math.min(MATCH_PAGE, fillTarget - nextStart);
    try {
      const page = await invoke("get_more_matches", { puuid: P.puuid, platform, start: nextStart, count });
      if (token !== loadToken) return;
      nextStart += count;
      hasMore = page.hasMore;
      const known = new Set(matches.map((m) => m.id));
      matches.push(...page.matches.filter((m) => !known.has(m.id)));
    } catch (err) {
      if (token !== loadToken) return;
      const message = typeof err === "string" ? err : "Couldn't load more games.";
      if (/rate limit/i.test(message)) {
        const secs = Number(/(\d+) seconds/.exec(message)?.[1] ?? 60);
        for (let left = secs; left > 0 && token === loadToken; left--) {
          fillStatus = `Riot's rate limit: continuing in ${left}s… (${matches.length} games so far)`;
          if (tab !== "live" && (left === secs || left % 5 === 0)) renderProfile();
          await sleep(1000);
        }
        fillStatus = null;
        continue;
      }
      toast(message);
      break;
    }
    if (tab !== "live") renderProfile();
  }
  if (token === loadToken) {
    filling = false;
    fillStatus = null;
    if (tab !== "live") renderProfile();
  }
}

/** Ask for games up to `target`; starts loading unless a load is already running
    (a running load picks up the higher target). */
function requestGames(target) {
  fillTarget = Math.max(fillTarget, target);
  if (!filling) fillGames(loadToken);
}

// Overview: one more page. Champions tab: the whole history (or the Settings limit).
const loadMore = () => requestGames(nextStart + MATCH_PAGE);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (form.hasAttribute("aria-busy")) return;
  const riotId = idInput.value.trim();
  if (!riotId.includes("#")) {
    renderError("Enter a Riot ID as Name#TAG, for example Faker#KR1.");
    return;
  }
  search(riotId);
});

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action } = el.dataset;
  if (action === "expand") {
    const id = el.dataset.id;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    renderProfile();
  } else if (action === "search") {
    search(el.dataset.riotId, el.dataset.platform ?? platform);
  } else if (action === "tab") {
    tab = el.dataset.tab;
    renderProfile();
    if (tab === "live") loadLiveRanks();
    if (tab === "champions") requestGames(championTarget());
  } else if (action === "queue") {
    queueFilter = el.dataset.queue;
    shownRows = ROW_STEP;
    renderProfile();
  } else if (action === "champ") {
    selectedChamp = el.dataset.champ;
    tab = "champions";
    renderProfile();
    requestGames(championTarget());
  } else if (action === "fav") {
    e.stopPropagation();
    toggleFav(el.dataset.riotId, el.dataset.platform);
    if (!searchMenu.hidden) renderSearchMenu();
    if (P) renderProfile();
  } else if (action === "refresh") {
    search(`${P.gameName}#${P.tagLine}`, platform, tab);
  } else if (action === "more") {
    loadMore();
  } else if (action === "open-settings") {
    openSettings();
  } else if (action === "close-settings") {
    settingsDialog.close();
  } else if (action === "save-key") {
    saveKey();
  } else if (action === "clear-cache") {
    clearCache();
  } else if (action === "check-update") {
    checkUpdate(true);
  } else if (action === "install-update") {
    installUpdate(el);
  } else if (action === "open-client") {
    if (client?.riotId) search(client.riotId, client.platform ?? platform, client.phase === "InProgress" ? "live" : "overview");
  }
});

// Infinite scroll: draw more match rows as the history nears its end.
view.addEventListener(
  "scroll",
  (e) => {
    const pane = e.target;
    if (!(pane instanceof Element) || !pane.matches(".history")) return;
    if (pane.scrollHeight - pane.scrollTop - pane.clientHeight > 400) return;
    if (shownRows < visibleMatches().length) {
      shownRows += ROW_STEP;
      renderProfile();
    } else if (hasMore && !filling) {
      shownRows += ROW_STEP;
      loadMore();
    }
  },
  true
);

// Keyboard support for clickable table rows.
view.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("tr[data-action]")) e.target.click();
});

/* ---------- fixed window sizes (League client style) ---------- */
// The layout is drawn once at 1280x720 and scaled to the chosen 16:9 size.
const BASE_WIDTH = 1280;
const sizeSelect = document.querySelector("#window-size");
const applyScale = () => document.documentElement.style.setProperty("--scale", window.innerWidth / BASE_WIDTH);
window.addEventListener("resize", applyScale);
applyScale();

for (const opt of sizeSelect.options) {
  const [w, h] = opt.value.split("x").map(Number);
  opt.disabled = w > screen.availWidth || h > screen.availHeight;
}

async function setWindowSize(value) {
  const [w, h] = value.split("x").map(Number);
  const win = window.__TAURI__.window.getCurrentWindow();
  await win.setSize(new window.__TAURI__.dpi.LogicalSize(w, h));
  await win.center();
}

/* ---------- settings ---------- */
const $ = (id) => document.querySelector(id);
const defaultRegion = $("#default-region");
defaultRegion.innerHTML = regionSelect.innerHTML;

function applyMotion() {
  document.documentElement.dataset.motion = settings.motion ? "on" : "off";
}

async function refreshKeyStatus() {
  try {
    const info = await invoke("app_info");
    $("#key-status").textContent = info.keySource
      ? `Using the key ending ${info.keyHint} from ${info.keySource}.`
      : "No key saved yet. Searches won't work until you add one.";
    $("#update-status").textContent = `RiftLens ${info.version}`;
    $("#cache-status").textContent = `Saved matches: ${info.cachedMatches} (${(info.cacheBytes / 1048576).toFixed(1)} MB)`;
  } catch {}
}

function openSettings() {
  sizeSelect.value = settings.size;
  defaultRegion.value = settings.region;
  gamesSelect.value = String(settings.gamesToLoad);
  $("#set-motion").checked = settings.motion;
  $("#set-auto-profile").checked = settings.autoProfile;
  $("#set-auto-live").checked = settings.autoLive;
  $("#set-auto-update").checked = settings.autoUpdate;
  $("#key-input").value = "";
  $("#client-status").textContent = client?.riotId
    ? `Connected: ${client.riotId} on ${regionLabel(client.platform ?? "")}.`
    : client
      ? "League client found, not logged in yet."
      : "League client isn't running.";
  refreshKeyStatus();
  settingsDialog.showModal();
}

async function saveKey() {
  const key = $("#key-input").value.trim();
  try {
    await invoke("save_key", { key });
    $("#key-input").value = "";
    await refreshKeyStatus();
    toast(key ? "Key saved." : "Saved key removed.");
    if (!P) renderEmpty();
  } catch (err) {
    toast(typeof err === "string" ? err : "Couldn't save the key.");
  }
}

sizeSelect.addEventListener("change", async () => {
  settings.size = sizeSelect.value;
  saveSettings();
  try {
    await setWindowSize(settings.size);
  } catch (err) {
    toast("Couldn't resize the window.");
    console.warn(err);
  }
});
defaultRegion.addEventListener("change", () => {
  settings.region = defaultRegion.value;
  saveSettings();
});
const gamesSelect = $("#games-to-load");
gamesSelect.addEventListener("change", () => {
  settings.gamesToLoad = Number(gamesSelect.value);
  saveSettings();
  // Top up the open profile to the new target.
  if (P && tab === "champions") requestGames(championTarget());
});

async function clearCache() {
  try {
    await invoke("clear_cache");
    await refreshKeyStatus();
    toast("Saved matches cleared.");
  } catch (err) {
    toast(typeof err === "string" ? err : "Couldn't clear saved matches.");
  }
}
for (const [id, key] of [
  ["#set-motion", "motion"],
  ["#set-auto-profile", "autoProfile"],
  ["#set-auto-live", "autoLive"],
  ["#set-auto-update", "autoUpdate"],
]) {
  $(id).addEventListener("change", (e) => {
    settings[key] = e.target.checked;
    saveSettings();
    if (key === "motion") applyMotion();
  });
}
// Click on the dimmed backdrop closes the dialog.
settingsDialog.addEventListener("click", (e) => {
  if (e.target === settingsDialog) settingsDialog.close();
});

/* ---------- updates ---------- */
async function checkUpdate(manual = false) {
  if (manual) $("#update-status").textContent = "Checking for updates…";
  try {
    const update = await invoke("check_update");
    if (update) {
      $("#update-status").textContent = `Version ${update.version} is available.`;
      toast(`RiftLens ${update.version} is available.`, { action: "install-update", label: "Update now" });
    } else if (manual) {
      await refreshKeyStatus();
      $("#update-status").textContent += " is up to date.";
    }
  } catch (err) {
    if (manual) $("#update-status").textContent = typeof err === "string" ? err : "Couldn't check for updates.";
  }
}

async function installUpdate(button) {
  button.disabled = true;
  button.textContent = "Updating…";
  try {
    await invoke("install_update"); // restarts the app when done
  } catch (err) {
    toast(typeof err === "string" ? err : "The update failed.");
  }
}

/* ---------- League client ---------- */
let lastPhase = null;
let checkedLaunch = false;

const PHASES = {
  None: "In client",
  Lobby: "In lobby",
  Matchmaking: "In queue",
  ReadyCheck: "Match found",
  ChampSelect: "Champ select",
  GameStart: "Loading",
  InProgress: "In game",
  WaitingForStats: "Post game",
  EndOfGame: "Post game",
};

async function pollClient() {
  try {
    client = await invoke("client_status");
  } catch {
    client = null;
  }
  if (client?.riotId) {
    clientChip.hidden = false;
    clientChip.innerHTML = `<span class="signal${client.phase === "InProgress" ? " signal--pulse" : ""}"></span>${esc(client.riotId.split("#")[0])} · ${esc(PHASES[client.phase] ?? "In client")}`;
    clientChip.title = `Open ${client.riotId}`;
  } else {
    clientChip.hidden = true;
  }

  // On launch, open the logged-in profile once the client answers (give it up to a minute).
  if (!checkedLaunch && (client?.riotId || performance.now() > 60000)) {
    checkedLaunch = true;
    if (client?.riotId && settings.autoProfile && !P && !form.hasAttribute("aria-busy")) {
      search(client.riotId, client.platform ?? settings.region);
    }
  }
  if (client?.riotId && settings.autoLive && client.phase === "InProgress" && lastPhase && lastPhase !== "InProgress") {
    // Give Riot's live-game data a few seconds to appear.
    setTimeout(() => search(client.riotId, client.platform ?? platform, "live"), 8000);
  }
  lastPhase = client?.phase ?? null;
}

/* ---------- start ---------- */
window.__TAURI__.event.listen("rate-limit", (e) => toast(`Riot's rate limit was reached. Waiting ${e.payload}s, then continuing…`));

applyMotion();
regionSelect.value = settings.region;
const savedSize = settings.size;
if (sizeSelect.querySelector(`option[value="${savedSize}"]:not([disabled])`) && savedSize !== "1280x720") {
  setWindowSize(savedSize).catch(console.warn);
}
idInput.value = recents()[0]?.riotId ?? "";
if (recents()[0]) regionSelect.value = recents()[0].platform;
renderEmpty();
pollClient();
setInterval(() => {
  if (!document.hidden) pollClient();
}, 5000);
if (settings.autoUpdate) setTimeout(() => checkUpdate(false), 3000);
