# Fast Context for Pi

Fast Context is a semantic code search tool for Pi. It takes your search query and a compact map of the project, analyzes them with a remote model, then executes a series of commands locally to find relevant files and line ranges.

Unlike local-only search, Fast Context understands intent: "where is authentication handled?" returns relevant functions and call sites, not just grep matches. Results are deliberately lightweight: file paths, line ranges, and grep keywords. Pi should then use `read` for the exact code it needs.

Here's how it works: Fast Context sends your query and a hotspot repo map to Devin's hosted code-search backend over a **reverse-engineered** protocol; the backend plans a sequence of search commands that this extension then runs locally. You bring your own Devin API key — the free tier works, and paid tiers unlock additional models — and because the integration is unofficial, the backend can change or break it at any time without notice. Not affiliated with or endorsed by Pi or Devin.

Apart from that backend planning call, everything runs locally: it reuses Pi's built-in ripgrep, respects `.gitignore`, ranks likely hotspot directories locally, and runs all path operations in a strict sandbox.

## Installation & Update

```bash
pi install git:github.com/ming-kang/pi-fast-context
# or from a local checkout during development:
pi install ./pi-fast-context
```

A local checkout does not auto-run `npm install`, but that's fine — this package has zero runtime dependencies.

Update:

```bash
pi update --extensions                                # update all installed packages
pi update git:github.com/ming-kang/pi-fast-context    # update only this one
```

## Configuring your API key

Run `/fast-context` to open the key configuration dialog:

- Enter your API key and submit to save it
- Submit empty to delete a saved key
- Press Escape to cancel

The key is stored persistently in `~/.pi/agent/fast-context/config.json`, loaded on startup, and never passed to the model or written to session logs.

For headless/CI environments, set the `FAST_CONTEXT_KEY` environment variable instead. If not set, the tool will use the saved key from `config.json`.

Current Devin tokens look like `devin-session-token$<JWT>`. If you set that value through a shell or config file, quote or escape the `$`; otherwise variable expansion can silently truncate the key. Fast Context warns when it detects that shape, but it never reads Devin/Windsurf local databases or tries to recover keys automatically.

## Usage

Once you've set your key, the tool becomes available to the model. It's designed for exploratory search: when you don't know which files contain what you're looking for. For known symbols or filenames, use Pi's built-in `grep`, `read`, or `find` instead.

Results include paths, line ranges, and grep keywords only. Pi should use `read` with the returned paths and ranges when it needs the actual code.

In the TUI, you'll see real-time progress: authentication, building the repo map, and each planning/execution round. Results display collapsed by default (showing file count and grep keywords), and expand to show the full result envelope.

### Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | What code or behavior to find |
| `project_path` | string | cwd | Subdirectory to search within (must be inside cwd) |
| `tree_depth` | int 0-6 | 3 | Repo-map depth. `0` chooses automatically from project size. In hotspot mode, higher values deepen hotspot subtrees |
| `max_turns` | int 1-5 | 3 | Search rounds. More = deeper but slower |
| `max_results` | int 1-30 | 10 | Maximum files to return |
| `exclude_paths` | string[] | [] | Directories/files to exclude from the repo map |

## Security and Guarantees

The remote model plans commands, but execution is sandboxed locally. All security guarantees are enforced by this extension:

