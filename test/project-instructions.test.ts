import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { configureDatabase } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";
import { createServer } from "./server-fixture.ts";

type ModelRequest = {
	instructions: string;
	input: { role?: string; content?: unknown }[];
};

async function fixture(respond?: (body: ModelRequest) => Promise<Response>) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "weft-instructions-")),
	);
	const home = join(directory, "home");
	await mkdir(join(home, ".weft"), { recursive: true });
	const db = join(directory, "db.sqlite");
	configureDatabase(db);
	const requests: ModelRequest[] = [];
	const server = createServer(
		async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			requests.push(body);
			return respond
				? respond(body)
				: completedResponse({
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "done" }],
							},
						],
					});
		},
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
	const post = async (path: string, body: unknown) => {
		const r = await fetch(base + path, {
			method: "POST",
			body: JSON.stringify(body),
		});
		assert(r.ok);
		return r.json();
	};
	return {
		directory,
		home,
		requests,
		post,
		base,
		ask: async (folders: string[]) => {
			const p = await post("/api/projects", { name: "P", folders });
			const c = await post(`/api/projects/${p.id}/chats`, { name: "C" });
			const a = await post(`/api/chats/${c.id}`, { prompt: "inspect" });
			await waitForAgent(base, a.agentId);
			return c.id as number;
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("new Agents receive user then deduplicated scoped Git ancestor and non-Git instructions", async () => {
	const f = await fixture();
	try {
		const repo = join(f.directory, "repo"),
			a = join(repo, "a"),
			b = join(repo, "b"),
			plain = join(f.directory, "plain");
		await Promise.all([
			mkdir(join(repo, ".git"), { recursive: true }),
			mkdir(a, { recursive: true }),
			mkdir(b, { recursive: true }),
			mkdir(plain),
		]);
		await Promise.all([
			writeFile(join(f.home, ".weft/AGENTS.md"), "USER-RULE"),
			writeFile(join(f.directory, "AGENTS.md"), "OUTSIDE-RULE"),
			writeFile(join(repo, "AGENTS.md"), "REPO-RULE"),
			writeFile(join(a, "AGENTS.md"), "A-RULE"),
			writeFile(join(b, "AGENTS.override.md"), "B-OVERRIDE"),
			writeFile(join(b, "AGENTS.md"), "B-FALLBACK"),
			writeFile(join(plain, "AGENTS.md"), "PLAIN-RULE"),
		]);
		await f.ask([a, b, plain]);
		const text = f.requests[0].instructions;
		assert(text.indexOf("USER-RULE") < text.indexOf("REPO-RULE"));
		assert(text.indexOf("REPO-RULE") < text.indexOf("A-RULE"));
		assert(text.indexOf("A-RULE") < text.indexOf("B-OVERRIDE"));
		assert(text.indexOf("B-OVERRIDE") < text.indexOf("PLAIN-RULE"));
		assert.equal(text.split("REPO-RULE").length, 2);
		assert(!text.includes("OUTSIDE-RULE"));
		assert(!text.includes("B-FALLBACK"));
		assert(
			text.includes(a) &&
				text.includes(b) &&
				text.includes("Before working on files"),
		);
	} finally {
		await f.close();
	}
});

test("empty override replaces fallback, failed selected override is reported, and later sources survive", async () => {
	const f = await fixture();
	try {
		const empty = join(f.directory, "empty"),
			failed = join(f.directory, "failed"),
			last = join(f.directory, "last");
		await Promise.all([mkdir(empty), mkdir(failed), mkdir(last)]);
		await Promise.all([
			writeFile(join(empty, "AGENTS.override.md"), ""),
			writeFile(join(empty, "AGENTS.md"), "EMPTY-FALLBACK"),
			mkdir(join(failed, "AGENTS.override.md")),
			writeFile(join(failed, "AGENTS.md"), "FAILED-FALLBACK"),
			writeFile(join(last, "AGENTS.md"), "LAST-RULE"),
		]);
		await f.ask([empty, failed, last]);
		const text = f.requests[0].instructions;
		assert(text.includes(join(empty, "AGENTS.override.md")));
		assert(text.includes("Instruction source is not a regular file"));
		assert(
			!text.includes("EMPTY-FALLBACK") && !text.includes("FAILED-FALLBACK"),
		);
		assert(text.includes("LAST-RULE"));
	} finally {
		await f.close();
	}
});

test("the shared UTF-8 budget reports a partial source and every omitted source in order", async () => {
	const f = await fixture();
	try {
		const a = join(f.directory, "a"),
			b = join(f.directory, "b");
		await Promise.all([mkdir(a), mkdir(b)]);
		await Promise.all([
			writeFile(join(f.home, ".weft/AGENTS.md"), "U".repeat(32765)),
			writeFile(join(a, "AGENTS.md"), "ééA-END"),
			writeFile(join(b, "AGENTS.md"), "B-OMITTED"),
		]);
		await f.ask([a, b]);
		const text = f.requests[0].instructions;
		assert(text.includes("é\n[Incomplete"));
		assert(!text.includes("�"));
		assert(!text.includes("A-END") && !text.includes("B-OMITTED"));
		assert(
			text.includes(join(b, "AGENTS.md")) &&
				text.includes("Not loaded: shared 32768-byte"),
		);
	} finally {
		await f.close();
	}
});

test("instruction symlinks outside named sources need ordinary permission and never fall back", async () => {
	const f = await fixture();
	try {
		const root = join(f.directory, "target"),
			secret = join(f.directory, "private.txt");
		await mkdir(root);
		await writeFile(secret, "PRIVATE-UNAUTHORIZED");
		await symlink(secret, join(root, "AGENTS.override.md"));
		await writeFile(join(root, "AGENTS.md"), "FORBIDDEN-FALLBACK");
		await f.ask([root]);
		const text = f.requests[0].instructions;
		assert(text.includes("requires ordinary file authorization"));
		assert(
			!text.includes("PRIVATE-UNAUTHORIZED") &&
				!text.includes("FORBIDDEN-FALLBACK"),
		);
		const update = await fetch(`${f.base}/api/access-defaults`, {
			method: "PATCH",
			body: JSON.stringify({ fileAccess: "full" }),
		});
		assert.equal(update.status, 200);
		await f.ask([root]);
		assert(f.requests.at(-1)?.instructions.includes("PRIVATE-UNAUTHORIZED"));
	} finally {
		await f.close();
	}
});

test("Sub-agents reload user rules while their running parent keeps its initial rules", async () => {
	let f: Awaited<ReturnType<typeof fixture>>;
	let count = 0;
	f = await fixture(async () => {
		if (count++ === 0) {
			await writeFile(join(f.home, ".weft/AGENTS.md"), "USER-NEW");
			return completedResponse({
				output: [
					{
						type: "function_call",
						name: "create_sub_agent",
						call_id: "delegate",
						arguments: JSON.stringify({
							prompt: "child task",
							context: "explicit background",
						}),
					},
				],
			});
		}
		return completedResponse({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "done" }] },
			],
		});
	});
	try {
		await writeFile(join(f.home, ".weft/AGENTS.md"), "USER-OLD");
		const chat = await f.ask([]);
		assert(f.requests.length >= 3);
		const child = f.requests.find((r) =>
			r.input.some(
				(item: { role?: string; content?: unknown }) =>
					item.role === "user" && item.content === "child task",
			),
		);
		assert(child);
		assert(
			child.instructions.includes("USER-NEW") &&
				!child.instructions.includes("USER-OLD"),
		);
		const parent = f.requests.filter(
			(r) =>
				!r.input.some(
					(item: { role?: string; content?: unknown }) =>
						item.role === "user" && item.content === "child task",
				),
		);
		assert(
			parent.every(
				(r) =>
					r.instructions.includes("USER-OLD") &&
					!r.instructions.includes("USER-NEW"),
			),
		);
		const next = await f.post(`/api/chats/${chat}`, { prompt: "fresh root" });
		await waitForAgent(f.base, next.agentId);
		assert(f.requests.at(-1)?.instructions.includes("USER-NEW"));
	} finally {
		await f.close();
	}
});

