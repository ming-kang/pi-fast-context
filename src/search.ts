/**
 * The swe-grep search loop — ported from upstream core.mjs `search()`.
 *
 * Stays Pi-agnostic: rg is supplied as an injected `grepFn`, so the whole loop
 * can be driven against the live backend in a standalone script (and wired to
 * Pi's grep in execute.ts). Includes the full robustness of upstream: adaptive
 * repo map, multi-turn with force-answer, no-valid-command turn compensation,
 * payload/timeout context-trim retry, and error classification.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	buildRequest,
	type ChatMessage,
	checkRateLimit,
	classifyError,
	FastContextError,
	getCachedJwt,
	parseResponse,
	streamingRequest,
} from "./client.ts";
import { type GrepFn, type RestrictedCommand, ToolExecutor } from "./executor.ts";
import { buildSystemPrompt, FINAL_FORCE_ANSWER, getToolDefinitions } from "./prompt.ts";
import { PathSandbox } from "./sandbox.ts";
import { buildRepoMap } from "./tree.ts";

const VIRTUAL_ROOT = "/codebase";

export interface SearchOptions {
	query: string;
	projectRoot: string;
	apiKey: string;
	grepFn: GrepFn;
	maxTurns?: number;
	maxCommands?: number;
	maxResults?: number;
	treeDepth?: number;
	timeoutMs?: number;
	excludePaths?: string[];
	onProgress?: (msg: string) => void;
	signal?: AbortSignal;
}

export interface SearchFile {
	/** Root-relative path. */
	path: string;
	/** Real absolute path, for the caller to read/grep next. */
	fullPath: string;
	ranges: Array<[number, number]>;
	/** Inlined code per range (parallel to `ranges`); set by attachSnippets. */
	snippets?: Snippet[];
}

export interface SearchMeta {
	treeDepth: number;
	treeSizeKB: number;
	fellBack: boolean;
	errorCode?: string;
	contextTrimmed?: boolean;
}

export interface SearchResult {
	files: SearchFile[];
	rgPatterns?: string[];
	error?: string;
	rawResponse?: string;
	meta?: SearchMeta;
	/** True when inline snippets were cut short by the total-line budget. */
	snippetBudgetHit?: boolean;
}

/** Trim accumulated rounds to shrink the payload on retry. Keeps head + last 2. */
function trimMessages(messages: ChatMessage[]): boolean {
	if (messages.length <= 4) return false;
	const head = messages.slice(0, 2);
	const tail = messages.slice(-2);
	messages.length = 0;
	messages.push(
		...head,
		{ role: 1, content: "[Prior search rounds omitted to reduce payload. Provide your best answer based on available context.]" },
		...tail,
	);
	return true;
}

/** Parse the <ANSWER> XML into files, mapping /codebase paths to real paths (sandboxed). */
function parseAnswer(xmlText: string, sandbox: PathSandbox): SearchFile[] {
	const files: SearchFile[] = [];
	const fileRegex = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
	let fm: RegExpExecArray | null;
	while ((fm = fileRegex.exec(xmlText)) !== null) {
		const vpath = fm[2]!;
		const real = sandbox.toReal(vpath);
		if (real === null) continue; // refuse anything outside the root
		const rel = vpath.replace(/^\/codebase[/\\]?/, "").replace(/^[/\\]+/, "");
		const ranges: Array<[number, number]> = [];
		const rangeRegex = /<range>(\d+)-(\d+)<\/range>/g;
		let rm: RegExpExecArray | null;
		while ((rm = rangeRegex.exec(fm[3]!)) !== null) {
			ranges.push([Number.parseInt(rm[1]!, 10), Number.parseInt(rm[2]!, 10)]);
		}
		files.push({ path: rel, fullPath: real, ranges });
	}
	return files;
}

// ─── Inline code snippets ────────────────────────────────────────────────────

function envInt(name: string, def: number, min: number, max: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	if (!Number.isFinite(parsed)) return def;
	return Math.min(max, Math.max(min, parsed));
}

