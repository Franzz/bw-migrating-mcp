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
   | Migration source | SAP BW | `bw-mcp`: the build clones the `bw-migration` branch of [Franzz/bw-modeling-mcp](https://github.com/Franzz/bw-modeling-mcp) into `modeling-mcp/bw` (or updates that checkout), then installs and builds it |
   | Migration target | Microsoft Fabric | `fabric-mcp`: Microsoft's official Fabric MCP server. The build clones the `main` branch of [Franzz/fabric-modeling-mcp](https://github.com/Franzz/fabric-modeling-mcp) into `modeling-mcp/fabric` (or updates that checkout), then runs its own build, which installs the server and sets up the Microsoft sign-in (the Azure CLI in `modeling-mcp/fabric/.venv`, or VS Code's sign-in on Windows), see [modeling-mcp/fabric/README.md](modeling-mcp/fabric/README.md) |
   | | Snowflake, Databricks, Google BigQuery | none yet: nothing is added to `.mcp.json` |

   Press Enter to keep the current choice. Without a terminal, or with `npm run build -- --yes`, the current choices are kept without asking. Servers you add to `.mcp.json` by hand are kept.

2. **Connection details:** copy `.destination.properties` from the Eclipse ADT/BWMT project of the system. Eclipse writes it when the project is created, at:

   `~/eclipse-workspace/.metadata/.plugins/org.eclipse.core.resources.semantic/.cache/<project>/.destination.properties`

   Once copied, Eclipse is no longer needed. If the file is missing here, the launcher falls back to the Eclipse workspace (`BW_ECLIPSE_WORKSPACE`, `BW_ECLIPSE_PROJECT`).

3. **Credentials:** copy `credentials.example.ini` to `credentials.ini` and fill in your SAP user and password. Keep it private (`chmod 600 credentials.ini`).

4. **Agents:** The agent opens this folder (tested with Claude Code). Approve the servers when asked and check them with `/mcp`. After a new build, restart the agent (in VS Code: **Developer: Reload Window**) so it loads the new `.mcp.json`.

## Options

Set these under `env` of `bw-mcp` in `.mcp.json`. Variables set there win over the files, and a new build keeps them.

| Variable | Default | Effect |
|---|---|---|
| `BW_STDIO_SCOPES` | `read` | `write` also offers the tools that create, change, activate or delete objects |
| `BW_MCP_DIR` | `modeling-mcp/bw` | Folder of the built server (also read by `npm run build`) |
| `BW_CA_FILE` | `rootca.pem` | CA bundle used to verify the server certificate |
| `BW_URL`, `BW_CLIENT`, `BW_LANGUAGE` | from `.destination.properties` | Override the connection details |

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
