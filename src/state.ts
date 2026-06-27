/**
 * API key state: an in-memory value backed by a persistent file under the Pi
 * agent dir. Seeded on load from the persisted file, falling back to an explicit
 * FAST_CONTEXT_KEY env var (set by the user, never read from Devin's local
 * state). Setting the key persists it; clearing removes the file.
 */
import { clearJwtCache } from "./client.ts";
import { deletePersistedKey, loadPersistedKey, savePersistedKey } from "./storage.ts";

let apiKey: string | undefined = loadPersistedKey() ?? process.env.FAST_CONTEXT_KEY?.trim() ?? undefined;

export function getApiKey(): string | undefined {
	return apiKey;
}

export function setApiKey(key: string): void {
	const next = key.trim();
	if (!next) return;
	if (apiKey && apiKey !== next) clearJwtCache(apiKey);
	apiKey = next;
	savePersistedKey(next);
}

export function clearApiKey(): void {
	if (apiKey) clearJwtCache(apiKey);
	apiKey = undefined;
	deletePersistedKey();
}
