/**
 * Self-rendered tool framing (renderShell: "self"). The pure formatting helpers
 * live in render-format.ts (node-testable); this module is the TUI glue.
 *
 * Four states:
 *   • call      → ● Fast Context(query · scope)
 *   • partial   → ● Fast Context · <live progress>   (streamed via onUpdate)
 *   • collapsed → │ N files · grep: …  (+ expand hint)  /  one-line error
 *   • expanded  → colorized envelope: file headers, grep keywords, config notes
 */
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { TOOL_LABEL } from "./constants.ts";
import type { FastContextDetails } from "./execute.ts";
import { activeDotLine, buildCollapsedSummary, callLine, colorizeEnvelope, errLine } from "./render-format.ts";
import type { FastContextParams } from "./schema.ts";

/** "(ctrl-? to expand)" — only when there's more than the collapsed line shows. */
function expandHint(text: string, theme: Theme): string {
	if (!text.includes("\n")) return "";
	return ` ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

export function renderCall(args: FastContextParams, theme: Theme): Text {
	const q = typeof args.query === "string" ? args.query : "";
	const short = q.length > 60 ? `${q.slice(0, 57)}…` : q;
	const scope =
		typeof args.project_path === "string" && args.project_path.trim() ? ` · ${args.project_path.trim()}` : "";
	return new Text(callLine(TOOL_LABEL, short + scope, theme, "accent"), 0, 0);
}

export function renderResult(
	result: AgentToolResult<FastContextDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text | Container {
	const details = result.details;
	const block = result.content.find((c) => c.type === "text");
	const text = block && "text" in block ? block.text : "";

	// Live progress streamed from search() via onUpdate.
	if (options.isPartial) {
		const msg = text.trim() || "Consulting Devin…";
		return new Text(activeDotLine(TOOL_LABEL, ` · ${msg}`, theme), 0, 0);
	}

	// Expanded shows the full colorized envelope (useful for errors too).
	if (options.expanded) {
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(new Text(colorizeEnvelope(text, theme), 1, 0));
		return container;
	}

	if (details?.errorMessage) {
		const msg = text.split("\n")[0] || details.errorMessage;
		return new Text(errLine(msg, theme) + expandHint(text, theme), 0, 0);
	}

	return new Text(buildCollapsedSummary(details, theme) + expandHint(text, theme), 0, 0);
}
