import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer as createPortProbe } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createServer } from "../src/server.ts";

test("CLI replaces an occupied port, uses --port independently of environment and rejects invalid ports before opening the database", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-port-"));
	const path = join(directory, "db.sqlite");
	try {
		for (const port of ["", "0", "65536", "1.5", "abc", "-1", "1e3"]) {
			const result = spawnSync(
				process.execPath,
				["src/server.ts", `--port=${port}`, "--db", path],
				{ encoding: "utf8", timeout: 5000 },
			);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /--port must be an integer/);
		}
		await assert.rejects(readFile(path), { code: "ENOENT" });
		const probe = createPortProbe().listen(0, "127.0.0.1");
		await once(probe, "listening");
		const address = probe.address();
		assert(address && typeof address !== "string");
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		const old = spawn(
			process.execPath,
			[
				"--watch",
				"src/server.ts",
				"--port",
				String(address.port),
				"--db",
				join(directory, "old.sqlite"),
			],
			{ timeout: 5000 },
		);
		const oldExited = once(old, "exit");
		await once(old.stdout, "data");

		const child = spawn(
			process.execPath,
			["src/server.ts", "--port", String(address.port), "--db", path],
			{ env: { ...process.env, PORT: "must-not-read" }, timeout: 5000 },
		);
		const exited = once(child, "exit");
		try {
			let output = "";
			await Promise.race([
				new Promise<void>((resolve) =>
					child.stdout.on("data", (data) => {
						output += data;
						if (output.includes(`Open http://127.0.0.1:${address.port}`))
							resolve();
					}),
				),
				exited.then(() => {
					throw new Error("Server exited before listening");
				}),
			]);
			assert.match(output, /Releasing port/);
			await oldExited;
			assert.equal(
				(await fetch(`http://127.0.0.1:${address.port}/api/projects`)).status,
				200,
			);
		} finally {
			child.kill();
			old.kill();
			await Promise.all([exited, oldExited]);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

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
			{ name: "Work", folders: "not an array" },
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
						folders: i === 0 ? [directory, locked] : [],
					})
				).status,
				201,
			);
		const projects = (await (await fetch(`${base}/api/projects`)).json())
			.projects;
		assert.equal(projects.length, 2);
		assert.equal(projects[0].name, "Work");
		assert.deepEqual(
			projects.find(
				(project: { folders: string[] }) => project.folders.length === 0,
			)?.folders,
			[],
		);
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

