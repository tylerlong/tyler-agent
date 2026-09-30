import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/server.ts";

test("two SSE clients see creations and debug changes; reconnection reads current shared state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-sse-"));
	process.env.OPENROUTER_API_KEY = "test";
	process.env.OPENROUTER_MODEL = "test";
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server = createServer(
		async () => {
			await held;
			return Response.json({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "answer" }],
					},
				],
			});
		},
		false,
		join(directory, "db.sqlite"),
	).listen(0, "127.0.0.1");
	const controllers: AbortController[] = [];
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		async function connect() {
			const controller = new AbortController();
			controllers.push(controller);
			const response = await fetch(`${base}/api/events`, {
				signal: controller.signal,
			});
			assert(response.body);
			const reader = response.body.getReader();
			let buffer = "";
			async function next() {
				while (!buffer.includes("\n\n")) {
					const chunk = await reader.read();
					assert(!chunk.done);
					buffer += new TextDecoder().decode(chunk.value);
				}
				const end = buffer.indexOf("\n\n");
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				return frame;
			}
			assert.equal(await next(), ": connected");
			return { next, controller };
		}
		const first = await connect();
		const second = await connect();
		assert.deepEqual(await (await fetch(`${base}/api/debug`)).json(), {
			enabled: false,
		});
		const project = await (
			await fetch(`${base}/api/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "Work", folders: [directory] }),
			})
		).json();
		assert.deepEqual(await Promise.all([first.next(), second.next()]), [
			"data: changed",
			"data: changed",
		]);
		const chat = await (
			await fetch(`${base}/api/projects/${project.id}/chats`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "Question" }),
			})
		).json();
		assert.deepEqual(await Promise.all([first.next(), second.next()]), [
			"data: changed",
			"data: changed",
		]);
		const pending = fetch(`${base}/api/chats/${chat.id}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "question" }),
		});
		await Promise.all([first.next(), second.next()]);
		assert.equal(
			(await (await fetch(`${base}/api/chats/${chat.id}`)).json()).busy,
			true,
		);
		release();
		assert.equal((await pending).status, 200);
		await Promise.all([first.next(), second.next()]);
		const shared = await (await fetch(`${base}/api/chats/${chat.id}`)).json();
		assert.equal(shared.busy, false);
		assert.equal(shared.messages.length, 2);
		first.controller.abort();
		const reconnected = await connect();
		assert.equal(
			(await (await fetch(`${base}/api/projects`)).json()).projects[0].chats
				.length,
			1,
		);
		await fetch(`${base}/api/debug`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		assert.deepEqual(await Promise.all([second.next(), reconnected.next()]), [
			"data: changed",
			"data: changed",
		]);
		assert.deepEqual(await (await fetch(`${base}/api/debug`)).json(), {
			enabled: true,
		});
		assert.equal(
			(
				await fetch(`${base}/api/debug`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabled: "yes" }),
				})
			).status,
			400,
		);
	} finally {
		for (const controller of controllers) controller.abort();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
