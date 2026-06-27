import { type Static, Type } from "typebox";

export const FastContextParamsSchema = Type.Object({
	query: Type.String({
		description: "Natural-language problem statement describing the behavior or concept to find (e.g. 'where is X handled'), not a bare keyword.",
	}),
	project_path: Type.Optional(
		Type.String({
			description: "Subdirectory to scope the search to. Must be inside the current working directory. Defaults to the cwd.",
		}),
	),
	tree_depth: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 6,
			description: "Repo-map tree depth (1-6, default 3). Use 1-2 for huge monorepos, 4-6 for small projects.",
		}),
	),
	max_turns: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5,
			description: "Search rounds (1-5, default 3). More = deeper but slower.",
		}),
	),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 30,
			description: "Maximum files to return (1-30, default 10).",
		}),
	),
	exclude_paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Directory/file names to exclude from the repo map (e.g. generated or vendored dirs).",
		}),
	),
});

export type FastContextParams = Static<typeof FastContextParamsSchema>;
