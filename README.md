# pi-fast-context

Fast Context is a semantic code search tool for Pi. It takes your search query and the project's directory structure, analyzes them with a remote model, then executes a series of commands locally to find and return relevant code snippets.

Unlike local-only search, Fast Context understands intent: "where is authentication handled?" returns relevant functions and call sites, not just grep matches. Results are returned with inline code (including line numbers), so you often get your answer in one shot.

> **Unofficial.** This is a third-party, zero-dependency Pi extension. It talks to Devin/Windsurf's `swe-grep` backend over a **reverse-engineered** protocol, so you must bring your own Devin API key, and the backend can change or break it at any time without notice. Not affiliated with or endorsed by Pi, Devin, or Windsurf.

Apart from that one backend call, everything runs locally: it reuses Pi's built-in ripgrep, respects `.gitignore`, and runs all path operations in a strict sandbox.

## Requirements

- Pi >= 0.80 (as the extension host)
- A Devin account with API key access (free tier is fine; paid tier supports additional models)
- No separate ripgrep installation needed — Pi provides it

## Installation

```bash
pi install git:github.com/ming-kang/pi-fast-context
# or from local checkout during development:
pi install ./pi-fast-context
```

Local checkout does not auto-run `npm install`, but that's fine — this package has zero runtime dependencies.

## Configuring your API key

Run `/fast-context` to open the key configuration dialog:

- Enter your API key and submit to save it
- Submit empty to delete a saved key
- Press Escape to cancel

The key is stored persistently in `~/.pi/agent/fast-context/config.json` (mode 0600), loaded on startup, and never passed to the model or written to session logs.

For headless/CI environments, set the `FAST_CONTEXT_KEY` environment variable instead. If not set, the tool will use the saved key from `config.json`.

## Usage

Once you've set your key, the tool becomes available to the model. It's designed for exploratory search: when you don't know which files contain what you're looking for. For known symbols or filenames, use Pi's built-in `grep`, `read`, or `find` instead.

Results include inline code for each relevant range (with line numbers), so you usually get your answer without needing to read further. If a result is truncated or you want more context, use `read` with the paths and line ranges provided.

In the TUI, you'll see real-time progress: authentication, building the repo map, each planning/execution round, and code retrieval. Results display collapsed by default (showing file count and grep keywords), and expand to show syntax-highlighted code.

### Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | What code or behavior to find |
| `project_path` | string | cwd | Subdirectory to search within (must be inside cwd) |
| `tree_depth` | int 1-6 | 3 | Depth of the repo map. Use 1-2 for huge monorepos, 4-6 for small projects. Auto-reduces if over 250KB |
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
- **Inline code budget:** Results include actual code (avoiding a second read), constrained by total line budget (default 400), max lines per range (default 80), and chars per line (default 250). Ranges exceeding budget show path/line pointers instead, with a hint to adjust parameters.


## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `FAST_CONTEXT_KEY` | — | API key at startup (useful for headless/CI) |
| `WS_MODEL` | MODEL_SWE_1_6_FAST | Backend model; paid tier can switch to swe-grep |
| `WS_APP_VER` | 1.48.2 | Protocol metadata: app version |
| `WS_LS_VER` | 1.9544.35 | Protocol metadata: language server version |
| `FC_MAX_COMMANDS` | 8 | Max parallel commands per round |
| `FC_TIMEOUT_MS` | 30000 | Stream request timeout (ms) |
| `FC_RESULT_MAX_LINES` | 50 | Max lines per command output (truncated) |
| `FC_LINE_MAX_CHARS` | 250 | Max chars per line (truncated) |
| `FC_SNIPPETS` | 1 | Inline code in results; 0 = paths only |
| `FC_SNIPPET_TOTAL_MAX_LINES` | 400 | Total inline code budget across all results |
| `FC_SNIPPET_RANGE_MAX_LINES` | 80 | Max inline lines per range |
| `FC_SNIPPET_LINE_MAX_CHARS` | 250 | Max chars per inline line (truncated) |

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
  search.ts             Search loop, inline code snippets, result formatting
  executor.ts           Restricted command execution (rg/readfile/tree/ls/glob)
  tree.ts               Native directory tree, adaptive repo map
  sandbox.ts            Path containment (security core)
  client.ts             Auth, JWT, metadata, streaming, parsing
  protocol.ts           Protobuf encoding/decoding, Connect-RPC framing
```

Zero runtime dependencies: all peer dependencies resolve to Pi's bundled versions. File I/O via `node:fs`, compression via `node:zlib`.

## License

MIT
