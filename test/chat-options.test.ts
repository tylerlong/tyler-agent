import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

async function fixture(
	fetchModel: typeof fetch = async () => completedResponse({ output: [] }),
) {
	const directory = await mkdtemp(join(tmpdir(), "agent-options-"));
	const path = join(directory, "db.sqlite");
	let server = createTestServer(fetchModel, path).listen(0, "127.0.0.1");
	let base = "";
	const address = async () => {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const value = server.address();
		assert(value && typeof value !== "string");
		base = `http://127.0.0.1:${value.port}`;
	};
	await address();
	const request = (route: string, method = "GET", body?: unknown) =>
		fetch(base + route, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const json = async (route: string, method = "GET", body?: unknown) => {
		const response = await request(route, method, body);
		assert(response.ok, `${method} ${route}: ${response.status}`);
		return response.json();
	};
	const project = await json("/api/projects", "POST", {
		name: "P",
		folders: [],
	});
	const chat = await json(`/api/projects/${project.id}/chats`, "POST", {
		name: "C",
	});
	const db = new DatabaseSync(path);
	return {
		db,
		project,
		chat,
		request,
		json,
		wait: (id: number) => waitForAgent(base, id),
		restart: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			server = createTestServer(fetchModel, path).listen(0, "127.0.0.1");
			await address();
		},
		close: async () => {
			db.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}
function addModel(
	db: DatabaseSync,
	id: string,
	efforts: string[] | null = ["low", "high"],
) {
	db.prepare("INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?)").run(
		id,
		id,
		JSON.stringify({
			supportedEfforts: efforts,
			reasoningRequired: false,
			catalogMissing: false,
		}),
	);
}

test("Chat choices persist independently across restart and never restore historical request choices", async () => {
	const f = await fixture();
	try {
		const route = `/api/chats/${f.chat.id}`;
		assert.deepEqual((await f.json(route)).chatOptions, {
			fileAccess: "restricted",
			networkAccess: "restricted",
			modelId: "test",
			reasoningEffort: null,
		});
		addModel(f.db, "second");
		const other = await f.json(`/api/projects/${f.project.id}/chats`, "POST", {
			name: "Other",
		});
		assert.equal(
			(
				await f.request(route, "PUT", {
					modelId: "second",
					reasoningEffort: "high",
				})
			).status,
			200,
		);
		await f.json(route, "PUT", { name: "Renamed" });
		const agent = f.db
			.prepare(
				"INSERT INTO agents(chat_id,prompt,status,created_at) VALUES (?,'Q','failed',0)",
			)
			.run(f.chat.id).lastInsertRowid;
		f.db
			.prepare(
				"INSERT INTO model_calls(agent_id,url,method,requested_at,request_body,status) VALUES (?,'url','POST','now',?,'failed')",
			)
			.run(
				agent,
				JSON.stringify({ model: "old", reasoning: { effort: "low" } }),
			);
		for (const query of ["", "?before=999"])
			assert.deepEqual((await f.json(route + query)).chatOptions, {
				fileAccess: "restricted",
				networkAccess: "restricted",
				modelId: "second",
				reasoningEffort: "high",
			});
		assert.deepEqual((await f.json(`/api/chats/${other.id}`)).chatOptions, {
			fileAccess: "restricted",
			networkAccess: "restricted",
			modelId: "test",
			reasoningEffort: null,
		});
		await f.restart();
		assert.deepEqual((await f.json(route)).chatOptions, {
			fileAccess: "restricted",
			networkAccess: "restricted",
			modelId: "second",
			reasoningEffort: "high",
		});
		assert.equal(
			f.db.prepare("SELECT name FROM chats WHERE id=?").get(f.chat.id)?.name,
			"Renamed",
		);
	} finally {
		await f.close();
	}
});

test("Chat PUT validates choices, preserves omitted fields, clears deleted references and GET never fills them", async () => {
	const f = await fixture();
	try {
		const route = `/api/chats/${f.chat.id}`;
		addModel(f.db, "second");
		for (const options of [
			{ modelId: "missing" },
			{ modelId: 4 },
			{ reasoningEffort: 4 },
			{ reasoningEffort: "unsupported" },
		])
			assert.equal((await f.request(route, "PUT", options)).status, 400);
		await f.json(route, "PUT", { reasoningEffort: "high" });
		await f.json(route, "PUT", { name: "Renamed" });
		assert.deepEqual((await f.json(route)).chatOptions, {
			fileAccess: "restricted",
			networkAccess: "restricted",
			modelId: "test",
			reasoningEffort: "high",
		});
		await f.json("/api/model-settings", "PUT", { defaultModelId: "second" });
		assert.deepEqual((await f.json(route)).chatOptions, {
			fileAccess: "restricted",
			networkAccess: "restricted",
			modelId: "test",
			reasoningEffort: "high",
		});
		await f.json("/api/models/test", "DELETE");
		for (let i = 0; i < 2; i++)
			assert.deepEqual((await f.json(route)).chatOptions, {
				fileAccess: "restricted",
				networkAccess: "restricted",
				modelId: null,
				reasoningEffort: null,
			});
		const activity = f.db
			.prepare("SELECT created_at FROM chats WHERE id=?")
			.get(f.chat.id)?.created_at;
		await f.json(route, "PUT", { modelId: "second" });
		assert.equal(
			f.db.prepare("SELECT created_at FROM chats WHERE id=?").get(f.chat.id)
				?.created_at,
			activity,
		);
		await f.json(route, "PUT", { reasoningEffort: "low" });
		await f.json(route, "PUT", { modelId: null });
		assert.deepEqual((await f.json(route)).chatOptions, {
			fileAccess: "restricted",
			networkAccess: "restricted",
			modelId: null,
			reasoningEffort: null,
		});
		await f.json("/api/model-settings", "PUT", { defaultModelId: null });
		const empty = await f.json(`/api/projects/${f.project.id}/chats`, "POST", {
			name: "Empty",
		});
		assert.deepEqual((await f.json(`/api/chats/${empty.id}`)).chatOptions, {
			fileAccess: "restricted",
			networkAccess: "restricted",
			modelId: null,
			reasoningEffort: null,
		});
		assert.equal(
			(await f.request(`/api/chats/${empty.id}`, "POST", { prompt: "Q" }))
				.status,
			400,
		);
		await f.json(`${route}/archive`, "PUT", { archived: true });
		assert.equal(
			(await f.request(route, "PUT", { modelId: "second" })).status,
			409,
		);
		assert.deepEqual((await f.json(route)).chatOptions, {
			fileAccess: "restricted",
			networkAccess: "restricted",
			modelId: null,
			reasoningEffort: null,
		});
	} finally {
		await f.close();
	}
});

test("prompt acceptance uses saved choices, busy edits affect the next call but never change the sent request", async () => {
	const requests: { model: string; reasoning?: { effort: string } }[] = [];
	let started!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => (started = resolve));
	const held = new Promise<void>((resolve) => (release = resolve));
	const f = await fixture(async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)));
		if (requests.length === 1) {
			started();
			await held;
			return completedResponse({
				output: [
					{
						id: "tool",
						type: "function_call",
						name: "read_file",
						call_id: "tool",
						arguments: JSON.stringify({ path: "/tmp" }),
					},
				],
			});
		}
		return completedResponse({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "Done" }] },
			],
		});
	});
	try {
		addModel(f.db, "second");
		const route = `/api/chats/${f.chat.id}`;
		await f.json(route, "PUT", { reasoningEffort: "high" });
		const accepted = await f.json(route, "POST", {
			prompt: "Q",
			modelId: "missing",
			reasoningEffort: "unsupported",
		});
		await entered;
		assert.equal(
			(await f.request(route, "POST", { prompt: "busy" })).status,
			409,
		);
		await f.json(route, "PUT", { modelId: "second", reasoningEffort: "low" });
		assert.deepEqual(requests[0].reasoning, { effort: "high" });
		assert.equal(requests[0].model, "test");
		release();
		assert.equal((await f.wait(accepted.agentId)).status, "succeeded");
		assert.equal(requests.length, 2);
		assert.equal(requests[1].model, "second");
		assert.deepEqual(requests[1].reasoning, { effort: "low" });
		assert.deepEqual((await f.json(route)).chatOptions, {
			fileAccess: "restricted",
			networkAccess: "restricted",
			modelId: "second",
			reasoningEffort: "low",
		});
	} finally {
		release();
		await f.close();
	}
});

