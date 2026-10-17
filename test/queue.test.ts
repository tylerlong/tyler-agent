import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

test("Queue stays outside Agent history until success advances FIFO, with duplicate acceptance", async () => {
	const directory = await mkdtemp(join(tmpdir(), "weft-queue-"));
	const requests: string[] = [];
	const gates: (() => void)[] = [];
	const server = createTestServer(
		async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)).input.at(-1).content);
			await new Promise<void>((resolve) => gates.push(resolve));
			return completedResponse({
				output: [
					{ type: "message", content: [{ type: "output_text", text: "done" }] },
				],
			});
		},
		join(directory, "db.sqlite"),
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const post = async (path: string, body: unknown) =>
		fetch(base + path, { method: "POST", body: JSON.stringify(body) });
	const read = async (path: string) => (await fetch(base + path)).json();
	const until = async (check: () => Promise<boolean>) => {
		for (let n = 0; n < 200; n++) {
			if (await check()) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.fail("state did not settle");
	};
	try {
		const project = await (
			await post("/api/projects", { name: "P", folders: [] })
		).json();
		const chat = await (
			await post(`/api/projects/${project.id}/chats`, { name: "C" })
		).json();
		const path = `/api/chats/${chat.id}`;
		await post(path, { prompt: "A" });
		await until(async () => gates.length === 1);
		const b = await (
			await post(path, { prompt: "B", intent: "queue", submissionId: "B" })
		).json();
		assert.equal(typeof b.queueId, "string");
		assert.deepEqual(
			await (
				await post(path, { prompt: "B", intent: "queue", submissionId: "B" })
			).json(),
			b,
		);
		await post(path, { prompt: "C", intent: "queue", submissionId: "C" });
		assert.deepEqual(requests, ["A"]);
		let state = await read(path);
		assert.equal(state.agents.length, 1);
		assert.deepEqual(
			state.queue.map((item: { prompt: string }) => item.prompt),
			["B", "C"],
		);
		gates[0]();
		await until(async () => gates.length === 2);
		state = await read(path);
		assert.equal(state.agents.length, 2);
		assert.equal(state.queue.length, 1);
		gates[1]();
		await until(async () => gates.length === 3);
		gates[2]();
		await until(async () => !(await read(path)).busy);
		assert.deepEqual(requests, ["A", "B", "C"]);
		assert.deepEqual((await read(path)).queue, []);
		assert.deepEqual(await read(`${path}/submissions/B`), b);
		let finishLate!: () => void;
		const lateStatus = new Promise<number>((resolve, reject) => {
			const pending = request(
				base + path,
				{
					method: "POST",
					headers: {
						origin: base,
						"x-tyler-management-token": server.managementToken,
					},
				},
				(response) => {
					response.resume();
					resolve(response.statusCode ?? 0);
				},
			);
			pending.on("error", reject);
			pending.write('{"prompt":');
			finishLate = () => pending.end('"late arrival","submissionId":"late"}');
		});
		assert.equal((await post(`${path}/submissions/late`, {})).status, 404);
		finishLate();
		assert.equal(await lateStatus, 409);
		assert.deepEqual(requests, ["A", "B", "C"]);
	} finally {
		for (const release of gates) release();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
