import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { completedResponse } from "./model-fixture.ts";

test("history restores a same-request pair across all statuses and pages, skipping unreadable calls only", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-options-"));
	const path = join(directory, "db.sqlite");
	const server = createTestServer(
		async () => completedResponse({ output: [] }),
		path,
	).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const post = (route: string, body: unknown) =>
			fetch(base + route, { method: "POST", body: JSON.stringify(body) }).then(
				(response) => response.json(),
			);
		const project = await post("/api/projects", { name: "P", folders: [] });
		const chat = await post(`/api/projects/${project.id}/chats`, { name: "C" });
		const route = `/api/chats/${chat.id}`;
		const options = (query = "") =>
			fetch(base + route + query)
				.then((response) => response.json())
				.then((body) => body.chatOptions);
		assert.deepEqual(await options(), {
			modelId: "test",
			reasoningEffort: null,
		});
		const db = new DatabaseSync(path);
		try {
			const agent = (status: string) =>
				Number(
					db
						.prepare(
							"INSERT INTO agents(chat_id,prompt,status,created_at) VALUES (?,'Q',?,0)",
						)
						.run(chat.id, status).lastInsertRowid,
				);
			const call = (id: number, body: string, status = "failed") =>
				db
					.prepare(
						"INSERT INTO model_calls(agent_id,url,method,requested_at,request_body,status) VALUES (?,'url','POST','now',?,?)",
					)
					.run(id, body, status);
			const oldest = agent("failed");
			call(
				oldest,
				JSON.stringify({ model: "old", reasoning: { effort: "high" } }),
			);
			for (let i = 0; i < 12; i++) {
				const id = agent("failed");
				call(id, i % 2 ? "{" : JSON.stringify({ model: " " }));
			}
			assert.deepEqual(await options(), {
				modelId: "old",
				reasoningEffort: "high",
			});
			assert.deepEqual(await options(`?before=${oldest + 2}`), {
				modelId: "old",
				reasoningEffort: "high",
			});
			const pending = agent("pending");
			call(
				pending,
				JSON.stringify({ model: "test", reasoning: { effort: "unsupported" } }),
				"pending",
			);
			assert.deepEqual(await options(), {
				modelId: "test",
				reasoningEffort: "unsupported",
			});
			call(pending, JSON.stringify({ model: "removed" }), "pending");
			assert.deepEqual(await options(), {
				modelId: "removed",
				reasoningEffort: null,
			});
			call(
				agent("succeeded"),
				JSON.stringify({ model: "test", reasoning: { effort: "low" } }),
				"succeeded",
			);
			assert.deepEqual(await options(), {
				modelId: "test",
				reasoningEffort: "low",
			});
			db.prepare("UPDATE settings SET default_model_id=NULL").run();
			assert.deepEqual(await options(), {
				modelId: "test",
				reasoningEffort: "low",
			});
		} finally {
			db.close();
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("chosen model/effort are validated before acceptance and immutable through busy edits, key rotation and deletion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-override-"));
	const path = join(directory, "db.sqlite");
	const requests: { model: string; reasoning?: { effort: string } }[] = [];
	let started: () => void = () => {};
	const start = new Promise<void>((resolve) => {
		started = resolve;
	});
	let release: () => void = () => {};
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	let fail = true;
	const server = createTestServer(async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)));
		if (requests.length === 1) {
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				"Bearer test",
			);
			started();
			await hold;
			return new Response("test", { status: 500 });
		}
		if (fail) return new Response("bad", { status: 500 });
		return completedResponse({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "A" }] },
			],
		});
	}, path).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const request = (route: string, method = "GET", body?: unknown) =>
			fetch(base + route, {
				method,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		const project = await (
			await request("/api/projects", "POST", { name: "P", folders: [] })
		).json();
		const chat = await (
			await request(`/api/projects/${project.id}/chats`, "POST", { name: "C" })
		).json();
		const route = `/api/chats/${chat.id}`;
		const db = new DatabaseSync(path);
		try {
			const add = (
				id: string,
				supportedEfforts?: string[] | null,
				reasoningRequired = false,
			) =>
				db
					.prepare("INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?)")
					.run(
						id,
						id,
						JSON.stringify({
							supportedEfforts,
							reasoningRequired,
							catalogMissing: false,
						}),
					);
			add("chosen", ["low", "high"]);
			add("plain");
			add("gateway", null, true);
			for (const body of [
				{ prompt: "Q" },
				{ prompt: "Q", modelId: "missing" },
				{ prompt: "Q", modelId: "chosen", reasoningEffort: "medium" },
				{ prompt: "Q", modelId: "chosen", reasoningEffort: 4 },
				{ prompt: "Q", modelId: "plain", reasoningEffort: "low" },
				{ prompt: "Q", modelId: "gateway", reasoningEffort: "none" },
			]) {
				assert.equal((await request(route, "POST", body)).status, 400);
			}
			assert.equal(
				db.prepare("SELECT COUNT(*) AS count FROM agents").get()?.count,
				0,
			);
			assert.equal(requests.length, 0);
			const pending = request(route, "POST", {
				prompt: "Q test",
				modelId: "chosen",
				reasoningEffort: "high",
			});
			await start;
			assert.deepEqual((await (await request(route)).json()).chatOptions, {
				modelId: "chosen",
				reasoningEffort: "high",
			});
			assert.equal(
				(await request(route, "POST", { prompt: "next", modelId: "plain" }))
					.status,
				409,
			);
			db.prepare("UPDATE settings SET api_key='new-key'").run();
			db.prepare("DELETE FROM managed_models WHERE id='chosen'").run();
			release();
			const accepted = await pending;
			assert.equal(accepted.status, 202);
			assert.equal(
				(await waitForAgent(base, (await accepted.json()).agentId)).status,
				"failed",
			);
			assert.deepEqual(requests[0].reasoning, { effort: "high" });
			assert.equal(requests[0].model, "chosen");
			const history = await (await request(route)).json();
			assert.equal(history.agents[0].question, "Q [REDACTED]");
			assert.deepEqual(history.chatOptions, {
				modelId: "chosen",
				reasoningEffort: "high",
			});
			assert.doesNotMatch(
				await (
					await request(`/api/agents/${history.agents[0].id}/calls`)
				).text(),
				/"test"/,
			);
			fail = false;
			const plain = await request(route, "POST", {
				prompt: "Q",
				modelId: "plain",
				reasoningEffort: null,
			});
			assert.equal(plain.status, 202);
			await waitForAgent(base, (await plain.json()).agentId);
			assert(!("reasoning" in requests[1]));
			const gateway = await request(route, "POST", {
				prompt: "Q",
				modelId: "gateway",
				reasoningEffort: "xhigh",
			});
			assert.equal(gateway.status, 202);
			await waitForAgent(base, (await gateway.json()).agentId);
			assert.deepEqual(requests[2].reasoning, { effort: "xhigh" });
			assert.deepEqual((await (await request(route)).json()).chatOptions, {
				modelId: "gateway",
				reasoningEffort: "xhigh",
			});
		} finally {
			db.close();
		}
	} finally {
		release();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
