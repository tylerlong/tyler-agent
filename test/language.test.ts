import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { localFetch as fetch } from "./local-fetch.ts";
import { createServer } from "./server-fixture.ts";

test("language defaults to English, validates, persists and leaves other settings unchanged on failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-language-"));
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
		assert.deepEqual(await (await request("/api/language")).json(), {
			language: "en",
		});
		await request("/api/sidebar-width", { width: 410 });
		for (const language of ["fr", null, 42]) {
			const response = await request("/api/language", { language });
			assert.equal(response.status, 400);
			assert.equal((await response.json()).code, "invalidLanguage");
		}
		assert.equal(
			(await request("/api/language", { language: "zh-CN" })).status,
			200,
		);
		assert.deepEqual(await (await request("/api/sidebar-width")).json(), {
			width: 410,
		});
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = createServer(fetch, path).listen(0, "127.0.0.1");
		base = await ready();
		assert.deepEqual(await (await request("/api/language")).json(), {
			language: "zh-CN",
		});
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TRIGGER reject_language BEFORE UPDATE OF language ON settings BEGIN SELECT RAISE(FAIL,'simulated disk failure'); END;",
		);
		db.close();
		const failure = await request("/api/language", { language: "en" });
		assert.equal(failure.status, 500);
		assert.equal((await failure.json()).code, "languageWriteFailed");
		assert.deepEqual(await (await request("/api/language")).json(), {
			language: "zh-CN",
		});
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
