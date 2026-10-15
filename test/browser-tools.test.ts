import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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

test("native browser launch requires both file and network access to be full", {
	skip: process.platform !== "darwin",
	timeout: 60000,
}, async () => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "browser-modes-")),
	);
	const target = join(directory, "target");
	await mkdir(target);
	const outside = join(directory, "outside.txt");
	await writeFile(outside, "outside-proof");
	const website = createServer((_req, res) => res.end("network-proof")).listen(
		0,
		"127.0.0.1",
	);
	await new Promise<void>((resolve) => website.once("listening", resolve));
	const address = website.address();
	assert(address && typeof address !== "string");
	await writeFile(
		join(target, "boundaries.cjs"),
		`
const fs = require('node:fs');
(async () => {
  let file = false, network = false;
  try { file = fs.readFileSync(${JSON.stringify(outside)}, 'utf8') === 'outside-proof'; } catch {}
  try { network = await (await fetch('http://127.0.0.1:${address.port}', {signal: AbortSignal.timeout(1000)})).text() === 'network-proof'; } catch {}
  console.log(JSON.stringify({file, network}));
})();
`,
	);
	const executor = new CommandExecutor();
	try {
		for (const [fullFile, fullNetwork] of [
			[false, false],
			[true, false],
			[false, true],
			[true, true],
		]) {
			const options = {
				cwd: target,
				targetFolders: [target],
				agentId: `browser-modes-${process.pid}-${fullFile}-${fullNetwork}`,
				extraPermissions: {
					fullFile,
					fullNetwork,
					paths: [],
					domains: [],
					localNetwork: false,
				},
				signal: new AbortController().signal,
			};
			let output = "";
			const boundary = await executor.execute({
				...options,
				command: "node boundaries.cjs",
				onOutput: (stream, text) => {
					if (stream === "stdout") output += text;
				},
			});
			assert.equal(boundary.exitCode, 0, output);
			assert.deepEqual(JSON.parse(output), {
				file: fullFile,
				network: fullNetwork,
			});
			output = "";
			const result = await executor.execute({
				...options,
				command: "playwright-cli open about:blank --browser=chromium",
				timeoutMs: 15000,
				onOutput: (_stream, text) => {
					output += text;
				},
			});
			if (fullFile && fullNetwork) {
				assert.equal(result.exitCode, 0, output);
				const closed = await executor.execute({
					...options,
					command: "playwright-cli close",
					onOutput: () => {},
				});
				assert.equal(closed.exitCode, 0);
			} else {
				assert.notEqual(
					result.exitCode,
					0,
					`${fullFile}/${fullNetwork}: ${output}`,
				);
			}
		}
	} finally {
		await executor.close();
		website.closeAllConnections();
		await new Promise<void>((resolve) => website.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
