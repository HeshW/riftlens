# RiftLens

A desktop League of Legends stats app (op.gg / leagueofgraphs style) by LegacyTech, built with
Tauri: a Rust backend that calls the Riot API, and a plain HTML/CSS/JS frontend styled with the
LegacyTech design system.

## Features

- **Search** a Riot ID (`Name#TAG`) and region, with recent searches and favourites (star a
  profile to pin it).
- **Profile**: Solo/Duo and Flex rank with emblems, level, champion mastery.
- **Overview**: win rate, average KDA, kill participation, CS/min, roles, top champions and
  players you often queue with, all following the **queue filter** (All, Solo/Duo, Flex,
  Normal, ARAM, Other).
- **Match history**: champion, spells, runes, KDA, KP, CS, vision, items, both teams, and
  badges (multikills, Top damage, Best KDA, First blood). Expand a game for the full scoreboard.
  Click any name to open that player. "Load more games" pages 10 at a time.
- **Champions tab**: every champion played in the loaded games; pick one for its win rate,
  core items, runes and spells, lane matchups and recent games.
- **Live game**: all 10 players with champions, spells, runes, bans and Solo/Duo rank.
- **Tooltips** on items, runes and summoner spells.
- **League client auto-detect**: when the League client is running, RiftLens shows who's logged
  in and what they're doing, opens your profile on launch and switches to your live game when
  it starts (both can be turned off in Settings). Uses the client's local API; no Riot API
  requests.
- **Settings**: Riot API key, window size, default region, animations, client options, updates.
- **Fixed 16:9 window** like the League client (1024×576 to 1920×1080). The layout is drawn at
  1280×720 and scaled.
- **Auto-updates** from GitHub Releases.
- **Full history in the background**: the first 10 games show right away, then RiftLens keeps
  loading older games (all available by default, or the last 20/50/100 in Settings) so the
  Overview and Champions stats cover the whole history. The match list grows as you scroll.
- **Saved matches**: finished games are saved to disk (`%LOCALAPPDATA%\me.legacytech.riftlens`),
  so opening a profile again only fetches new games. Settings shows the size and can clear it.
- Rate limits: when Riot's limit is hit, RiftLens waits it out and continues instead of failing.

## Install

Download `RiftLens_x.y.z_x64-setup.exe` from the
[latest release](https://github.com/HeshW/riftlens/releases/latest) and run it. Then open
Settings (gear, top right) and paste your Riot API key. Installed copies check for updates on
launch and update themselves.

The key typed in Settings is saved in the app's config folder
(`%APPDATA%\me.legacytech.riftlens\riot_api_key.txt`), never in the repo.

## Develop

1. Paste your key in Settings, or copy `.env.example` to `.env` and paste it after
   `RIOT_API_KEY=`. The Settings key always wins; `.env` is only read by dev builds. Development keys expire every 24 hours; the app
   re-reads the key on every search.
2. `npm install`
3. `npm run tauri dev`

Needs Rust, Node and the Windows WebView2 runtime.

## Release a new version

1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Commit, then tag and push: `git tag v0.3.0 && git push origin main --tags`.
3. GitHub Actions (`.github/workflows/release.yml`) builds the installer, signs the update and
   publishes the release with `latest.json`. Installed apps pick it up on next launch.

Update signing uses the key pair in `~/.tauri/riftlens.key` (private; stored as the
`TAURI_SIGNING_PRIVATE_KEY` repo secret) and the public key in `tauri.conf.json`. Losing the
private key means existing installs can't verify future updates, so back it up.

## How it fits together

- `src-tauri/src/lib.rs`: Tauri commands
  - Riot API: `get_profile`, `get_more_matches`, `get_ranks`, `get_static` (Data Dragon
    champions, items, spells, runes)
  - League client: `client_status`
  - Settings and updates: `app_info`, `save_key`, `check_update`, `install_update`
- `src/`: `index.html`, `main.js` (UI and state), `styles.css` (design tokens, fixed frame),
  `fonts/` (bundled Oxanium and Manrope, OFL).
- Images: Data Dragon (champions, items, spells, runes, profile icons) and CommunityDragon
  (rank emblems).

## Limits

- A development or personal key allows 100 requests per 2 minutes. A fresh profile costs about
  16 calls, opening a live game about 10, and the full history about one call per game (around
  20 minutes for 1,000 games the first time; saved matches make later visits fast).
- Riot's policy says development keys aren't for public products. Releases are public so the
  updater can reach them, but each user needs their own key. Before promoting RiftLens, move
  the key to a small server and apply for a production key.
- Champion stats, builds and matchups only cover the games loaded in the app. Tier lists and
  LP graphs need a server that collects matches over time.
