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
const RANK_QUEUES = { RANKED_SOLO_5x5: "Solo / Duo", RANKED_FLEX_SR: "Flex" };
const ROLES = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", UTILITY: "Support" };
const APEX = ["MASTER", "GRANDMASTER", "CHALLENGER"];
// Match data and Data Dragon disagree on a few champion ids.
const CHAMP_ID_FIX = { FiddleSticks: "Fiddlesticks" };

const view = document.querySelector("#view");
const form = document.querySelector("#search");
const idInput = document.querySelector("#riot-id");
const regionSelect = document.querySelector("#region");

// App state for the current profile.
let S = null; // static data: version, champions, spells, runes
let P = null; // profile
let platform = "euw1";
let matches = [];
let nextStart = 0;
let hasMore = false;
let tab = "overview";
const expanded = new Set();
let liveRanks = null;

/* ---------- helpers ---------- */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const title = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : "");
const pct = (w, n) => (n ? Math.round((100 * w) / n) : 0);
const ratio = (k, d, a) => (d ? ((k + a) / d).toFixed(2) : "Perfect");
const avg = (n, d) => (d ? (n / d).toFixed(1) : "0.0");
const thousands = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const remember = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
const recall = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

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
const champSrc = (name) => `${DD}/${S.version}/img/champion/${CHAMP_ID_FIX[name] ?? name}.png`;
const champById = (id) => S.champions[id] ?? { id: "", name: "Unknown" };
const itemSrc = (id) => `${DD}/${S.version}/img/item/${id}.png`;
const iconSrc = (id) => `${DD}/${S.version}/img/profileicon/${id}.png`;
const emblemSrc = (tier) => `${CD}/ranked-emblem/emblem-${tier.toLowerCase()}.png`;
const crestSrc = (tier) => `${CD}/ranked-mini-crests/${tier.toLowerCase()}.svg`;

const hide = `onerror="this.style.visibility='hidden'"`;
const champImg = (name, cls = "champ") =>
  `<img class="${cls}" src="${champSrc(name)}" alt="${esc(name)}" title="${esc(name)}" loading="lazy" ${hide} />`;
function spellImg(id) {
  const s = S.spells[id];
  return s
    ? `<img class="mini" src="${DD}/${S.version}/img/spell/${s.id}.png" alt="${esc(s.name)}" title="${esc(s.name)}" loading="lazy" />`
    : `<span class="mini mini--empty"></span>`;
}
function runeImg(id, cls = "mini mini--rune") {
  const r = S.runes[id];
  return r
    ? `<img class="${cls}" src="${DD}/img/${r.icon}" alt="${esc(r.name)}" title="${esc(r.name)}" loading="lazy" />`
    : `<span class="mini mini--empty"></span>`;
}
const loadout = (spells, keystone, subStyle) =>
  `<div class="loadout">${spellImg(spells[0])}${runeImg(keystone, "mini mini--keystone")}${spellImg(spells[1])}${runeImg(subStyle)}</div>`;
function itemsRow(items) {
  return `<div class="items">${items
    .map((id, i) =>
      id
        ? `<img class="item${i === 6 ? " item--trinket" : ""}" src="${itemSrc(id)}" alt="" loading="lazy" ${hide} />`
        : `<span class="item item--empty${i === 6 ? " item--trinket" : ""}"></span>`
    )
    .join("")}</div>`;
}
const nameLink = (riotId, cls = "player-link") =>
  riotId && riotId !== "#"
    ? `<button type="button" class="${cls}" data-action="search" data-riot-id="${esc(riotId)}" title="Open ${esc(riotId)}">${esc(riotId.split("#")[0])}</button>`
    : `<span class="${cls}">Hidden</span>`;

const me = (m) => m.players.find((p) => p.puuid === P.puuid);
const teamOf = (m, teamId) => m.teams.find((t) => t.id === teamId) ?? { kills: 0 };

