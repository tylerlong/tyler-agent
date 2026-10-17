import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDatabase } from "../src/database.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { createServer } from "./server-fixture.ts";

test("follow-up-behavior defaults to Queue, validates, persists and leaves other settings unchanged on failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-follow-up-behavior-"));
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
		assert.deepEqual(await (await request("/api/follow-up-behavior")).json(), {
			behavior: "queue",
		});
		await request("/api/sidebar-width", { width: 410 });
		await request("/api/language", { language: "zh-CN" });
		for (const behavior of ["fr", null, 42, "", true]) {
			const response = await request("/api/follow-up-behavior", { behavior });
			assert.equal(response.status, 400);
			assert.equal((await response.json()).code, "invalidFollowUpBehavior");
		}
		assert.equal(
			(await request("/api/follow-up-behavior", { behavior: "steer" })).status,
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
		assert.deepEqual(await (await request("/api/follow-up-behavior")).json(), {
			behavior: "steer",
		});
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TRIGGER reject_follow_up_behavior BEFORE UPDATE OF follow_up_behavior ON settings BEGIN SELECT RAISE(FAIL,'simulated disk failure'); END;",
		);
		db.close();
		const failure = await request("/api/follow-up-behavior", {
			behavior: "queue",
		});
		assert.equal(failure.status, 500);
		assert.equal((await failure.json()).code, "followUpBehaviorWriteFailed");
		assert.deepEqual(await (await request("/api/follow-up-behavior")).json(), {
			behavior: "steer",
		});
		const unreadable = new DatabaseSync(path);
		unreadable.exec(
			"DROP TRIGGER reject_follow_up_behavior; ALTER TABLE settings DROP COLUMN follow_up_behavior;",
		);
		unreadable.close();
		const readFailure = await request("/api/follow-up-behavior");
		assert.equal(readFailure.status, 500);
		assert.equal((await readFailure.json()).code, "followUpBehaviorReadFailed");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("fresh schema defaults Follow-up to Queue and rejects invalid saved preferences", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-follow-up-schema-"));
	const path = join(directory, "db.sqlite");
	try {
		const db = openDatabase(path, false);
		assert.equal(
			db.prepare("SELECT follow_up_behavior FROM settings").get()
				?.follow_up_behavior,
			"queue",
		);
		assert.throws(
			() =>
				db.prepare("UPDATE settings SET follow_up_behavior=?").run("invalid"),
			/CHECK/,
		);
		db.exec(
			"PRAGMA ignore_check_constraints=ON; UPDATE settings SET follow_up_behavior='invalid'",
		);
		db.close();
		assert.throws(() => openDatabase(path, false), /Corrupt database/);
		const retained = new DatabaseSync(path);
		assert.equal(
			retained.prepare("SELECT follow_up_behavior FROM settings").get()
				?.follow_up_behavior,
			"invalid",
		);
		retained.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
