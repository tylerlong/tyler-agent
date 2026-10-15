import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { configureDatabase } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";
import { createServer } from "./server-fixture.ts";

const message = {
	id: "answer",
	type: "message",
	content: [{ type: "output_text", text: "done" }],
};
const call = (name: string, args: unknown) => ({
	id: "tool",
	call_id: "tool",
	type: "function_call",
	name,
	arguments: JSON.stringify(args),
});
const skill = async (
	directory: string,
	name: string,
	description: string,
	body = "BODY",
	flags = "",
) => {
	await mkdir(directory, { recursive: true });
	const source = join(directory, "SKILL.md");
	await writeFile(
		source,
		`---\nname: ${name}\ndescription: ${description}\n${flags}---\n${body}`,
	);
	return source;
};
async function fixture(model: typeof globalThis.fetch) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "skills-http-")),
	);
	const target = join(directory, "project");
	const home = join(directory, "home");
	await mkdir(target);
	await mkdir(home);
	const db = join(directory, "db.sqlite");
	configureDatabase(db);
	const server = createServer(
		model,
		db,
		undefined,
		undefined,
		undefined,
		home,
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const request = async (path: string, body?: unknown) => {
		const response = await fetch(
			base + path,
			body === undefined
				? undefined
				: { method: "POST", body: JSON.stringify(body) },
		);
		assert(response.ok, `${path}: ${await response.clone().text()}`);
		return response.json();
	};
	const project = await request("/api/projects", {
		name: "Skills",
		folders: [target],
	});
	const chat = await request(`/api/projects/${project.id}/chats`, {
		name: "Test",
	});
	return {
		directory,
		project,
		target,
		home,
		chat,
		request,
		wait: (id: number) => waitForAgent(base, id),
		ask: async (skillSources: string[] = []) => {
			const { agentId } = await request(`/api/chats/${chat.id}`, {
				prompt: "Task",
				skillSources,
			});
			const agent = await waitForAgent(base, agentId);
			assert.equal(agent.status, "succeeded", JSON.stringify(agent));
			return agentId as number;
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("skill catalog preserves duplicate sources and explicit-only visibility, refreshes each Root and records full exact selections", async () => {
	const requests: {
		instructions: string;
		input: { role?: string; content?: string }[];
	}[] = [];
	const f = await fixture(async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return completedResponse({ output: [message] });
	});
	try {
		const project = await skill(
			join(f.target, ".agents/skills/shared"),
			"shared",
			"Project description",
			"PROJECT BODY",
		);
		const user = await skill(
			join(f.home, ".agents/skills/shared"),
			"shared",
			"User description",
			"USER BODY",
		);
		const disabled = await skill(
			join(f.target, ".agents/skills/explicit"),
			"explicit",
			"Explicit description",
			"EXPLICIT BODY",
			"disable-model-invocation: true\n",
		);
		const policy = await skill(
			join(f.target, ".agents/skills/policy"),
			"policy",
			"Policy description",
			"POLICY BODY",
		);
		await mkdir(join(dirname(policy), "agents"));
		await writeFile(
			join(dirname(policy), "agents/openai.yaml"),
			"policy:\n  allow_implicit_invocation: false\n",
		);
		const catalog = await f.request(`/api/chats/${f.chat.id}/skills`);
		assert.equal(catalog.skills.length, 4);
		assert.deepEqual(
			catalog.skills
				.filter((s: { name: string }) => s.name === "shared")
				.map((s: { source: string }) => s.source)
				.sort(),
			[project, user].sort(),
		);
		assert.equal(
			catalog.skills.find((s: { source: string }) => s.source === disabled)
				.implicit,
			false,
		);
		assert.equal(
			catalog.skills.find((s: { source: string }) => s.source === policy)
				.implicit,
			false,
		);
		await f.ask();
		assert.match(requests[0].instructions, /Project description/);
		assert.match(requests[0].instructions, /User description/);
		assert.doesNotMatch(
			requests[0].instructions,
			/EXPLICIT BODY|Explicit description|POLICY BODY|Policy description|PROJECT BODY|USER BODY|skills\/explicit|skills\/policy/,
		);
		await writeFile(
			disabled,
			`${await readFile(disabled, "utf8")}\nLATEST FULL BODY`,
		);
		const id = await f.ask([disabled, policy]);
		assert.match(requests[1].instructions, /EXPLICIT BODY\nLATEST FULL BODY/);
		assert.match(requests[1].instructions, /POLICY BODY/);
		assert.doesNotMatch(requests[1].instructions, /PROJECT BODY|USER BODY/);
		const calls = await f.request(`/api/agents/${id}/calls`);
		assert.match(calls.calls[0].requestBody, /LATEST FULL BODY/);
		await skill(join(f.target, ".agents/skills/added"), "added", "New skill");
		await f.ask();
		assert.match(requests[2].instructions, /New skill/);
		assert.doesNotMatch(
			requests[2].instructions,
			/LATEST FULL BODY|EXPLICIT BODY|POLICY BODY/,
		);
	} finally {
		await f.close();
	}
});

test("new Sub-agents refresh skills without inheriting the parent selection; broken discoveries and explicit reads remain diagnostics", async () => {
	let first = true;
	let target = "";
	const requests: {
		instructions: string;
		input: { role?: string; content?: string }[];
	}[] = [];
	const f = await fixture(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body);
		if (first) {
			first = false;
			await skill(
				join(target, ".agents/skills/fresh"),
				"fresh",
				"Fresh child catalog",
			);
			return completedResponse({
				output: [
					call("create_sub_agent", {
						prompt: "Child task",
						context: "Explicit background",
					}),
				],
			});
		}
		return completedResponse({ output: [message] });
	});
	target = f.target;
	try {
		const explicit = await skill(
			join(target, ".agents/skills/explicit"),
			"explicit",
			"Explicit",
			"PARENT SELECTION",
			"disable-model-invocation: true\n",
		);
		await mkdir(join(target, ".agents/skills/broken"), { recursive: true });
		await writeFile(
			join(target, ".agents/skills/broken/SKILL.md"),
			"---\nname: [broken YAML\n---\nBroken body",
		);
		await symlink(
			join(f.directory, "missing"),
			join(target, ".agents/skills/dangling"),
		);
		const brokenPolicy = join(target, ".agents/skills/broken-policy");
		await skill(brokenPolicy, "broken-policy", "Unresolved policy metadata");
		await mkdir(join(brokenPolicy, "agents"));
		await symlink(
			join(f.directory, "missing-policy"),
			join(brokenPolicy, "agents/openai.yaml"),
		);
		await f.ask([explicit, join(target, ".agents/skills/vanished/SKILL.md")]);
		assert.match(requests[0].instructions, /PARENT SELECTION/);
		assert.match(requests[0].instructions, /Skill discovery diagnostics/);
		assert.match(requests[0].instructions, /Explicit skill read failed/);
		assert.match(requests[0].instructions, /dangling/);
		assert.match(requests[0].instructions, /openai.yaml/);
		assert.doesNotMatch(requests[0].instructions, /Unresolved policy metadata/);
		const child = requests.find((body) =>
			body.input.some(
				(item: { role?: string; content?: string }) =>
					item.role === "user" && item.content === "Child task",
			),
		);
		assert(child);
		assert.match(child.instructions, /Fresh child catalog/);
		assert.doesNotMatch(child.instructions, /PARENT SELECTION/);
		assert.match(JSON.stringify(child.input), /Explicit background/);
	} finally {
		await f.close();
	}
});

