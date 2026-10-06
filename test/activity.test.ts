import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer as createServer } from "./config-fixture.ts";
import { completedResponse } from "./model-fixture.ts";

test("accepted questions sort immediately, failures count, rejected questions and answers do not; activity survives restart", async (context) => {
	const start = Date.now();
	let time = start;
	context.mock.method(Date, "now", () => time);
	const directory = await mkdtemp(join(tmpdir(), "agent-activity-"));
	const path = join(directory, "db.sqlite");
	let release!: () => void;
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let fail = false;
	let pending: Promise<Response> | undefined;
	const model: typeof fetch = async () => {
		enter();
		await held;
		if (fail) return new Response("failed", { status: 500 });
		return completedResponse({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "answer" }] },
			],
		});
	};
	let server = createServer(model, path).listen(0, "127.0.0.1");
	async function base() {
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	}
	let url = await base();
	const post = (route: string, body: unknown) =>
		fetch(url + route, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const list = async () =>
		(await (await fetch(`${url}/api/projects`)).json()).projects;
	try {
		const project = async (name: string) =>
			(await post("/api/projects", { name, folders: [directory] })).json();
		const chat = async (id: number, name: string) =>
			(await post(`/api/projects/${id}/chats`, { name })).json();
		const work = await project("Work");
		const a = await chat(work.id, "A");
		const b = await chat(work.id, "B");
		const empty = await project("Empty");
		// Equal creation times sort deterministically by descending IDs.
		assert.deepEqual(
			(await list()).map((p: { id: number }) => p.id),
			[empty.id, work.id],
		);
		assert.deepEqual(
			(await list())[1].chats.map((c: { id: number }) => c.id),
			[b.id, a.id],
		);
		time = start + 100;
		const newer = await project("Newer empty");
		time = start + 200;
		pending = post(`/api/chats/${a.id}`, {
			modelId: "test",
			prompt: "question",
		});
		await entered;
		let projects = await list();
		assert.deepEqual(
			projects.map((p: { id: number }) => p.id),
			[work.id, newer.id, empty.id],
		);
		assert.deepEqual(
			projects[0].chats.map((c: { id: number }) => c.id),
			[a.id, b.id],
		);
		assert.equal(projects[0].chats[0].lastQuestionAt, start + 200);
		assert.equal(projects[0].chats[0].busy, true);
		time = start + 300;
		assert.equal(
			(await post(`/api/chats/${a.id}`, { modelId: "test", prompt: "busy" }))
				.status,
			409,
		);
		assert.equal(
			(await post(`/api/chats/${b.id}`, { modelId: "test", prompt: " " }))
				.status,
			400,
		);
		assert.equal(
			(await post("/api/chats/999", { modelId: "test", prompt: "unknown" }))
				.status,
			404,
		);
		assert.deepEqual(await list(), projects);
		release();
		const accepted = await pending;
		assert.equal(accepted.status, 202);
		await waitForAgent(url, (await accepted.json()).agentId);
		projects = await list();
		assert.equal(projects[0].chats[0].lastQuestionAt, start + 200);
		assert.equal(projects[0].chats[0].busy, false);
		time = start + 400;
		fail = true;
		const failed = await post(`/api/chats/${b.id}`, {
			modelId: "test",
			prompt: "failed question",
		});
		assert.equal(failed.status, 202);
		assert.equal(
			(await waitForAgent(url, (await failed.json()).agentId)).status,
			"failed",
		);
		projects = await list();
		assert.deepEqual(
			projects[0].chats.map((c: { id: number }) => c.id),
			[b.id, a.id],
		);
		assert.equal(projects[0].chats[0].lastQuestionAt, start + 400);
		assert.equal(
			(await (await fetch(`${url}/api/chats/${b.id}`)).json()).messages.length,
			2,
		);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = createServer(model, path).listen(0, "127.0.0.1");
		url = await base();
		assert.deepEqual(await list(), projects);
	} finally {
		release();
		await pending;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