/* ---------- simple states ---------- */
function chapter(label, head, accent, lede) {
  return `
    <section class="chapter">
      <p class="micro chapter-label"><span class="signal"></span>${label}</p>
      <h1 class="display">${head} <em>${accent}</em></h1>
      ${lede ? `<p class="lede">${lede}</p>` : ""}
    </section>`;
}

const renderEmpty = () =>
  (view.innerHTML = chapter(
    "01 / Search",
    "Find a player.",
    "Read their games.",
    "Enter a Riot ID like <strong>Name#TAG</strong>, pick the region they play on, and RiftLens pulls their rank, mastery, live game and match history."
  ));

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

function sideCard(label, body) {
  return `<section class="card"><p class="micro chapter-label"><span class="signal"></span>${label}</p>${body}</section>`;
}

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
    `Last ${n} games`,
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
      : `<p class="tiny">No games yet.</p>`
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
      : `<p class="tiny">No ranked or normal games yet.</p>`
  );
}

function championsCard(played) {
  const by = new Map();
  for (const m of played) {
    const p = me(m);
    const c = by.get(p.champion) ?? { name: p.champion, games: 0, wins: 0, k: 0, d: 0, a: 0, cs: 0, mins: 0 };
    c.games++;
    c.wins += p.win ? 1 : 0;
    c.k += p.kills;
    c.d += p.deaths;
    c.a += p.assists;
    c.cs += p.cs;
    c.mins += m.duration / 60;
    by.set(p.champion, c);
  }
  const top = [...by.values()].sort((a, b) => b.games - a.games || b.wins - a.wins).slice(0, 6);
  return sideCard(
    "Champions",
    top.length
      ? `<ul class="list">${top
          .map(
            (c) => `
          <li class="champ-row">
            ${champImg(c.name, "champ champ--sm")}
            <div><p class="champ-row__name">${esc(champByName(c.name))}</p><p class="tiny num">${(c.cs / Math.max(c.mins, 1)).toFixed(1)} CS/m</p></div>
            <div class="champ-row__right"><p class="num">${ratio(c.k, c.d, c.a)}</p><p class="tiny num">${plural(c.games, "game")} · ${pct(c.wins, c.games)}%</p></div>
          </li>`
          )
          .join("")}</ul>`
      : `<p class="tiny">No games yet.</p>`
  );
}

function champByName(apiName) {
  const id = CHAMP_ID_FIX[apiName] ?? apiName;
  return Object.values(S.champions).find((c) => c.id === id)?.name ?? apiName;
}

