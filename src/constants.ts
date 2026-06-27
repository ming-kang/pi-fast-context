/** Tool/command identifiers and prompt text. */

export const TOOL_NAME = "fast_context_search";
export const TOOL_LABEL = "Fast Context";

export const CMD = "fast-context";

export const TOOL_DESCRIPTION =
	"Locate code by concept or behavior in a large or unfamiliar codebase: describe what you want in " +
	"natural language (e.g. 'where is rate limiting enforced') and a remote model returns the most relevant " +
	"files with line ranges, the code at those ranges inlined, and suggested grep keywords. For a known " +
	"filename, symbol, or literal string, use grep/find instead. Requires a user-provided Devin key.";

export const PROMPT_SNIPPET =
	"Locate code by concept/behavior in large or unfamiliar repos (returns files + the code at the relevant ranges inlined + grep keywords)";

// Deliberately positions this as one option among Pi's own grep/read/find, not a
// mandatory first step — it costs network round-trips against a third-party backend.
export const PROMPT_GUIDELINES = [
	"Reach for fast_context_search to locate code by concept or behavior when the file is unknown — most useful in large or unfamiliar repos.",
	"Write the query as a short natural-language problem statement, not bare keywords.",
	"For a known filename, symbol, or literal string, use built-in grep/find/read instead — faster and free.",
	"It inlines the code at each returned range plus grep keywords, so you usually don't need to re-read those lines. Each call is several network round-trips.",
];