/** Inlining is on by default; FC_SNIPPETS=0 falls back to pointers-only. */
const SNIPPETS_ENABLED = process.env.FC_SNIPPETS !== "0";
const SNIPPET_RANGE_MAX_LINES = envInt("FC_SNIPPET_RANGE_MAX_LINES", 80, 1, 1000);
const SNIPPET_TOTAL_MAX_LINES = envInt("FC_SNIPPET_TOTAL_MAX_LINES", 400, 10, 5000);
const SNIPPET_LINE_MAX_CHARS = envInt("FC_SNIPPET_LINE_MAX_CHARS", 250, 20, 10000);

export interface Snippet {
	start: number;
	end: number;
	/** Line-numbered, char-capped code; empty when error/omitted. */
	text: string;
	shownLines: number;
	rangeLines: number;
	/** Range was capped (per-range cap or remaining budget). */
	truncated: boolean;
	/** Range skipped entirely because the total budget was already spent. */
	omitted: boolean;
	error?: string;
}

/** Read one file's ranges off disk (fullPath is already sandbox-validated). */
function readFileSnippets(file: SearchFile, cache: Map<string, string[] | null>, budget: { remaining: number }): Snippet[] {
	let lines = cache.get(file.fullPath);
	if (lines === undefined) {
		try {
			const buf = readFileSync(file.fullPath);
			// Crude binary guard: a NUL byte in the first 8KB.
			lines = buf.subarray(0, 8192).includes(0) ? null : buf.toString("utf-8").split("\n");
		} catch {
			lines = null;
		}
		cache.set(file.fullPath, lines);
	}

	return file.ranges.map(([rawStart, rawEnd]): Snippet => {
		const start = Math.max(1, rawStart);
		const end = Math.max(start, rawEnd);
		const rangeLines = end - start + 1;
		const base = { start, end, text: "", shownLines: 0, rangeLines, truncated: false, omitted: false };
		if (lines === null) return { ...base, error: "unreadable or binary file" };
		if (budget.remaining <= 0) return { ...base, truncated: true, omitted: true };

		const cap = Math.min(rangeLines, SNIPPET_RANGE_MAX_LINES, budget.remaining);
		const slice = lines.slice(start - 1, start - 1 + cap);
		if (slice.length === 0) return { ...base, error: `range past end of file (${lines.length} lines)` };

		const gutterW = String(start + slice.length - 1).length;
		const text = slice
			.map((ln, i) => {
				const no = String(start + i).padStart(gutterW);
				const capped = ln.length > SNIPPET_LINE_MAX_CHARS ? `${ln.slice(0, SNIPPET_LINE_MAX_CHARS)} …` : ln;
				return `${no} │ ${capped}`;
			})
			.join("\n");
		budget.remaining -= slice.length;
		return { start, end, text, shownLines: slice.length, rangeLines, truncated: slice.length < rangeLines, omitted: false };
	});
}

/**
 * Read the answer files' ranges and attach them as `file.snippets`, sharing one
 * total-line budget across the whole result. Returns true if the budget forced
 * any range to be omitted (so the caller can surface a note).
 */
export function attachSnippets(files: SearchFile[]): boolean {
	if (!SNIPPETS_ENABLED) return false;
	const cache = new Map<string, string[] | null>();
	const budget = { remaining: SNIPPET_TOTAL_MAX_LINES };
	let budgetHit = false;
	for (const file of files) {
		file.snippets = readFileSnippets(file, cache, budget);
		if (file.snippets.some((s) => s.omitted)) budgetHit = true;
	}
	return budgetHit;
}

