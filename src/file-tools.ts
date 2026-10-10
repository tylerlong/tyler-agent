import { permissionParameters } from "./execution-permissions.ts";
export const fileTools = [
	{
		type: "function",
		name: "read_file",
		description:
			"Read a bounded native file block under the same current scope as commands. Explicit extra_permissions plus reason wait for user deny/once approval. Byte offsets; defaults offset 0, limit 51200, maximum 51200 bytes. Returns exact base64 content and decoded UTF-8 text (partial codepoints/invalid bytes may display replacement characters). Continue at next_offset until eof; each call opens and closes its own handle.",
		parameters: {
			type: "object",
			properties: {
				...permissionParameters,
				path: { type: "string", description: "Absolute file path" },
				offset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 51200 },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "apply_patch",
		description:
			"Create or change text using Codex built-in patch under the same current scope as commands. Explicit extra_permissions plus reason wait for user deny/once approval. Supply *** Begin Patch / *** End Patch with Add File, Update File (optional Move to), or Delete File and @@ hunks. Paths are relative to cwd or absolute. No transactional rollback, unique-match, locking or collision guarantee. Command output is saved and bounded; continue via read_tool_output. Timeout defaults to 30000 ms.",
		parameters: {
			type: "object",
			properties: {
				...permissionParameters,
				patch: { type: "string" },
				cwd: { type: "string", description: "Absolute working directory" },
				timeout_ms: { type: "integer", minimum: 1, maximum: 3600000 },
			},
			required: ["patch", "cwd"],
			additionalProperties: false,
		},
	},
];
export type ToolExecution = {
	status: "succeeded" | "failed" | "interrupted";
	result: string;
};
export type ToolExecutor = (
	name: string,
	argumentsText: string,
	roots: string[],
	signal?: AbortSignal,
) => Promise<ToolExecution>;
// The model loop alone has no trusted Agent identity or managed execution scope.
export const executeTool: ToolExecutor = async () => ({
	status: "failed",
	result: JSON.stringify({
		error: "Local file tools require application Agent ownership",
	}),
});
