# BW migration audit

A local web interface that audits the SAP BW system through `bw-mcp` and scores how hard each object would be to migrate to another data platform. It includes a Claude chat for follow-up analysis.

The chat can query the audit snapshot and read the live BW system with the same read-only `bw-mcp` tools.

## Run

The main `npm run build` installs the audit app dependencies when SAP BW is selected
as the migration source. After completing that setup:

```bash
cd bw-audit
npm start               # http://localhost:5180
```

To serve the app at `http://bw-audit.localhost` with nginx or Apache and manage
it with systemd, use the [site and service configuration](config/README.md).

Click **Run audit** in the page, or run `npm run audit` from the terminal. A run takes about 3 minutes on this system. It writes `data/latest.json`, plus a timestamped copy for comparing runs.

Setup prerequisites:

- the parent repository is set up: `npm run build`, `.destination.properties` and `credentials.ini`;
- `bw-mcp` works with `/mcp`.

The app starts its own `bw-mcp` process through `../start-bw-mcp.mjs`, always with `BW_STDIO_SCOPES=read`.

## What it reads

| Area | Source |
|---|---|
| System | `bw_find system_profile` |
| Inventory | `bw_find search` per object type, `source_systems`, `afo_workbooks`, `RSPCLOG *` |
| Providers | `bw_read adso` and `hcpr`, plus `metadata_tables` for CUBE, ODSO and MPRO (structure, parts, load history) |
| Logic | `metadata_tables TRFN`: routines, ABAP code and rule types |
| Orchestration | `metadata_tables RSPC`: steps |
| Reporting | `bw_read query` and `variable` for customer objects |

## Scoring

Difficulty runs from 1 (lift and shift) to 5 (redesign). Each score lists its reasons in the page. The base rules are platform-agnostic and live in [lib/score.mjs](lib/score.mjs).

- **Target.** The **Migration target** radio buttons pick the platform the scores are computed for: Generic platform (the platform-agnostic rules alone), Microsoft Fabric, Snowflake + dbt, SAP Datasphere or Google BigQuery. A target adds its own adjustments on top of the generic score, each listed as a reason prefixed with the target name, and can reword findings. The adjustments live in [lib/targets.mjs](lib/targets.mjs). Switching target re-scores the saved snapshot without reading BW again; the chat uses the selected target too. From the terminal: `npm run audit -- --target=fabric` (or `snowflake-dbt`, `datasphere`, `bigquery`).

- **Index.** The complexity index (0–100) weights each area by importance and by its object count. The count is log-damped, so 300 queries don't outweigh 10 ABAP routines.
- **SAP content.** SAP-delivered objects are excluded by default; use **Include SAP content** to add them. An object counts as SAP content if it uses the `0*` or `/XXX/` namespaces (but not `/BIC/`), or was created or changed by user `SAP`.
- **Decommission candidates.** Objects flagged never loaded, never run or inactive.
- **aDSO load history.** Not used. On this release aDSO requests are not in the request store the metadata read covers, so "no requests" is not evidence of an unused aDSO.

## Chat

The chat picks its route when the server starts. The server log and the chat panel say which one is active.

| Route | When | Credentials |
|---|---|---|
| **Claude Code** (headless `claude -p`) | no API key set (default here) | your own Claude login |
| **Claude API** | `ANTHROPIC_API_KEY` in `.env` | API key, billed to the API account |

Set `CHAT_BACKEND=api` or `CHAT_BACKEND=claude-code` to force a route.

**Claude Code route.** The server looks for the binary in this order:

1. `CLAUDE_CODE_BIN`;
2. `claude` on the `PATH`;
3. the newest binary bundled with the VS Code extension.

The bundled binary shares your Claude Code sign-in, so nothing else is needed. Each chat turn runs one Claude Code process, resumed with `--resume` so the conversation continues. The process is locked down:

- no built-in tools (`--tools ""`): no shell, files or web;
- only two MCP servers (`--strict-mcp-config`):
  - `bw-mcp`, read scope, started with the same launcher;
  - `audit`, which serves `audit_query` ([lib/audit-mcp.mjs](lib/audit-mcp.mjs));
- only the read tools pre-approved; anything else is refused (`--permission-mode dontAsk`);
- run from `data/claude-code/`, so no project settings or `CLAUDE.md` apply.

A first turn takes about 20 seconds, because Claude Code starts `bw-mcp` for each turn. Follow-ups without tool calls take about 5 seconds.

This route is for your own use only. A personal Claude login must not serve other people's requests: switch to an API key before you share the page.

**API route.** The server runs a streaming tool loop on the Messages API with `claude-opus-5-5` (override with `CLAUDE_MODEL`). The request also sets:

- server-side refusal fallback (`fallbacks: "default"`);
- `effort: high`;
- prompt caching.

Conversations are kept in server memory.

**Data sent to Anthropic, on both routes:**

- the audit summary;
- your messages;
- every tool result: BW metadata and ABAP code, and, if Claude calls `bw_data preview_datasource`, sample rows from the source system.

## Security

The server binds to `127.0.0.1` only and refuses cross-origin requests. It has no login, and it acts with the SAP user in `credentials.ini`.

## Tests

```bash
npm test
```

The tests cover the parsers and scoring rules, using output captured from `bw-mcp`.
