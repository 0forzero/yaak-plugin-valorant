# yaak-plugin-valorant

Yaak plugin that ports the behavior of [`insomnia-plugin-valorant`](https://github.com/techchrism/insomnia-plugin-valorant) to Yaak.

## What It Includes

- Full template-function parity with the original Insomnia plugin, including the same function names used by the workspace export and compatibility aliases (`riot_xmpp`, `riot_xmpp_mitm`).
- Riot authentication workflow in Yaak: direct token extraction from local Riot client data when available, persisted web login session support, and explicit actions for login/logout/clearing saved auth state.
- Live local Valorant data helpers: lockfile parsing for local client auth (`lockfile_port`, `lockfile_password`), log scraping for PUUID/region/shard/client version fallbacks, and API-based fallback/refresh for auth, entitlements, PAS token, and region data.
- Match/party convenience functions with short-term caching for repeated calls (`pregame_match_id`, `current_game_match_id`, `party_id`).
- XMPP tooling: standard XMPP websocket proxy URL generation (`xmpp_websocket_url`) with raw, buffered, and JSON modes, plus MITM websocket mode (`xmpp_mitm_websocket_url`) that launches Riot Client through a rewritten client config path for packet inspection/testing.
- Insomnia workspace migration support: included pre-converted Yaak workspace file (`yaak-workspace-valorant.json`) and a converter script for Insomnia export v4 JSON to Yaak schema JSON, including request/folder structure and template syntax conversion.

## Template Functions

- `client_platform`
- `client_version`
- `lockfile_port`
- `lockfile_password`
- `puuid`
- `valorant_region`
- `valorant_shard`
- `valorant_token`
- `valorant_entitlement`
- `valorant_id_token`
- `valorant_pas_token`
- `pregame_match_id`
- `current_game_match_id`
- `party_id`
- `xmpp_websocket_url` (alias: `riot_xmpp`)
- `xmpp_mitm_websocket_url` (alias: `riot_xmpp_mitm`)

## Actions

- `Riot Login`
- `Riot Logout`
- `Remove Saved Valorant Data`

Actions are available in workspace, HTTP request, and websocket request action menus.

## Requirements

- Yaak desktop app
- Node.js 18+
- Windows (current implementation expects Riot/VALORANT Windows paths and uses Windows process/registry commands for MITM)

## Local Install (Yaak)

1. Install dependencies and build:

```bash
npm install
npm run build
```

2. In Yaak: `Settings -> Plugins -> Install from Directory` and select this project folder.
3. Enable the plugin.

## Import Workspace (Recommended)

A Yaak-ready workspace file is included:

- `yaak-workspace-valorant.json`

In Yaak: `Settings -> Import Data` and select that file.

## Convert the Insomnia Workspace (Not required)

If you want, you can run the converter script (Insomnia export format v4 JSON -> Yaak schema JSON):

```bash
npm run convert:workspace -- insomnia-workspace-valorant.json yaak-workspace-valorant.json
```

## XMPP Testing Notes

- `xmpp_websocket_url` (normal proxy): Riot Client can stay open.
- `xmpp_mitm_websocket_url` (MITM): close Riot Client first, then connect MITM websocket.

## Troubleshooting

- `Lockfile not found! Is Valorant running?`
  - Start VALORANT so Riot lockfile exists.
- Riot auth tags fail
  - Run `Riot Login` action again.

## Attribution

This project is a port/adaptation of:

- https://github.com/techchrism/insomnia-plugin-valorant

Original author: `techchrism` / `Techdoodle`.

## License

MIT. See `LICENSE`.

## Notice

This project isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
