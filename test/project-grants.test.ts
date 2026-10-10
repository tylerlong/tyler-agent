import assert from "node:assert/strict";
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
import { localFetch } from "./local-fetch.ts";
import { completedBody } from "./model-fixture.ts";

const native = {
	skip:
		platform() !== "darwin"
			? "Native Project permissions verified on macOS"
			: false,
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture() {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "project-grants-")),
	);
	const root = join(directory, "root");
	await mkdir(root);
	const path = join(directory, "extra.txt");
	await writeFile(path, "shared input");
	let operation: { name: string; args: unknown } = {
		name: "read_file",
		args: { path },
	};
	const fetchModel: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const lastUser = body.input.findLastIndex(
			(item: { role?: string }) => item.role === "user",
		);
		const current = body.input.slice(lastUser);
		const selected =
			operation.name === "create_sub_agent" &&
			JSON.stringify(current[0]).includes("Child reads shared permission")
				? { name: "read_file", args: { path } }
				: operation;
		const output = current.some(
			(item: { type: string }) => item.type === "function_call_output",
		)
			? [
					{
						id: "answer",
						type: "message",
						content: [{ type: "output_text", text: "done" }],
					},
				]
			: [
					{
						id: "tool",
						call_id: "tool",
						type: "function_call",
						name: selected.name,
						arguments: JSON.stringify(selected.args),
					},
				];
		return new Response(completedBody({ status: "completed", output }));
	};
	let server = createTestServer(fetchModel, join(directory, "db.sqlite"));
	let base = "";
	async function listen() {
		server.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		base = `http://127.0.0.1:${address.port}`;
	}
	await listen();
	async function request(route: string, body?: unknown, method = "POST") {
		const response = await localFetch(
			base + route,
			body === undefined ? undefined : { method, body: JSON.stringify(body) },
		);
		assert(response.ok, await response.clone().text());
		return response.json();
	}
	const project = await request("/api/projects", {
		name: "Shared",
		folders: [root],
	});
	const chat = await request(`/api/projects/${project.id}/chats`, {
		name: "First",
	});
	const other = await request("/api/projects", {
		name: "Other",
		folders: [root],
	});
	const isolated = await request(`/api/projects/${other.id}/chats`, {
		name: "Isolated",
	});
	return {
		directory,
		root,
		path,
		project,
		chat,
		isolated,
		request,
		get base() {
			return base;
		},
		setOperation(next: typeof operation) {
			operation = next;
		},
		async run(chatId: number) {
			const { agentId } = await request(`/api/chats/${chatId}`, {
				prompt: "read",
			});
			await waitForAgent(base, agentId);
			return (await request(`/api/agents/${agentId}/tools`)).toolCalls;
		},
		async restart() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			server = createTestServer(fetchModel, join(directory, "db.sqlite"));
			await listen();
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test(
	"Project grants survive restart, authorize existing/future Chats and children, isolate Projects and distinguish read/write",
	native,
	async () => {
		const f = await fixture();
		try {
			await f.request(
				`/api/projects/${f.project.id}/grants`,
				{
					paths: [{ path: f.path, access: "read" }],
					domains: ["EXAMPLE.com"],
					localNetwork: true,
				},
				"PUT",
			);
			await f.restart();
			const saved = (await f.request("/api/projects")).projects.find(
				(project: { id: number }) => project.id === f.project.id,
			);
			assert.deepEqual(saved.grants, {
				paths: [{ path: f.path, access: "read" }],
				domains: ["example.com"],
				localNetwork: true,
			});
			assert.equal((await f.run(f.chat.id))[0].status, "succeeded");
			const future = await f.request(`/api/projects/${f.project.id}/chats`, {
				name: "Future",
			});
			assert.equal((await f.run(future.id))[0].status, "succeeded");
			assert.equal((await f.run(f.isolated.id))[0].status, "failed");
			f.setOperation({
				name: "exec_command",
				args: {
					cwd: f.root,
					command: `printf changed > ${quote(f.path)}`,
					timeout_ms: 10000,
				},
			});
			const failed = (await f.run(f.chat.id))[0];
			assert.equal(JSON.parse(failed.result).exitCode, 1);
			assert.equal(await readFile(f.path, "utf8"), "shared input");
			await f.request(
				`/api/projects/${f.project.id}/grants`,
				{
					paths: [{ path: f.path, access: "write" }],
					domains: [],
					localNetwork: false,
				},
				"PUT",
			);
			assert.equal(JSON.parse((await f.run(f.chat.id))[0].result).exitCode, 0);
			assert.equal(await readFile(f.path, "utf8"), "changed");
			f.setOperation({
				name: "create_sub_agent",
				args: { prompt: "Child reads shared permission" },
			});
			const started = await f.request(`/api/chats/${f.chat.id}`, {
				prompt: "parent",
			});
			let childId: number | undefined;
			for (let i = 0; i < 1000; i++) {
				const tools = (await f.request(`/api/agents/${started.agentId}/tools`))
					.toolCalls;
				if (tools[0]?.result) {
					childId = JSON.parse(tools[0].result).agent_id;
					break;
				}
				await setTimeout(10);
			}
			assert(childId);
			// The child request uses its own prompt and inherited Project permissions.
			f.setOperation({ name: "read_file", args: { path: f.path } });
			await waitForAgent(f.base, started.agentId);
			const childTools = (await f.request(`/api/agents/${childId}/tools`))
				.toolCalls;
			assert.equal(childTools[0].name, "read_file");
			assert.equal(childTools[0].status, "succeeded");
		} finally {
			await f.close();
		}
	},
);

test(
	"grant revocation affects subsequent starts while an executing command keeps its snapshot",
	native,
	async () => {
		const f = await fixture();
		try {
			await f.request(
				`/api/projects/${f.project.id}/grants`,
				{
					paths: [{ path: f.path, access: "write" }],
					domains: [],
					localNetwork: false,
				},
				"PUT",
			);
			f.setOperation({
				name: "exec_command",
				args: {
					cwd: f.root,
					command: `printf started; sleep 1; printf snapshot > ${quote(f.path)}`,
					timeout_ms: 10000,
				},
			});
			const { agentId } = await f.request(`/api/chats/${f.chat.id}`, {
				prompt: "run",
			});
			for (let i = 0; i < 1000; i++) {
				const tools = (await f.request(`/api/agents/${agentId}/tools`))
					.toolCalls;
				if (tools[0]) {
					const output = tools[0].output;
					if (JSON.stringify(output).includes("started")) break;
				}
				await setTimeout(10);
			}
			await f.request(
				`/api/projects/${f.project.id}/grants`,
				{ paths: [], domains: [], localNetwork: false },
				"PUT",
			);
			await waitForAgent(f.base, agentId);
			assert.equal(await readFile(f.path, "utf8"), "snapshot");
			f.setOperation({ name: "read_file", args: { path: f.path } });
			assert.equal((await f.run(f.chat.id))[0].status, "failed");
		} finally {
			await f.close();
		}
	},
);
