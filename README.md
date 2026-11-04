# BW MCP Migration Server

This app lets an agent read a SAP BW system through the modified
[bw-modeling-mcp](https://github.com/Franzz/bw-modeling-mcp/tree/bw-migration) server.

Access is read-only, and the server certificate is checked against the BW root CA `rootca.pem`.

## Setup

1. **BW MCP Server**

   Run the build. It clones the `bw-migration` branch of [Franzz/bw-modeling-mcp](https://github.com/Franzz/bw-modeling-mcp) into `../bw-modeling-mcp` (next to this folder), or updates that checkout if it exists, then installs and builds it.

   ```bash
   npm run build
   ```

2. **Connection details:** copy `.destination.properties` from the Eclipse ADT/BWMT project of the system. Eclipse writes it when the project is created, at:

   `~/eclipse-workspace/.metadata/.plugins/org.eclipse.core.resources.semantic/.cache/<project>/.destination.properties`

   Once copied, Eclipse is no longer needed. If the file is missing here, the launcher falls back to the Eclipse workspace (`BW_ECLIPSE_WORKSPACE`, `BW_ECLIPSE_PROJECT`).

3. **Credentials:** copy `credentials.example.ini` to `credentials.ini` and fill in your SAP user and password. Keep it private (`chmod 600 credentials.ini`).

4. **Agents:** The agent opens this folder (tested with Claude Code), approve the `bw-mcp` server when asked, and check it with `/mcp`.

## Options

Set these under `env` in `.mcp.json`. Variables set there win over the files.

| Variable | Default | Effect |
|---|---|---|
| `BW_STDIO_SCOPES` | `read` | `write` also offers the tools that create, change, activate or delete objects |
| `BW_MCP_DIR` | `../bw-modeling-mcp` | Folder of the built server (also read by `npm run build`) |
| `BW_CA_FILE` | `rootca.pem` | CA bundle used to verify the server certificate |
| `BW_URL`, `BW_CLIENT`, `BW_LANGUAGE` | from `.destination.properties` | Override the connection details |
