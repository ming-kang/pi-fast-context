# Package Contract

A Pi-native semantic code-search extension. A remote backend plans a sequence of restricted filesystem commands; this extension runs them locally and returns files, line ranges, inlined code, and grep keywords. **The remote side plans commands that execute on the user's machine — so the entire security boundary lives in this extension, not in any remote prompt.** Read this before touching `src/`.

## Build & Test

- **Zero runtime dependencies, no build.** `node` type-strips `.ts`; jiti loads it in Pi. No `npm install`.
- **Selftests** (pure, no Pi / no network) — run the relevant one after touching that area:
  - `node src/sandbox.selftest.ts` — path containment (security core)
  - `node src/executor.selftest.ts` — restricted command execution
  - `node src/protocol.selftest.ts` — protobuf / Connect-RPC framing
- **Load:** `pi -ne -e ./pi-fast-context`.
- **Live wire:** `client.ts` / `protocol.ts` changes need a real search + `<ANSWER>` round-trip — selftests can't cover the wire. (`render-format.ts` is pure, so colorization is unit-testable too.)

## Architecture Boundaries

- **`sandbox.ts` (`PathSandbox`) is the security core.** Every model-supplied path (rg / readfile / tree / ls / glob + answer paths) maps through `toReal()`, checked **lexically** (`..` traversal) **and after symlink resolution**; glob walks are re-vetted per entry via `contains()`.
- **Minimal Pi surface:** only **three** modules import Pi — `storage.ts` (`getAgentDir`), `grep-backend.ts` (Pi's grep), and `execute.ts` (via grep-backend). Everything else is pure and node-testable. Inject dependencies (the `GrepFn` pattern); never add a Pi import to a pure module.
- **Fragile backend boundary:** `client.ts` / `protocol.ts` speak a third-party `swe-grep` wire format that can change without notice. Protocol constants (`WS_APP_VER`, `WS_LS_VER`, `WS_MODEL`) are env-overridable; expect `403 / 429 / 413 / timeout`, classified in `classifyError`. Any change here needs live validation, not just selftests.

```
src/
  index.ts          Entry: register tool + commands + key-gated visibility hooks
  constants.ts      Tool/command names, model-facing description/guidelines
  schema.ts         TypeBox parameter schema
  state.ts          In-memory key, seeded from storage then env
  storage.ts        Key persistence (~/.pi/agent/fast-context/config.json, 0600)
  commands.ts       /fast-context: set / clear key
  reconcile.ts      Toggle the tool in/out of the active set by key presence
  execute.ts        Pi-facing orchestration: confine project_path, run search, build envelope
  search.ts         swe-grep search loop, range code-inlining, result formatting
  executor.ts       Restricted command execution (rg/readfile/tree/ls/glob), every path sandboxed
  tree.ts           Native directory tree + adaptive repo map
  sandbox.ts        Path containment (security core)
  grep-backend.ts   The one wrapper around Pi's grep (reuses Pi's ripgrep)
  render.ts         Self-render: call / partial (live) / collapsed / expanded
  render-format.ts  Pure render helpers (no Pi imports, unit-testable)
  client.ts         Backend client: auth / JWT / metadata / streaming / parsing
  protocol.ts       Protobuf + Connect-RPC framing (node:zlib only)
```

## Conventions

- **Zero runtime dependencies.** `package.json` carries only `peerDependencies`. rg → Pi's grep; fs/tree/ls/glob → `node:fs`; framing → `node:zlib`; schema → typebox (peerDep).
- Relative imports use the **`.ts`** suffix — never `.js`.
- **Clamp every env/param knob** (`clampEnv` / `clampParam`: finite + min/max); document defaults in the README's env table.
- **Key-gated visibility:** the tool is always registered but toggled into the active set by `reconcile.ts` only when a key exists (mirrors advisor's reconcile). With no key it is invisible to the model.
- **Honest model-facing copy:** position the tool as one option (network round-trips against a third party), not a mandatory first step.

## Safety Rails

Non-negotiable security invariants. Weakening any one is a regression, however convenient.

### NEVER
- Pass a model-supplied path to `node:fs` without `toReal()` first; absolute paths from the model are rejected outright.
- Set `NODE_TLS_REJECT_UNAUTHORIZED=0` — no TLS downgrade; this runs inside a shared Pi host.
- Read the backend vendor's local state (SQLite, CLI creds, IDE DBs) or offer any key-extraction tool.
- Log the API key, write it to session JSONL, or pass it as an LLM tool parameter.
- Let `project_path` escape cwd.
- Add a Pi import to a pure module, add a runtime `dependency`, or write a `.js` specifier.

### ALWAYS
- Route every model path through `PathSandbox.toReal()` / `contains()`.
- Persist the key only to `~/.pi/agent/fast-context/config.json` (file `0600`, dir `0700`); clearing it deletes the file.
- Re-run the relevant selftest after touching `sandbox` / `executor` / `protocol`.
- Live-validate after touching `client.ts` / `protocol.ts`.

## Compact Instructions

Preserve (NEVER summarize away):

1. The five security invariants — sandbox/`toReal`, no TLS downgrade, no credential discovery, key handling, `project_path` containment.
2. The minimal Pi-import surface (3 modules) and the `GrepFn` injection pattern.
3. The fragile backend boundary status and any live-validation result.
4. Modified files, selftest pass/fail, open risks and rollback notes.
