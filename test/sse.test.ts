import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/server.ts";

test("two clients receive state invalidations and a reconnect reads the latest state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "tyler-agent-sse-"));
	const databasePath = join(directory, `${randomUUID()}.sqlite`);
	const previousKey = process.env.OPENROUTER_API_KEY;
	const previousModel = process.env.OPENROUTER_MODEL;
	process.env.OPENROUTER_API_KEY = "test-key";
	process.env.OPENROUTER_MODEL = "test-model";
	const server = createServer(
		async () =>
			Response.json({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "answer" }],
					},
				],
			}),
		false,
		databasePath,
	).listen(0, "127.0.0.1");
	const clients: AbortController[] = [];
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		async function connect() {
			const controller = new AbortController();
			clients.push(controller);
			const response = await fetch(`${base}/api/events`, {
				signal: controller.signal,
			});
			assert.equal(response.status, 200);
			assert.match(
				response.headers.get("content-type") ?? "",
				/^text\/event-stream/,
			);
			assert(response.body);
			const reader = response.body.getReader();
			let buffer = "";
			async function nextFrame() {
				while (!buffer.includes("\n\n")) {
					const chunk = await reader.read();
					assert.equal(chunk.done, false);
					buffer += new TextDecoder().decode(chunk.value);
				}
				const boundary = buffer.indexOf("\n\n");
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				return frame;
			}
			assert.equal(await nextFrame(), ": connected");
			return { controller, nextFrame };
		}

		const first = await connect();
		const second = await connect();
		const debug = await fetch(`${base}/api/debug`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		assert.equal(debug.status, 200);
		assert.deepEqual(
			await Promise.all([first.nextFrame(), second.nextFrame()]),
			["data: changed", "data: changed"],
		);
		assert.deepEqual(await (await fetch(`${base}/api/debug`)).json(), {
			enabled: true,
		});

		const task = await fetch(`${base}/api/task`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ folder: directory, prompt: "question" }),
		});
		assert.equal(task.status, 200);
		for (const client of [first, second]) {
			assert.equal(await client.nextFrame(), "data: changed");
			assert.equal(await client.nextFrame(), "data: changed");
		}
		assert.deepEqual(await (await fetch(`${base}/api/chat`)).json(), {
			messages: [
				{ role: "user", content: "question" },
				{ role: "assistant", content: "answer" },
			],
			folder: directory,
		});

		first.controller.abort();
		const reconnected = await connect();
		assert.deepEqual(await (await fetch(`${base}/api/chat`)).json(), {
			messages: [
				{ role: "user", content: "question" },
				{ role: "assistant", content: "answer" },
			],
			folder: directory,
		});
		assert.deepEqual(await (await fetch(`${base}/api/debug`)).json(), {
			enabled: true,
		});
		reconnected.controller.abort();
	} finally {
		for (const client of clients) client.abort();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
		if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
		else process.env.OPENROUTER_MODEL = previousModel;
	}
});
