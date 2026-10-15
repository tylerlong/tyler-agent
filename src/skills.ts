import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";

export type Skill = {
	name: string;
	description: string;
	source: string;
	implicit: boolean;
};
export type SkillDiscovery = {
	skills: Skill[];
	diagnostics: string[];
	readPaths: string[];
};
const missing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";
const diagnostic = (path: string, error: unknown) =>
	`${path}: ${error instanceof Error ? error.message : String(error)}`;

// Source paths retain user-installed aliases; only permission grants use real paths.
export async function discoverSkills(
	targetFolders: string[],
	userHome = homedir(),
): Promise<SkillDiscovery> {
	const skills: Skill[] = [];
	const diagnostics: string[] = [];
	const readPaths = new Set<string>();
	const roots = new Set([join(userHome, ".agents", "skills")]);
	for (const target of targetFolders) {
		const chain = [target];
		let directory: string;
		try {
			directory = await realpath(target);
		} catch (error) {
			diagnostics.push(diagnostic(target, error));
			continue;
		}
		for (;;) {
			try {
				await lstat(join(directory, ".git"));
				for (const path of chain) roots.add(join(path, ".agents", "skills"));
				break;
			} catch (error) {
				if (!missing(error)) {
					diagnostics.push(diagnostic(directory, error));
					break;
				}
			}
			const parent = dirname(directory);
			if (parent === directory) {
				roots.add(join(target, ".agents", "skills"));
				break;
			}
			directory = parent;
			chain.push(directory);
		}
	}
	async function visit(
		path: string,
		ancestors: Set<string>,
		insideSkill = false,
		grant = false,
	) {
		try {
			const actual = await realpath(path);
			if (grant) readPaths.add(actual);
			if (!(await stat(path)).isDirectory()) return;
			if (ancestors.has(actual))
				throw new Error("Symbolic link directory cycle");
			const next = new Set(ancestors).add(actual);
			const entries = await readdir(path, { withFileTypes: true });
			const source = join(path, "SKILL.md");
			const hasSkill =
				!insideSkill && entries.some((entry) => entry.name === "SKILL.md");
			if (hasSkill) {
				try {
					const text = await readFile(source, "utf8");
					const frontmatter = text.match(
						/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
					);
					if (!frontmatter) throw new Error("Missing YAML frontmatter");
					const metadata = parse(frontmatter[1]);
					if (
						!metadata ||
						typeof metadata.name !== "string" ||
						!metadata.name.trim() ||
						typeof metadata.description !== "string" ||
						!metadata.description.trim()
					)
						throw new Error("Skill requires a name and description");
					let implicit = metadata["disable-model-invocation"] !== true;
					const policyPath = join(path, "agents", "openai.yaml");
					let present = true;
					try {
						await lstat(policyPath);
					} catch (error) {
						if (!missing(error)) throw error;
						present = false;
					}
					const policy = present
						? parse(await readFile(policyPath, "utf8"))
						: null;
					if (policy?.policy?.allow_implicit_invocation === false)
						implicit = false;
					skills.push({
						name: metadata.name,
						description: metadata.description,
						source,
						implicit,
					});
				} catch (error) {
					diagnostics.push(diagnostic(source, error));
					// Broken metadata stays explicitly selectable, with the actual read attempted at submission.
					skills.push({
						name: basename(path),
						description: "",
						source,
						implicit: false,
					});
				}
			}
			for (const entry of entries.sort((a, b) =>
				a.name.localeCompare(b.name),
			)) {
				if (entry.isDirectory() || entry.isSymbolicLink())
					await visit(
						join(path, entry.name),
						next,
						insideSkill || hasSkill,
						entry.isSymbolicLink(),
					);
			}
		} catch (error) {
			diagnostics.push(diagnostic(path, error));
		}
	}
	for (const root of roots) {
		try {
			await lstat(root);
		} catch (error) {
			if (!missing(error)) diagnostics.push(diagnostic(root, error));
			continue;
		}
		await visit(root, new Set(), false, true);
	}
	return { skills, diagnostics, readPaths: [...readPaths] };
}

export async function skillInstructions(
	discovery: SkillDiscovery,
	selected: string[] = [],
) {
	const sections = [
		"Skills are reusable task guidance. Choose relevant implicit skills from this catalog and read the complete SKILL.md before using them. Read referenced resources as needed; execute scripts with the normal command tools. Skill sources and installed symbolic link targets are trusted read-only resources; they grant no extra write or network permissions. New sub-agents discover their own catalog; pass task guidance explicitly in prompt/context.",
		`Available implicit skills (name, description, exact source): ${JSON.stringify(discovery.skills.filter((skill) => skill.implicit).map(({ name, description, source }) => ({ name, description, source })))}`,
	];
	if (discovery.diagnostics.length)
		sections.push(
			`Skill discovery diagnostics (unresolved):\n${discovery.diagnostics.join("\n")}`,
		);
	for (const source of selected) {
		try {
			if (!discovery.skills.some((skill) => skill.source === source))
				throw new Error(
					"Selected source is no longer in the discovered skill catalog",
				);
			sections.push(
				`Explicitly selected skill: ${source}\n${await readFile(source, "utf8")}`,
			);
		} catch (error) {
			sections.push(
				`Explicit skill read failed (unresolved): ${diagnostic(source, error)}`,
			);
		}
	}
	return sections.join("\n\n");
}
