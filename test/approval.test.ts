import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch, managementTokens } from "./local-fetch.ts";
import { completedBody } from "./model-fixture.ts";

const native = {
	skip:
		platform() !== "darwin"
			? "Native executor approval is verified on macOS"
			: false,
};
const answer = {
	id: "answer",
	type: "message",
	content: [{ type: "output_text", text: "done" }],
};
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function fixture(
	operation: () => { name: string; args: unknown },
	again = false,
) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "approval-http-")),
	);
	const root = join(directory, "project");
	await mkdir(root);
	let requests = 0;
	const results: unknown[] = [];
	const server = createTestServer(
		async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (++requests === 1 || (again && requests === 2)) {
				if (requests > 1) results.push(JSON.parse(body.input.at(-1).output));
				const { name, args } = operation();
				return new Response(
					completedBody({
						status: "completed",
						output: [
							{
								id: `call-${requests}`,
								call_id: `call-${requests}`,
								type: "function_call",
								name,
								arguments: JSON.stringify(args),
							},
						],
					}),
				);
			}
			results.push(JSON.parse(body.input.at(-1).output));
			return new Response(
				completedBody({ status: "completed", output: [answer] }),
			);
		},
		join(directory, "db.sqlite"),
	).listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const response = (route: string, body?: unknown) =>
		localFetch(
			base + route,
			body === undefined
				? undefined
				: { method: "POST", body: JSON.stringify(body) },
		);
	const request = async (route: string, body?: unknown) => {
		const res = await response(route, body);
		assert(res.ok, `${route}: ${res.status} ${await res.clone().text()}`);
		return res.json();
	};
	const project = await request("/api/projects", {
		name: "Approval fixture",
		folders: [root],
	});
	const chat = await request(`/api/projects/${project.id}/chats`, {
		name: "Pending operation",
	});
	return {
		directory,
		root,
		base,
		server,
		results,
		request,
		response,
		ask: async () =>
			(await request(`/api/chats/${chat.id}`, { prompt: "run" }))
				.agentId as number,
		pending: async () => {
			for (let i = 0; i < 1000; i++) {
				const { approvals } = await request("/api/approvals");
				if (approvals.length) return approvals[0];
				await setTimeout(10);
			}
			assert.fail("No pending approval");
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("management writes reject native forged Origin and cannot bootstrap a token over HTTP", async () => {
	const f = await fixture(() => ({
		name: "read_file",
		args: { path: "/unused" },
	}));
	try {
		assert.match(f.server.managementToken, /^[a-f0-9]{64}$/);
		const forgedHeaders: Record<string, string>[] = [
			{ Origin: f.base },
			{ Origin: f.base, "x-tyler-management-token": "forged" },
		];
		for (const headers of forgedHeaders) {
			const res = await fetch(`${f.base}/api/projects`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "forged", folders: [f.root] }),
			});
			assert.equal(res.status, 403);
		}
		for (const route of [
			"/api/management-token",
			"/api/bootstrap",
			"/api/token",
		]) {
			const res = await fetch(f.base + route);
			assert.equal(res.status, 404);
			assert(!(await res.text()).includes(f.server.managementToken));
		}
		const html = await (await fetch(f.base)).text();
		assert(!html.includes(f.server.managementToken));
		assert.equal((await f.request("/api/projects")).projects.length, 1);
	} finally {
		await f.close();
	}
});

