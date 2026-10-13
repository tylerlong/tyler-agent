import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/server.ts";

test("a live service owns its database across aliases until shutdown, while independent stores coexist", async () => {
	const directory = await mkdtemp(join(tmpdir(), "database-ownership-"));
	const path = join(directory, "db.sqlite");
	const first = createServer(undefined, path).listen(0, "127.0.0.1");
	await once(first, "listening");
	try {
		await symlink(path, join(directory, "alias.sqlite"));
		for (const alias of [
			path,
			relative(process.cwd(), path),
			join(directory, "alias.sqlite"),
		])
			assert.throws(
				() => createServer(undefined, alias),
				/Database is already in use/,
			);
		for (const independent of [
			join(directory, "other.sqlite"),
			":memory:",
			":memory:",
		]) {
			const other = createServer(undefined, independent).listen(0, "127.0.0.1");
			await once(other, "listening");
			await new Promise<void>((resolve) => other.close(() => resolve()));
		}
	} finally {
		await new Promise<void>((resolve) => first.close(() => resolve()));
	}
	const next = createServer(undefined, path).listen(0, "127.0.0.1");
	await once(next, "listening");
	await new Promise<void>((resolve) => next.close(() => resolve()));
	await rm(directory, { recursive: true, force: true });
});

test("independent services reject concurrent owners before recovery, recover a killed owner without replay, and replace the same port", {
	timeout: 30000,
}, async () => {
	const { spawn } = await import("node:child_process");
	const { createServer: createHttpServer } = await import("node:http");
	const { DatabaseSync } = await import("node:sqlite");
	const { setTimeout: delay } = await import("node:timers/promises");
	const { configureDatabase } = await import("./config-fixture.ts");
	const directory = await mkdtemp(join(tmpdir(), "database-process-"));
	const path = join(directory, "db.sqlite");
	configureDatabase(path);
	const children: ReturnType<typeof spawn>[] = [];
	const freePort = async () => {
		const probe = createHttpServer().listen(0, "127.0.0.1");
		await once(probe, "listening");
		const address = probe.address();
		assert(address && typeof address !== "string");
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		return address.port;
	};
	const start = (database: string, port: number) => {
		const preload =
			"globalThis.fetch=async (_url,init)=>{console.log('model-request');return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}))}";
		const child = spawn(
			process.execPath,
			[
				"--import",
				`data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`,
				new URL("../src/server.ts", import.meta.url).pathname,
				"--db",
				database,
				"--port",
				String(port),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		children.push(child);
		let stdout = "",
			stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const exited = once(child, "exit");
		return {
			child,
			exited,
			get stdout() {
				return stdout;
			},
			get stderr() {
				return stderr;
			},
			async ready() {
				for (let n = 0; n < 500; n++) {
					const match = stdout.match(
						/Open (http:\/\/127\.0\.0\.1:\d+)\/#management=([a-f0-9]+)/,
					);
					if (match) return { base: match[1], token: match[2] };
					assert.equal(child.exitCode, null, stderr);
					await delay(10);
				}
				throw new Error(`startup timeout: ${stderr}`);
			},
		};
	};
	const request = async (
		service: { base: string; token: string },
		route: string,
		body?: unknown,
	) => {
		const response = await fetch(service.base + route, {
			headers: {
				"x-tyler-management-token": service.token,
				origin: service.base,
			},
			...(body === undefined
				? {}
				: { method: "POST", body: JSON.stringify(body) }),
		});
		assert(response.ok, `${route}: ${response.status}`);
		return response.json();
	};
	try {
		const port = await freePort();
		const first = start(path, port);
		const service = await first.ready();
		const project = await request(service, "/api/projects", {
			name: "Live",
			folders: [],
		});
		const chat = await request(service, `/api/projects/${project.id}/chats`, {
			name: "Live",
		});
		const { agentId } = await request(service, `/api/chats/${chat.id}`, {
			prompt: "waiting",
		});
		const db = new DatabaseSync(path);
		for (let n = 0; n < 500 && !first.stdout.includes("model-request"); n++)
			await delay(10);
		assert(first.stdout.includes("model-request"));
		const callId = Number(
			db.prepare("SELECT id FROM model_calls WHERE agent_id=?").get(agentId)
				?.id,
		);
		assert(callId);
		db.prepare(
			"INSERT INTO tool_calls(model_call_id,call_id,name,arguments,ordinal,status) VALUES(?,?,?,?,0,'running')",
		).run(
			callId,
			"synthetic-active",
			"exec_command",
			JSON.stringify({ command: "must-not-replay" }),
		);
		await symlink(path, join(directory, "alias.sqlite"));
		for (const alias of [
			path,
			relative(process.cwd(), path),
			join(directory, "alias.sqlite"),
		]) {
			const second = start(alias, await freePort());
			const [code] = await second.exited;
			assert.equal(code, 1);
			assert.match(second.stderr, /Database is already in use/);
			assert.equal(
				db.prepare("SELECT status FROM agents WHERE id=?").get(agentId)?.status,
				"pending",
			);
			assert.equal(
				db.prepare("SELECT status FROM model_calls WHERE id=?").get(callId)
					?.status,
				"pending",
			);
			assert.equal(
				db
					.prepare("SELECT status FROM tool_calls WHERE model_call_id=?")
					.get(callId)?.status,
				"running",
			);
			assert((await request(service, "/api/projects")).projects);
		}
		const independent = start(
			join(directory, "independent.sqlite"),
			await freePort(),
		);
		await independent.ready();
		independent.child.kill("SIGTERM");
		assert.equal((await independent.exited)[0], 0);
		first.child.kill("SIGKILL");
		assert.equal((await first.exited)[1], "SIGKILL");
		const restarted = start(path, port);
		await restarted.ready();
		assert.equal(
			db.prepare("SELECT status FROM agents WHERE id=?").get(agentId)?.status,
			"failed",
		);
		assert.equal(
			db.prepare("SELECT error_code FROM model_calls WHERE id=?").get(callId)
				?.error_code,
			"modelInterrupted",
		);
		assert.equal(
			db
				.prepare("SELECT status FROM tool_calls WHERE model_call_id=?")
				.get(callId)?.status,
			"interrupted",
		);
		assert(!restarted.stdout.includes("model-request"));
		const replacement = start(path, port);
		const replacementService = await replacement.ready();
		assert.equal((await restarted.exited)[0], 0);
		assert((await request(replacementService, "/api/projects")).projects);
		assert(!replacement.stdout.includes("model-request"));
		replacement.child.kill("SIGTERM");
		assert.equal((await replacement.exited)[0], 0);
		const normalRestart = start(path, port);
		await normalRestart.ready();
		normalRestart.child.kill("SIGTERM");
		assert.equal((await normalRestart.exited)[0], 0);
		db.close();
	} finally {
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
		await rm(directory, { recursive: true, force: true });
	}
});
