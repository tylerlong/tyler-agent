import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTestServer } from "./config-fixture.ts";
import { completedResponse } from "./model-fixture.ts";
import { waitForTurn } from "./turn-fixture.ts";

test("HTTP submission acknowledges its durable pending turn before the held model completes", {
	timeout: 10000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "accepted-turn-"));
	const path = join(directory, "db.sqlite");
	let release: (() => void) | undefined;
	let calls = 0;
	const server = createTestServer(async () => {
		calls++;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return completedResponse({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "answer" }] },
			],
		});
	}, path).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const post = (route: string, body: unknown) =>
		fetch(base + route, {
			method: "POST",
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(2000),
		});
	try {
		const project = await (
			await post("/api/projects", { name: "P", folders: [] })
		).json();
		const chat = await (
			await post(`/api/projects/${project.id}/chats`, { name: "C" })
		).json();
		const response = await post(`/api/chats/${chat.id}`, {
			modelId: "test",
			prompt: "question",
		});
		assert.equal(response.status, 202);
		const accepted = await response.json();
		assert.deepEqual(Object.keys(accepted), ["turnId"]);
		assert.equal(typeof accepted.turnId, "number");
		const db = new DatabaseSync(path);
		try {
			assert.deepEqual(
				{
					...db
						.prepare("SELECT chat_id,user_content,status FROM turns WHERE id=?")
						.get(accepted.turnId),
				},
				{ chat_id: chat.id, user_content: "question", status: "pending" },
			);
		} finally {
			db.close();
		}
		const pending = await (
			await fetch(`${base}/api/turns/${accepted.turnId}`)
		).json();
		assert.equal(pending.busy, true);
		assert.equal(pending.turns[0].status, "pending");
		assert.equal(
			(
				await post(`/api/chats/${chat.id}`, {
					modelId: "test",
					prompt: "duplicate",
				})
			).status,
			409,
		);
		while (!release) await new Promise((resolve) => setImmediate(resolve));
		release();
		const turn = await waitForTurn(base, accepted.turnId);
		assert.equal(turn.status, "succeeded");
		assert.equal(calls, 1);
	} finally {
		release?.();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
