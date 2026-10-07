import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";

const pathParameter = { type: "string", description: "Absolute scoped path" };
const offsetParameter = {
	type: "integer",
	minimum: 0,
	description: "Continue at nextOffset (default 0)",
};
const tool = (
	name: string,
	description: string,
	properties: object,
	required: string[],
) => ({
	type: "function",
	name,
	description,
	parameters: {
		type: "object",
		properties: { path: pathParameter, ...properties },
		required,
		additionalProperties: false,
	},
});
export const fileTools = [
	tool(
		"list_files",
		"List entries in one directory; optional relative path glob (Node path.matchesGlob syntax) discovers recursively without following symlinks. Includes hidden/.git paths. At most 100 entries; truncated and nextOffset indicate continuation.",
		{ pattern: { type: "string" }, offset: offsetParameter },
		["path"],
	),
	tool(
		"search_files",
		"Search UTF-8 text recursively in one directory for a case-sensitive literal query, without following symlinks. Unsupported files are skipped. At most 100 matching lines with absolute path, line, Unicode column, and a Unicode-safe excerpt of up to 4096 characters (textStartColumn/textTruncated identify clipping); truncated and nextOffset indicate continuation.",
		{ query: { type: "string" }, offset: offsetParameter },
		["path", "query"],
	),
	tool(
		"read_file",
		"Read one UTF-8 text file. Optional 1-based startLine/endLine and startColumn (Unicode codepoints); at most 2000 lines or 50 KiB. Continue using nextLine/nextColumn when truncated. Binary or invalid UTF-8 content fails.",
		{
			startLine: { type: "integer", minimum: 1 },
			endLine: { type: "integer", minimum: 1 },
			startColumn: { type: "integer", minimum: 1 },
		},
		["path"],
	),
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
export class FileToolError extends Error {
	kind: "validation" | "scope" | "execution";
	constructor(kind: "validation" | "scope" | "execution", message: string) {
		super(message);
		this.kind = kind;
	}
}
const contains = (root: string, path: string) => {
	const child = relative(root, path);
	return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
export async function scopedPath(path: string, roots: string[]) {
	if (
		!isAbsolute(path) ||
		path.includes("\0") ||
		path.split(sep).includes("..")
	)
		throw new FileToolError(
			"validation",
			"Expected an absolute path without traversal",
		);
	if (!roots.length)
		throw new FileToolError(
			"scope",
			"No target folders are configured for this Agent",
		);
	const resolved = await realpath(path);
	const resolvedRoots = await Promise.allSettled(
		roots.map((root) => realpath(root)),
	);
	if (
		!resolvedRoots.some(
			(root) => root.status === "fulfilled" && contains(root.value, resolved),
		)
	)
		throw new FileToolError(
			"scope",
			"The resolved path is outside configured target folders",
		);
	return resolved;
}
async function* paths(
	directory: string,
	recursive: boolean,
	signal?: AbortSignal,
): AsyncGenerator<{ path: string; type: string }> {
	signal?.throwIfAborted();
	const entries = (await readdir(directory, { withFileTypes: true })).sort(
		(a, b) => a.name.localeCompare(b.name, "en"),
	);
	for (const entry of entries) {
		signal?.throwIfAborted();
		const path = join(directory, entry.name);
		yield {
			path,
			type: entry.isDirectory()
				? "directory"
				: entry.isFile()
					? "file"
					: entry.isSymbolicLink()
						? "symlink"
						: "other",
		};
		if (recursive && entry.isDirectory()) {
			// Resolve each descendant before traversal so replaced directories cannot escape scope.
			if ((await realpath(path)) !== path) continue;
			yield* paths(path, true, signal);
		}
	}
}
export async function textFile(
	path: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!(await stat(path)).isFile())
		throw new FileToolError(
			"validation",
			"The selected path must be a regular file",
		);
	const stream = createReadStream(path, { signal });
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let text = "";
	try {
		for await (const chunk of stream) {
			signal?.throwIfAborted();
			text += decoder.decode(chunk, { stream: true });
			if (text.includes("\0"))
				throw new FileToolError(
					"validation",
					"Binary content is not supported",
				);
		}
		text += decoder.decode();
	} catch (error) {
		if (error instanceof TypeError)
			throw new FileToolError(
				"validation",
				"Invalid UTF-8 content is not supported",
			);
		throw error;
	}
	return text;
}
export const executeTool: ToolExecutor = async (
	name,
	argumentsText,
	roots,
	signal,
) => {
	try {
		signal?.throwIfAborted();
		let args: Record<string, unknown>;
		try {
			args = JSON.parse(argumentsText);
		} catch {
			throw new FileToolError(
				"validation",
				"Tool arguments must be valid JSON",
			);
		}
		const allowed =
			name === "list_files"
				? ["path", "pattern", "offset"]
				: name === "search_files"
					? ["path", "query", "offset"]
					: name === "read_file"
						? ["path", "startLine", "endLine", "startColumn"]
						: [];
		if (
			!allowed.length ||
			!args ||
			typeof args !== "object" ||
			Array.isArray(args) ||
			Object.keys(args).some((key) => !allowed.includes(key)) ||
			typeof args.path !== "string"
		)
			throw new FileToolError("validation", "Invalid tool name or arguments");
		for (const key of ["offset", "startLine", "endLine", "startColumn"])
			if (
				key in args &&
				(!Number.isSafeInteger(args[key]) ||
					Number(args[key]) < (key === "offset" ? 0 : 1))
			)
				throw new FileToolError("validation", `Invalid ${key}`);
		if (
			"pattern" in args &&
			(typeof args.pattern !== "string" || args.pattern.includes("\0"))
		)
			throw new FileToolError("validation", "Invalid path pattern");
		if (
			name === "search_files" &&
			(typeof args.query !== "string" ||
				!args.query ||
				args.query.includes("\0"))
		)
			throw new FileToolError(
				"validation",
				"Expected a nonempty literal query",
			);
		const path = await scopedPath(args.path, roots);
		let result: object;
		if (name === "read_file") {
			const startLine = Number(args.startLine ?? 1),
				startColumn = Number(args.startColumn ?? 1),
				endLine = Number(args.endLine ?? Number.MAX_SAFE_INTEGER);
			if (endLine < startLine)
				throw new FileToolError(
					"validation",
					"endLine must not precede startLine",
				);
			const text = await textFile(path, signal);
			const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
			let output = "",
				bytes = 0,
				nextLine: number | null = null,
				nextColumn: number | null = null,
				lastLine = startLine - 1;
			outer: for (
				let line = startLine;
				line <= Math.min(lines.length, endLine);
				line++
			) {
				signal?.throwIfAborted();
				if (line - startLine >= 2000) {
					nextLine = line;
					nextColumn = 1;
					break;
				}
				const characters = Array.from(lines[line - 1]);
				if (line === startLine && startColumn > characters.length + 1)
					throw new FileToolError(
						"validation",
						"startColumn is beyond the selected line",
					);
				for (
					let column = line === startLine ? startColumn : 1;
					column <= characters.length;
					column++
				) {
					const character = characters[column - 1],
						size = Buffer.byteLength(character);
					if (bytes + size > 50 * 1024) {
						nextLine = line;
						nextColumn = column;
						break outer;
					}
					output += character;
					bytes += size;
					lastLine = line;
				}
			}
			result = {
				path: args.path,
				text: output,
				startLine,
				endLine: lastLine,
				truncated: nextLine !== null,
				nextLine,
				nextColumn,
			};
		} else {
			if (!(await stat(path)).isDirectory())
				throw new FileToolError(
					"validation",
					"The selected path must be a directory",
				);
			const offset = Number(args.offset ?? 0);
			const entries: object[] = [];
			let count = 0,
				truncated = false;
			outer: for await (const entry of paths(
				path,
				name === "search_files" || args.pattern !== undefined,
				signal,
			)) {
				if (name === "list_files") {
					if (
						args.pattern !== undefined &&
						!matchesGlob(relative(path, entry.path), String(args.pattern))
					)
						continue;
					if (count++ < offset) continue;
					if (entries.length === 100) {
						truncated = true;
						break;
					}
					entries.push(entry);
				} else if (entry.type === "file") {
					let content: string;
					try {
						content = await textFile(
							await scopedPath(entry.path, roots),
							signal,
						);
					} catch (error) {
						if (error instanceof FileToolError && error.kind === "validation")
							continue;
						throw error;
					}
					const lines = content.split("\n");
					for (let line = 0; line < lines.length; line++) {
						signal?.throwIfAborted();
						if (!lines[line].includes(String(args.query))) continue;
						if (count++ < offset) continue;
						if (entries.length === 100) {
							truncated = true;
							break outer;
						}
						const characters = Array.from(lines[line]);
						const column =
							Array.from(
								lines[line].slice(0, lines[line].indexOf(String(args.query))),
							).length + 1;
						const excerptStart = Math.max(0, column - 1 - 128);
						entries.push({
							path: entry.path,
							line: line + 1,
							column,
							text: characters
								.slice(excerptStart, excerptStart + 4096)
								.join(""),
							textStartColumn: excerptStart + 1,
							textTruncated:
								excerptStart > 0 || characters.length > excerptStart + 4096,
						});
					}
				}
			}
			result = {
				path: args.path,
				...(name === "list_files" ? { entries } : { matches: entries }),
				truncated,
				nextOffset: truncated ? offset + entries.length : null,
			};
		}
		signal?.throwIfAborted();
		return { status: "succeeded", result: JSON.stringify(result) };
	} catch (error) {
		return {
			status: signal?.aborted ? "interrupted" : "failed",
			result: JSON.stringify({
				error: {
					kind: error instanceof FileToolError ? error.kind : "execution",
					message: String(error instanceof Error ? error.message : error).slice(
						0,
						4096,
					),
				},
			}),
		};
	}
};
