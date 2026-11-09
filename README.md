# RiftLens

A desktop League of Legends stats app (op.gg / leagueofgraphs style) built with Tauri: a Rust
backend that calls the Riot API, and a plain HTML/CSS/JS frontend styled with the LegacyTech
design system.

## Features

- Search a Riot ID (`Name#TAG`) and region.
- Profile: Solo/Duo and Flex rank with emblems, level, champion mastery (top 5).
- Last games summary: win rate, average KDA, kill participation, CS/min, roles, top champions,
  players you often queue with.
- Compact match history: champion, spells, runes, KDA, KP, CS, vision, items and both teams.
  Expand a game for the full scoreboard (damage, gold, CS, wards, items). Click any name to open
  that player. "Load more games" pages 10 at a time.
- Live game tab: if the player is in a game, all 10 players with champions, spells, runes, bans
  and Solo/Duo rank.
- Fixed 16:9 window like the League client (1024×576, 1280×720, 1600×900, 1920×1080). The layout
  is drawn at 1280×720 and scaled to the chosen size.

## Setup

1. Copy `.env.example` to `.env` and paste your Riot key after `RIOT_API_KEY=`.
   Development keys expire every 24 hours; the app re-reads `.env` on every search, so just
   paste the new key, no restart needed.
2. `npm install`
3. `npm run tauri dev`

Needs Rust, Node and the Windows WebView2 runtime.

## How it fits together

- `src-tauri/src/lib.rs`: Tauri commands `get_profile`, `get_more_matches`, `get_ranks` (live
  game ranks) and `get_static` (Data Dragon champions, spells, runes). Matches are cached in
  memory for the life of the app.
- `src/`: `index.html`, `main.js` (calls the commands and renders), `styles.css` (design tokens,
  fixed 1280×720 frame).
- Images: Data Dragon (champions, items, spells, runes, profile icons) and CommunityDragon
  (rank emblems).

## Limits and next steps

- A development or personal key allows 100 requests per 2 minutes. A fresh profile costs about
  16 calls, "Load more" about 11, opening a live game about 10.
- Before releasing, the key must move to a small server, because a key shipped inside a desktop
  app can be extracted. Then apply for a production key.
- Tier lists, build stats and LP graphs need a server that collects matches over time.
- The app icons are still Tauri's defaults.
