import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export const countFilesTool = {
	type: "function",
	name: "count_files",
	description:
		"Count non-hidden regular files recursively in an absolute directory within a configured target folder. Hidden descendants and symbolic links are excluded.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Absolute directory path" },
		},
		required: ["path"],
		additionalProperties: false,
	},
	strict: true,
} as const;

type ToolResult =
	| { path: string; count: number }
	| {
			error: {
				kind: "validation" | "scope" | "execution";
				message: string;
				exitStatus?: number | null;
				signal?: string | null;
				stdout?: string;
				stderr?: string;
				timedOut?: boolean;
				truncated?: boolean;
			};
	  };

const failure = (
	kind: "validation" | "scope" | "execution",
	message: string,
): ToolResult => ({ error: { kind, message: message.slice(0, 4096) } });

export async function executeTool(
	name: string,
	argumentsText: string,
	roots: string[],
): Promise<ToolResult> {
	if (name !== "count_files") return failure("validation", "Unknown tool name");
	let args: unknown;
	try {
		args = JSON.parse(argumentsText);
	} catch {
		return failure("validation", "Tool arguments must be valid JSON");
	}
	if (
		!args ||
		typeof args !== "object" ||
		Array.isArray(args) ||
		Object.keys(args).length !== 1 ||
		!("path" in args) ||
		typeof args.path !== "string" ||
		!isAbsolute(args.path) ||
		args.path.includes("\0")
	)
		return failure(
			"validation",
			"Expected one absolute directory path argument",
		);
	if (!roots.length)
		return failure("scope", "No target folders are configured for this Turn");
	const selectedPath = args.path;
	let directory: string;
	try {
		directory = await realpath(selectedPath);
		if (!(await stat(directory)).isDirectory())
			return failure("validation", "The selected path must be a directory");
	} catch (error) {
		return failure("execution", String(error));
	}
	const resolvedRoots = await Promise.allSettled(
		roots.map((root) => realpath(root)),
	);
	if (
		!resolvedRoots.some((root) => {
			if (root.status !== "fulfilled") return false;
			const child = relative(root.value, directory);
			return (
				child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
			);
		})
	)
		return failure(
			"scope",
			"The resolved path is outside configured target folders",
		);

	return new Promise((resolve) => {
		// Each file produces one constant byte, regardless of its filename.
		const child = spawn("find", [
			"-P",
			directory,
			"-mindepth",
			"1",
			"-name",
			".*",
			"-prune",
			"-o",
			"-type",
			"f",
			"-exec",
			"/usr/bin/printf",
			"x%.0s",
			"{}",
			"+",
		]);
		let count = 0;
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let truncated = false;
		let timedOut = false;
		let processError: Error | undefined;
		let invalidOutput = false;
		const retain = (previous: Buffer, chunk: Buffer) => {
			truncated ||= previous.length + chunk.length > 4096;
			return Buffer.concat([
				previous,
				chunk.subarray(0, 4096 - previous.length),
			]);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			count += chunk.length;
			invalidOutput ||= chunk.some((byte) => byte !== 120);
			stdout = retain(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = retain(stderr, chunk);
		});
		child.on("error", (error) => {
			processError = error;
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, 15_000);
		child.on("close", (exitStatus, signal) => {
			clearTimeout(timeout);
			if (
				!processError &&
				!timedOut &&
				exitStatus === 0 &&
				!invalidOutput &&
				Number.isSafeInteger(count)
			) {
				resolve({ path: selectedPath, count });
				return;
			}
			resolve({
				error: {
					kind: "execution",
					message: (
						processError?.message ??
						(timedOut
							? "File counting timed out"
							: invalidOutput || !Number.isSafeInteger(count)
								? "File counting returned invalid output"
								: "File counting command failed")
					).slice(0, 4096),
					...(!processError ? { exitStatus, signal } : {}),
					stdout: stdout.toString("utf8"),
					stderr: stderr.toString("utf8"),
					timedOut,
					truncated,
				},
			});
		});
	});
}
