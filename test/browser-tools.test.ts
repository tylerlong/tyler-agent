import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
			signal: options.signal,
			path: join(browserSkill, "SKILL.md"),
			offset: 0,
			limit: 20000,
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

test("native commands can read outside their cwd and launch, operate and close the browser", {
	skip: process.platform !== "darwin",
	timeout: 60000,
}, async () => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "browser-full-access-")),
	);
	const page = createServer((_request, response) =>
		response.end(
			"<title>Full Access</title><button onclick=\"this.textContent='Clicked'\">Click me</button>",
		),
	);
	page.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => page.once("listening", resolve));
	const address = page.address();
	assert(address && typeof address !== "string");
	const executor = new CommandExecutor();
	const options = {
		cwd: directory,
		agentId: `browser-full-access-${process.pid}`,
		signal: new AbortController().signal,
		timeoutMs: 15000,
	};
	const execute = async (command: string) => {
		let output = "";
		const result = await executor.execute({
			...options,
			command,
			onOutput: (_stream, text) => {
				output += text;
			},
		});
		assert.equal(result.exitCode, 0, output);
		return output;
	};
	try {
		const outside = join(directory, "outside.txt");
		await writeFile(outside, "outside-proof");
		assert.match(await execute(`cd /; cat '${outside}'`), /outside-proof/);
		await execute(
			`playwright-cli open http://127.0.0.1:${address.port} --browser=chromium`,
		);
		assert.match(
			await execute(
				`playwright-cli run-code 'async page => { await page.getByRole("button", { name: "Click me" }).click(); return await page.getByRole("button").textContent(); }'`,
			),
			/Clicked/,
		);
		await execute("playwright-cli close");
	} finally {
		await executor.execute({
			...options,
			command: "playwright-cli close",
			onOutput: () => {},
		});
		await executor.close();
		page.closeAllConnections();
		await new Promise<void>((resolve) => page.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
