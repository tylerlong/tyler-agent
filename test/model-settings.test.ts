import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDatabase } from "../src/database.ts";
import { waitForAgent } from "./agent-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";
import { createServer } from "./server-fixture.ts";

const catalogModel = (id: string, name = id, reasoning?: unknown) => ({
	id,
	name,
	architecture: { output_modalities: ["text"] },
	...(reasoning ? { reasoning } : {}),
});

test("custom database startup rejects a shared parent without changing permissions or creating data", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-shared-parent-"));
	const path = join(directory, "db.sqlite");
	try {
		await chmod(directory, 0o755);
		assert.throws(() => openDatabase(path, false), /directory must be private/);
		assert.equal((await stat(directory)).mode & 0o777, 0o755);
		await assert.rejects(stat(path), { code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("database model metadata excludes credentials, durable anonymous lazy catalog refresh preserves membership and failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-settings-"));
	const path = join(directory, "db.sqlite");
	let calls = 0;
	let fail = false;
	let release: (() => void) | undefined;
	let wait = false;
	let data = [
		catalogModel("one", "One", {
			supported_efforts: ["none", "high"],
			mandatory: true,
		}),
		catalogModel("two", "Two", { supported_efforts: null }),
		catalogModel("plain"),
		{
			id: "image",
			name: "Image",
			architecture: { output_modalities: ["image"] },
		},
	];
	const anonymous: typeof fetch = async (url, init) => {
		calls++;
		assert.equal(
			url,
			"https://openrouter.ai/api/v1/models?sort=most-popular&limit=100&output_modalities=text",
		);
		assert.equal(init?.method, "GET");
		assert.equal(new Headers(init?.headers).has("authorization"), false);
		if (wait)
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		if (fail) throw Error("untrusted provider detail secret");
		return Response.json({ data });
	};
	let server = createServer(
		async () => {
			throw Error("must not infer");
		},
		path,
		anonymous,
	).listen(0, "127.0.0.1");
	const base = async () => {
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	};
	const request = async (route: string, method = "GET", body?: unknown) =>
		fetch(`${await base()}${route}`, {
			method,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
	try {
		assert.equal(calls, 0);
		assert.deepEqual(await (await request("/api/model-settings")).json(), {
			apiKeyConfigured: false,
			defaultModelId: null,
			models: [],
		});
		assert.equal(
			(
				await request("/api/model-settings", "PUT", {
					defaultModelId: "absent",
				})
			).status,
			400,
		);
		const saved = await (
			await request("/api/model-settings", "PUT", { apiKey: "secret" })
		).json();
		assert.equal(saved.apiKeyConfigured, true);
		assert.doesNotMatch(JSON.stringify(saved), /secret/);
		assert.equal(calls, 0);
		const initial = await (await request("/api/model-catalog")).json();
		assert.equal(calls, 1);
		assert.equal(initial.models.length, 3);
		assert.deepEqual(initial.models[0].supportedEfforts, ["none", "high"]);
		assert.equal(initial.models[0].reasoningRequired, true);
		assert.equal(initial.models[1].supportedEfforts, null);
		assert.equal("supportedEfforts" in initial.models[2], false);
		await request("/api/model-catalog");
		assert.equal(calls, 1);
		await request("/api/models", "POST", { id: "one" });
		await request("/api/models", "POST", { id: "two" });
		assert.equal(calls, 1);
		await request("/api/model-settings", "PUT", {
			defaultModelId: "one",
		});
		data = [
			catalogModel("one", "Renamed", { supported_efforts: ["low"] }),
			catalogModel("plain"),
		];
		const refreshed = await request("/api/model-catalog", "POST");
		assert.equal(refreshed.status, 200);
		let settings = await (await request("/api/model-settings")).json();
		assert.equal(settings.defaultModelId, "one");
		assert.equal(settings.apiKeyConfigured, true);
		assert.equal(settings.models[0].name, "Renamed");
		assert.deepEqual(settings.models[0].supportedEfforts, ["low"]);
		assert.equal(settings.models[1].catalogMissing, false);
		assert.equal(settings.models[1].supportedEfforts, null);
		fail = true;
		const failure = await request("/api/model-catalog", "POST");
		assert.equal(failure.status, 502);
		assert.doesNotMatch(await failure.text(), /secret|provider/);
		assert.deepEqual(
			await (await request("/api/model-settings")).json(),
			settings,
		);
		const before = calls;
		await request("/api/model-catalog");
		assert.equal(calls, before);
		fail = false;
		wait = true;
		const pending = request("/api/model-catalog", "POST");
		while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
		await request("/api/models/one", "DELETE");
		await request("/api/models", "POST", { id: "plain" }).then((response) =>
			assert.equal(response.status, 200),
		);
		release();
		await pending;
		wait = false;
		release = undefined;
		settings = await (await request("/api/model-settings")).json();
		assert.equal(settings.defaultModelId, "two");
		assert.deepEqual(
			settings.models.map((model: { id: string }) => model.id),
			["two", "plain"],
		);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = createServer(fetch, path, anonymous).listen(0, "127.0.0.1");
		const restartCalls = calls;
		assert.deepEqual(await (await request("/api/model-settings")).json(), {
			...settings,
			models: settings.models,
		});
		assert.equal(calls, restartCalls);
		assert.deepEqual(await (await request("/api/settings/credential")).json(), {
			apiKey: "secret",
		});
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(directory)).mode & 0o777, 0o700);
		const db = new DatabaseSync(path);
		assert.equal(
			db.prepare("SELECT api_key FROM settings").get()?.api_key,
			"secret",
		);
		db.close();
		await request("/api/model-settings", "PUT", { apiKey: "" });
		assert.equal(
			(await (await request("/api/model-settings")).json()).apiKeyConfigured,
			false,
		);
	} finally {
		release?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent catalog refreshes share one request while GET serves the successful cache and acceptance notifies once", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-catalog-sharing-"));
	let calls = 0;
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const refreshStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const server = createServer(
		async () => {
			assert.fail("Catalog requests must not call a model");
		},
		join(directory, "db.sqlite"),
		async () => {
			calls++;
			if (calls > 1) {
				started?.();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return Response.json({
				data: [catalogModel("one", calls === 1 ? "Old" : "New")],
			});
		},
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const request = (method = "GET") =>
		fetch(`${base}/api/model-catalog`, { method });
	const abort = new AbortController();
	try {
		const old = await (await request()).json();
		assert.equal(old.models[0].name, "Old");
		let refreshes = 0;
		let endEvents: (() => void) | undefined;
		const bothReceived = new Promise<void>((resolve) => {
			server.on("request", (incoming, response) => {
				if (
					incoming.url === "/api/model-catalog" &&
					incoming.method === "POST" &&
					++refreshes === 2
				)
					resolve();
				if (incoming.url === "/api/events") endEvents = () => response.end();
			});
		});
		const events = await fetch(`${base}/api/events`, { signal: abort.signal });
		const first = request("POST");
		await refreshStarted;
		const second = request("POST");
		await bothReceived;
		assert.deepEqual(await (await request()).json(), old);
		assert.equal(calls, 2);
		release?.();
		const refreshed = await Promise.all([first, second]);
		for (const response of refreshed) {
			assert.equal(response.status, 200);
			assert.equal((await response.json()).models[0].name, "New");
		}
		assert.equal(calls, 2);
		// Finish the existing event response after acceptance so every notification is observed.
		endEvents?.();
		assert.equal(await events.text(), ": connected\n\ndata: changed\n\n");
	} finally {
		release?.();
		abort.abort();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("Settings credential read is scoped and uncached; empty writes remove it without provider calls or exposing events", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-credential-read-"));
	const path = join(directory, "db.sqlite");
	const noProvider: typeof fetch = async () => {
		assert.fail("Credential reads and writes must not call a provider");
	};
	const server = createServer(noProvider, path, noProvider).listen(
		0,
		"127.0.0.1",
	);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const request = (route: string, method = "GET", body?: unknown) =>
		fetch(`${base}${route}`, {
			method,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
	const eventsAbort = new AbortController();
	try {
		const credential = await request("/api/settings/credential");
		assert.equal(credential.headers.get("cache-control"), "no-store");
		assert.deepEqual(await credential.json(), { apiKey: "" });
		const events = await fetch(`${base}/api/events`, {
			signal: eventsAbort.signal,
		});
		const reader = events.body?.getReader();
		assert(reader);
		await reader.read();
		const saved = await request("/api/model-settings", "PUT", {
			apiKey: " synthetic-secret ",
		});
		assert.equal(saved.status, 200);
		assert.doesNotMatch(await saved.text(), /synthetic-secret/);
		const event = new TextDecoder().decode((await reader.read()).value);
		assert.equal(event, "data: changed\n\n");
		assert.deepEqual(await (await request("/api/settings/credential")).json(), {
			apiKey: "synthetic-secret",
		});
		assert.doesNotMatch(
			await (await request("/api/model-settings")).text(),
			/synthetic-secret/,
		);
		assert.equal(
			(await request("/api/settings/credential", "POST")).status,
			404,
		);
		for (const apiKey of [3, "synthetic-secret\ninvalid"]) {
			const invalid = await request("/api/model-settings", "PUT", { apiKey });
			assert.equal(invalid.status, 400);
			assert.doesNotMatch(await invalid.text(), /synthetic-secret/);
		}
		for (const apiKey of ["", "   "]) {
			await request("/api/model-settings", "PUT", {
				apiKey: "synthetic-secret",
			});
			const removed = await request("/api/model-settings", "PUT", { apiKey });
			assert.equal((await removed.json()).apiKeyConfigured, false);
			assert.deepEqual(
				await (await request("/api/settings/credential")).json(),
				{ apiKey: "" },
			);
			const db = new DatabaseSync(path);
			assert.equal(
				db.prepare("SELECT api_key FROM settings").get()?.api_key,
				null,
			);
			db.close();
		}
	} finally {
		eventsAbort.abort();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("fresh database has empty model settings with no environment fallback", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-migrate-"));
	const path = join(directory, "db.sqlite");
	try {
		const db = openDatabase(path, false);
		db.exec(
			"INSERT INTO projects(id,name,created_at) VALUES(1,'Project',1); INSERT INTO chats(id,project_id,name,created_at) VALUES(1,1,'Chat',1)",
		);
		assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 17);
		assert.deepEqual(
			{ ...db.prepare("SELECT * FROM settings").get() },
			{
				id: 1,
				sidebar_width: 320,
				language: "en",
				api_key: null,
				default_model_id: null,
				enter_behavior: "send",
				model_call_limit: 16,
				sub_agent_limit: 32,
			},
		);
		db.close();
		const oldKey = process.env.OPENROUTER_API_KEY;
		const oldModel = process.env.OPENROUTER_MODEL;
		process.env.OPENROUTER_API_KEY = "must-not-import";
		process.env.OPENROUTER_MODEL = "must-not-import";
		let count = 0;
		const server = createServer(async () => {
			count++;
			return completedResponse({ output: [] });
		}, path).listen(0, "127.0.0.1");
		try {
			await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address();
			assert(address && typeof address !== "string");
			const base = `http://127.0.0.1:${address.port}`;
			const response = await fetch(`${base}/api/chats/1`, {
				method: "POST",
				body: JSON.stringify({ modelId: "test", prompt: "Try" }),
			});
			assert.equal(response.status, 400);
			assert.equal((await response.json()).code, "modelConfigMissing");
			assert.equal(count, 0);
			assert.equal(
				(await (await fetch(`${base}/api/model-settings`)).json())
					.apiKeyConfigured,
				false,
			);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = oldKey;
			if (oldModel === undefined) delete process.env.OPENROUTER_MODEL;
			else process.env.OPENROUTER_MODEL = oldModel;
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("accepted call keeps captured key/model through replacement and removal, with secret redaction and write failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-key-snapshot-"));
	const path = join(directory, "db.sqlite");
	const db = openDatabase(path, false);
	const metadata = JSON.stringify({
		reasoningRequired: false,
		catalogMissing: false,
	});
	db.prepare("INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?)").run(
		"old-model",
		"Old",
		metadata,
	);
	db.prepare("INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?)").run(
		"new-model",
		"New",
		metadata,
	);
	db.exec(
		"UPDATE settings SET api_key='old-secret',default_model_id='old-model'",
	);
	db.close();
	let started: (() => void) | undefined;
	const start = new Promise<void>((resolve) => {
		started = resolve;
	});
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const server = createServer(async (_url, init) => {
		calls++;
		assert.equal(
			new Headers(init?.headers).get("authorization"),
			"Bearer old-secret",
		);
		assert.equal(JSON.parse(String(init?.body)).model, "old-model");
		started?.();
		await held;
		return completedResponse({
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text: "Echo old-secret" }],
				},
			],
			echo: "old-secret",
		});
	}, path).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const request = (route: string, method = "GET", body?: unknown) =>
			fetch(`${base}${route}`, {
				method,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});
		const project = await (
			await request("/api/projects", "POST", { name: "P", folders: [] })
		).json();
		const chat = await (
			await request(`/api/projects/${project.id}/chats`, "POST", { name: "C" })
		).json();
		const pending = request(`/api/chats/${chat.id}`, "POST", {
			modelId: "old-model",
			prompt: "Question old-secret",
		});
		await start;
		const changed = await request("/api/model-settings", "PUT", {
			apiKey: "new-secret",
			defaultModelId: "new-model",
		});
		assert.equal(changed.status, 200);
		assert.doesNotMatch(await changed.text(), /old-secret|new-secret/);
		await request("/api/models/old-model", "DELETE");
		await request("/api/model-settings", "PUT", { removeApiKey: true });
		release?.();
		const accepted = await pending;
		assert.equal(accepted.status, 202);
		await waitForAgent(base, (await accepted.json()).agentId);
		const history = await (await request(`/api/chats/${chat.id}`)).json();
		assert.equal(history.agents[0].question, "Question [REDACTED]");
		assert.equal(history.agents[0].answer, "Echo [REDACTED]");
		const communication = await (
			await request(`/api/agents/${history.agents[0].id}/calls`)
		).text();
		assert.doesNotMatch(communication, /old-secret/);
		assert.match(communication, /old-model/);
		assert.equal(
			(
				await request(`/api/chats/${chat.id}`, "POST", {
					modelId: "old-model",
					prompt: "Again",
				})
			).status,
			400,
		);
		assert.equal(calls, 1);
		const raw = new DatabaseSync(path);
		raw.exec(
			"CREATE TRIGGER reject_config BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'private disk detail old-secret'); END",
		);
		const failure = await request("/api/model-settings", "PUT", {
			apiKey: "new-secret",
		});
		assert.equal(failure.status, 500);
		assert.doesNotMatch(await failure.text(), /secret|disk detail/);
		assert.equal(
			raw.prepare("SELECT api_key FROM settings").get()?.api_key,
			null,
		);
		raw.close();
	} finally {
		release?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("popular discovery is bounded, preserves out-of-ranking default/history and only updates complete responses", async () => {
	let data = Array.from({ length: 101 }, (_, index) =>
		catalogModel(`rank-${index}`, `Rank ${index}`),
	);
	let malformed = false;
	let calls = 0;
	const directory = await mkdtemp(join(tmpdir(), "agent-ranked-"));
	const server = createServer(
		fetch,
		join(directory, "db.sqlite"),
		async (_url, init) => {
			calls++;
			assert.equal(new Headers(init?.headers).has("authorization"), false);
			return Response.json({ data: malformed ? [{ id: "rank-0" }] : data });
		},
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const request = (path: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${address.port}${path}`, {
			method,
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	try {
		const initial = await (await request("/api/model-catalog", "POST")).json();
		assert.equal(initial.models.length, 100);
		assert.equal(
			(await request("/api/models", "POST", { id: "rank-100" })).status,
			400,
		);
		await request("/api/models", "POST", { id: "rank-1" });
		await request("/api/models", "POST", { id: "rank-0" });
		await request("/api/model-settings", "PUT", { defaultModelId: "rank-1" });
		assert.deepEqual(
			(await (await request("/api/model-settings")).json()).models.map(
				(row: { id: string }) => row.id,
			),
			["rank-1", "rank-0"],
		);
		data = [catalogModel("rank-0", "Renamed")];
		await request("/api/model-catalog", "POST");
		const saved = await (await request("/api/model-settings")).json();
		assert.equal(saved.defaultModelId, "rank-1");
		assert.equal(saved.models[0].name, "Rank 1");
		assert.equal(saved.models[0].catalogMissing, false);
		malformed = true;
		assert.equal((await request("/api/model-catalog", "POST")).status, 502);
		assert.deepEqual(
			await (await request("/api/model-settings")).json(),
			saved,
		);
		assert.equal(
			(await (await request("/api/model-catalog")).json()).models[0].name,
			"Renamed",
		);
		assert.equal(calls, 3);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("default removal is atomic, uses successful cached rank, and falls back to stable order after restart", async () => {
	const folder = await mkdtemp(join(tmpdir(), "agent-replacement-"));
	const path = join(folder, "db.sqlite");
	let fail = false;
	let data = ["a", "b", "c", "d", "e"].map((id) => catalogModel(id));
	const start = () =>
		createServer(fetch, path, async () => {
			if (fail) throw Error("directory failed");
			return Response.json({ data });
		}).listen(0, "127.0.0.1");
	let server = start();
	const request = async (route: string, method = "GET", body?: unknown) => {
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return fetch(`http://127.0.0.1:${address.port}${route}`, {
			method,
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	};
	const settings = async () => (await request("/api/model-settings")).json();
	const setDefault = async (id: string) =>
		request("/api/model-settings", "PUT", { defaultModelId: id });
	try {
		await request("/api/model-catalog", "POST");
		for (const id of ["a", "b", "c", "d", "e"])
			await request("/api/models", "POST", { id });
		await setDefault("a");
		data = [catalogModel("c")];
		await request("/api/model-catalog", "POST");
		fail = true;
		assert.equal((await request("/api/model-catalog", "POST")).status, 502);
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TRIGGER reject_replacement BEFORE UPDATE OF default_model_id ON settings WHEN NEW.default_model_id='c' BEGIN SELECT RAISE(ABORT,'disk failure'); END",
		);
		const before = await settings();
		assert.equal((await request("/api/models/a", "DELETE")).status, 500);
		assert.deepEqual(await settings(), before);
		db.exec("DROP TRIGGER reject_replacement");
		db.close();
		await request("/api/models/a", "DELETE");
		assert.equal((await settings()).defaultModelId, "c");
		assert.deepEqual(
			(await settings()).models.map((model: { id: string }) => model.id),
			["b", "c", "d", "e"],
		);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = start();
		await request("/api/models/c", "DELETE");
		assert.equal((await settings()).defaultModelId, "b");
		fail = false;
		data = [catalogModel("outside")];
		assert.equal((await request("/api/model-catalog", "POST")).status, 200);
		assert.equal((await request("/api/models/b", "DELETE")).status, 200);
		assert.equal((await settings()).defaultModelId, "d");
		await request("/api/models/e", "DELETE");
		assert.equal((await settings()).defaultModelId, "d");
		await request("/api/models/d", "DELETE");
		assert.equal((await settings()).defaultModelId, null);
		assert.deepEqual((await settings()).models, []);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(folder, { recursive: true, force: true });
	}
});

test("first model addition persists its default atomically and duplicates or later additions preserve selection and order", async () => {
	const folder = await mkdtemp(join(tmpdir(), "agent-first-add-"));
	const path = join(folder, "db.sqlite");
	let failCatalog = false;
	let catalogCalls = 0;
	let data = [catalogModel("one"), catalogModel("two"), catalogModel("three")];
	const start = () =>
		createServer(fetch, path, async () => {
			catalogCalls++;
			if (failCatalog) throw Error("directory unavailable");
			return Response.json({ data });
		}).listen(0, "127.0.0.1");
	let server = start();
	const request = async (route: string, method = "GET", body?: unknown) => {
		if (!server.listening)
			await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return fetch(`http://127.0.0.1:${address.port}${route}`, {
			method,
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	};
	const settings = async () => (await request("/api/model-settings")).json();
	const add = async (id: string) => request("/api/models", "POST", { id });
	try {
		assert.equal((await add("one")).status, 400);
		assert.equal(catalogCalls, 0);
		assert.deepEqual((await settings()).models, []);
		await request("/api/model-catalog", "POST");
		const first = await (await add("one")).json();
		assert.equal(first.defaultModelId, "one");
		assert.equal(first.firstModelAdded, true);
		const duplicate = await (await add("one")).json();
		assert.equal(duplicate.firstModelAdded, false);
		assert.equal(duplicate.defaultModelId, "one");
		assert.equal((await (await add("two")).json()).firstModelAdded, false);
		await request("/api/model-settings", "PUT", { defaultModelId: "two" });
		assert.equal((await (await add("one")).json()).defaultModelId, "two");
		await request("/api/model-settings", "PUT", { defaultModelId: null });
		const later = await (await add("three")).json();
		assert.equal(later.defaultModelId, null);
		assert.equal(later.firstModelAdded, false);
		assert.deepEqual(
			later.models.map((model: { id: string }) => model.id),
			["one", "two", "three"],
		);
		for (const id of ["one", "two", "three"])
			await request(`/api/models/${id}`, "DELETE");
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TRIGGER reject_first_default BEFORE UPDATE OF default_model_id ON settings WHEN NEW.default_model_id='one' BEGIN SELECT RAISE(ABORT,'disk failure'); END",
		);
		const before = await settings();
		assert.equal((await add("one")).status, 500);
		assert.deepEqual(await settings(), before);
		db.exec("DROP TRIGGER reject_first_default");
		db.close();
		assert.equal((await (await add("two")).json()).firstModelAdded, true);
		const saved = await settings();
		assert.equal(saved.defaultModelId, "two");
		data = [catalogModel("three")];
		assert.equal((await request("/api/model-catalog", "POST")).status, 200);
		const retainedDuplicate = await add("two");
		assert.equal(retainedDuplicate.status, 200);
		assert.equal((await retainedDuplicate.json()).firstModelAdded, false);
		assert.deepEqual(await settings(), saved);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		failCatalog = true;
		server = start();
		const restartedDuplicate = await add("two");
		assert.equal(restartedDuplicate.status, 200);
		assert.equal((await restartedDuplicate.json()).firstModelAdded, false);
		assert.deepEqual(await settings(), saved);
		const beforeRetry = catalogCalls;
		// A browser may retain candidates after restart, but saving must not fetch discovery.
		assert.equal((await add("three")).status, 400);
		assert.equal(catalogCalls, beforeRetry);
		assert.deepEqual(await settings(), saved);
		failCatalog = false;
		assert.equal((await request("/api/model-catalog", "POST")).status, 200);
		assert.equal(catalogCalls, beforeRetry + 1);
		assert.equal((await add("three")).status, 200);
		assert.equal(catalogCalls, beforeRetry + 1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(folder, { recursive: true, force: true });
	}
});
