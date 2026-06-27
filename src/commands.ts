/**
 * Single `/fast-context` command: shows the key on/off status in the dialog
 * title, lets you enter a key (saved to ~/.pi/agent/), or submit an empty field
 * to clear it. The key is entered through Pi's input box (same as /login) and
 * never echoed back.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CMD, TOOL_LABEL } from "./constants.ts";
import { reconcileFastContextTool } from "./reconcile.ts";
import { clearApiKey, getApiKey, setApiKey } from "./state.ts";
import { keyFilePath } from "./storage.ts";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand(CMD, {
		description: `Configure ${TOOL_LABEL}: set or clear the Devin API key`,
		handler: async (_args, ctx) => {
			const configured = !!getApiKey();

			if (!ctx.hasUI) {
				ctx.ui.notify(
					configured
						? `${TOOL_LABEL}: key configured (${keyFilePath()}).`
						: `${TOOL_LABEL}: no key. Set FAST_CONTEXT_KEY for headless runs, or run /${CMD} interactively.`,
					configured ? "info" : "warning",
				);
				return;
			}

			// Note: ctx.ui.input renders only the title (placeholder is ignored), so the
			// status + instructions live in the title.
			const title = configured
				? `${TOOL_LABEL} — key configured. Enter a new key, or submit empty to clear.`
				: `${TOOL_LABEL} — no key. Paste your Devin token (devin-session-token$… / sk-ws-…).`;

			const value = await ctx.ui.input(title);
			if (value === undefined) return; // cancelled (Esc)

			const trimmed = value.trim();
			if (!trimmed) {
				// Empty submit = clear (only meaningful when a key was set).
				if (configured) {
					clearApiKey();
					reconcileFastContextTool(pi);
					ctx.ui.notify(`${TOOL_LABEL} key cleared — tool disabled (removed ${keyFilePath()}).`, "info");
				} else {
					ctx.ui.notify(`${TOOL_LABEL}: no key entered.`, "info");
				}
				return;
			}

			setApiKey(trimmed);
			reconcileFastContextTool(pi);
			ctx.ui.notify(`${TOOL_LABEL} key saved — tool enabled → ${keyFilePath()}`, "info");
		},
	});
}