test("trusted skill links permit native file and command reads while rejecting writes outside Target and preserving Target writes", {
	skip: platform() !== "darwin",
}, async () => {
	let step = 0;
	let source = "",
		reference = "",
		projectFile = "",
		target = "";
	const f = await fixture(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const results = body.input.filter(
			(item: { type: string }) => item.type === "function_call_output",
		);
		switch (step++) {
			case 0:
				return completedResponse({
					output: [call("read_file", { path: source })],
				});
			case 1:
				assert.match(JSON.parse(results.at(-1).output).text, /SYMLINK BODY/);
				return completedResponse({
					output: [call("read_file", { path: reference })],
				});
			case 2:
				assert.equal(JSON.parse(results.at(-1).output).text, "REFERENCE");
				return completedResponse({
					output: [
						call("exec_command", {
							command: `cat '${reference}'; printf changed > '${reference}'`,
							cwd: target,
							timeout_ms: 3000,
						}),
					],
				});
			case 3:
				assert.notEqual(JSON.parse(results.at(-1).output).exitCode, 0);
				assert.match(
					JSON.parse(results.at(-1).output)
						.output.chunks.map((chunk: { text: string }) => chunk.text)
						.join(""),
					/REFERENCE/,
				);
				assert.equal(await readFile(reference, "utf8"), "REFERENCE");
				return completedResponse({
					output: [
						call("apply_patch", {
							patch: `*** Begin Patch\n*** Add File: .agents/skills/local/output.txt\n+TARGET WRITE\n*** End Patch`,
							cwd: target,
						}),
					],
				});
			default:
				assert.equal(
					JSON.parse(results.at(-1).output).exitCode,
					0,
					JSON.stringify(results.at(-1)),
				);
				return completedResponse({ output: [message] });
		}
	});
	target = f.target;
	try {
		const installed = join(f.directory, "installed");
		source = await skill(installed, "linked", "Installed link", "SYMLINK BODY");
		reference = join(f.directory, "reference.txt");
		await writeFile(reference, "REFERENCE");
		await symlink(reference, join(installed, "reference.txt"));
		await mkdir(join(f.home, ".agents/skills"), { recursive: true });
		await symlink(installed, join(f.home, ".agents/skills/linked"));
		await skill(join(target, ".agents/skills/local"), "local", "Local skill");
		projectFile = join(target, ".agents/skills/local/output.txt");
		await f.ask();
		assert.equal(await readFile(projectFile, "utf8"), "TARGET WRITE\n");
	} finally {
		await f.close();
	}
});

