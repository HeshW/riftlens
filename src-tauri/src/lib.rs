// RiftLens backend: talks to the Riot API with the user's key and hands the
// frontend ready-to-draw data (profile, matches, live game, static data).
// Also reads the local League client (who is logged in, game phase) and
// handles app updates from GitHub Releases.
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const MATCH_PAGE: usize = 10;
const NOT_FOUND: &str = "NOT_FOUND";
const MAX_RATE_WAIT_SECS: u64 = 30;

static APP: OnceLock<AppHandle> = OnceLock::new();

struct AppState {
    http: reqwest::Client,
    // The League client serves its local API over a self-signed certificate.
    lcu: reqwest::Client,
    // Finished matches never change, so keep them for the life of the app.
    match_cache: Mutex<HashMap<String, Value>>,
    statics: Mutex<Option<Value>>,
    lockfile: Mutex<Option<PathBuf>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            http: reqwest::Client::new(),
            lcu: reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .timeout(Duration::from_secs(3))
                .build()
                .expect("LCU client"),
            match_cache: Mutex::default(),
            statics: Mutex::default(),
            lockfile: Mutex::default(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    game_name: String,
    tag_line: String,
    puuid: String,
    level: i64,
    icon_id: i64,
    ranks: Vec<Rank>,
    mastery: Vec<Mastery>,
    live: Option<LiveGame>,
    page: MatchPage,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Rank {
    queue: String,
    tier: String,
    division: String,
    lp: i64,
    wins: i64,
    losses: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Mastery {
    champion_id: i64,
    level: i64,
    points: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MatchPage {
    matches: Vec<MatchSummary>,
    skipped: usize,
    has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MatchSummary {
    id: String,
    queue_id: i64,
    started_at: i64,
    duration: i64,
    remake: bool,
    teams: Vec<Team>,
    players: Vec<Player>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Team {
    id: i64,
    win: bool,
    kills: i64,
    towers: i64,
    dragons: i64,
    barons: i64,
    gold: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Player {
    puuid: String,
    riot_id: String,
    team_id: i64,
    win: bool,
    position: String,
    champion: String,
    champ_level: i64,
    kills: i64,
    deaths: i64,
    assists: i64,
    cs: i64,
    gold: i64,
    damage: i64,
    damage_taken: i64,
    vision: i64,
    wards: i64,
    multikill: i64,
    first_blood: bool,
    items: Vec<i64>,
    spells: [i64; 2],
    keystone: i64,
    sub_style: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveGame {
    queue_id: i64,
    started_at: i64,
    players: Vec<LivePlayer>,
    bans: Vec<LiveBan>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LivePlayer {
    puuid: String,
    riot_id: String,
    team_id: i64,
    champion_id: i64,
    spells: [i64; 2],
    keystone: i64,
    sub_style: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveBan {
    team_id: i64,
    champion_id: i64,
}

/// Platform (where the summoner lives) -> (account cluster, match cluster).
fn routing(platform: &str) -> Result<(&'static str, &'static str), String> {
    Ok(match platform {
        "na1" | "br1" | "la1" | "la2" => ("americas", "americas"),
        "euw1" | "eun1" | "tr1" | "ru" | "me1" => ("europe", "europe"),
        "kr" | "jp1" => ("asia", "asia"),
        "oc1" | "sg2" | "tw2" | "vn2" => ("asia", "sea"),
        _ => return Err("Unknown region.".into()),
    })
}

/// Where the key typed into Settings is saved (the app's config folder).
fn key_file() -> Option<PathBuf> {
    let dir = APP.get()?.path().app_config_dir().ok()?;
    Some(dir.join("riot_api_key.txt"))
}

/// The key and where it came from. Read on every request, so a fresh
/// development key works without restarting the app. The key saved in
/// Settings always wins; dev builds (`npm run tauri dev`) fall back to .env.
fn find_key() -> Option<(String, &'static str)> {
    if let Some(saved) = key_file().and_then(|f| std::fs::read_to_string(f).ok()) {
        if !saved.trim().is_empty() {
            return Some((saved.trim().to_string(), "Settings"));
        }
    }
    if cfg!(debug_assertions) {
        if let Ok(iter) = dotenvy::from_filename_iter(".env") {
            for (k, v) in iter.flatten() {
                if k == "RIOT_API_KEY" && !v.trim().is_empty() {
                    return Some((v.trim().to_string(), ".env file (dev build)"));
                }
            }
        }
    }
    None
}

fn api_key() -> Result<String, String> {
    find_key()
        .map(|(k, _)| k)
        .ok_or_else(|| "No Riot API key yet. Open Settings (top right) and paste your key.".into())
}

/// GET from the Riot API. When the rate limit is hit and the wait is short,
/// tell the UI and retry instead of failing.
async fn riot_get(http: &reqwest::Client, url: &str) -> Result<Value, String> {
    for attempt in 0..3 {
        let res = http
            .get(url)
            .header("X-Riot-Token", api_key()?)
            .send()
            .await
            .map_err(|e| format!("Couldn't reach Riot: {e}"))?;
        match res.status().as_u16() {
            200 => {
                return res
                    .json()
                    .await
                    .map_err(|e| format!("Riot sent something unexpected: {e}"))
            }
            401 | 403 => {
                return Err("Riot rejected the API key. Development keys expire every 24 hours: \
                            paste a fresh one in Settings and search again."
                    .into())
            }
            404 => return Err(NOT_FOUND.into()),
            429 => {
                let wait = res
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(5);
                if attempt == 2 || wait > MAX_RATE_WAIT_SECS {
                    return Err(format!("Riot's rate limit was hit. Try again in {wait} seconds."));
                }
                if let Some(app) = APP.get() {
                    let _ = app.emit("rate-limit", wait);
                }
                tokio::time::sleep(Duration::from_secs(wait) + Duration::from_millis(250)).await;
            }
            s => return Err(format!("Riot API error {s}. Try again in a moment.")),
        }
    }
    Err("Riot's rate limit was hit. Try again in a minute.".into())
}

/// A 404 that just means "nothing here" (unranked, not in game) becomes None.
fn optional(r: Result<Value, String>) -> Result<Option<Value>, String> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(e) if e == NOT_FOUND => Ok(None),
        Err(e) => Err(e),
    }
}

fn int(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

/// Finished matches are saved here, so a profile opened again only fetches
/// games played since last time.
fn match_dir() -> Option<PathBuf> {
    Some(APP.get()?.path().app_cache_dir().ok()?.join("matches"))
}

fn match_file(id: &str) -> Option<PathBuf> {
    // Match ids look like EUW1_7012345678; keep only safe filename characters.
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    Some(match_dir()?.join(format!("{safe}.json")))
}

async fn get_match(state: &AppState, region: &str, id: &str) -> Result<Value, String> {
    let cached = state.match_cache.lock().unwrap().get(id).cloned();
    if let Some(m) = cached {
        return Ok(m);
    }
    let file = match_file(id);
    let on_disk = file
        .as_ref()
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let m = match on_disk {
        Some(m) => m,
        None => {
            let url = format!("https://{region}.api.riotgames.com/lol/match/v5/matches/{id}");
            let m = riot_get(&state.http, &url).await?;
            if let Some(f) = &file {
                if let Some(dir) = f.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(f, serde_json::to_vec(&m).unwrap_or_default());
            }
            m
        }
    };
    state
        .match_cache
        .lock()
        .unwrap()
        .insert(id.to_string(), m.clone());
    Ok(m)
}

/// Number and total size of saved matches.
fn cache_usage() -> (u64, u64) {
    let Some(entries) = match_dir().and_then(|d| std::fs::read_dir(d).ok()) else {
        return (0, 0);
    };
    entries
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .fold((0, 0), |(n, bytes), m| (n + 1, bytes + m.len()))
}

#[tauri::command]
fn clear_cache(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.match_cache.lock().unwrap().clear();
    match match_dir() {
        Some(dir) if dir.exists() => {
            std::fs::remove_dir_all(dir).map_err(|e| format!("Couldn't clear saved matches: {e}"))
        }
        _ => Ok(()),
    }
}

fn summarize(m: &Value) -> Option<MatchSummary> {
    let info = &m["info"];
    let players: Vec<Player> = info["participants"]
        .as_array()?
        .iter()
        .map(|p| {
            let styles = &p["perks"]["styles"];
            Player {
                puuid: text(&p["puuid"]),
                riot_id: format!("{}#{}", text(&p["riotIdGameName"]), text(&p["riotIdTagline"])),
                team_id: int(&p["teamId"]),
                win: p["win"].as_bool().unwrap_or(false),
                position: text(&p["teamPosition"]),
                champion: text(&p["championName"]),
                champ_level: int(&p["champLevel"]),
                kills: int(&p["kills"]),
                deaths: int(&p["deaths"]),
                assists: int(&p["assists"]),
                cs: int(&p["totalMinionsKilled"]) + int(&p["neutralMinionsKilled"]),
                gold: int(&p["goldEarned"]),
                damage: int(&p["totalDamageDealtToChampions"]),
                damage_taken: int(&p["totalDamageTaken"]),
                vision: int(&p["visionScore"]),
                wards: int(&p["wardsPlaced"]),
                multikill: int(&p["largestMultiKill"]),
                first_blood: p["firstBloodKill"].as_bool().unwrap_or(false),
                items: (0..7).map(|n| int(&p[format!("item{n}")])).collect(),
                spells: [int(&p["summoner1Id"]), int(&p["summoner2Id"])],
                keystone: int(&styles[0]["selections"][0]["perk"]),
                sub_style: int(&styles[1]["style"]),
            }
        })
        .collect();
    let teams = info["teams"]
        .as_array()?
        .iter()
        .map(|t| {
            let id = int(&t["teamId"]);
            let obj = &t["objectives"];
            Team {
                id,
                win: t["win"].as_bool().unwrap_or(false),
                kills: int(&obj["champion"]["kills"]),
                towers: int(&obj["tower"]["kills"]),
                dragons: int(&obj["dragon"]["kills"]),
                barons: int(&obj["baron"]["kills"]),
                gold: players.iter().filter(|p| p.team_id == id).map(|p| p.gold).sum(),
            }
        })
        .collect();
    Some(MatchSummary {
        id: m["metadata"]["matchId"].as_str()?.to_string(),
        queue_id: int(&info["queueId"]),
        started_at: int(&info["gameStartTimestamp"]),
        duration: int(&info["gameDuration"]),
        remake: info["participants"][0]["gameEndedInEarlySurrender"]
            .as_bool()
            .unwrap_or(false),
        teams,
        players,
    })
}

async fn match_page(
    state: &AppState,
    region: &str,
    puuid: &str,
    start: usize,
    count: usize,
) -> Result<MatchPage, String> {
    let url = format!(
        "https://{region}.api.riotgames.com/lol/match/v5/matches/by-puuid/{puuid}/ids?start={start}&count={count}"
    );
    let ids: Vec<String> =
        serde_json::from_value(riot_get(&state.http, &url).await?).unwrap_or_default();
    let results =
        futures::future::join_all(ids.iter().map(|id| get_match(state, region, id))).await;
    let mut matches = Vec::new();
    let mut first_err = None;
    for r in results {
        match r {
            Ok(m) => matches.extend(summarize(&m)),
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }
    if matches.is_empty() {
        if let Some(e) = first_err {
            return Err(e);
        }
    }
    Ok(MatchPage {
        skipped: ids.len() - matches.len(),
        has_more: ids.len() == count,
        matches,
    })
}

fn parse_ranks(v: Option<Value>) -> Vec<Rank> {
    v.and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|l| Rank {
            queue: text(&l["queueType"]),
            tier: text(&l["tier"]),
            division: text(&l["rank"]),
            lp: int(&l["leaguePoints"]),
            wins: int(&l["wins"]),
            losses: int(&l["losses"]),
        })
        .collect()
}

fn parse_live(v: Option<Value>) -> Option<LiveGame> {
    let g = v?;
    Some(LiveGame {
        queue_id: int(&g["gameQueueConfigId"]),
        started_at: int(&g["gameStartTime"]),
        players: g["participants"]
            .as_array()?
            .iter()
            .map(|p| LivePlayer {
                puuid: text(&p["puuid"]),
                riot_id: text(&p["riotId"]),
                team_id: int(&p["teamId"]),
                champion_id: int(&p["championId"]),
                spells: [int(&p["spell1Id"]), int(&p["spell2Id"])],
                keystone: int(&p["perks"]["perkIds"][0]),
                sub_style: int(&p["perks"]["perkSubStyle"]),
            })
            .collect(),
        bans: g["bannedChampions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter(|b| int(&b["championId"]) > 0)
            .map(|b| LiveBan {
                team_id: int(&b["teamId"]),
                champion_id: int(&b["championId"]),
            })
            .collect(),
    })
}

#[tauri::command]
async fn get_profile(
    riot_id: String,
    platform: String,
    state: tauri::State<'_, AppState>,
) -> Result<Profile, String> {
    let (account_region, match_region) = routing(&platform)?;
    let (name, tag) = riot_id
        .trim()
        .rsplit_once('#')
        .map(|(n, t)| (n.trim(), t.trim()))
        .filter(|(n, t)| !n.is_empty() && !t.is_empty())
        .ok_or("Enter a Riot ID as Name#TAG.")?;
    let http = &state.http;

    let account = riot_get(
        http,
        &format!(
            "https://{account_region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{}/{}",
            urlencoding::encode(name),
            urlencoding::encode(tag)
        ),
    )
    .await
    .map_err(|e| if e == NOT_FOUND { format!("No player called {name}#{tag}.") } else { e })?;
    let puuid = text(&account["puuid"]);

    let base = format!("https://{platform}.api.riotgames.com/lol");
    let summoner_url = format!("{base}/summoner/v4/summoners/by-puuid/{puuid}");
    let league_url = format!("{base}/league/v4/entries/by-puuid/{puuid}");
    let mastery_url = format!("{base}/champion-mastery/v4/champion-masteries/by-puuid/{puuid}/top?count=5");
    let live_url = format!("{base}/spectator/v5/active-games/by-summoner/{puuid}");
    let (summoner, leagues, mastery, live, page) = futures::join!(
        riot_get(http, &summoner_url),
        riot_get(http, &league_url),
        riot_get(http, &mastery_url),
        riot_get(http, &live_url),
        match_page(&state, match_region, &puuid, 0, MATCH_PAGE),
    );

    let summoner = summoner.map_err(|e| {
        if e == NOT_FOUND {
            format!("{name}#{tag} hasn't played League on {}.", platform.to_uppercase())
        } else {
            e
        }
    })?;

    Ok(Profile {
        game_name: account["gameName"].as_str().unwrap_or(name).to_string(),
        tag_line: account["tagLine"].as_str().unwrap_or(tag).to_string(),
        level: int(&summoner["summonerLevel"]),
        icon_id: int(&summoner["profileIconId"]),
        ranks: parse_ranks(optional(leagues)?),
        mastery: optional(mastery)?
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .map(|m| Mastery {
                champion_id: int(&m["championId"]),
                level: int(&m["championLevel"]),
                points: int(&m["championPoints"]),
            })
            .collect(),
        // Live game is a bonus: a failure there shouldn't sink the profile.
        live: parse_live(optional(live).unwrap_or(None)),
        page: page?,
        puuid,
    })
}

#[tauri::command]
async fn get_more_matches(
    puuid: String,
    platform: String,
    start: usize,
    count: usize,
    state: tauri::State<'_, AppState>,
) -> Result<MatchPage, String> {
    let (_, match_region) = routing(&platform)?;
    match_page(&state, match_region, &puuid, start, count.clamp(1, 100)).await
}

/// Solo/Duo and Flex ranks for each player in a live game.
#[tauri::command]
async fn get_ranks(
    puuids: Vec<String>,
    platform: String,
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, Vec<Rank>>, String> {
    routing(&platform)?;
    let urls: Vec<String> = puuids
        .iter()
        .map(|p| format!("https://{platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/{p}"))
        .collect();
    let results = futures::future::join_all(urls.iter().map(|u| riot_get(&state.http, u))).await;
    let mut out = HashMap::new();
    for (puuid, r) in puuids.into_iter().zip(results) {
        out.insert(puuid, parse_ranks(optional(r)?));
    }
    Ok(out)
}

async fn ddragon_json(http: &reqwest::Client, url: &str) -> Result<Value, String> {
    http.get(url)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Data Dragon: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Data Dragon sent something unexpected: {e}"))
}

/// Patch version plus lookup tables for champions, summoner spells and runes.
#[tauri::command]
async fn get_static(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let cached = state.statics.lock().unwrap().clone();
    if let Some(s) = cached {
        return Ok(s);
    }
    let http = &state.http;
    let versions = ddragon_json(http, "https://ddragon.leagueoflegends.com/api/versions.json").await?;
    let v = versions[0].as_str().ok_or("No Data Dragon version.")?.to_string();
    let data = format!("https://ddragon.leagueoflegends.com/cdn/{v}/data/en_US");
    let (champ_url, spell_url, rune_url, item_url) = (
        format!("{data}/champion.json"),
        format!("{data}/summoner.json"),
        format!("{data}/runesReforged.json"),
        format!("{data}/item.json"),
    );
    let (champs, spells, runes, items) = futures::join!(
        ddragon_json(http, &champ_url),
        ddragon_json(http, &spell_url),
        ddragon_json(http, &rune_url),
        ddragon_json(http, &item_url),
    );

    let mut champions = serde_json::Map::new();
    for c in champs?["data"].as_object().into_iter().flat_map(|m| m.values()) {
        champions.insert(text(&c["key"]), json!({ "id": c["id"], "name": c["name"] }));
    }
    let mut spell_map = serde_json::Map::new();
    for s in spells?["data"].as_object().into_iter().flat_map(|m| m.values()) {
        spell_map.insert(
            text(&s["key"]),
            json!({ "id": s["id"], "name": s["name"], "desc": s["description"] }),
        );
    }
    let mut rune_map = serde_json::Map::new();
    for style in runes?.as_array().cloned().unwrap_or_default() {
        rune_map.insert(int(&style["id"]).to_string(), json!({ "name": style["name"], "icon": style["icon"] }));
        for slot in style["slots"].as_array().cloned().unwrap_or_default() {
            for r in slot["runes"].as_array().cloned().unwrap_or_default() {
                rune_map.insert(
                    int(&r["id"]).to_string(),
                    json!({ "name": r["name"], "icon": r["icon"], "desc": r["shortDesc"] }),
                );
            }
        }
    }
    let mut item_map = serde_json::Map::new();
    if let Some(all) = items?["data"].as_object() {
        for (id, it) in all {
            item_map.insert(
                id.clone(),
                json!({
                    "name": it["name"],
                    "desc": it["description"],
                    "gold": it["gold"]["total"],
                    // Finished items don't build into anything; used for "core build".
                    "final": it["into"].as_array().is_none_or(|a| a.is_empty()),
                    "tags": it["tags"],
                }),
            );
        }
    }

    let out = json!({
        "version": v,
        "champions": champions,
        "spells": spell_map,
        "runes": rune_map,
        "items": item_map,
    });
    *state.statics.lock().unwrap() = Some(out.clone());
    Ok(out)
}

/* ---------- Local League client (LCU) ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientStatus {
    phase: String,
    riot_id: Option<String>,
    platform: Option<String>,
}

/// Port and password from the League client's lockfile, which sits next to
/// LeagueClientUx.exe while the client is running.
fn read_lockfile(path: &PathBuf) -> Option<(String, String)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parts: Vec<&str> = raw.trim().split(':').collect();
    (parts.len() >= 5).then(|| (parts[2].to_string(), parts[3].to_string()))
}

fn find_lockfile(state: &AppState) -> Option<(String, String)> {
    let known = state.lockfile.lock().unwrap().clone();
    if let Some(found) = known.as_ref().and_then(read_lockfile) {
        return Some(found);
    }
    let mut candidates = Vec::new();
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
    );
    for p in sys.processes_by_exact_name("LeagueClientUx.exe".as_ref()) {
        if let Some(dir) = p.exe().and_then(|e| e.parent()) {
            candidates.push(dir.join("lockfile"));
        }
    }
    for drive in ["C", "D", "E", "F", "G", "H"] {
        candidates.push(PathBuf::from(format!("{drive}:\\Riot Games\\League of Legends\\lockfile")));
    }
    for path in candidates {
        if let Some(found) = read_lockfile(&path) {
            *state.lockfile.lock().unwrap() = Some(path);
            return Some(found);
        }
    }
    None
}

async fn lcu_get(client: &reqwest::Client, port: &str, password: &str, path: &str) -> Option<Value> {
    client
        .get(format!("https://127.0.0.1:{port}{path}"))
        .basic_auth("riot", Some(password))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()
}

/// Client region code -> Riot API platform.
fn platform_from_region(region: &str) -> Option<&'static str> {
    Some(match region.to_uppercase().as_str() {
        "EUW" | "EUW1" => "euw1",
        "EUNE" | "EUN1" => "eun1",
        "NA" | "NA1" => "na1",
        "KR" => "kr",
        "BR" | "BR1" => "br1",
        "LAN" | "LA1" => "la1",
        "LAS" | "LA2" => "la2",
        "OCE" | "OC1" => "oc1",
        "TR" | "TR1" => "tr1",
        "RU" => "ru",
        "JP" | "JP1" => "jp1",
        "ME" | "ME1" => "me1",
        "SG" | "SG2" => "sg2",
        "TW" | "TW2" => "tw2",
        "VN" | "VN2" => "vn2",
        _ => return None,
    })
}

/// Who is logged in to the League client and what they're doing.
/// None when the client isn't running. Uses no Riot API requests.
#[tauri::command]
async fn client_status(state: tauri::State<'_, AppState>) -> Result<Option<ClientStatus>, String> {
    let Some((port, pw)) = find_lockfile(&state) else {
        return Ok(None);
    };
    let c = &state.lcu;
    let (phase, me, platform_id, region) = futures::join!(
        lcu_get(c, &port, &pw, "/lol-gameflow/v1/gameflow-phase"),
        lcu_get(c, &port, &pw, "/lol-summoner/v1/current-summoner"),
        lcu_get(c, &port, &pw, "/lol-platform-config/v1/namespaces/LoginDataPacket/platformId"),
        lcu_get(c, &port, &pw, "/riotclient/region-locale"),
    );
    let Some(phase) = phase else {
        return Ok(None);
    };
    let riot_id = me.and_then(|m| {
        let (name, tag) = (text(&m["gameName"]), text(&m["tagLine"]));
        (!name.is_empty() && !tag.is_empty()).then(|| format!("{name}#{tag}"))
    });
    let platform = platform_id
        .as_ref()
        .and_then(|v| v.as_str())
        .and_then(platform_from_region)
        .or_else(|| region.as_ref().and_then(|r| r["region"].as_str()).and_then(platform_from_region))
        .map(String::from);
    Ok(Some(ClientStatus {
        phase: phase.as_str().unwrap_or_default().to_string(),
        riot_id,
        platform,
    }))
}

/* ---------- Settings and updates ---------- */

#[tauri::command]
fn app_info(app: AppHandle) -> Value {
    let key = find_key();
    let (cached_matches, cache_bytes) = cache_usage();
    json!({
        "version": app.package_info().version.to_string(),
        "cachedMatches": cached_matches,
        "cacheBytes": cache_bytes,
        "keySource": key.as_ref().map(|k| k.1),
        "keyHint": key.map(|(k, _)| {
            let tail: String = k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
            format!("…{tail}")
        }),
    })
}

/// Save (or, when empty, remove) the key typed into Settings.
#[tauri::command]
fn save_key(key: String) -> Result<(), String> {
    let file = key_file().ok_or("Couldn't find the app's settings folder.")?;
    if key.trim().is_empty() {
        let _ = std::fs::remove_file(&file);
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't save the key: {e}"))?;
    }
    std::fs::write(&file, key.trim()).map_err(|e| format!("Couldn't save the key: {e}"))
}

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Couldn't check for updates: {e}"))?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone(),
    }))
}

/// Download, install and restart into the newest release.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Couldn't check for updates: {e}"))?
        .ok_or("RiftLens is already up to date.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("The update failed: {e}"))?;
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            let _ = APP.set(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_profile,
            get_more_matches,
            get_ranks,
            get_static,
            client_status,
            app_info,
            save_key,
            clear_cache,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