test("deleting the selected model stops continuation without issuing another Model Call", async () => {
	let started!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => (started = resolve));
	const held = new Promise<void>((resolve) => (release = resolve));
	let requests = 0;
	const f = await fixture(async () => {
		requests++;
		started();
		await held;
		return completedResponse({
			output: [
				{
					id: "tool",
					type: "function_call",
					name: "read_file",
					call_id: "tool",
					arguments: JSON.stringify({ path: "/tmp" }),
				},
			],
		});
	});
	try {
		const route = `/api/chats/${f.chat.id}`;
		const { agentId } = await f.json(route, "POST", { prompt: "Q" });
		await entered;
		await f.json("/api/models/test", "DELETE");
		release();
		assert.equal((await f.wait(agentId)).status, "failed");
		assert.equal(requests, 1);
		assert.deepEqual((await f.json(route)).chatOptions, {
			fileAccess: "restricted",
			networkAccess: "restricted",
			modelId: null,
			reasoningEffort: null,
		});
	} finally {
		release();
		await f.close();
	}
});

test("access defaults initialize only new Chats and independent saved choices survive restart", async () => {
	const f = await fixture();
	try {
		assert.deepEqual(await f.json("/api/access-defaults"), {
			fileAccess: "restricted",
			networkAccess: "restricted",
		});
		await f.json("/api/access-defaults", "PATCH", { fileAccess: "full" });
		const second = await f.json(`/api/projects/${f.project.id}/chats`, "POST", {
			name: "new",
		});
		assert.equal(
			(await f.json(`/api/chats/${second.id}`)).chatOptions.fileAccess,
			"full",
		);
		assert.equal(
			(await f.json(`/api/chats/${f.chat.id}`)).chatOptions.fileAccess,
			"restricted",
		);
		await f.json(`/api/chats/${second.id}`, "PUT", { networkAccess: "full" });
		await f.json(`/api/chats/${second.id}`, "PUT", { name: "renamed" });
		for (const input of [
			{ fileAccess: null },
			{ networkAccess: "inherit" },
			{ fileAccess: 42 },
		])
			assert.equal(
				(await f.request(`/api/chats/${second.id}`, "PUT", input)).status,
				400,
			);
		assert.equal(
			(await f.request("/api/access-defaults", "PATCH", { fileAccess: "bad" }))
				.status,
			400,
		);
		await f.restart();
		assert.deepEqual(await f.json("/api/access-defaults"), {
			fileAccess: "full",
			networkAccess: "restricted",
		});
		assert.deepEqual((await f.json(`/api/chats/${second.id}`)).chatOptions, {
			modelId: "test",
			reasoningEffort: null,
			fileAccess: "full",
			networkAccess: "full",
		});
	} finally {
		await f.close();
	}
});