export async function search(opts: SearchOptions): Promise<SearchResult> {
	const {
		query,
		apiKey,
		grepFn,
		maxTurns = 3,
		maxCommands = 8,
		maxResults = 10,
		treeDepth = 3,
		timeoutMs = 30000,
		excludePaths = [],
		onProgress,
	} = opts;
	const log = (m: string) => onProgress?.(m);

	const projectRoot = resolve(opts.projectRoot);
	const sandbox = new PathSandbox(projectRoot);
	const executor = new ToolExecutor(sandbox, grepFn);

	log("Authenticating…");
	const jwt = await getCachedJwt(apiKey);

	log("Checking rate limit…");
	if (!(await checkRateLimit(apiKey, jwt))) {
		return { files: [], error: "Rate limited, please try again later" };
	}

	const toolDefs = getToolDefinitions(maxCommands);
	const systemPrompt = buildSystemPrompt(maxTurns, maxCommands, maxResults);
	const { tree: repoMap, depth: actualDepth, sizeBytes: treeSizeBytes, fellBack } = buildRepoMap(
		sandbox.realRoot,
		VIRTUAL_ROOT,
		treeDepth,
		excludePaths,
	);
	log(`Mapping repo (tree -L ${actualDepth}, ${(treeSizeBytes / 1024).toFixed(1)}KB${fellBack ? `, fell back from L${treeDepth}` : ""})`);

	const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${actualDepth} /codebase):\n\`\`\`text\n${repoMap}\n\`\`\``;
	const messages: ChatMessage[] = [
		{ role: 5, content: systemPrompt },
		{ role: 1, content: userContent },
	];

	const baseMeta = (): SearchMeta => ({
		treeDepth: actualDepth,
		treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
		fellBack,
	});

	const totalApiCalls = maxTurns + 1;
	let compensatedTurns = 0;
	const MAX_COMPENSATIONS = 2;
	let forceAnswerInjected = false;

	for (let turn = 0; turn < totalApiCalls + compensatedTurns; turn++) {
		log(`Planning (turn ${turn + 1}/${totalApiCalls})`);
		const proto = buildRequest(apiKey, jwt, messages, toolDefs);

		let respData: Buffer;
		try {
			respData = await streamingRequest(proto, timeoutMs);
		} catch (e) {
			const err = e instanceof FastContextError ? e : classifyError(e as Error);
			const errCode = err.code;
			if ((errCode === "PAYLOAD_TOO_LARGE" || errCode === "TIMEOUT") && messages.length > 4) {
				log(`${errCode === "TIMEOUT" ? "Timed out" : "Payload too large"} — trimming context, retrying…`);
				trimMessages(messages);
				try {
					respData = await streamingRequest(buildRequest(apiKey, jwt, messages, toolDefs), timeoutMs);
				} catch (retryErr) {
					const rc = retryErr instanceof FastContextError ? retryErr.code : "UNKNOWN";
					return {
						files: [],
						error: `${rc}: ${(retryErr as Error).message} (retry after context trim also failed)`,
						meta: { ...baseMeta(), errorCode: rc, contextTrimmed: true },
					};
				}
			} else {
				return { files: [], error: `${errCode}: ${err.message}`, meta: { ...baseMeta(), errorCode: errCode } };
			}
		}

		const [thinking, toolInfo] = parseResponse(respData);
		if (toolInfo === null) {
			if (thinking.startsWith("[Error]")) return { files: [], error: thinking };
			return { files: [], rawResponse: thinking };
		}
		const [toolName, toolArgs] = toolInfo;

		if (toolName === "answer") {
			const answerXml = typeof toolArgs.answer === "string" ? toolArgs.answer : "";
			log("Reading code ranges…");
			const files = parseAnswer(answerXml, sandbox);
			const snippetBudgetHit = attachSnippets(files);
			return {
				files,
				rgPatterns: [...new Set(executor.collectedRgPatterns)],
				meta: baseMeta(),
				snippetBudgetHit,
			};
		}

		if (toolName === "restricted_exec") {
			const callId = randomUUID();
			const argsJson = JSON.stringify(toolArgs);
			const args = toolArgs as Record<string, RestrictedCommand>;
			const cmds = Object.keys(args).filter((k) => k.startsWith("command"));
			log(`Running ${cmds.length} ${cmds.length === 1 ? "command" : "commands"}`);

			const results = await executor.execToolCall(args, opts.signal);

			const validCommands = cmds.filter((k) => args[k]?.type);
			if (validCommands.length === 0 && compensatedTurns < MAX_COMPENSATIONS) {
				compensatedTurns++;
				log(`Retrying (no actionable results) ${compensatedTurns}/${MAX_COMPENSATIONS}…`);
			}

			messages.push({
				role: 2,
				content: thinking,
				tool_call_id: callId,
				tool_name: "restricted_exec",
				tool_args_json: argsJson,
			});
			messages.push({ role: 4, content: results, ref_call_id: callId });

			const effectiveTurn = turn - compensatedTurns;
			if (effectiveTurn >= maxTurns - 1 && !forceAnswerInjected) {
				messages.push({ role: 1, content: FINAL_FORCE_ANSWER });
				forceAnswerInjected = true;
				log("Requesting final answer…");
			}
		}
	}

	return {
		files: [],
		error: "Max turns reached without getting an answer",
		rgPatterns: [...new Set(executor.collectedRgPatterns)],
		meta: baseMeta(),
	};
}