test("project skills follow the nearest Git root through a saved Target alias and keep Target-local sources distinct", async () => {
	let instructions = "";
	const f = await fixture(async (_url, init) => {
		instructions = JSON.parse(String(init?.body)).instructions;
		return completedResponse({ output: [message] });
	});
	try {
		await mkdir(join(f.target, ".git"));
		const nested = join(f.target, "nested");
		await mkdir(nested);
		const alias = join(f.directory, "alias");
		await symlink(nested, alias);
		await skill(
			join(f.target, ".agents/skills/shared"),
			"shared",
			"Repository root",
		);
		await skill(
			join(nested, ".agents/skills/shared"),
			"shared",
			"Target local",
		);
		await skill(
			join(f.directory, ".agents/skills/outside"),
			"outside",
			"Outside repository",
		);
		const project = await f.request("/api/projects", {
			name: "Alias",
			folders: [alias],
		});
		const chat = await f.request(`/api/projects/${project.id}/chats`, {
			name: "Alias",
		});
		const catalog = await f.request(`/api/chats/${chat.id}/skills`);
		assert.equal(catalog.skills.length, 2);
		assert.deepEqual(
			catalog.skills
				.map((entry: { description: string }) => entry.description)
				.sort(),
			["Repository root", "Target local"],
		);
		const { agentId } = await f.request(`/api/chats/${chat.id}`, {
			prompt: "Task",
		});
		await f.wait(agentId);
		assert.match(instructions, /Repository root/);
		assert.match(instructions, /Target local/);
		assert.doesNotMatch(instructions, /Outside repository/);
		assert(agentId);
	} finally {
		await f.close();
	}
});
