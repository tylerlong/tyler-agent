import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createServer } from "../src/server.ts";

test("chat histories are isolated; busy rejects duplicates and allows parallel chats; failures release busy", async () => {
	process.env.OPENROUTER_API_KEY = "test";
	process.env.OPENROUTER_MODEL = "test";
	const directory = await mkdtemp(join(tmpdir(), "agent-chat-"));
	const inputs: unknown[] = [];
	let release: (() => void) | undefined;
	let fail = false;
	const server = createServer(
		async (_url, options) => {
			inputs.push(JSON.parse(String(options?.body)).input);
			if (inputs.length === 1)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			if (fail) return new Response("broken", { status: 500 });
			return Response.json({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "Answer" }],
					},
				],
			});
		},
		join(directory, "db.sqlite"),
	).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const post = (path: string, body: unknown) =>
			fetch(base + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const project = await (
			await post("/api/projects", { name: "Work", folders: [directory] })
		).json();
		const a = await (
			await post(`/api/projects/${project.id}/chats`, { name: "A" })
		).json();
		const b = await (
			await post(`/api/projects/${project.id}/chats`, { name: "B" })
		).json();
		assert.equal((await fetch(`${base}/api/chats/999`)).status, 404);
		assert.equal(
			(await post(`/api/chats/${a.id}`, { prompt: " " })).status,
			400,
		);
		const first = post(`/api/chats/${a.id}`, { prompt: "first" });
		while (!release) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(
			(await (await fetch(`${base}/api/chats/${a.id}`)).json()).busy,
			true,
		);
		assert.equal(
			(await post(`/api/chats/${a.id}`, { prompt: "duplicate" })).status,
			409,
		);
		assert.equal(
			(await post(`/api/chats/${b.id}`, { prompt: "separate" })).status,
			200,
		);
		release();
		assert.equal((await first).status, 200);
		assert.equal(
			(await post(`/api/chats/${a.id}`, { prompt: "followup" })).status,
			200,
		);
		assert.deepEqual(inputs, [
			[{ role: "user", content: "first" }],
			[{ role: "user", content: "separate" }],
			[
				{ role: "user", content: "first" },
				{ role: "assistant", content: "Answer" },
				{ role: "user", content: "followup" },
			],
		]);
		fail = true;
		assert.equal(
			(await post(`/api/chats/${a.id}`, { prompt: "failure" })).status,
			502,
		);
		const saved = await (await fetch(`${base}/api/chats/${a.id}`)).json();
		assert.equal(saved.messages.length, 4);
		assert.equal(saved.busy, false);
		fail = false;
		assert.equal(
			(await post(`/api/chats/${a.id}`, { prompt: "retry" })).status,
			200,
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("all model and database failures preserve complete history and release chat lock; restart preserves successful history", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-chat-fail-"));
	const path = join(directory, "db.sqlite");
	process.env.OPENROUTER_API_KEY = "test";
	process.env.OPENROUTER_MODEL = "test";
	let mode = "ok";
	const fake: typeof fetch = async () => {
		if (mode === "network") throw new Error("offline");
		if (mode === "parse") return new Response("{");
		if (mode === "empty") return Response.json({ output: [] });
		return Response.json({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "saved" }] },
			],
		});
	};
	let server = createServer(fake, path).listen(0, "127.0.0.1");
	async function base() {
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	}
	try {
		const folder = join(directory, "folder");
		await mkdir(folder);
		let url = await base();
		const post = (route: string, body: unknown) =>
			fetch(url + route, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const project = await (
			await post("/api/projects", { name: "Work", folders: [folder] })
		).json();
		const chat = await (
			await post(`/api/projects/${project.id}/chats`, { name: "Chat" })
		).json();
		const route = `/api/chats/${chat.id}`;
		assert.equal((await post(route, { prompt: "saved question" })).status, 200);
		for (mode of ["network", "parse", "empty", "db"]) {
			const db = new DatabaseSync(path);
			if (mode === "db")
				db.exec(
					"CREATE TRIGGER reject_turn BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT,'write failed'); END",
				);
			try {
				assert.equal(
					(await post(route, { prompt: "failed question" })).status,
					mode === "db" ? 500 : 502,
				);
				const state = await (await fetch(url + route)).json();
				assert.equal(state.messages.length, 2);
				assert.equal(state.busy, false);
			} finally {
				if (mode === "db") db.exec("DROP TRIGGER reject_turn");
				db.close();
			}
		}
		mode = "ok";
		await rm(folder, { recursive: true });
		assert.equal((await post(route, { prompt: "retry" })).status, 200);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = createServer(fake, path).listen(0, "127.0.0.1");
		url = await base();
		const state = await (await fetch(url + route)).json();
		assert.equal(state.messages.length, 4);
		assert.equal(state.busy, false);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
