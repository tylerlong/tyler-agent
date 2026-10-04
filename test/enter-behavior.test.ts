import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDatabase } from "../src/database.ts";
import { createServer } from "../src/server.ts";

test("enter-behavior defaults to Send, validates, persists and leaves other settings unchanged on failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-enter-behavior-"));
	const path = join(directory, "db.sqlite");
	let server = createServer(fetch, path).listen(0, "127.0.0.1");
	const ready = async () => {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	};
	let base = await ready();
	const request = (route: string, body?: unknown) =>
		fetch(base + route, {
			method: body === undefined ? "GET" : "PUT",
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
		});
	try {
		assert.deepEqual(await (await request("/api/enter-behavior")).json(), {
			behavior: "send",
		});
		await request("/api/sidebar-width", { width: 410 });
		await request("/api/language", { language: "zh-CN" });
		for (const behavior of ["fr", null, 42, "", true]) {
			const response = await request("/api/enter-behavior", { behavior });
			assert.equal(response.status, 400);
			assert.equal((await response.json()).code, "invalidEnterBehavior");
		}
		assert.equal(
			(await request("/api/enter-behavior", { behavior: "newline" })).status,
			200,
		);
		assert.deepEqual(await (await request("/api/language")).json(), {
			language: "zh-CN",
		});
		assert.deepEqual(await (await request("/api/sidebar-width")).json(), {
			width: 410,
		});
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = createServer(fetch, path).listen(0, "127.0.0.1");
		base = await ready();
		assert.deepEqual(await (await request("/api/enter-behavior")).json(), {
			behavior: "newline",
		});
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TRIGGER reject_enter_behavior BEFORE UPDATE OF enter_behavior ON settings BEGIN SELECT RAISE(FAIL,'simulated disk failure'); END;",
		);
		db.close();
		const failure = await request("/api/enter-behavior", { behavior: "send" });
		assert.equal(failure.status, 500);
		assert.equal((await failure.json()).code, "enterBehaviorWriteFailed");
		assert.deepEqual(await (await request("/api/enter-behavior")).json(), {
			behavior: "newline",
		});
		const unreadable = new DatabaseSync(path);
		unreadable.exec(
			"DROP TRIGGER reject_enter_behavior; ALTER TABLE settings DROP COLUMN enter_behavior;",
		);
		unreadable.close();
		const readFailure = await request("/api/enter-behavior");
		assert.equal(readFailure.status, 500);
		assert.equal((await readFailure.json()).code, "enterBehaviorReadFailed");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("upgrading a v9 database defaults Enter to Send and preserves complete saved content and configuration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-enter-upgrade-"));
	const path = join(directory, "db.sqlite");
	try {
		const db = openDatabase(path, false);
		db.exec(`INSERT INTO projects(id,name,created_at,archived) VALUES(1,'Project',10,1);
			INSERT INTO folders VALUES(1,'/saved');
			INSERT INTO chats(id,project_id,name,created_at,last_question_at,archived) VALUES(1,1,'Chat',20,30,1);
			INSERT INTO turns(id,chat_id,user_content,assistant_content,status,created_at,output_json) VALUES(1,1,'Question','Answer','succeeded',30,'[{"type":"message"}]');
			INSERT INTO model_calls(id,turn_id,url,method,requested_at,request_body,status,http_status,response_body,duration_ms) VALUES(1,1,'https://example.test','POST','now','{"model":"saved","reasoning":{"effort":"high"}}','succeeded',200,'saved output',25);
			INSERT INTO managed_models VALUES('saved','Saved model','{"supportedEfforts":["high"],"reasoningRequired":false,"catalogMissing":false}');
			UPDATE settings SET language='zh-CN',sidebar_width=500,api_key='saved-key',default_model_id='saved';
			ALTER TABLE settings DROP COLUMN enter_behavior;
			PRAGMA user_version=9;`);
		const tables = [
			"projects",
			"folders",
			"chats",
			"turns",
			"model_calls",
			"managed_models",
		];
		const before = tables.map((table) =>
			db.prepare(`SELECT * FROM ${table}`).all(),
		);
		db.close();
		const upgraded = openDatabase(path, false);
		assert.equal(
			upgraded.prepare("PRAGMA user_version").get()?.user_version,
			10,
		);
		assert.deepEqual(
			tables.map((table) => upgraded.prepare(`SELECT * FROM ${table}`).all()),
			before,
		);
		assert.deepEqual(
			{ ...upgraded.prepare("SELECT * FROM settings").get() },
			{
				id: 1,
				sidebar_width: 500,
				language: "zh-CN",
				api_key: "saved-key",
				default_model_id: "saved",
				enter_behavior: "send",
			},
		);
		assert.throws(
			() =>
				upgraded.prepare("UPDATE settings SET enter_behavior=?").run("invalid"),
			/CHECK/,
		);
		upgraded.exec(
			"PRAGMA ignore_check_constraints=ON; UPDATE settings SET enter_behavior='invalid';",
		);
		upgraded.close();
		assert.throws(() => openDatabase(path, false), /Corrupt database/);
		const retained = new DatabaseSync(path);
		assert.equal(
			retained.prepare("SELECT enter_behavior FROM settings").get()
				?.enter_behavior,
			"invalid",
		);
		assert.deepEqual(
			tables.map((table) => retained.prepare(`SELECT * FROM ${table}`).all()),
			before,
		);
		retained.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
