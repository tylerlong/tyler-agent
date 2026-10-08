import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer as createServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

test("stable ten-agent pages and forward catch-up preserve complete model context", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-pages-"));
	let lastInput: { content: string }[] = [];
	const server = createServer(
		async (_url, options) => {
			lastInput = JSON.parse(String(options?.body)).input;
			return completedResponse({
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
		const post = async (path: string, data: unknown) =>
			(
				await fetch(base + path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(data),
				})
			).json();
		const project = await post("/api/projects", { name: "Work", folders: [] });
		const chat = await post(`/api/projects/${project.id}/chats`, { name: "A" });
		const path = `/api/chats/${chat.id}`;
		for (let i = 1; i <= 25; i++) {
			const accepted = await post(path, {
				modelId: "test",
				prompt: `Question ${i}`,
			});
			await waitForAgent(base, accepted.agentId);
		}
		const read = async (query = "") =>
			(await fetch(base + path + query)).json();
		const latest = await read();
		assert.equal(latest.agents.length, 10);
		assert.equal(latest.agents[0].question, "Question 16");
		assert.equal(latest.hasMore, true);
		assert.equal(latest.messages.length, 20);
		assert(!JSON.stringify(latest).includes("requestBody"));
		const accepted = await post(path, {
			modelId: "test",
			prompt: "Question 26",
		});
		await waitForAgent(base, accepted.agentId);
		const older = await read(`?before=${latest.agents[0].id}`);
		assert.deepEqual(
			older.agents.map((agent: { question: string }) => agent.question),
			Array.from({ length: 10 }, (_, i) => `Question ${i + 6}`),
		);
		const first = await read(`?before=${older.agents[0].id}`);
		assert.equal(first.agents.length, 5);
		assert.equal(first.hasMore, false);
		const forward = await read(`?after=${first.agents.at(-1).id}`);
		assert.equal(forward.agents.length, 10);
		assert.equal(forward.agents[0].question, "Question 6");
		assert.equal(forward.hasMoreNewer, true);
		const finish = await read(`?after=${forward.agents.at(-1).id}`);
		assert.equal(finish.agents[0].question, "Question 16");
		assert.equal(lastInput.length, 51);
		assert.equal(lastInput[0]?.content, "Question 1");
		assert.equal(lastInput.at(-1)?.content, "Question 26");
		assert.equal((await fetch(`${base}${path}?before=bad`)).status, 400);
		assert.equal((await fetch(`${base}${path}?before=1&after=2`)).status, 400);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