test("local first reads see current contents and initial ancestor access does not grant reference reads", {
	skip: platform() !== "darwin",
}, async () => {
	let f: Awaited<ReturnType<typeof fixture>>;
	let root: string, deep: string;
	let count = 0;
	f = await fixture(async (body) => {
		if (count++ === 0) {
			await writeFile(join(deep, "AGENTS.md"), "LOCAL-CURRENT");
			return completedResponse({
				output: [
					{
						type: "function_call",
						name: "read_file",
						call_id: "local",
						arguments: JSON.stringify({ path: join(deep, "AGENTS.md") }),
					},
					{
						type: "function_call",
						name: "read_file",
						call_id: "reference",
						arguments: JSON.stringify({ path: join(root, "README.md") }),
					},
				],
			});
		}
		assert(JSON.stringify(body.input).includes("LOCAL-CURRENT"));
		assert(!JSON.stringify(body.input).includes("PRIVATE-REFERENCE-CONTENT"));
		return completedResponse({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "done" }] },
			],
		});
	});
	try {
		root = join(f.directory, "repo");
		const target = join(root, "target");
		deep = join(target, "deep");
		await mkdir(join(root, ".git"), { recursive: true });
		await mkdir(deep, { recursive: true });
		await writeFile(join(root, "AGENTS.md"), "ANCESTOR-READ-EXCEPTION");
		await writeFile(join(root, "README.md"), "PRIVATE-REFERENCE-CONTENT");
		await writeFile(join(deep, "AGENTS.md"), "LOCAL-INITIAL");
		await f.ask([target]);
		assert(f.requests[0].instructions.includes("ANCESTOR-READ-EXCEPTION"));
		assert(!f.requests[0].instructions.includes("LOCAL-INITIAL"));
		assert.equal(f.requests.length, 2);
	} finally {
		await f.close();
	}
});