// ─── Result envelope formatting (pure; standalone-testable) ──────────────────

export interface FormatOptions {
	maxTurns: number;
	maxResults: number;
	maxCommands: number;
	timeoutMs: number;
	excludePaths: string[];
}

function hintFor(code?: string): string {
	if (code === "PAYLOAD_TOO_LARGE" || code === "TIMEOUT")
		return "\n[hint] Payload/timeout error. Try: reduce tree_depth, reduce max_turns, add exclude_paths, or narrow project_path to a subdirectory.";
	if (code === "AUTH_ERROR")
		return "\n[hint] Authentication error. The key may be expired or revoked. Run /fast-context to set a fresh Devin key.";
	if (code === "RATE_LIMITED") return "\n[hint] Rate limited. Wait a moment and retry.";
	return "\n[hint] If the error is payload-related, try a lower tree_depth value or add exclude_paths.";
}

export function formatSearchResult(result: SearchResult, fmt: FormatOptions): string {
	if (result.error) {
		const meta = result.meta;
		let errMsg = `Error: ${result.error}`;
		if (meta) {
			errMsg += `\n\n[diagnostic] error_type=${meta.errorCode ?? "unknown"}, tree_depth_used=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
			if (meta.fellBack) errMsg += " (auto fell back from requested depth)";
			if (meta.contextTrimmed) errMsg += ", context_trimmed=true";
			errMsg += `\n[config] max_turns=${fmt.maxTurns}, max_results=${fmt.maxResults}, max_commands=${fmt.maxCommands}, timeout_ms=${fmt.timeoutMs}`;
			if (fmt.excludePaths.length) errMsg += `, exclude_paths=[${fmt.excludePaths.join(", ")}]`;
			errMsg += hintFor(meta.errorCode);
		}
		return errMsg;
	}

	const files = result.files ?? [];
	const rgPatterns = [...new Set(result.rgPatterns ?? [])].filter((p) => p.length >= 3);

	if (!files.length && !rgPatterns.length) {
		const raw = result.rawResponse ?? "";
		return raw ? `No relevant files found.\n\nRaw response:\n${raw}` : "No relevant files found.";
	}

	const parts: string[] = [];
	const n = files.length;
	if (files.length) {
		parts.push(`Found ${n} relevant ${n === 1 ? "file" : "files"}.`, "");
		files.forEach((entry, i) => {
			const rangesStr = entry.ranges.map(([s, e]) => `L${s}-${e}`).join(", ");
			parts.push(`  [${i + 1}/${n}] ${entry.fullPath}${rangesStr ? ` (${rangesStr})` : ""}`);
			for (const sn of entry.snippets ?? []) {
				if (sn.omitted) continue; // covered by the global budget note below
				if (sn.error) {
					parts.push(`      (snippet unavailable: ${sn.error})`);
					continue;
				}
				if (!sn.text) continue;
				for (const line of sn.text.split("\n")) parts.push(`      ${line}`);
				if (sn.truncated)
					parts.push(`      … (L${sn.start}-${sn.end}: showing first ${sn.shownLines} of ${sn.rangeLines} lines — read the rest with the read tool)`);
			}
		});
	} else {
		parts.push("No files found.");
	}

	if (result.snippetBudgetHit)
		parts.push("", `[note] Inline snippets stopped at the ${SNIPPET_TOTAL_MAX_LINES}-line budget — read the remaining ranges with the read tool.`);

	if (rgPatterns.length) parts.push("", `grep keywords: ${rgPatterns.join(", ")}`);

	const meta = result.meta;
	if (meta) {
		const fb = meta.fellBack ? " (fell back from requested depth)" : "";
		parts.push(
			"",
			`[config] tree_depth=${meta.treeDepth}${fb}, tree_size=${meta.treeSizeKB}KB, max_turns=${fmt.maxTurns}, max_results=${fmt.maxResults}, timeout_ms=${fmt.timeoutMs}${fmt.excludePaths.length ? `, exclude_paths=[${fmt.excludePaths.join(", ")}]` : ""}`,
		);
	}

	return parts.join("\n");
}
