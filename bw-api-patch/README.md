# BW API patch (classic SAP BW, not BW/4HANA)

The ABAP code that a classic SAP BW system (SAP BW 7.x, standalone or embedded in S/4HANA, such as
SAP_BW 758) needs so that bw-mcp can work with it, and an installer
that puts it in place. Nothing here is needed on BW/4HANA: the installer detects the release and
stops there.

| Part | File | Needed for | Installed by |
|---|---|---|---|
| Accept header enhancement: post-exit on `CL_RSO_RES_RESOURCE=>GET_REQUEST_PROPERTIES` | [abap/accept_header.post-exit.abap](abap/accept_header.post-exit.abap) | **Required.** Without it, almost every BW modeling call fails with HTTP 406 | Hand, in SE24 (step 1). The installer only checks it |
| `ZCL_BWMCP_DTP_FILTER`: reads a DTP filter through the BW API and returns it as JSON | [abap/zcl_bwmcp_dtp_filter.abap](abap/zcl_bwmcp_dtp_filter.abap) | Optional: DTP filters, filter routines, semantic groups, package sizes | Installer (ADT) |
| `ZCL_BWMCP_HTTP`: `IF_HTTP_EXTENSION`, answers `GET` with that JSON | [abap/zcl_bwmcp_http.abap](abap/zcl_bwmcp_http.abap) | Same | Installer (ADT) |
| ICF service `/sap/bc/zbwmcp`, handler `ZCL_BWMCP_HTTP`, no logon data | created by [abap/zcl_bwmcp_install.abap](abap/zcl_bwmcp_install.abap) | Same | Installer: temporary class, run once through ADT classrun, then deleted |

Everything else bw-mcp reads on a classic release needs no ABAP. That includes transformations,
DTPs, process chains, classic providers, InfoPackages, analysis processes and the 3.x data flow
(update rules, transfer rules, 3.x DataSources and InfoSources). They are read from the metadata
tables through the ADT DataPreview service.

The helper classes are read-only and run as the calling user, so BW authorisations apply
unchanged. The background, the root cause of the 406 and the endpoint contract are in
[modeling-mcp/bw/bw75/README.md](../modeling-mcp/bw/bw75/README.md) and `BW75-SUPPORT.md` next to it.

## Running it

The main build runs it when SAP BW is the source (`npm run build`). The connection is the one
bw-mcp uses, from `.destination.properties` and `credentials.ini`.

- **On a terminal**, the build asks once, together with the source and target questions, whether to
  install missing parts. The default is yes.
- **Unattended** (`--yes`, CI, piped input), the build only checks and reports, unless
  `--install-bw-patch` is given.
- If the check cannot reach BW, the build reports it and carries on. The MCP server is configured
  either way.

On its own:

```
npm run bw-api-patch                       # check, show the plan, ask before changing anything
node bw-api-patch/install.mjs --check      # check only
node bw-api-patch/install.mjs --yes        # check and install without asking
```

Each part is checked first, and only what is missing or outdated is installed:

```
BW API patch on https://host:44300 (client 100, user ...), classic SAP BW:
  [ok      ] Accept header enhancement (post-exit on CL_RSO_RES_RESOURCE) — the Accept header is read
  [missing ] ZCL_BWMCP_DTP_FILTER — create in $TMP and activate
  [outdated] ZCL_BWMCP_HTTP — update to the bundled source and activate
  [missing ] ICF service /sap/bc/zbwmcp — not found (HTTP 404); create and activate it
```

A class is "outdated" when its active source differs from the file here, which is how a new
version of the bundle reaches the system. After installing, the installer checks everything again
and fails if a part is still missing.

| Variable | Default | Meaning |
|---|---|---|
| `BW_PATCH_PACKAGE` | `$TMP` | Package of the classes and the ICF node. `$TMP` is local: nothing can be transported |
| `BW_PATCH_TRANSPORT` | — | Transport request; required for any package that is not a local `$` package |
| `BW_HELPER_PATH` | `/sap/bc/zbwmcp` | Where bw-mcp looks for the helper; checked at the same path |

The user needs ADT developer authorisation (S_DEVELOP for class creation and activation) and the
authorisation to create ICF services (S_ICF_ADM). For a landscape with transports, install into
the development system with a package and request, then move the request like any other custom
development. The ICF node is created without a transport prompt, so add `R3TR SICF` for `ZBWMCP`
to the request by hand. Check the service in each follow-on system; ICF activation does not
reliably travel with a transport.

## Step 1: the Accept header enhancement (by hand)

Class pre/post exits cannot be created over ADT, so this one stays manual. It is an
enhancement, not a modification: no SSCR key, nothing to adjust on upgrade, removable at any time.

1. Transaction **SE24**, open `CL_RSO_RES_RESOURCE`, **Display**.
2. **Class → Enhance** (`Ctrl+F4`). Create an enhancement implementation, e.g. `Z_RSO_RES_HDR_CASE`.
3. Tab **Methods**, select `GET_REQUEST_PROPERTIES`. **Edit → Enhancement Operations → Create Post-Method**.
4. Double-click the generated `IPO_GET_REQUEST_PROPERTIES` and paste the body of
   [abap/accept_header.post-exit.abap](abap/accept_header.post-exit.abap).
5. **Activate** (`Ctrl+F3`), then run `npm run bw-api-patch`. The first line must read `[ok]`.

If the post-method entry is greyed out, use the pre-exit fallback on
`CL_RSO_RES_CNT_TYPE_HANDLER->IS_REQUEST_COMPATIBLE` described in
[modeling-mcp/bw/bw75/README.md](../modeling-mcp/bw/bw75/README.md#fallback-if-the-post-method-cannot-be-created).

## Rolling back

Deactivate and delete the SICF node `default_host/sap/bc/zbwmcp`, then delete `ZCL_BWMCP_HTTP`
and `ZCL_BWMCP_DTP_FILTER`. If they are in a transportable package, record the deletion on a
request. Remove the post-method in SE24, or the enhancement implementation in SE19. SAP
standard is never touched.
