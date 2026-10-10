import { permissionParameters } from "./execution-permissions.ts";
export const commandTools = [
	{
		type: "function",
		name: "exec_command",
		description:
			"Run a shell command inside current Project target folders/grants or your scratch. Waits for completion. Explicit extra_permissions plus reason wait for user deny/once/Project-always approval. Network is restricted; errors are returned without escalation or replay. Output is bounded; continue using read_tool_output.",
		parameters: {
			type: "object",
			properties: {
				...permissionParameters,
				command: { type: "string" },
				cwd: { type: "string", description: "Absolute working directory" },
				timeout_ms: { type: "integer", minimum: 1, maximum: 3600000 },
			},
			required: ["command", "cwd", "timeout_ms"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "read_tool_output",
		description:
			"Read saved command output from your own Tool Call using character offsets, preserving stream and chunk order. Defaults: offset 0, limit 16000; maximum 16000.",
		parameters: {
			type: "object",
			properties: {
				tool_call_id: { type: "integer", minimum: 1 },
				offset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 16000 },
			},
			required: ["tool_call_id"],
			additionalProperties: false,
		},
	},
];

export function outputPage(
	chunks: { ordinal: number; stream: string; text: string }[],
	offset = 0,
	limit = 16000,
) {
	let position = 0;
	const page = [];
	for (const chunk of chunks) {
		const start = Math.max(0, offset - position);
		const end = Math.min(chunk.text.length, offset + limit - position);
		if (start < end)
			page.push({
				ordinal: chunk.ordinal,
				stream: chunk.stream,
				text: chunk.text.slice(start, end),
			});
		position += chunk.text.length;
	}
	return {
		chunks: page,
		next_offset: Math.min(position, offset + limit),
		total_chars: position,
	};
}
