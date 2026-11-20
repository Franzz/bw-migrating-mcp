# BW MCP Migration Server

This app lets an agent read a SAP BW system through the modified
[bw-modeling-mcp](https://github.com/Franzz/bw-modeling-mcp/tree/bw-migration) server.

Access is read-only, and the server certificate is checked against the BW root CA `rootca.pem`.

## Setup

1. **MCP servers:** run the build. It asks for the migration source and target, sets up their MCP servers and writes `.mcp.json` (not tracked in git).

   ```bash
   npm run build
   ```

   | Question | Choices | MCP server |
   |---|---|---|
   | Migration source | SAP BW | `bw-mcp`: the build clones the `bw-migration` branch of [Franzz/bw-modeling-mcp](https://github.com/Franzz/bw-modeling-mcp) into `modeling-mcp/bw` (or updates that checkout), then installs and builds it; also installs the audit and modeling app dependencies (`npm --prefix bw-audit install`, `npm --prefix modeling install`), and checks the [BW API patch](bw-api-patch/README.md) in the BW system (step 4) |
   | Migration target | Microsoft Fabric | `fabric-mcp`: Microsoft's official Fabric MCP server. The build clones the `main` branch of [Franzz/fabric-modeling-mcp](https://github.com/Franzz/fabric-modeling-mcp) into `modeling-mcp/fabric` (or updates that checkout), then runs its own build, which installs the server and sets up the Microsoft sign-in (the Azure CLI in `modeling-mcp/fabric/.venv`, or VS Code's sign-in on Windows), see [modeling-mcp/fabric/README.md](modeling-mcp/fabric/README.md) |
   | Migration target | SAP Datasphere | `datasphere-mcp`: fetches [datasphere-modeling-mcp](https://github.com/Franzz/datasphere-modeling-mcp) into `modeling-mcp/datasphere` and runs its build, which installs SAP's official Datasphere CLI and the custom modeling MCP. Configure the tenant and OAuth sign-in as described in [modeling-mcp/datasphere/README.md](modeling-mcp/datasphere/README.md). |
   | Migration target | Snowflake + dbt | `snowflake-dbt-mcp`: the independent repo in `modeling-mcp/snowflake-dbt`. Its build uses uv/Python 3.12 to install dbt Core, the Snowflake adapter and the custom MCP into a local `.venv`. Maps BW storage to Snowflake and transformations to dbt. See [modeling-mcp/snowflake-dbt/README.md](modeling-mcp/snowflake-dbt/README.md). |
   | | Databricks, Google BigQuery | none yet: nothing is added to `.mcp.json` |

   Press Enter to keep the current choice. Without a terminal, or with `npm run build -- --yes`, the current choices are kept without asking. Servers you add to `.mcp.json` by hand are kept.

   To select Snowflake/dbt directly: `npm run build -- --yes --target=snowflake-dbt`.
   Other target flags are `fabric`, `datasphere`, `databricks` and `bigquery`.

   The folders under `modeling-mcp/` are ignored by this parent repository and managed as independent git repositories. The BW, Fabric and Datasphere checkouts are cloned or fast-forwarded by the build; prepare `snowflake-dbt/` locally before selecting it, or set `SNOWFLAKE_DBT_MCP_REPO`.

2. **Connection details:** copy `.destination.properties` from the Eclipse ADT/BWMT project of the system. Eclipse writes it when the project is created, at:

   `~/eclipse-workspace/.metadata/.plugins/org.eclipse.core.resources.semantic/.cache/<project>/.destination.properties`

   Once copied, Eclipse is no longer needed. If the file is missing here, the launcher falls back to the Eclipse workspace (`BW_ECLIPSE_WORKSPACE`, `BW_ECLIPSE_PROJECT`).

3. **Credentials:** copy `credentials.example.ini` to `credentials.ini` and fill in your SAP user and password. Keep it private (`chmod 600 credentials.ini`).

4. **BW API patch (classic SAP BW only, not BW/4HANA):** a classic BW system needs some ABAP before bw-mcp can work with it. All of it is in [bw-api-patch](bw-api-patch/README.md), with an installer. The build checks it when SAP BW is the source. On a terminal it asks whether to install the missing parts (default yes); unattended it only reports them, unless you pass `npm run build -- --yes --install-bw-patch`. The Accept header enhancement has to be created by hand in SE24, and the installer tells you whether it is in place. The check needs the connection from steps 2 and 3. On a first build, before those files exist, it reports that it could not connect and the build carries on. Run it later on its own:

   ```bash
   npm run bw-api-patch
   ```

5. **Agents:** The agent opens this folder (tested with Claude Code). Approve the servers when asked and check them with `/mcp`. After a new build, restart the agent (in VS Code: **Developer: Reload Window**) so it loads the new `.mcp.json`.

   For Codex, register the same launcher in its shared CLI/IDE configuration:

   ```bash
   codex mcp add bw-mcp --env BW_STDIO_SCOPES=read -- node "$PWD/start-bw-mcp.mjs"
   ```

   Run this from the project root, then restart the Codex extension to load the
   server. `.mcp.json` alone does not configure Codex. See the
   [Codex MCP setup guide](https://developers.openai.com/codex/mcp).

## Apps

| App | Start | What it does |
|---|---|---|
| [BW audit](bw-audit/README.md) | `npm run bw-audit-start`, http://localhost:5180 | Reads the BW system and scores how hard each object is to migrate. Writes `bw-audit/data/`. |
| [BW modeling](modeling/README.md) | `npm run modeling-start`, http://localhost:5181 | After the audit: converts the BW data models in scope into a technology-agnostic dbt project in `modeling/data/<project>/`, and checks it. |

## Options

Set these under `env` of `bw-mcp` in `.mcp.json`. Variables set there win over the files, and a new build keeps them.

| Variable | Default | Effect |
|---|---|---|
| `BW_STDIO_SCOPES` | `read` | `write` also offers the tools that create, change, activate or delete objects |
| `BW_TOOL_MODE` | `focused` | Version 2 groups operations under `bw_read`, `bw_find`, etc.; `full` offers individual tools |
| `BW_MCP_DIR` | `modeling-mcp/bw` | Folder of the built server (also read by `npm run build`) |
| `BW_CA_FILE` | `rootca.pem` | CA bundle used to verify the server certificate |
| `BW_URL`, `BW_CLIENT`, `BW_LANGUAGE` | from `.destination.properties` | Override the connection details |

With the v2 focused surface, `bw_describe` returns the parameters of each
operation. On classic BW, read transformations and DTPs with `bw_find`,
`operation=metadata_tables`, `object_type=TRFN` or `DTPA`, and the 3.x data flow with
`object_type=UPDR` (update rules), `ISTS` (transfer rules), `ISFS` (3.x DataSources) or
`ISTD` (3.x InfoSources); `object_name="*"` lists each with its version. `bw_find` with
`operation=dtps` lists a transformation's dependent DTPs. The server hides direct
REST reads when the BW system does not publish those resources.

### Build options

Set these in the environment of `npm run build`. Each checkout is cloned on the first build and fast-forwarded on later builds; local commits or uncommitted changes in a checkout are never discarded, git stops instead.

| Variable | Default | Effect |
|---|---|---|
| `BW_MCP_DIR` | `modeling-mcp/bw` | Folder of the BW server checkout |
| `BW_MCP_REPO` | [Franzz/bw-modeling-mcp](https://github.com/Franzz/bw-modeling-mcp) | Repository of the BW server |
| `BW_MCP_BRANCH` | `bw-migration` | Branch of the BW server |
| `FABRIC_MCP_DIR` | `modeling-mcp/fabric` | Folder of the Fabric server checkout |
| `FABRIC_MCP_REPO` | [Franzz/fabric-modeling-mcp](https://github.com/Franzz/fabric-modeling-mcp) | Repository of the Fabric server |
| `FABRIC_MCP_BRANCH` | `main` | Branch of the Fabric server |
| `FABRIC_SIGN_IN` | chosen by the Fabric build | `azcli` or `vscode`, see [modeling-mcp/fabric/README.md](modeling-mcp/fabric/README.md) |
| `DATASPHERE_MCP_DIR` | `modeling-mcp/datasphere` | Folder of the Datasphere server checkout |
| `DATASPHERE_MCP_REPO` | [Franzz/datasphere-modeling-mcp](https://github.com/Franzz/datasphere-modeling-mcp) | Repository of the Datasphere server |
| `DATASPHERE_MCP_BRANCH` | `main` | Branch of the Datasphere server |
| `SNOWFLAKE_DBT_MCP_DIR` | `modeling-mcp/snowflake-dbt` | Folder of the independent Snowflake/dbt MCP repo |
| `SNOWFLAKE_DBT_MCP_REPO` | unset | Optional remote URL; otherwise build the existing local checkout |
| `SNOWFLAKE_DBT_MCP_BRANCH` | `main` | Branch used when `SNOWFLAKE_DBT_MCP_REPO` is set |
| `SNOWFLAKE_DBT_UV` | `uv` | uv executable used to install the isolated dbt/MCP environment |
| `BW_PATCH_PACKAGE` | `$TMP` | Package of the ABAP objects the BW API patch creates, see [bw-api-patch](bw-api-patch/README.md) |
| `BW_PATCH_TRANSPORT` | unset | Transport request for them; required for a package other than a local `$` package |

The Datasphere target enables `read,write` tools by default; create/update saves drafts unless a tool call sets `deploy=true`. Enable `execute` or `delete` separately if needed. Datasphere connection settings stay in its ignored `datasphere.config.json`, or can be supplied through `DATASPHERE_*` environment variables. See its README for all settings and tool scopes.

The Snowflake/dbt target enables local planning and artifact writing (`read,write`)
by default. Add `execute` to `SNOWFLAKE_DBT_SCOPES` for warehouse deployment and dbt
runs. Configure credentials in `modeling-mcp/snowflake-dbt/.env` using its example;
SAP credentials remain separate. VS Code settings use its dbt environment with
the existing Power User extension. Tasks prepare and parse the bundled example.
Data extraction/loading, ABAP routines and BW delta semantics require explicit
conversion; the MCP reports blockers before generating an executable project.