test("fresh schema initializes defaults and retains ordered partial output on restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-schema-"));
	const path = join(directory, "db.sqlite");
	try {
		const server = createServer(fetch, path);
		server.emit("close");
		const db = new DatabaseSync(path);
		assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 13);
		assert.deepEqual(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all()
				.map((row) => row.name),
			[
				"agents",
				"chats",
				"folders",
				"managed_models",
				"model_calls",
				"projects",
				"settings",
				"tool_calls",
			],
		);
		assert.equal(
			db
				.prepare("PRAGMA table_info(chats)")
				.all()
				.some((column) => column.name === "last_question_at"),
			false,
		);
		assert.deepEqual(
			db
				.prepare("PRAGMA foreign_key_list(tool_calls)")
				.all()
				.map((key) => [key.from, key.table]),
			[["model_call_id", "model_calls"]],
		);
		assert.deepEqual(
			db
				.prepare("PRAGMA foreign_key_list(model_calls)")
				.all()
				.map((key) => [key.from, key.table]),
			[["agent_id", "agents"]],
		);

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
		assert.equal(
			db.prepare("SELECT COUNT(*) AS count FROM projects").get()?.count,
			0,
		);
		assert.equal(
			db.prepare("SELECT COUNT(*) AS count FROM chats").get()?.count,
			0,
		);
		const output = JSON.stringify([
			{
				id: "answer-1",
				type: "message",
				content: [{ type: "output_text", text: "部分回答" }],
			},
			{
				id: "thinking-2",
				type: "reasoning",
				content: [{ type: "reasoning_text", text: "仍在思考" }],
			},
		]);
		db.exec(`INSERT INTO projects(name,created_at) VALUES('Saved',1);
			INSERT INTO chats(project_id,name,created_at) VALUES(1,'Chat',2);
			INSERT INTO agents(chat_id,prompt,status,created_at) VALUES(1,'Question','pending',3);
			INSERT INTO model_calls(agent_id,url,method,requested_at,request_body,status,response_body) VALUES(1,'https://example.test','POST','now','{}','pending','data: partial');
			UPDATE settings SET sidebar_width=410.5,language='zh-CN' WHERE id=1;`);
		assert.equal(
			db.prepare("SELECT output_json FROM model_calls").get()?.output_json,
			"[]",
		);
		const agentColumns = db
			.prepare("PRAGMA table_info(agents)")
			.all()
			.map((column) => column.name);
		for (const removed of ["assistant_content", "output_json", "error_details"])
			assert(!agentColumns.includes(removed));
		db.prepare("UPDATE model_calls SET output_json=? WHERE id=1").run(output);
		assert.throws(
			() => db.prepare("UPDATE model_calls SET output_json=?").run("{}"),
			/CHECK/,
		);
		db.close();
		const restarted = createServer(async () => {
			throw new Error("must not resume model");
		}, path);
		restarted.emit("close");
		const saved = new DatabaseSync(path);
		assert.deepEqual(
			{
				...saved.prepare("SELECT status,error_code FROM agents").get(),
			},
			{
				status: "failed",
				error_code: "agentInterrupted",
			},
		);
		assert.deepEqual(
			{
				...saved
					.prepare(
						"SELECT response_body,output_json,status,error_code,error FROM model_calls",
					)
					.get(),
			},
			{
				response_body: "data: partial",
				output_json: output,
				error_code: "modelInterrupted",
				status: "failed",
				error: "Service restarted before the call completed",
			},
		);
		assert.deepEqual(
			{ ...saved.prepare("SELECT * FROM settings").get() },
			{
				id: 1,
				sidebar_width: 410.5,
				language: "zh-CN",
				api_key: null,
				default_model_id: null,
				enter_behavior: "send",
				model_call_limit: 16,
				sub_agent_limit: 32,
			},
		);
		saved.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("unsupported, invalid, corrupt and read-only databases fail without resetting data", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-invalid-schema-"));
	try {
		for (const version of [0, 1, 7, 9]) {
			const path = join(directory, `unsupported-${version}.sqlite`);
			const db = new DatabaseSync(path);
			db.exec(
				`CREATE TABLE precious(content TEXT); INSERT INTO precious VALUES('keep'); PRAGMA user_version=${version};`,
			);
			db.close();
			assert.throws(() => createServer(fetch, path), /schema/);
			const retained = new DatabaseSync(path);
			assert.equal(
				retained.prepare("SELECT content FROM precious").get()?.content,
				"keep",
			);
			assert.equal(
				retained.prepare("PRAGMA user_version").get()?.user_version,
				version,
			);
			retained.close();
		}
		const broken = join(directory, "broken.sqlite");
		await writeFile(broken, "not a database");
		assert.throws(() => createServer(fetch, broken));
		assert.equal(await readFile(broken, "utf8"), "not a database");
		const path = join(directory, "current.sqlite");
		createServer(fetch, path).emit("close");
		await chmod(path, 0o444);
		try {
			assert.throws(() => createServer(fetch, path));
		} finally {
			await chmod(path, 0o644);
		}
		const db = new DatabaseSync(path);
		db.exec("DELETE FROM settings WHERE id=1");
		db.close();
		assert.throws(() => createServer(fetch, path), /Corrupt database/);
		const retained = new DatabaseSync(path);
		assert.equal(
			retained.prepare("SELECT COUNT(*) AS count FROM settings").get()?.count,
			0,
		);
		retained.close();
		const invalid = join(directory, "invalid.sqlite");
		createServer(fetch, invalid).emit("close");
		const invalidDb = new DatabaseSync(invalid);
		invalidDb.exec("ALTER TABLE model_calls DROP COLUMN output_json");
		invalidDb.close();
		assert.throws(
			() => createServer(fetch, invalid),
			/Invalid database schema/,
		);
		const missing = join(directory, "missing", "db.sqlite");
		assert.throws(() => createServer(fetch, missing));
		const result = spawnSync(
			process.execPath,
			["src/server.ts", "--db", missing],
			{
				cwd: new URL("..", import.meta.url),
				encoding: "utf8",
			},
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unable to open database/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("sidebar width validates bounds and preserves language across restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-width-"));
	const path = join(directory, "db.sqlite");
	const server = createServer(fetch, path).listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const width = async () =>
			(await (await fetch(`${base}/api/sidebar-width`)).json()).width;
		assert.equal(await width(), 320);
		for (const body of [
			"{}",
			'{"width":null}',
			'{"width":"400"}',
			'{"width":239}',
			'{"width":601}',
			'{"width":1e309}',
		]) {
			assert.equal(
				(
					await fetch(`${base}/api/sidebar-width`, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body,
					})
				).status,
				400,
			);
			assert.equal(await width(), 320);
		}
		assert.equal(
			(
				await fetch(`${base}/api/language`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ language: "zh-CN" }),
				})
			).status,
			200,
		);
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
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	try {
		createServer(fetch, path).emit("close");
		const db = new DatabaseSync(path);
		assert.deepEqual(
			{ ...db.prepare("SELECT * FROM settings").get() },
			{
				id: 1,
				sidebar_width: 600,
				language: "zh-CN",
				api_key: null,
				default_model_id: null,
				enter_behavior: "send",
				model_call_limit: 16,
				sub_agent_limit: 32,
			},
		);
		db.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