test(
	"pending read approval rejects altered/stale decisions, waits without executing and deny returns a result",
	native,
	async () => {
		let path = "";
		const f = await fixture(() => ({
			name: "read_file",
			args: {
				path,
				reason: "Read the requested private input",
				extra_permissions: { paths: [{ path, access: "read" }] },
			},
		}));
		path = join(f.directory, "private.txt");
		try {
			await writeFile(path, "secret");
			const id = await f.ask();
			const pending = await f.pending();
			assert.equal(pending.agentId, id);
			assert.equal(pending.name, "read_file");
			assert.deepEqual(pending.permissions.paths, [{ path, access: "read" }]);
			const tool = (await f.request(`/api/agents/${id}/tools`)).toolCalls[0];
			assert.equal(tool.status, "waiting");
			assert.equal(tool.reason, "approvalRequired");
			await setTimeout(1100);
			assert.equal(f.results.length, 0);
			assert.equal((await f.pending()).requestId, pending.requestId);
			for (const body of [
				{ requestId: "stale", decision: "once" },
				{ ...pending, decision: "once" },
				{
					requestId: pending.requestId,
					decision: "once",
					permissions: { paths: [{ path, access: "write" }] },
				},
				{ requestId: pending.requestId, decision: "always" },
			]) {
				assert(
					!(await f.response(`/api/approvals/${pending.toolCallId}`, body)).ok,
				);
				assert.equal((await f.pending()).requestId, pending.requestId);
			}
			const forged = await fetch(
				`${f.base}/api/approvals/${pending.toolCallId}`,
				{
					method: "POST",
					headers: { Origin: f.base },
					body: JSON.stringify({
						requestId: pending.requestId,
						decision: "once",
					}),
				},
			);
			assert.equal(forged.status, 403);
			await f.request(`/api/approvals/${pending.toolCallId}`, {
				requestId: pending.requestId,
				decision: "deny",
			});
			assert.equal((await waitForAgent(f.base, id)).status, "succeeded");
			assert.match(JSON.stringify(f.results), /denied/i);
			assert(!JSON.stringify(f.results).includes('"text":"secret"'));
			assert(
				!(
					await f.response(`/api/approvals/${pending.toolCallId}`, {
						requestId: pending.requestId,
						decision: "once",
					})
				).ok,
			);
			assert.deepEqual((await f.request("/api/approvals")).approvals, []);
		} finally {
			await f.close();
		}
	},
);

test(
	"once approval reads original path and another call must ask again",
	native,
	async () => {
		let path = "";
		const f = await fixture(
			() => ({
				name: "read_file",
				args: {
					path,
					reason: "Read once",
					extra_permissions: { paths: [{ path, access: "read" }] },
				},
			}),
			true,
		);
		path = join(f.directory, "private.txt");
		try {
			await writeFile(path, "private input");
			const id = await f.ask();
			const first = await f.pending();
			await f.request(`/api/approvals/${first.toolCallId}`, {
				requestId: first.requestId,
				decision: "once",
			});
			const second = await f.pending();
			assert.notEqual(second.toolCallId, first.toolCallId);
			assert.notEqual(second.requestId, first.requestId);
			assert.match(JSON.stringify(f.results), /private input/);
			assert(
				!(
					await f.response(`/api/approvals/${second.toolCallId}`, {
						requestId: first.requestId,
						decision: "once",
					})
				).ok,
			);
			await f.request(`/api/approvals/${second.toolCallId}`, {
				requestId: second.requestId,
				decision: "deny",
			});
			assert.equal((await waitForAgent(f.base, id)).status, "succeeded");
			assert.equal(f.results.length, 2);
		} finally {
			await f.close();
		}
	},
);

