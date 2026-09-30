import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createServer } from "../src/server.ts";

test("invalid project inputs never create partial records; duplicate names and empty chats are allowed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-inputs-"));
	const file = join(directory, "note.txt");
	await writeFile(file, "unchanged");
	const server = createServer(
		async () => {
			throw new Error("must not call model");
		},
		join(directory, "db.sqlite"),
	).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const post = (path: string, body: unknown) =>
			fetch(base + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		for (const input of [
			{ name: " ", folders: [directory] },
			{ name: "Work", folders: [] },
			{ name: "Work", folders: [" "] },
			{ name: "Work", folders: [directory, join(directory, "missing")] },
			{ name: "Work", folders: [file] },
			{ name: "Work", folders: [directory, join(directory, ".")] },
		]) {
			assert.equal((await post("/api/projects", input)).status, 400);
			assert.deepEqual(await (await fetch(`${base}/api/projects`)).json(), {
				projects: [],
			});
		}
		const locked = join(directory, "locked");
		await mkdir(locked);
		await chmod(locked, 0);
		try {
			assert.equal(
				(await post("/api/projects", { name: "Work", folders: [locked] }))
					.status,
				400,
			);
		} finally {
			await chmod(locked, 0o700);
		}
		for (let i = 0; i < 2; i++)
			assert.equal(
				(
					await post("/api/projects", {
						name: " Work ",
						folders: [directory, locked],
					})
				).status,
				201,
			);
		const projects = (await (await fetch(`${base}/api/projects`)).json())
			.projects;
		assert.equal(projects.length, 2);
		assert.equal(projects[0].name, "Work");
		assert.equal(
			(await post("/api/projects/999/chats", { name: "Question" })).status,
			404,
		);
		assert.equal(
			(await post(`/api/projects/${projects[0].id}/chats`, { name: " " }))
				.status,
			400,
		);
		for (let i = 0; i < 2; i++)
			assert.equal(
				(
					await post(`/api/projects/${projects[0].id}/chats`, {
						name: " Question ",
					})
				).status,
				201,
			);
		const chats = (await (await fetch(`${base}/api/projects`)).json())
			.projects[0].chats;
		assert.equal(chats.length, 2);
		assert.equal(chats[0].name, "Question");
		assert.notEqual(chats[0].id, chats[1].id);
		assert.equal((await fetch(`${base}/api/chat`)).status, 404);
		assert.equal((await post("/api/task", { prompt: "old" })).status, 404);
		const html = await (await fetch(`${base}/?chat=1`)).text();
		const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
		assert(script);
		assert.equal((await fetch(base + script)).status, 200);
		assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("legacy schema resets once and invalid or read-only databases fail at startup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-schema-"));
	const path = join(directory, "legacy.sqlite");
	try {
		const db = new DatabaseSync(path);
		db.exec(
			"CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1),folder TEXT NOT NULL);CREATE TABLE turns(id INTEGER PRIMARY KEY,user_content TEXT NOT NULL,assistant_content TEXT NOT NULL);INSERT INTO turns(user_content,assistant_content)VALUES('old','answer');",
		);
		db.close();
		const server = createServer(fetch, path).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		assert.deepEqual(
			await (
				await fetch(`http://127.0.0.1:${address.port}/api/projects`)
			).json(),
			{ projects: [] },
		);
		const created = await (
			await fetch(`http://127.0.0.1:${address.port}/api/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "New", folders: ["."] }),
			})
		).json();
		assert.deepEqual(created.folders, [process.cwd()]);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		const restarted = createServer(fetch, path).listen(0, "127.0.0.1");
		try {
			await new Promise<void>((resolve) =>
				restarted.once("listening", resolve),
			);
			const restartAddress = restarted.address();
			assert(restartAddress && typeof restartAddress !== "string");
			const saved = (
				await (
					await fetch(`http://127.0.0.1:${restartAddress.port}/api/projects`)
				).json()
			).projects;
			assert.equal(saved[0].id, created.id);
			assert.equal(saved[0].name, "New");
		} finally {
			await new Promise<void>((resolve) => restarted.close(() => resolve()));
		}
		const invalid = join(directory, "invalid.sqlite");
		const bad = new DatabaseSync(invalid);
		bad.exec("CREATE TABLE surprise(id INTEGER)");
		bad.close();
		assert.throws(() => createServer(fetch, invalid), /schema/);
		const broken = join(directory, "broken.sqlite");
		await writeFile(broken, "not a database");
		assert.throws(() => createServer(fetch, broken));
		await chmod(path, 0o444);
		try {
			assert.throws(() => createServer(fetch, path));
		} finally {
			await chmod(path, 0o644);
		}
		const missing = join(directory, "missing", "db.sqlite");
		assert.throws(() => createServer(fetch, missing));
		const result = spawnSync(
			process.execPath,
			["src/server.ts", "--db", missing],
			{ cwd: new URL("..", import.meta.url), encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unable to open database/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

for (const version of [1, 2])
	for (const saved of [false, true])
		test(`settings migrate v${version} (saved width: ${saved}) without losing user content`, async () => {
			const directory = await mkdtemp(join(tmpdir(), "agent-width-"));
			const path = join(directory, "db.sqlite");
			const db = new DatabaseSync(path);
			db.exec(`
		CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) > 0), created_at INTEGER NOT NULL);
		CREATE TABLE folders (project_id INTEGER NOT NULL REFERENCES projects(id), path TEXT NOT NULL, PRIMARY KEY(project_id,path));
		CREATE TABLE chats (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL CHECK(length(trim(name)) > 0), created_at INTEGER NOT NULL, last_question_at INTEGER);
		CREATE TABLE turns (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id), user_content TEXT NOT NULL, assistant_content TEXT NOT NULL);
		INSERT INTO projects VALUES(7,'Existing project',100);
		INSERT INTO folders VALUES(7,'/existing/folder');
		INSERT INTO chats VALUES(9,7,'Existing chat',200,300);
		INSERT INTO turns VALUES(11,9,'Existing question','Existing answer');
		PRAGMA user_version = ${version};
	`);
			if (version === 2) {
				db.exec(
					"CREATE TABLE sidebar_width (id INTEGER PRIMARY KEY CHECK(id=1), width REAL NOT NULL CHECK(width BETWEEN 240 AND 600));",
				);
				if (saved) db.exec("INSERT INTO sidebar_width VALUES(1,410.5)");
			}
			db.close();
			const server = createServer(fetch, path).listen(0, "127.0.0.1");
			try {
				await new Promise<void>((resolve) => server.once("listening", resolve));
				const address = server.address();
				assert(address && typeof address !== "string");
				const base = `http://127.0.0.1:${address.port}`;
				const schema = new DatabaseSync(path);
				assert.equal(
					schema.prepare("PRAGMA user_version").get()?.user_version,
					3,
				);
				assert.equal(
					schema
						.prepare(
							"SELECT name FROM sqlite_master WHERE name='sidebar_width'",
						)
						.get(),
					undefined,
				);
				assert.deepEqual(
					{ ...schema.prepare("SELECT * FROM settings").get() },
					{
						id: 1,
						sidebar_width: version === 2 && saved ? 410.5 : 320,
						debug_enabled: 1,
					},
				);
				schema.close();
				const width = async () =>
					(await (await fetch(`${base}/api/sidebar-width`)).json()).width;
				assert.equal(await width(), version === 2 && saved ? 410.5 : 320);
				for (const input of [
					{},
					{ width: null },
					{ width: "400" },
					{ width: 239 },
					{ width: 601 },
					{ width: Number.POSITIVE_INFINITY },
				]) {
					assert.equal(
						(
							await fetch(`${base}/api/sidebar-width`, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify(input),
							})
						).status,
						400,
					);
					assert.equal(await width(), version === 2 && saved ? 410.5 : 320);
				}
				assert.equal(
					(
						await fetch(`${base}/api/sidebar-width`, {
							method: "PUT",
							headers: { "content-type": "application/json" },
							body: '{"width":1e309}',
						})
					).status,
					400,
				);
				assert.equal(await width(), version === 2 && saved ? 410.5 : 320);
				for (const value of [240, 400.5, 600]) {
					assert.equal(
						(
							await fetch(`${base}/api/sidebar-width`, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ width: value }),
							})
						).status,
						200,
					);
					assert.equal(await width(), value);
				}
				assert.deepEqual(await (await fetch(`${base}/api/projects`)).json(), {
					projects: [
						{
							id: 7,
							name: "Existing project",
							createdAt: 100,
							folders: ["/existing/folder"],
							chats: [
								{
									id: 9,
									name: "Existing chat",
									createdAt: 200,
									lastQuestionAt: 300,
									busy: false,
								},
							],
						},
					],
				});
				assert.deepEqual(await (await fetch(`${base}/api/chats/9`)).json(), {
					messages: [
						{ id: "11-user", role: "user", content: "Existing question" },
						{
							id: "11-assistant",
							role: "assistant",
							content: "Existing answer",
						},
					],
					busy: false,
				});
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await rm(directory, { recursive: true, force: true });
			}
		});
