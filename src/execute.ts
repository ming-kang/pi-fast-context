/**
 * Pi-facing orchestration: resolve + confine the project path, wire rg to Pi's
 * grep, run the search, and return both the text envelope and structured
 * details for rendering. This is the second (and last) module that imports Pi,
 * via grep-backend.ts.
 */
import { isAbsolute, resolve } from "node:path";
import { createPiGrepFn } from "./grep-backend.ts";
import { formatSearchResult, search } from "./search.ts";
import { PathSandbox } from "./sandbox.ts";

function clampEnv(name: string, def: number, min: number, max: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	if (!Number.isFinite(parsed)) return def;
	return Math.min(max, Math.max(min, parsed));
}

function clampParam(v: unknown, def: number, min: number, max: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return def;
	return Math.min(max, Math.max(min, Math.round(v)));
}

const MAX_COMMANDS = clampEnv("FC_MAX_COMMANDS", 8, 1, 8);
const TIMEOUT_MS = clampEnv("FC_TIMEOUT_MS", 30000, 5000, 120000);

export interface FastContextParams {
	query?: string;
	project_path?: string;
	tree_depth?: number;
	max_turns?: number;
	max_results?: number;
	exclude_paths?: string[];
}

/** Structured result for renderResult; the text envelope is the tool content. */
export interface FastContextDetails {
	fileCount?: number;
	keywords?: string[];
	errorMessage?: string;
}

export interface FastContextOutput {
	text: string;
	details: FastContextDetails;
}

export async function runFastContextSearch(
	params: FastContextParams,
	apiKey: string,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (msg: string) => void,
): Promise<FastContextOutput> {
	const query = typeof params.query === "string" ? params.query.trim() : "";
	if (!query) return { text: "Error: query is required.", details: { errorMessage: "query is required" } };

	// Resolve and confine project_path within the current working directory.
	let projectRoot = resolve(cwd);
	if (params.project_path) {
		const candidate = isAbsolute(params.project_path)
			? resolve(params.project_path)
			: resolve(cwd, params.project_path);
		if (!new PathSandbox(cwd).contains(candidate)) {
			return {
				text: `Error: project_path must be inside the current working directory.\n[hint] given=${params.project_path}, cwd=${cwd}`,
				details: { errorMessage: "project_path outside cwd" },
			};
		}
		projectRoot = candidate;
	}

	const treeDepth = clampParam(params.tree_depth, 3, 1, 6);
	const maxTurns = clampParam(params.max_turns, 3, 1, 5);
	const maxResults = clampParam(params.max_results, 10, 1, 30);
	const excludePaths = Array.isArray(params.exclude_paths)
		? params.exclude_paths.filter((p): p is string => typeof p === "string")
		: [];

	const result = await search({
		query,
		projectRoot,
		apiKey,
		grepFn: createPiGrepFn(projectRoot),
		maxTurns,
		maxCommands: MAX_COMMANDS,
		maxResults,
		treeDepth,
		timeoutMs: TIMEOUT_MS,
		excludePaths,
		signal,
		onProgress,
	});

	const text = formatSearchResult(result, {
		maxTurns,
		maxResults,
		maxCommands: MAX_COMMANDS,
		timeoutMs: TIMEOUT_MS,
		excludePaths,
	});

	const details: FastContextDetails = result.error
		? { errorMessage: result.error.split("\n")[0] }
		: {
				fileCount: result.files.length,
				keywords: [...new Set(result.rgPatterns ?? [])].filter((p) => p.length >= 3),
			};

	return { text, details };
}