- **Path containment:** Every command path (rg, readfile, tree, ls, glob) is checked via `toReal` to ensure it stays within the current working directory. Checks are performed both on literal `..` sequences and after symlink resolution. Any out-of-bounds path is rejected with an error.
- **project_path is constrained:** Must resolve within cwd; defaults to cwd. Searches cannot escape the working directory.
- **Key storage:** Saved to `~/.pi/agent/fast-context/config.json` with mode 0600 (matching Pi's own credential format). Never logged in session transcripts or passed as a tool parameter.
- **No local credential extraction:** Does not attempt to read any local IDE databases or extract keys from other applications.
- **TLS not downgraded:** Network errors never trigger a fallback to insecure TLS modes.
- **Respects .gitignore:** Uses Pi's built-in grep, which understands `.gitignore`. The repo map merges `.gitignore` and `.git/info/exclude` patterns (limited to simple directory names; complex globs and negations are skipped) with built-in exclusions, keeping the search scope aligned and avoiding exposure of ignored file names to the backend.

## Known Trade-offs

- **Single glob:** Pi's grep accepts one glob pattern, so multiple include/exclude patterns are simplified to the first include. Default exclusions overlap significantly with .gitignore, so practical impact is small.
- **Remote-dependent:** Each search involves multiple network rounds. Quality depends on the directory tree and backend model decisions — not equivalent to semantic vector indexing. Position this as "exploratory code search accelerator", not the only code search entry point.
- **Hotspot repo map:** The default map sends a shallow whole-repo tree plus deeper subtrees for locally ranked hotspot directories. If that adds latency on a huge repo, set `FC_REPO_MAP_MODE=classic` to use the old adaptive flat tree.
- **Lightweight results:** The tool returns pointers, not code. This keeps the model-facing result small; use Pi's `read` tool for the selected ranges.


## Environment Variables

| Variable | Default | Description |
|:-:|---|---|
| `FAST_CONTEXT_KEY` | — | API key at startup (useful for headless/CI) |
| `WS_MODEL` | MODEL_SWE_1_6_FAST | Devin backend model; paid tiers may unlock other model ids |
| `WS_APP_VER` | 1.48.2 | Devin/Windsurf protocol metadata: app version |
| `WS_LS_VER` | 1.9544.35 | Devin/Windsurf protocol metadata: language server version |
| `FC_MAX_COMMANDS` | 8 | Max parallel commands per round |
| `FC_TIMEOUT_MS` | 30000 | Stream request timeout (ms) |
| `FC_RESULT_MAX_LINES` | 50 | Max lines per command output (truncated) |
| `FC_LINE_MAX_CHARS` | 250 | Max chars per line (truncated) |
| `FC_REPO_MAP_MODE` | hotspot | `hotspot` for shallow base + ranked subtrees, or `classic` for the old flat adaptive tree |
| `FC_HOTSPOT_BASE_DEPTH` | 1 | Depth of the shallow whole-repo tree in hotspot mode |
| `FC_HOTSPOT_TOP_K` | 4 | Preferred number of hotspot directories to drill into |
| `FC_HOTSPOT_TREE_DEPTH` | 2 | Depth of each hotspot subtree |
| `FC_HOTSPOT_MAX_BYTES` | 122880 | Byte budget for the assembled hotspot repo map |

## Architecture

```
src/
  index.ts              Extension entry: register tool, command, hooks
  constants.ts          Tool/command names, copy text
  schema.ts             Parameter schema (typebox)
  state.ts              Key state: load/save, in-memory cache
  storage.ts            Persist key to ~/.pi/agent/fast-context/config.json
  commands.ts           /fast-context command for setting/clearing key
  execute.ts            Pi-side orchestration: project_path scope, result envelope
  render.ts             Tool render: call, partial (live), collapsed, expanded states
  render-format.ts      Pure rendering helpers: color envelope, collapsed summary
  grep-backend.ts       Pi grep wrapper (reuses Pi's ripgrep)
  search.ts             Search loop and lightweight result formatting
  repo-map.ts           Classic/hotspot repo-map assembly
  directory-scorer.ts   Local hotspot scoring (BM25F + injected grep probe)
  executor.ts           Restricted command execution (rg/readfile/tree/ls/glob)
  tree.ts               Native directory-tree renderer
  sandbox.ts            Path containment (security core)
  client.ts             Auth, JWT, metadata, streaming, parsing
  protocol.ts           Protobuf encoding/decoding, Connect-RPC framing
```

Zero runtime dependencies: all peer dependencies resolve to Pi's bundled versions. File I/O via `node:fs`, compression via `node:zlib`.

## License

[MIT](LICENSE)
