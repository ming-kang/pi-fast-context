# Fast Context for Pi

Fast Context is a semantic code retrieval tool for Pi. It takes a task-level search query and a compact map of the current project, asks Devin's Fast Context backend to plan a small search, then executes that search locally to return relevant files and line ranges.

[Devin's docs](https://docs.devin.ai/desktop/context-awareness/fast-context) describe Fast Context as a specialized subagent powered by the `SWE-grep` model family: `SWE-grep-mini` is the ultra-fast variant available to free users, while paid accounts may have access to the higher-intelligence `SWE-grep` backend. This Pi extension uses the same reverse-engineered protocol surface, but stays Pi-native around it and does not expose model selection as a normal user workflow.

Unlike local-only grep, Fast Context understands intent: "where is authentication handled?" can return the handler, middleware, session code, and relevant call sites even when they do not share one exact token. Results are deliberately lightweight: candidate file paths, line ranges, and grep keywords. Pi should then use `read` and `grep` for the exact code and evidence it needs.

Here's how it works: Fast Context sends your query and a hotspot repo map to Devin's hosted code-search backend over a **reverse-engineered** protocol; the backend plans a sequence of restricted search commands; this extension runs those commands locally. You bring your own Devin API key. Because the integration is unofficial, the backend can change or break it at any time without notice. Not affiliated with or endorsed by Pi or Devin.

Apart from that backend planning call, execution stays local: it reuses Pi's built-in ripgrep, respects `.gitignore`, ranks likely hotspot directories locally, and runs all path operations in a strict sandbox.

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

Pi Fast Context intentionally has no automatic credential discovery. Users configure a key manually through `/fast-context` or `FAST_CONTEXT_KEY`; the extension never reads Devin/Windsurf SQLite databases, IDE state, CLI credentials, or other local apps to recover a key.

Current Devin tokens look like `devin-session-token$<JWT>`. If you set that value through a shell or config file, quote or escape the `$`; otherwise variable expansion can silently truncate the key. Fast Context warns when it detects that shape, but it still does not attempt to recover the key automatically.

## Usage

Once you've set your key, Pi can call Fast Context when it needs a fast starting context for unfamiliar local code. Users do not normally call this tool by hand.

Good use cases:

- Understanding a large or unfamiliar repo before implementing a feature
- Finding where a cross-module behavior lives, such as auth, session restore, tool rendering, or config loading
- Tracing a bug flow when the relevant files are unknown
- Getting an initial reading list for architecture exploration or refactor planning

Poor use cases:

- Exact symbols, filenames, literals, or known paths: use `grep`, `find`, or `read`
- Small known scopes where local tools are faster
- Freshness-sensitive external facts: this only searches the local checkout
- Proof that something exists or does not exist: verify with local `grep`/`read`

Write queries as short natural-language problem statements, preferably in English, with domain terms when useful. For example: "where is session resume and conversation persistence implemented?" works better than `resume`.

Results include paths, line ranges, and grep keywords only. Treat returned files as candidate context, not proof. Pi should use `read` with the returned paths/ranges and use the grep keywords for follow-up verification.

In the TUI, you'll see real-time progress: authentication, building the repo map, and each planning/execution round. Results display collapsed by default (showing file count and grep keywords), and expand to show the full result envelope.

### Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Natural-language code retrieval query. Prefer English plus local domain terms; avoid bare exact symbols |
| `project_path` | string | cwd | Optional package/subtree to search within (must resolve inside cwd). Narrow this for monorepos |
| `tree_depth` | int 0-6 | 3 | Repo-map depth. `0` chooses automatically from project size. Use 1-2 for huge repos, 4-6 only for small focused repos |
| `max_turns` | int 1-5 | 3 | Search rounds. Use 1-2 for quick orientation, 3 normally, 4-5 for complex cross-module flows |
| `max_results` | int 1-30 | 10 | Maximum files to return. Use 3-8 for focused implementation work |
| `exclude_paths` | string[] | [] | Extra directories/files to exclude from the repo map and hotspot scoring, on top of defaults and simple `.gitignore` dirs |

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
- **Semantic, not exact:** Fast Context can return near matches for symbol-like queries. Use local `grep` for exact existence, definitions, and literal strings.
- **Hotspot repo map:** The default map sends a shallow whole-repo tree plus deeper subtrees for locally ranked hotspot directories. If that adds latency on a huge repo, set `FC_REPO_MAP_MODE=classic` to use the old adaptive flat tree.
- **Grep keywords are hints:** The returned keywords are useful follow-up searches, not proof that a file is relevant.
- **Lightweight results:** The tool returns pointers, not code. This keeps the result small; use Pi's `read` tool for the selected ranges.


## Environment Variables

| Variable | Default | Description |
|:-:|---|---|
| `FAST_CONTEXT_KEY` | — | API key at startup (useful for headless/CI) |
| `WS_MODEL` | MODEL_SWE_1_6_FAST | Backend protocol model id escape hatch. Leave unset unless the upstream protocol changes or you are debugging the wire |
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
