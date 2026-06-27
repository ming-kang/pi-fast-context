# pi-fast-context — Agent Guidelines

This file is for AI coding agents working on `pi-fast-context/`. It documents the design invariants, module layout, and conventions that must hold across changes. Read it before touching any source under `src/`.

pi-fast-context is a Pi-native semantic code search extension. A remote backend (`swe-grep`) plans a sequence of restricted filesystem commands; this extension executes them locally and returns the relevant files, line ranges, inlined code, and grep keywords. Because the remote side plans commands that run on the user's machine, **the security boundary lives entirely in this extension, not in any remote prompt.**

---

## Security Invariants

These are non-negotiable. A change that weakens any of them is a regression, even if it makes something more convenient.

### 1. Every model-supplied path goes through the sandbox

`sandbox.ts` (`PathSandbox`) is the security core. Every path the backend plans — for `rg`, `readfile`, `tree`, `ls`, `glob`, and the final answer paths — must be mapped through `toReal()`, which returns `null` for anything that escapes the project root. Containment is checked **both lexically** (catches `..` traversal) **and after symlink resolution** (catches symlink escapes). Glob walk results are additionally vetted per-entry through `contains()`.

- Never pass a model-supplied path to `node:fs` without `toReal()` first.
- Never reintroduce the upstream behavior of passing non-`/codebase` paths through verbatim, or skipping the re-check after `join`. That was the escape hole this port closed.
- Absolute paths from the model are rejected outright — the model addresses everything under the virtual `/codebase` root.

### 2. No TLS downgrade

`client.ts` must never set `NODE_TLS_REJECT_UNAUTHORIZED=0` (the upstream flipped it process-wide on the first network error). It is removed deliberately. Never reintroduce it — this runs inside a shared Pi host.

### 3. No local credential discovery

The API key is always passed in explicitly. This extension must never read the backend vendor's local state (SQLite, CLI credentials, IDE databases) or offer any key-extraction tool. The only key sources are: the persisted `config.json` and an explicit `FAST_CONTEXT_KEY` env var the user sets themselves.

### 4. Key handling

`storage.ts` persists the key to `~/.pi/agent/fast-context/config.json` (file `0600`, dir `0700`) — a dedicated file, never Pi's `auth.json`. The key is held in memory (`state.ts`), seeded from the persisted file then the env var. It must never be logged, never appear in session JSONL, and never be passed as an LLM tool parameter. Clearing the key (empty submit in `/fast-context`) deletes the file.

### 5. project_path stays inside cwd

`execute.ts` confines `project_path` within the current working directory via `PathSandbox.contains()`, defaulting to cwd. Searches cannot escape the working directory.

---

## Architecture

```
src/
  index.ts          Extension entry: register tool + commands + key-gated visibility hooks
  constants.ts      Tool/command names, model-facing description/guidelines
  schema.ts         TypeBox parameter schema
  state.ts          In-memory key, seeded from storage then env
  storage.ts        Key persistence (~/.pi/agent/fast-context/config.json, 0600)
  commands.ts       /fast-context: set / clear key
  reconcile.ts      Toggle tool in/out of the active set based on key presence
  execute.ts        Pi-facing orchestration: confine project_path, run search, build envelope
  search.ts         swe-grep search loop, range code-inlining, result formatting
  executor.ts       Restricted command execution (rg/readfile/tree/ls/glob), every path sandboxed
  tree.ts           Native directory tree + adaptive repo map
  sandbox.ts        Path containment (security core)
  grep-backend.ts   The one wrapper around Pi's grep (reuses Pi's ripgrep)
  render.ts         Self-render: call / partial (live progress) / collapsed / expanded
  render-format.ts  Pure render helpers (no Pi imports, unit-testable)
  client.ts         Backend client: auth/JWT/metadata/streaming/parsing
  protocol.ts       Protobuf + Connect-RPC framing (node:zlib only)
```

### Keep the Pi import surface minimal

Only **three** modules import Pi: `storage.ts` (`getAgentDir`), `grep-backend.ts` (Pi's grep), and `execute.ts` (via `grep-backend`). Everything else — `sandbox`, `executor`, `search`, `tree`, `protocol`, `client`, `render-format` — is pure and runs under plain `node`. This is what lets the security and search logic be unit-tested with a fake `grepFn`. Do not add Pi imports to the pure modules; inject what they need (the `GrepFn` pattern) instead.

### The backend boundary is fragile by nature

`client.ts` and `protocol.ts` speak the `swe-grep` backend's Connect-RPC / protobuf wire format. That backend is a third-party service: it can rev protobuf field numbers, endpoints, and the app / language-server versions, and change the model id. This is why protocol constants (`WS_APP_VER`, `WS_LS_VER`, `WS_MODEL`) are env-overridable. Treat these two modules as the fragile boundary — any change here needs live validation against the real backend, not just unit tests. Expect `403/429/413/timeout` in the wild; errors are classified in `classifyError` and surfaced with actionable hints.

---

## Conventions

- **Zero runtime dependencies.** `package.json` carries only `peerDependencies` pointing at Pi's framework packages. Do not add runtime `dependencies`. rg → Pi's grep; tree/ls/glob/readfile → `node:fs`; protobuf/framing → `node:zlib`; schema → typebox (peerDep).
- **Relative imports use the `.ts` source suffix** (jiti resolves it directly) — do not write `.js` specifiers.
- **Clamp every env/param knob.** New tunables follow `clampEnv` / `clampParam` (finite check + min/max). Document defaults in the README's environment-variable table.
- **Tool visibility is key-gated.** The tool is always registered but toggled in/out of the active set by `reconcile.ts` on `session_start` / `before_agent_start`. With no key, it is invisible to the model (name, description, snippet, guidelines all drop from the prompt). Mirrors the advisor extension's reconcile pattern.
- **Model-facing copy positions the tool as one option, not a mandatory first step** — it costs network round-trips against a third-party backend. Keep `constants.ts` honest about that (prefer built-in grep/find/read for known filenames/symbols/literals).

---

## Testing Notes

- `executor.ts` / `search.ts` take an injected `GrepFn`, so the native command logic and search loop can be driven under plain `node` with a fake grep — no Pi and no network required. Prefer this for sandbox and command-execution coverage.
- `render-format.ts` is pure and unit-testable: verify collapsed summary and per-line colorization without a TUI.
- The protocol/client path can only be validated live against the backend. When changing `client.ts` / `protocol.ts`, run a real search and confirm an `<ANSWER>` round-trip.
