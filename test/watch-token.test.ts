import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	cp,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CommandExecutor } from "../src/command-executor.ts";
import { createServer as createApplicationServer } from "../src/server.ts";

test("development watch retains authorization after restart and a new launch rotates it", {
	timeout: 30000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-watch-token-"));
	const probe = createServer().listen(0, "127.0.0.1");
	await once(probe, "listening");
	const address = probe.address();
	assert(address && typeof address !== "string");
	const port = address.port;
	assert.notEqual(port, 3000);
	await new Promise<void>((done) => probe.close(() => done()));
	try {
		await cp("src", join(directory, "src"), { recursive: true });
		const serverPath = join(directory, "src/server.ts");
		await writeFile(
			serverPath,
			`${await readFile(serverPath, "utf8")}\nif (import.meta.main) {
 const { spawnSync } = await import("node:child_process");
 const result = spawnSync(process.execPath, ["-e", 'process.stdout.write(String("TYLER_MANAGEMENT_TOKEN" in process.env))']);
 if (result.stdout.toString() !== "false") throw new Error("Management token leaked to child environment");
 console.log("Child environment cleared");
}\n`,
		);
		await symlink(resolve("node_modules"), join(directory, "node_modules"));
		await writeFile(join(directory, "package.json"), '{"type":"module"}');
		const base = `http://127.0.0.1:${port}`;
		let previous = "";
		for (let launch = 0; launch < 2; launch++) {
			const child = spawn(
				"sh",
				[
					resolve("scripts/start.sh"),
					"--port",
					String(port),
					"--db",
					join(directory, "db.sqlite"),
				],
				{
					cwd: directory,
					env: {
						...process.env,
						PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
					},
				},
			);
			const exited = once(child, "exit");
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk;
			});
			const waitForToken = async (count: number) => {
				for (let attempt = 0; attempt < 200; attempt++) {
					const tokens = [...output.matchAll(/#management=([a-f0-9]{64})/g)];
					if (
						tokens.length >= count &&
						output.split("Child environment cleared").length - 1 >= count
					)
						return tokens[count - 1][1];
					assert.equal(child.exitCode, null, "Watcher exited before startup");
					await delay(50);
				}
				throw new Error("Watcher did not finish startup");
			};
			try {
				const token = await waitForToken(1);
				const headers = { "x-tyler-management-token": token };
				assert.equal(
					(await fetch(`${base}/api/projects`, { headers })).status,
					200,
				);
				if (launch === 0) {
					const path = join(directory, "src/server.ts");
					await writeFile(
						path,
						`${await readFile(path, "utf8")}\n// watch restart fixture\n`,
					);
					assert.equal(await waitForToken(2), token);
					assert.equal(
						(await fetch(`${base}/api/projects`, { headers })).status,
						200,
					);
					previous = token;
				} else {
					assert.notEqual(token, previous);
					assert.equal(
						(
							await fetch(`${base}/api/projects`, {
								headers: { "x-tyler-management-token": previous },
							})
						).status,
						403,
					);
				}
			} finally {
				child.kill();
				await exited;
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("direct server instances generate independent tokens without consuming watch environment", async () => {
	const previous = process.env.TYLER_MANAGEMENT_TOKEN;
	const supplied = "a".repeat(64);
	process.env.TYLER_MANAGEMENT_TOKEN = supplied;
	const servers = [
		createApplicationServer(fetch, ":memory:"),
		createApplicationServer(fetch, ":memory:"),
	];
	try {
		assert.notEqual(servers[0].managementToken, servers[1].managementToken);
		for (const server of servers) {
			assert.match(server.managementToken, /^[a-f0-9]{64}$/);
			assert.notEqual(server.managementToken, supplied);
		}
	} finally {
		if (previous === undefined) delete process.env.TYLER_MANAGEMENT_TOKEN;
		else process.env.TYLER_MANAGEMENT_TOKEN = previous;
		await Promise.all(
			servers.map(
				(server) => new Promise<void>((done) => server.close(() => done())),
			),
		);
	}
});

test("CLI rejects invalid supplied tokens before creating a database", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-invalid-token-"));
	const path = join(directory, "db.sqlite");
	try {
		for (const token of ["", "invalid", "A".repeat(64)]) {
			const result = spawnSync(
				process.execPath,
				["src/server.ts", "--db", path],
				{
					env: { ...process.env, TYLER_MANAGEMENT_TOKEN: token },
					encoding: "utf8",
					timeout: 5000,
				},
			);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /Invalid TYLER_MANAGEMENT_TOKEN/);
		}
		await assert.rejects(readFile(path), { code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("command tools never inherit the watch management token", {
	skip: platform() !== "darwin",
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-tool-token-"));
	const executor = new CommandExecutor();
	const previous = process.env.TYLER_MANAGEMENT_TOKEN;
	process.env.TYLER_MANAGEMENT_TOKEN = "synthetic-management-token";
	try {
		let output = "";
		const result = await executor.execute({
			command: 'test -z "$TYLER_MANAGEMENT_TOKEN" && printf clean',
			cwd: directory,
			agentId: `token-${process.pid}`,
			timeoutMs: 5000,
			signal: new AbortController().signal,
			onOutput: (_stream, text) => {
				output += text;
			},
		});
		assert.equal(result.exitCode, 0);
		assert.equal(output, "clean");
	} finally {
		if (previous === undefined) delete process.env.TYLER_MANAGEMENT_TOKEN;
		else process.env.TYLER_MANAGEMENT_TOKEN = previous;
		await executor.close();
		await rm(directory, { recursive: true, force: true });
	}
});