test(
	"native read approval cannot write and explicit write approval runs original command after waiting",
	native,
	async () => {
		let path = "",
			root = "";
		const f = await fixture(() => ({
			name: "exec_command",
			args: {
				cwd: root,
				command: `printf changed > ${quote(path)}`,
				timeout_ms: 1000,
				reason: "Write fixture",
				extra_permissions: { paths: [{ path, access: "read" }] },
			},
		}));
		root = f.root;
		path = join(f.directory, "private.txt");
		try {
			await writeFile(path, "preserved");
			const id = await f.ask();
			const pending = await f.pending();
			await f.request(`/api/approvals/${pending.toolCallId}`, {
				requestId: pending.requestId,
				decision: "once",
			});
			assert.equal((await waitForAgent(f.base, id)).status, "succeeded");
			assert.equal(await readFile(path, "utf8"), "preserved");
		} finally {
			await f.close();
		}
		let writable = "",
			cwd = "";
		const g = await fixture(() => ({
			name: "exec_command",
			args: {
				cwd,
				command: `printf changed > ${quote(writable)}`,
				timeout_ms: 1000,
				reason: "Write fixture",
				extra_permissions: { paths: [{ path: writable, access: "write" }] },
			},
		}));
		cwd = g.root;
		writable = join(g.directory, "private.txt");
		try {
			await writeFile(writable, "preserved");
			const id = await g.ask();
			const pending = await g.pending();
			await setTimeout(1200);
			assert.equal(await readFile(writable, "utf8"), "preserved");
			await g.request(`/api/approvals/${pending.toolCallId}`, {
				requestId: pending.requestId,
				decision: "once",
			});
			assert.equal((await waitForAgent(g.base, id)).status, "succeeded");
			assert.equal(
				await readFile(writable, "utf8"),
				"changed",
				JSON.stringify(g.results),
			);
		} finally {
			await g.close();
		}
	},
);

test(
	"cancelled pending approval cannot revive original command",
	native,
	async () => {
		let root = "",
			path = "";
		const f = await fixture(() => ({
			name: "exec_command",
			args: {
				cwd: root,
				command: `printf executed > ${quote(path)}`,
				timeout_ms: 10000,
				reason: "Write input",
				extra_permissions: { paths: [{ path, access: "write" }] },
			},
		}));
		root = f.root;
		path = join(f.directory, "private.txt");
		try {
			await writeFile(path, "preserved");
			const id = await f.ask();
			const pending = await f.pending();
			await f.request(`/api/agents/${id}/cancel`, {});
			assert(
				!(
					await f.response(`/api/approvals/${pending.toolCallId}`, {
						requestId: pending.requestId,
						decision: "once",
					})
				).ok,
			);
			assert.equal((await waitForAgent(f.base, id)).status, "cancelled");
			assert.equal(await readFile(path, "utf8"), "preserved");
			assert.equal(f.results.length, 0);
			assert.deepEqual((await f.request("/api/approvals")).approvals, []);
		} finally {
			await f.close();
		}
	},
);

test(
	"approved native localhost command still cannot forge management writes or obtain the user token",
	native,
	async () => {
		let root = "",
			base = "";
		const f = await fixture(() => ({
			name: "exec_command",
			args: {
				cwd: root,
				command: "node attack.cjs",
				reason: "Probe local fixture",
				extra_permissions: { localNetwork: true },
				timeout_ms: 10000,
			},
		}));
		root = f.root;
		base = f.base;
		try {
			await writeFile(
				join(root, "attack.cjs"),
				`(async()=>{const base=${JSON.stringify(base)}; const response=await fetch(base+'/api/projects',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:'forged',folders:[]})});console.log('forged:'+response.status);const bootstrap=await fetch(base+'/api/bootstrap');console.log('bootstrap:'+bootstrap.status)})().catch(e=>{console.error(e);process.exitCode=1})`,
			);
			const id = await f.ask();
			const pending = await f.pending();
			assert.equal(pending.permissions.localNetwork, true);
			await f.request(`/api/approvals/${pending.toolCallId}`, {
				requestId: pending.requestId,
				decision: "once",
			});
			assert.equal((await waitForAgent(base, id)).status, "succeeded");
			const output = JSON.stringify(f.results);
			assert.match(output, /forged:403/);
			assert.match(output, /bootstrap:404/);
			assert(!output.includes(f.server.managementToken));
			assert.equal((await f.request("/api/projects")).projects.length, 1);
		} finally {
			await f.close();
		}
	},
);

