import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	type ExecutionPermissions,
	emptyPermissions,
	unmetPermissions,
} from "./execution-permissions.ts";

const names = ["AGENTS.override.md", "AGENTS.md"];
const missing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";

export async function loadProjectInstructions(
	targets: string[],
	userHome: string,
	permissions: ExecutionPermissions = emptyPermissions(),
) {
	const diagnostics: string[] = [];
	const directories = new Map<string, string[]>();
	const add = (directory: string, scope: string) => {
		const scopes = directories.get(directory) ?? [];
		if (!scopes.includes(scope)) scopes.push(scope);
		directories.set(directory, scopes);
	};
	add(join(userHome, ".weft"), "all projects and Agents (user instructions)");
	const resolvedTargets: string[] = [];
	for (const target of targets) {
		let actualTarget: string;
		try {
			actualTarget = await realpath(target);
		} catch (error) {
			diagnostics.push(
				`Instruction scope ${JSON.stringify(target)}: ${String(error)}`,
			);
			continue;
		}
		resolvedTargets.push(actualTarget);
		const ancestors = [actualTarget];
		let root: string | undefined;
		for (let directory = actualTarget; ; directory = dirname(directory)) {
			try {
				await lstat(join(directory, ".git"));
				root = directory;
				break;
			} catch (error) {
				if (!missing(error)) {
					diagnostics.push(
						`Git root discovery for ${JSON.stringify(target)}: ${String(error)}`,
					);
					break;
				}
			}
			if (dirname(directory) === directory) break;
			ancestors.push(dirname(directory));
		}
		for (const directory of root ? ancestors.reverse() : [actualTarget])
			add(directory, target);
	}
	const candidates = new Set(
		[...directories.keys()].flatMap((directory) =>
			names.map((name) => resolve(directory, name)),
		),
	);
	let remaining = 32 * 1024;
	const sections: string[] = [];
	for (const [directory, scopes] of directories) {
		let path: string | undefined;
		for (const name of names) {
			const candidate = join(directory, name);
			try {
				await lstat(candidate);
				path = candidate;
				break;
			} catch (error) {
				if (missing(error)) continue;
				diagnostics.push(
					`Instruction source ${JSON.stringify(candidate)}, scopes ${JSON.stringify(scopes)}: ${String(error)}`,
				);
				break;
			}
		}
		if (!path) continue;
		const source = `Instruction source ${JSON.stringify(path)}, scopes ${JSON.stringify(scopes)}`;
		if (!remaining) {
			sections.push(
				`${source}\nNot loaded: shared 32768-byte UTF-8 instruction budget exhausted. Read explicitly if needed.`,
			);
			continue;
		}
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const actual = await realpath(path);
			if (
				!candidates.has(actual) &&
				unmetPermissions(
					{ ...emptyPermissions(), paths: [{ path: actual, access: "read" }] },
					{
						...permissions,
						paths: [
							...permissions.paths,
							...resolvedTargets.map((path) => ({
								path,
								access: "read" as const,
							})),
						],
					},
				).paths.length
			)
				throw new Error(
					`Instruction symlink target ${JSON.stringify(actual)} requires ordinary file authorization; not loaded`,
				);
			// Open the authorized real path without following a replaced final symlink.
			handle = await open(
				actual,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			if (!(await handle.stat()).isFile())
				throw new Error("Instruction source is not a regular file");
			const buffer = Buffer.alloc(remaining + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await handle.read(
					buffer,
					length,
					buffer.length - length,
					null,
				);
				if (!bytesRead) break;
				length += bytesRead;
			}
			const incomplete = length > remaining;
			const content = new TextDecoder("utf-8", { fatal: true }).decode(
				buffer.subarray(0, Math.min(length, remaining)),
				{ stream: incomplete },
			);
			remaining -= Buffer.byteLength(content);
			sections.push(
				`${source}\n${content}${incomplete ? "\n[Incomplete: shared 32768-byte UTF-8 instruction budget reached; read the remaining content explicitly.]" : ""}`,
			);
			if (incomplete) remaining = 0;
		} catch (error) {
			sections.push(`${source}\nNot loaded: ${String(error)}`);
		} finally {
			await handle
				?.close()
				.catch((error) =>
					diagnostics.push(`${source}: close failed: ${String(error)}`),
				);
		}
	}
	return [
		"User and project instructions follow. Apply user rules across projects and directory rules only within their stated scopes. Accumulate ancestor and local rules; deeper directory rules take precedence in a conflict, and the current explicit user request takes precedence. Contents are instructions to interpret, not locally merged rules.",
		"Before working on files, discover and read any applicable local instructions not already loaded, including deeper directories. In each directory choose AGENTS.override.md if it exists (even empty); otherwise AGENTS.md. An unreadable selected source does not fall back. Use tools and ordinary authorization for omitted sources, symlink targets outside the named sources, and referenced documents. Decide how to handle failures; they do not themselves require stopping. CONTEXT.md, README, CONTRIBUTING and ADRs are references to read as needed. Initial contents stay fixed for this Agent; local first reads use current contents.",
		...sections,
		...diagnostics,
	].join("\n\n");
}