function masteryCard() {
  return sideCard(
    "Mastery",
    P.mastery.length
      ? `<ul class="list">${P.mastery
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
          ${p.multikill >= 2 ? `<span class="tag">${["", "", "Double", "Triple", "Quadra", "Penta"][Math.min(p.multikill, 5)]} kill</span>` : ""}
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
      .map((b) => {
        const c = champById(b.championId);
        return champImg(c.id, "champ champ--xs champ--ban");
      })
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
  if (!P.live || liveRanks) return;
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
  const played = matches.filter((m) => !m.remake && me(m));
  view.innerHTML = `
    <section class="profile-head">
      <img class="profile-head__icon" src="${iconSrc(P.iconId)}" alt="" />
      <div class="profile-head__id">
        <h1 class="profile-head__name">${esc(P.gameName)}<span class="profile-head__tag">#${esc(P.tagLine)}</span></h1>
        <div class="profile-head__chips">
          <span class="chip">${esc(regionSelect.querySelector(`option[value="${platform}"]`)?.text ?? platform)}</span>
          <span class="chip">Level <span class="num">${P.level}</span></span>
          ${P.live ? `<button type="button" class="chip chip--live" data-action="tab" data-tab="live"><span class="signal signal--pulse"></span>In game now</button>` : ""}
        </div>
      </div>
      <button type="button" class="btn btn--small" data-action="refresh">Update</button>
    </section>

    <nav class="tabs" role="tablist">
      <button type="button" role="tab" class="tab" data-action="tab" data-tab="overview" aria-selected="${tab === "overview"}">Overview</button>
      <button type="button" role="tab" class="tab" data-action="tab" data-tab="live" aria-selected="${tab === "live"}">
        Live game${P.live ? ` <span class="signal"></span>` : ""}
      </button>
    </nav>

    ${
      tab === "live"
        ? liveTab()
        : `<div class="overview">
      <aside class="sidebar">
        <section class="card ranks">${rankCard("RANKED_SOLO_5x5")}${rankCard("RANKED_FLEX_SR")}</section>
        ${recentCard(played)}
        ${rolesCard(played)}
        ${championsCard(played)}
        ${masteryCard()}
        ${duosCard(played)}
      </aside>
      <section class="history">
        ${matches.length ? `<ol class="matches">${matches.filter(me).map(matchRow).join("")}</ol>` : `<p class="status glass">No games found.</p>`}
        ${hasMore ? `<button type="button" class="btn btn--ghost more" data-action="more">Load more games</button>` : ""}
      </section>
    </div>`
    }`;
}

/* ---------- actions ---------- */
async function ensureStatic() {
  if (!S) S = await invoke("get_static");
}

async function search(riotId) {
  platform = regionSelect.value;
  remember("riftlens.riotId", riotId);
  remember("riftlens.region", platform);
  form.setAttribute("aria-busy", "true");
  renderLoading(`Reading match history for <strong>${esc(riotId)}</strong>…`);
  try {
    await ensureStatic();
    P = await invoke("get_profile", { riotId, platform });
    matches = P.page.matches;
    nextStart = 10;
    hasMore = P.page.hasMore;
    expanded.clear();
    liveRanks = null;
    if (tab === "live" && !P.live) tab = "overview";
    renderProfile();
    if (P.page.skipped) toast(`${plural(P.page.skipped, "game")} couldn't load (rate limit). Update in a minute.`);
    if (tab === "live") loadLiveRanks();
  } catch (err) {
    renderError(typeof err === "string" ? err : "Something went wrong. Try again.");
  } finally {
    form.removeAttribute("aria-busy");
  }
}

async function loadMore(button) {
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    const page = await invoke("get_more_matches", { puuid: P.puuid, platform, start: nextStart });
    nextStart += 10;
    hasMore = page.hasMore;
    const known = new Set(matches.map((m) => m.id));
    matches.push(...page.matches.filter((m) => !known.has(m.id)));
    renderProfile();
    if (page.skipped) toast(`${plural(page.skipped, "game")} couldn't load (rate limit).`);
  } catch (err) {
    toast(typeof err === "string" ? err : "Couldn't load more games.");
    button.disabled = false;
    button.textContent = "Load more games";
  }
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 5000);
}

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

view.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (action === "expand") {
    const id = el.dataset.id;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    renderProfile();
  } else if (action === "search") {
    idInput.value = el.dataset.riotId;
    tab = "overview";
    search(el.dataset.riotId);
  } else if (action === "tab") {
    tab = el.dataset.tab;
    renderProfile();
    if (tab === "live") loadLiveRanks();
  } else if (action === "refresh") {
    search(`${P.gameName}#${P.tagLine}`);
  } else if (action === "more") {
    loadMore(el);
  }
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

sizeSelect.addEventListener("change", async () => {
  remember("riftlens.size", sizeSelect.value);
  try {
    await setWindowSize(sizeSelect.value);
  } catch (err) {
    toast("Couldn't resize the window.");
    console.warn(err);
  }
});

const savedSize = recall("riftlens.size");
if (savedSize && sizeSelect.querySelector(`option[value="${savedSize}"]:not([disabled])`)) {
  sizeSelect.value = savedSize;
  if (savedSize !== "1280x720") setWindowSize(savedSize).catch(console.warn);
} else {
  sizeSelect.value = "1280x720";
}

idInput.value = recall("riftlens.riotId") ?? "";
regionSelect.value = recall("riftlens.region") ?? "euw1";
renderEmpty();