test(
	"approved exact localhost domain reaches named fixture while listening still requires native localNetwork",
	native,
	async () => {
		const { createServer } = await import("node:http");
		const endpoint = createServer((_req, res) =>
			res.end("local-response"),
		).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => endpoint.once("listening", resolve));
		const address = endpoint.address();
		assert(address && typeof address !== "string");
		try {
			for (const localNetwork of [false, true]) {
				let cwd = "";
				const f = await fixture(() => ({
					name: "exec_command",
					args: {
						cwd,
						command: "node network.cjs",
						timeout_ms: 10000,
						reason: "Read named local fixture",
						extra_permissions: {
							domains: ["localhost"],
							...(localNetwork ? { localNetwork: true } : {}),
						},
					},
				}));
				cwd = f.root;
				try {
					await writeFile(
						join(cwd, "network.cjs"),
						`const http=require('node:http');fetch('http://localhost:${address.port}').then(r=>r.text()).then(console.log).catch(()=>{console.log('network-denied');process.exitCode=2}); const listener=http.createServer().listen(0,'127.0.0.1');listener.on('error',()=>console.log('listen-denied'));listener.on('listening',()=>{console.log('listen-allowed');listener.close()})`,
					);
					const id = await f.ask();
					const pending = await f.pending();
					assert.deepEqual(pending.permissions.domains, ["localhost"]);
					await f.request(`/api/approvals/${pending.toolCallId}`, {
						requestId: pending.requestId,
						decision: "once",
					});
					assert.equal((await waitForAgent(f.base, id)).status, "succeeded");
					assert.match(
						JSON.stringify(f.results),
						localNetwork ? /listen-allowed/ : /listen-denied/,
					);
				} finally {
					await f.close();
				}
			}
		} finally {
			endpoint.closeAllConnections();
			await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		}
	},
);

test(
	"Project scope edits recheck pending full and partial requests without model bookkeeping calls",
	native,
	async () => {
		for (const full of [false, true]) {
			let a = "",
				b = "";
			const f = await fixture(() => ({
				name: "read_file",
				args: {
					path: join(a, "input"),
					reason: "Read both scopes",
					extra_permissions: {
						paths: [
							{ path: a, access: "read" },
							{ path: b, access: "read" },
						],
					},
				},
			}));
			a = join(f.directory, "extra-a");
			b = join(f.directory, "extra-b");
			try {
				await mkdir(a);
				await mkdir(b);
				await writeFile(join(a, "input"), "original operation");
				const id = await f.ask();
				const before = await f.pending();
				const update = await localFetch(
					`${f.base}/api/projects/${before.projectId}`,
					{
						method: "PUT",
						body: JSON.stringify({
							name: "Approval fixture",
							folders: [f.root, a, ...(full ? [b] : [])],
						}),
					},
				);
				assert.equal(update.status, 200);
				if (!full) {
					const after = await f.pending();
					assert.deepEqual(after.permissions.paths, [
						{ path: b, access: "read" },
					]);
					assert.notEqual(after.requestId, before.requestId);
					assert.equal(f.results.length, 0);
					assert(
						!(
							await f.response(`/api/approvals/${after.toolCallId}`, {
								requestId: before.requestId,
								decision: "once",
							})
						).ok,
					);
					await f.request(`/api/approvals/${after.toolCallId}`, {
						requestId: after.requestId,
						decision: "once",
					});
				}
				assert.equal((await waitForAgent(f.base, id)).status, "succeeded");
				assert.equal(f.results.length, 1);
				assert.match(JSON.stringify(f.results), /original operation/);
				assert.deepEqual((await f.request("/api/approvals")).approvals, []);
			} finally {
				await f.close();
			}
		}
	},
);

