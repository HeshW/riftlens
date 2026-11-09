// RiftLens backend: talks to the Riot API with the key from .env and hands
// the frontend ready-to-draw data (profile, matches, live game, static data).
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

const MATCH_PAGE: usize = 10;
const NOT_FOUND: &str = "NOT_FOUND";

#[derive(Default)]
struct AppState {
    http: reqwest::Client,
    // Finished matches never change, so keep them for the life of the app.
    match_cache: Mutex<HashMap<String, Value>>,
    statics: Mutex<Option<Value>>,
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

/// Read the key from .env on every request, so a fresh development key
/// works without restarting the app.
fn api_key() -> Result<String, String> {
    if let Ok(iter) = dotenvy::from_filename_iter(".env") {
        for (k, v) in iter.flatten() {
            if k == "RIOT_API_KEY" && !v.trim().is_empty() {
                return Ok(v.trim().to_string());
            }
        }
    }
    std::env::var("RIOT_API_KEY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            "No API key yet. Put RIOT_API_KEY=<your key> in the .env file in the riftlens folder."
                .to_string()
        })
}

async fn riot_get(http: &reqwest::Client, url: &str) -> Result<Value, String> {
    let res = http
        .get(url)
        .header("X-Riot-Token", api_key()?)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Riot: {e}"))?;
    match res.status().as_u16() {
        200 => res
            .json()
            .await
            .map_err(|e| format!("Riot sent something unexpected: {e}")),
        401 | 403 => Err("Riot rejected the API key. Development keys expire every 24 hours: \
                         paste a fresh one into .env and search again."
            .into()),
        404 => Err(NOT_FOUND.into()),
        429 => {
            let wait = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("a few")
                .to_string();
            Err(format!("Riot's rate limit was hit. Try again in {wait} seconds."))
        }
        s => Err(format!("Riot API error {s}. Try again in a moment.")),
    }
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

async fn get_match(state: &AppState, region: &str, id: &str) -> Result<Value, String> {
    let cached = state.match_cache.lock().unwrap().get(id).cloned();
    if let Some(m) = cached {
        return Ok(m);
    }
    let url = format!("https://{region}.api.riotgames.com/lol/match/v5/matches/{id}");
    let m = riot_get(&state.http, &url).await?;
    state
        .match_cache
        .lock()
        .unwrap()
        .insert(id.to_string(), m.clone());
    Ok(m)
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
) -> Result<MatchPage, String> {
    let url = format!(
        "https://{region}.api.riotgames.com/lol/match/v5/matches/by-puuid/{puuid}/ids?start={start}&count={MATCH_PAGE}"
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
        has_more: ids.len() == MATCH_PAGE,
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
        match_page(&state, match_region, &puuid, 0),
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
    state: tauri::State<'_, AppState>,
) -> Result<MatchPage, String> {
    let (_, match_region) = routing(&platform)?;
    match_page(&state, match_region, &puuid, start).await
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
    let (champ_url, spell_url, rune_url) = (
        format!("{data}/champion.json"),
        format!("{data}/summoner.json"),
        format!("{data}/runesReforged.json"),
    );
    let (champs, spells, runes) = futures::join!(
        ddragon_json(http, &champ_url),
        ddragon_json(http, &spell_url),
        ddragon_json(http, &rune_url),
    );

    let mut champions = serde_json::Map::new();
    for c in champs?["data"].as_object().into_iter().flat_map(|m| m.values()) {
        champions.insert(text(&c["key"]), json!({ "id": c["id"], "name": c["name"] }));
    }
    let mut spell_map = serde_json::Map::new();
    for s in spells?["data"].as_object().into_iter().flat_map(|m| m.values()) {
        spell_map.insert(text(&s["key"]), json!({ "id": s["id"], "name": s["name"] }));
    }
    let mut rune_map = serde_json::Map::new();
    for style in runes?.as_array().cloned().unwrap_or_default() {
        rune_map.insert(int(&style["id"]).to_string(), json!({ "name": style["name"], "icon": style["icon"] }));
        for slot in style["slots"].as_array().cloned().unwrap_or_default() {
            for r in slot["runes"].as_array().cloned().unwrap_or_default() {
                rune_map.insert(int(&r["id"]).to_string(), json!({ "name": r["name"], "icon": r["icon"] }));
            }
        }
    }

    let out = json!({ "version": v, "champions": champions, "spells": spell_map, "runes": rune_map });
    *state.statics.lock().unwrap() = Some(out.clone());
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_profile,
            get_more_matches,
            get_ranks,
            get_static
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
