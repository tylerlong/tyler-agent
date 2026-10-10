import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { createTestServer } from "./config-fixture.ts";
import { localFetch } from "./local-fetch.ts";
import { completedBody } from "./model-fixture.ts";

const executorPids = async () => {
	const { stdout } = await promisify(execFile)("ps", [
		"-axo",
		"pid=,ppid=,command=",
	]);
	return stdout.split("\n").flatMap((line) => {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
		return match &&
			Number(match[2]) === process.pid &&
			match[3].includes("exec-server --listen stdio://")
			? [Number(match[1])]
			: [];
	});
};

for (const unresponsive of [false, true])
	test(`ordinary HTTP shutdown cleans managed work (unresponsive backend: ${unresponsive})`, {
		skip: platform() !== "darwin",
		timeout: 55000,
	}, async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "command-shutdown-")),
		);
		const root = join(directory, "project");
		await mkdir(root);
		const before = new Set(await executorPids());
		let requests = 0;
		const server = createTestServer(
			async () => {
				requests++;
				return new Response(
					completedBody({
						status: "completed",
						output: [
							{
								id: "run",
								call_id: "run",
								type: "function_call",
								name: "exec_command",
								arguments: JSON.stringify({
									command: "printf 'ready:%s\n' $$; sleep 60",
									cwd: root,
									timeout_ms: 60000,
								}),
							},
						],
					}),
				);
			},
			join(directory, "db.sqlite"),
		).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const request = async (path: string, body?: unknown) => {
			const res = await localFetch(
				base + path,
				body === undefined
					? undefined
					: { method: "POST", body: JSON.stringify(body) },
			);
			assert(res.ok);
			return res.json();
		};
		let pid = 0,
			commandPid = 0,
			closed = false;
		try {
			const project = await request("/api/projects", {
				name: "Shutdown",
				folders: [root],
			});
			const chat = await request(`/api/projects/${project.id}/chats`, {
				name: "Shutdown",
			});
			const { agentId } = await request(`/api/chats/${chat.id}`, {
				prompt: "run",
			});
			let ready = false;
			for (let i = 0; i < 500; i++) {
				const tool = (await request(`/api/agents/${agentId}/tools`))
					.toolCalls[0];
				if (tool) {
					const output = (
						await request(`/api/agents/${agentId}/tools?toolId=${tool.id}`)
					).toolCalls[0].output;
					const log = output
						.map((chunk: { text: string }) => chunk.text)
						.join("");
					const match = log.match(/ready:(\d+)\n/);
					if (match) {
						commandPid = Number(match[1]);
						ready = true;
						break;
					}
				}
				await setTimeout(10);
			}
			assert(ready, "received native output before shutdown");
			const owned = (await executorPids()).filter((id) => !before.has(id));
			assert.equal(owned.length, 1);
			pid = owned[0];
			if (unresponsive) process.kill(pid, "SIGSTOP");
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			closed = true;
			const deadline = Date.now() + 40000;
			while (Date.now() < deadline && (await executorPids()).includes(pid))
				await setTimeout(100);
			assert(
				!(await executorPids()).includes(pid),
				"dead backend cleanup must settle within 40 seconds",
			);
			if (!unresponsive)
				assert.throws(() => process.kill(commandPid, 0), { code: "ESRCH" });
			assert.equal(
				requests,
				1,
				"shutdown does not replay a tool or model request",
			);
		} finally {
			if (pid && (await executorPids()).includes(pid))
				process.kill(pid, "SIGCONT");
			if (!closed) {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			if (commandPid) {
				try {
					process.kill(-commandPid, "SIGKILL");
				} catch (error) {
					assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
				}
			}
			await rm(directory, { recursive: true, force: true });
		}
	});
