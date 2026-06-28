/** Tool/command identifiers and prompt text. */

export const TOOL_NAME = "fast_context_search";
export const TOOL_LABEL = "Fast Context";

export const CMD = "fast-context";

export const TOOL_DESCRIPTION =
	"Semantic code locator for large or unfamiliar repos. Use when the relevant files are unknown: describe " +
	"the behavior in natural language and it returns likely files, line ranges, and grep keywords. For known " +
	"symbols, filenames, or literals, use grep/find/read instead.";

export const PROMPT_SNIPPET =
	"Use fast_context_search only to locate unknown files by concept/behavior in large or unfamiliar repos; it returns paths, line ranges, and grep keywords.";

// Deliberately positions this as one option among Pi's own grep/read/find, not a
// mandatory first step — it costs network round-trips against a third-party backend.
export const PROMPT_GUIDELINES = [
	"Use fast_context_search when you need to find where an unfamiliar behavior/concept lives, especially in a large repo.",
	"Do not use it for known filenames, symbols, or exact strings; use grep/find/read directly.",
	"Ask a short natural-language query. After it returns paths and ranges, use read for the code you actually need.",
];
