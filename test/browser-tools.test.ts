import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserSkill } from "../src/browser-tools.ts";
import { CommandExecutor } from "../src/command-executor.ts";
import { discoverSkills } from "../src/skills.ts";

test("bundled official CLI and skill work outside the application repository", {
	skip: process.platform !== "darwin",
}, async () => {
	const target = await realpath(
		await mkdtemp(join(tmpdir(), "browser-tools-")),
	);
	const executor = new CommandExecutor();
	const options = {
		cwd: target,
		targetFolders: [target],
		agentId: `browser-tools-${process.pid}`,
		signal: new AbortController().signal,
	};
	try {
		const discovery = await discoverSkills([target], target);
		assert(
			discovery.skills.some(
				(skill) =>
					skill.name === "playwright-cli" &&
					skill.implicit &&
					skill.source === join(browserSkill, "SKILL.md"),
			),
		);
		const content = await executor.read({
			...options,
			path: join(browserSkill, "SKILL.md"),
			offset: 0,
			limit: 20000,
			extraPermissions: {
				paths: discovery.readPaths.map((path) => ({
					path,
					access: "read" as const,
				})),
				domains: [],
				localNetwork: false,
			},
		});
		assert.match(JSON.stringify(content), /playwright-cli run-code/);
		let output = "";
		const result = await executor.execute({
			...options,
			command: "playwright-cli --version",
			onOutput: (_stream, text) => {
				output += text;
			},
		});
		assert.equal(result.exitCode, 0, output);
		assert.match(output, /1\.63\.0/);
	} finally {
		await executor.close();
		await rm(target, { recursive: true, force: true });
	}
});