test(
	"restarting service interrupts a pending approval and never revives its operation",
	native,
	async () => {
		const directory = await realpath(
			await mkdtemp(join(tmpdir(), "approval-restart-")),
		);
		const root = join(directory, "project");
		await mkdir(root);
		const path = join(directory, "private.txt");
		await writeFile(path, "secret");
		const database = join(directory, "db.sqlite");
		const fixtureUrl = new URL("./config-fixture.ts", import.meta.url).href;
		const modelUrl = new URL("./model-fixture.ts", import.meta.url).href;
		const child = spawn(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`import {createTestServer} from ${JSON.stringify(fixtureUrl)};import {completedBody} from ${JSON.stringify(modelUrl)};const server=createTestServer(async()=>new Response(completedBody({status:'completed',output:[{id:'read',call_id:'read',type:'function_call',name:'read_file',arguments:JSON.stringify({path:${JSON.stringify(path)},reason:'Read once',extra_permissions:{paths:[{path:${JSON.stringify(path)},access:'read'}]}})}]})),${JSON.stringify(database)}).listen(0,'127.0.0.1');server.once('listening',()=>console.log(JSON.stringify({port:server.address().port,token:server.managementToken})));`,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const exited = once(child, "exit");
		let restarted: ReturnType<typeof createTestServer> | undefined;
		try {
			const startup = await new Promise<{ port: number; token: string }>(
				(resolve, reject) => {
					let output = "";
					const timer = globalThis.setTimeout(
						() => reject(new Error("Startup timed out")),
						10000,
					);
					child.stdout.on("data", (chunk) => {
						output += chunk;
						if (output.includes("\n")) {
							globalThis.clearTimeout(timer);
							resolve(JSON.parse(output.trim()));
						}
					});
					child.once("error", reject);
				},
			);
			const base = `http://127.0.0.1:${startup.port}`;
			managementTokens.set(base, startup.token);
			const request = async (route: string, body?: unknown) => {
				const res = await localFetch(
					base + route,
					body === undefined
						? undefined
						: { method: "POST", body: JSON.stringify(body) },
				);
				assert(res.ok);
				return res.json();
			};
			const project = await request("/api/projects", {
				name: "Restart",
				folders: [root],
			});
			const chat = await request(`/api/projects/${project.id}/chats`, {
				name: "Restart",
			});
			const { agentId } = await request(`/api/chats/${chat.id}`, {
				prompt: "Read",
			});
			let pending: { toolCallId: number; requestId: string } | undefined;
			for (let attempt = 0; attempt < 1000; attempt++) {
				pending = (await request("/api/approvals")).approvals[0];
				if (pending) break;
				await setTimeout(10);
			}
			assert(pending);
			child.kill("SIGKILL");
			await exited;
			managementTokens.delete(base);
			let requests = 0;
			restarted = createTestServer(async () => {
				requests++;
				return new Response(
					completedBody({ status: "completed", output: [answer] }),
				);
			}, database).listen(0, "127.0.0.1");
			await new Promise<void>((resolve) =>
				restarted?.once("listening", resolve),
			);
			const address = restarted.address();
			assert(address && typeof address !== "string");
			const restartBase = `http://127.0.0.1:${address.port}`;
			assert.deepEqual(
				(await (await localFetch(`${restartBase}/api/approvals`)).json())
					.approvals,
				[],
			);
			const tool = (
				await (
					await localFetch(`${restartBase}/api/agents/${agentId}/tools`)
				).json()
			).toolCalls[0];
			assert.equal(tool.status, "interrupted");
			assert.equal(tool.approval.status, "interrupted");
			assert(
				!(
					await localFetch(
						`${restartBase}/api/approvals/${pending.toolCallId}`,
						{
							method: "POST",
							body: JSON.stringify({
								requestId: pending.requestId,
								decision: "once",
							}),
						},
					)
				).ok,
			);
			assert.equal(requests, 0);
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
			if (restarted) {
				restarted.closeAllConnections();
				await new Promise<void>((resolve) => restarted?.close(() => resolve()));
			}
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test(
	"service shutdown settles pending approval before closing its database",
	native,
	async () => {
		let path = "";
		const f = await fixture(() => ({
			name: "read_file",
			args: {
				path,
				reason: "Read once",
				extra_permissions: { paths: [{ path, access: "read" }] },
			},
		}));
		path = join(f.directory, "private.txt");
		try {
			await writeFile(path, "secret");
			await f.ask();
			await f.pending();
		} finally {
			await f.close();
		}
	},
);

test(
	"invalid extra scopes and missing reasons return results without inferred approval or widened retry",
	native,
	async () => {
		for (const variant of [
			"missing reason",
			"wildcard domain",
			"bad localNetwork",
			"no extra request",
		]) {
			let path = "";
			const f = await fixture(() => ({
				name: "read_file",
				args: {
					path,
					...(variant === "no extra request"
						? {}
						: {
								...(variant === "missing reason"
									? {}
									: { reason: "Read fixture" }),
								extra_permissions:
									variant === "wildcard domain"
										? { domains: ["*.example.com"] }
										: variant === "bad localNetwork"
											? { localNetwork: "yes" }
											: { paths: [{ path, access: "read" }] },
							}),
				},
			}));
			path = join(f.directory, "private.txt");
			try {
				await writeFile(path, "private input");
				const id = await f.ask();
				assert.equal((await waitForAgent(f.base, id)).status, "succeeded");
				assert.deepEqual((await f.request("/api/approvals")).approvals, []);
				assert.equal(f.results.length, 1);
				assert.match(JSON.stringify(f.results), /error/);
				assert(!JSON.stringify(f.results).includes('"text":"private input"'));
			} finally {
				await f.close();
			}
		}
	},
);

test(
	"approved write directory applies the original native patch to an outside file once",
	native,
	async () => {
		let directory = "",
			cwd = "";
		const f = await fixture(() => ({
			name: "apply_patch",
			args: {
				cwd,
				patch: `*** Begin Patch\n*** Update File: ${join(directory, "private.txt")}\n@@\n-before\n+after\n*** End Patch`,
				reason: "Update requested fixture",
				extra_permissions: { paths: [{ path: directory, access: "write" }] },
			},
		}));
		cwd = f.root;
		directory = join(f.directory, "extra");
		try {
			await mkdir(directory);
			await writeFile(join(directory, "private.txt"), "before\n");
			const id = await f.ask();
			const pending = await f.pending();
			assert.equal(
				await readFile(join(directory, "private.txt"), "utf8"),
				"before\n",
			);
			await f.request(`/api/approvals/${pending.toolCallId}`, {
				requestId: pending.requestId,
				decision: "once",
			});
			assert.equal((await waitForAgent(f.base, id)).status, "succeeded");
			assert.equal(
				await readFile(join(directory, "private.txt"), "utf8"),
				"after\n",
				JSON.stringify(f.results),
			);
			assert.equal(f.results.length, 1);
		} finally {
			await f.close();
		}
	},
);

test(
	"concurrent approval and cancellation settle the original command at most once",
	native,
	async () => {
		let root = "",
			path = "";
		const f = await fixture(() => ({
			name: "exec_command",
			args: {
				cwd: root,
				command: `printf executed >> ${quote(path)}`,
				timeout_ms: 10000,
				reason: "Append once",
				extra_permissions: { paths: [{ path, access: "write" }] },
			},
		}));
		root = f.root;
		path = join(f.directory, "private.txt");
		try {
			await writeFile(path, "");
			const id = await f.ask();
			const pending = await f.pending();
			const [approved, cancelled] = await Promise.all([
				f.response(`/api/approvals/${pending.toolCallId}`, {
					requestId: pending.requestId,
					decision: "once",
				}),
				f.response(`/api/agents/${id}/cancel`, {}),
			]);
			assert.equal(cancelled.status, 200);
			assert([200, 400, 409].includes(approved.status));
			assert.equal((await waitForAgent(f.base, id)).status, "cancelled");
			assert(["", "executed"].includes(await readFile(path, "utf8")));
			assert(
				!(
					await f.response(`/api/approvals/${pending.toolCallId}`, {
						requestId: pending.requestId,
						decision: "once",
					})
				).ok,
			);
			assert.deepEqual((await f.request("/api/approvals")).approvals, []);
		} finally {
			await f.close();
		}
	},
);
