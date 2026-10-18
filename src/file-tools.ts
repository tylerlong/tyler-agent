import type { InputContent } from "./image-content.ts";
export const fileTools = [
	{
		type: "function",
		name: "read_file",
		description:
			"Read complete text lines as the current system user. start_line is 1-based (default 1); max_lines defaults to 2000 and is adjustable. Returns only path, text, encoding and next_line (null only at EOF), preserving original Unicode and LF/CRLF/CR endings. UTF-8 and BOM-marked UTF-16 LE/BE only; invalid encoding and binary content fail. Text is limited to 51200 UTF-8 bytes; an oversized first line fails. Continue at next_line. Each call scans from the beginning without caching; skipped prefixes cost reads and file changes between calls may change positions. Only decoded blocks are validated. Use read_image for images, existing commands or MCP for other formats.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute file path" },
				start_line: { type: "integer", minimum: 1 },
				max_lines: { type: "integer", minimum: 1 },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "apply_patch",
		description:
			"Create or change text using Codex built-in patch as the current system user. Supply *** Begin Patch / *** End Patch with Add File, Update File (optional Move to), or Delete File and @@ hunks. Paths are relative to cwd or absolute. No transactional rollback, unique-match, locking or collision guarantee. Command output is saved and bounded; continue via read_tool_output. Timeout defaults to 30000 ms.",
		parameters: {
			type: "object",
			properties: {
				patch: { type: "string" },
				cwd: { type: "string", description: "Absolute working directory" },
				timeout_ms: { type: "integer", minimum: 1, maximum: 3600000 },
			},
			required: ["patch", "cwd"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "read_image",
		description:
			"Read a complete local PNG, JPEG, GIF or WebP image as visual content (maximum 10 MiB). Reads as the current system user. Read only when needed; images remain in this Agent context.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute image path" },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
];
export type ToolExecution = {
	status: "succeeded" | "failed" | "interrupted";
	result: string | InputContent[];
};
export type ToolReview = (operation: {
	name: string;
	description: string;
	arguments: unknown;
	execution?: unknown;
}) => Promise<void>;
export type ToolExecutor = (
	name: string,
	argumentsText: string,
	roots: string[],
	signal?: AbortSignal,
	review?: ToolReview,
) => Promise<ToolExecution>;
// The model loop alone has no trusted Agent identity or execution context.
export const executeTool: ToolExecutor = async () => ({
	status: "failed",
	result: JSON.stringify({
		error: "Local file tools require application Agent ownership",
	}),
});
