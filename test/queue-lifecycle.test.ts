import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { imageFromBytes } from "../src/image-content.ts";
import { waitForAgent } from "./agent-fixture.ts";
import { createTestServer } from "./config-fixture.ts";
import { localFetch as fetch } from "./local-fetch.ts";
import { completedResponse } from "./model-fixture.ts";

const answer = [
	{ type: "message", content: [{ type: "output_text", text: "done" }] },
];
async function until(check: () => Promise<boolean>) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		if (await check()) return;
		await setTimeout(5);
	}
	assert.fail("Queue state did not settle");
}
async function fixture(holdCancellation = false) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "queue-lifecycle-")),
	);
	const path = join(directory, "db.sqlite");
	const calls: {
		body: {
			model: string;
			input: { content: unknown }[];
			instructions?: string;
		};
		finish: (output?: unknown[]) => void;
		fail: () => void;
		aborted: boolean;
	}[] = [];
	const model: typeof fetch = async (_url, init) =>
		new Promise<Response>((resolve, reject) => {
			const finish = (output: unknown[] = answer) =>
				resolve(completedResponse({ output }));
			calls.push({
				body: JSON.parse(String(init?.body)),
				finish,
				fail: () => reject(new Error("controlled model failure")),
				aborted: false,
			});
			const call = calls.at(-1);
			assert(call);
			init?.signal?.addEventListener(
				"abort",
				() => {
					call.aborted = true;
					if (!holdCancellation) reject(init.signal?.reason);
				},
				{ once: true },
			);
		});
	let server = createTestServer(model, path).listen(0, "127.0.0.1");
	let base = "";
	const listen = async () => {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		base = `http://127.0.0.1:${address.port}`;
	};
	await listen();
	const request = (route: string, method = "GET", body?: unknown) =>
		fetch(base + route, {
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const json = async (route: string, method = "GET", body?: unknown) => {
		const response = await request(route, method, body);
		assert(
			response.ok,
			`${method} ${route}: ${response.status} ${await response.clone().text()}`,
		);
		return response.json();
	};
	const project = await json("/api/projects", "POST", {
		name: "P",
		folders: [directory],
	});
	const chat = await json(`/api/projects/${project.id}/chats`, "POST", {
		name: "C",
	});
	const route = `/api/chats/${chat.id}`;
	const db = new DatabaseSync(path);
	const closeServer = async () => {
		calls.forEach((call) => {
			call.finish();
		});
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	return {
		directory,
		calls,
		db,
		route,
		project,
		json,
		request,
		ask: (prompt: string) => json(route, "POST", { prompt }),
		queue: (prompt: string) => json(route, "POST", { prompt, intent: "queue" }),
		state: () => json(route),
		wait: (id: number) => waitForAgent(base, id),
		call: async (index: number) => {
			await until(async () => calls.length > index);
			return calls[index];
		},
		restart: async () => {
			await closeServer();
			server = createTestServer(model, path).listen(0, "127.0.0.1");
			await listen();
		},
		close: async () => {
			await closeServer();
			db.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

for (const termination of ["failure", "stop", "limit"] as const) {
	test(`Queue pauses after ${termination}; Send D resumes B then C`, async () => {
		const f = await fixture();
		try {
			if (termination === "limit")
				await f.json("/api/execution-limits", "PATCH", { modelCallLimit: 1 });
			const a = await f.ask("A");
			const call = await f.call(0);
			await f.queue("B");
			await f.queue("C");
			if (termination === "failure") call.fail();
			else if (termination === "stop")
				await f.json(`/api/agents/${a.agentId}/cancel`, "POST", {});
			else
				call.finish([
					{
						type: "function_call",
						name: "read_file",
						call_id: "limit",
						arguments: JSON.stringify({ path: "/tmp/no-file" }),
					},
				]);
			const stopped = await f.wait(a.agentId);
			assert.equal(
				stopped.status,
				termination === "stop" ? "cancelled" : "failed",
			);
			if (termination === "limit")
				assert.equal(stopped.errorCode, "modelCallLimit");
			assert.equal(f.calls.length, 1);
			assert.deepEqual(
				(await f.state()).queue.map((item: { prompt: string }) => item.prompt),
				["B", "C"],
			);
			const d = await f.ask("D");
			(await f.call(1)).finish();
			(await f.call(2)).finish();
			(await f.call(3)).finish();
			await until(async () => !(await f.state()).busy);
			assert.equal((await f.wait(d.agentId)).status, "succeeded");
			assert.deepEqual(
				f.calls.map((item) => item.body.input.at(-1)?.content),
				["A", "D", "B", "C"],
			);
			assert.deepEqual((await f.state()).queue, []);
		} finally {
			await f.close();
		}
	});
}

test("Queue retains a failed admission and continue uses repaired current configuration", async () => {
	const f = await fixture();
	try {
		const a = await f.ask("A");
		const call = await f.call(0);
		const b = await f.queue("B");
		await f.queue("C");
		await f.json("/api/model-settings", "PUT", { apiKey: "" });
		call.finish();
		await f.wait(a.agentId);
		await until(async () => Boolean((await f.state()).queue[0]?.error));
		let state = await f.state();
		assert.equal(state.queue[0].id, b.queueId);
		assert.equal(state.agents.length, 1);
		assert.equal(f.calls.length, 1);
		assert.equal((await f.request(`${f.route}/queue`, "POST", {})).status, 400);
		assert.equal((await f.state()).queue.length, 2);
		f.db
			.prepare(
				"INSERT INTO managed_models(id,name,metadata) VALUES ('replacement','replacement',?)",
			)
			.run(JSON.stringify({ reasoningRequired: false, supportedEfforts: [] }));
		await f.json("/api/model-settings", "PUT", { apiKey: "repaired" });
		await f.json(f.route, "PUT", {
			modelId: "replacement",
			reasoningEffort: null,
		});
		const resumed = await f.json(`${f.route}/queue`, "POST", {});
		assert.equal(typeof resumed.agentId, "number");
		assert.equal((await f.call(1)).body.model, "replacement");
		assert.equal((await f.request(`${f.route}/queue`, "POST", {})).status, 409);
		(await f.call(1)).finish();
		(await f.call(2)).finish();
		await until(async () => !(await f.state()).busy);
		state = await f.state();
		assert.equal(state.agents.length, 3);
		assert.deepEqual(state.queue, []);
	} finally {
		await f.close();
	}
});

test("Archived Chat retains queued input until unarchived and explicitly continued", async () => {
	const f = await fixture();
	try {
		const a = await f.ask("A");
		const call = await f.call(0);
		const b = await f.queue("B");
		await f.json(`${f.route}/archive`, "PUT", { archived: true });
		call.finish();
		await f.wait(a.agentId);
		await until(async () => Boolean((await f.state()).queue[0]?.error));
		assert.equal(f.calls.length, 1);
		assert.equal((await f.state()).queue[0].id, b.queueId);
		assert.equal((await f.request(`${f.route}/queue`, "POST", {})).status, 400);
		await f.json(`${f.route}/archive`, "PUT", { archived: false });
		const accepted = await f.json(`${f.route}/queue`, "POST", {});
		(await f.call(1)).finish();
		await f.wait(accepted.agentId);
		assert.deepEqual((await f.state()).queue, []);
	} finally {
		await f.close();
	}
});

test("Chat queues progress independently and restart clears only unstarted input", async () => {
	const f = await fixture();
	try {
		const a = await f.ask("A");
		const first = await f.call(0);
		await f.queue("B");
		const other = await f.json(`/api/projects/${f.project.id}/chats`, "POST", {
			name: "other",
		});
		const route = `/api/chats/${other.id}`;
		const x = await f.json(route, "POST", { prompt: "X" });
		const second = await f.call(1);
		await f.json(route, "POST", { prompt: "Y", intent: "queue" });
		second.finish();
		(await f.call(2)).finish();
		await f.wait(x.agentId);
		await until(async () => !(await f.json(route)).busy);
		assert.equal((await f.state()).busy, true);
		assert.equal((await f.state()).queue.length, 1);
		first.fail();
		await f.wait(a.agentId);
		await f.restart();
		assert.deepEqual((await f.state()).queue, []);
		assert.equal((await f.state()).agents.length, 1);
		assert.equal((await f.state()).agents[0].status, "failed");
		assert.equal(f.calls.length, 3);
	} finally {
		await f.close();
	}
});

test("Concurrent continue, remove and Send admit each input at most once", async () => {
	const f = await fixture();
	try {
		const a = await f.ask("A");
		const first = await f.call(0);
		await f.queue("B");
		const c = await f.queue("C");
		first.fail();
		await f.wait(a.agentId);
		const responses = await Promise.all([
			f.request(`${f.route}/queue`, "POST", {}),
			f.request(`${f.route}/queue/${c.queueId}`, "DELETE"),
			f.request(f.route, "POST", { prompt: "D" }),
		]);
		assert.equal(responses[1].status, 200);
		assert.deepEqual(
			[responses[0].status, responses[2].status].sort(),
			[202, 409],
		);
		(await f.call(1)).finish();
		if (responses[2].status === 202) (await f.call(2)).finish();
		await until(async () => !(await f.state()).busy);
		const prompts = f.calls
			.slice(1)
			.map((item) => item.body.input.at(-1)?.content);
		assert.deepEqual(prompts, responses[0].status === 202 ? ["B"] : ["D", "B"]);
		assert.deepEqual((await f.state()).queue, []);
	} finally {
		await f.close();
	}
});

test("Queue waits for a held descendant and its terminal notification before starting next Root", async () => {
	const f = await fixture();
	try {
		const a = await f.ask("A");
		await f.queue("B");
		(await f.call(0)).finish([
			{
				type: "function_call",
				name: "create_sub_agent",
				call_id: "child",
				arguments: JSON.stringify({ prompt: "child", context: "background" }),
			},
		]);
		await f.call(2);
		const child = f.calls.find((call) =>
			call.body.input.some((item) => item.content === "child"),
		);
		const continuation = f.calls.find(
			(call, index) => index > 0 && call !== child,
		);
		assert(child);
		assert(continuation);
		continuation.finish();
		await until(async () => {
			const { calls } = await f.json(
				`/api/agents/${a.agentId}/calls?kind=metadata`,
			);
			return (
				calls.filter((call: { status: string }) => call.status === "succeeded")
					.length === 2
			);
		});
		let state = await f.state();
		assert.equal(state.busy, true);
		assert.equal(state.agents.length, 1);
		assert.equal(state.queue.length, 1);
		assert.equal(f.calls.length, 3);
		child.finish();
		(await f.call(3)).finish();
		(await f.call(4)).finish();
		await until(async () => !(await f.state()).busy);
		state = await f.state();
		assert.deepEqual(state.queue, []);
		assert.equal(f.calls[4].body.input.at(-1)?.content, "B");
		const tree = await f.json(`/api/agents/${a.agentId}/tree`);
		assert.equal(tree.agents.length, 2);
		assert(
			tree.agents.every(
				(agent: { status: string }) => agent.status === "succeeded",
			),
		);
	} finally {
		await f.close();
	}
});

test("Queued images and explicit Skill sources survive pending time and load current Skill text on start", async () => {
	const f = await fixture();
	try {
		const skillDirectory = join(f.directory, ".agents/skills/selected");
		await mkdir(skillDirectory, { recursive: true });
		const source = join(skillDirectory, "SKILL.md");
		const skill = (body: string) =>
			`---\nname: selected\ndescription: chosen skill\ndisable-model-invocation: true\n---\n${body}`;
		await writeFile(source, skill("OLD BODY"));
		await f.ask("A");
		const call = await f.call(0);
		const image = imageFromBytes(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYioAAAAASUVORK5CYII=",
				"base64",
			),
		);
		await f.json(f.route, "POST", {
			intent: "queue",
			prompt: "inspect",
			images: [image],
			skillSources: [source],
		});
		assert.equal(f.calls.length, 1);
		await writeFile(source, skill("CURRENT BODY"));
		call.finish();
		const queued = await f.call(1);
		assert.deepEqual(queued.body.input.at(-1), {
			role: "user",
			content: [{ type: "input_text", text: "inspect" }, image],
		});
		assert.match(queued.body.instructions ?? "", /CURRENT BODY/);
		assert.doesNotMatch(queued.body.instructions ?? "", /OLD BODY/);
		queued.finish();
		await until(async () => !(await f.state()).busy);
		assert.deepEqual((await f.state()).queue, []);
	} finally {
		await f.close();
	}
});

for (const outcome of ["success", "failure", "stop", "limit"] as const) {
	test(`Steer cancels A and prioritizes D before B/C; replacement ${outcome}`, async () => {
		const f = await fixture();
		try {
			const a = await f.ask("A");
			await f.call(0);
			await f.queue("B");
			await f.queue("C");
			const d = await f.json(f.route, "POST", {
				prompt: "D",
				intent: "steer",
				targetAgentId: a.agentId,
				submissionId: "D",
			});
			assert.equal(
				(await f.json(`/api/agents/${a.agentId}`)).agents[0].status,
				"cancelled",
			);
			const replacement = await f.call(1);
			if (outcome === "limit")
				await f.json("/api/execution-limits", "PATCH", { modelCallLimit: 1 });
			assert.equal(replacement.body.input.at(-1)?.content, "D");
			assert.equal(f.calls[0].aborted, true);
			assert.deepEqual(
				await f.json(f.route, "POST", {
					prompt: "D",
					intent: "steer",
					targetAgentId: a.agentId,
					submissionId: "D",
				}),
				d,
			);
			if (outcome === "success") {
				replacement.finish();
				(await f.call(2)).finish();
				(await f.call(3)).finish();
			} else if (outcome === "failure") replacement.fail();
			else if (outcome === "limit")
				replacement.finish([
					{
						type: "function_call",
						name: "read_file",
						call_id: "limit",
						arguments: JSON.stringify({ path: "/tmp/no-file" }),
					},
				]);
			else await f.json(`/api/agents/${d.agentId}/cancel`, "POST", {});
			const terminal = await f.wait(d.agentId);
			if (outcome === "limit")
				assert.equal(terminal.errorCode, "modelCallLimit");
			await until(async () => !(await f.state()).busy);
			assert.deepEqual(
				f.calls.map((call) => call.body.input.at(-1)?.content),
				outcome === "success" ? ["A", "D", "B", "C"] : ["A", "D"],
			);
			assert.deepEqual(
				(await f.state()).queue.map((item: { prompt: string }) => item.prompt),
				outcome === "success" ? [] : ["B", "C"],
			);
		} finally {
			await f.close();
		}
	});
}

test("Steer validates before Stop, binds the observed Root and sends after target finished", async () => {
	const f = await fixture();
	try {
		const a = await f.ask("A");
		const first = await f.call(0);
		assert.equal(
			(
				await f.request(f.route, "POST", {
					prompt: "",
					intent: "steer",
					targetAgentId: a.agentId,
				})
			).status,
			400,
		);
		assert.equal(first.aborted, false);
		assert.equal(
			(
				await f.request(f.route, "POST", {
					prompt: "wrong target",
					intent: "steer",
					targetAgentId: a.agentId + 100,
				})
			).status,
			409,
		);
		assert.equal(first.aborted, false);
		first.finish();
		await f.wait(a.agentId);
		const d = await f.json(f.route, "POST", {
			prompt: "D",
			intent: "steer",
			targetAgentId: a.agentId,
		});
		const next = await f.call(1);
		assert.equal(
			(
				await f.request(f.route, "POST", {
					prompt: "stale",
					intent: "steer",
					targetAgentId: a.agentId,
				})
			).status,
			409,
		);
		assert.equal(next.aborted, false);
		next.finish();
		await f.wait(d.agentId);
		assert.equal(f.calls.length, 2);
	} finally {
		await f.close();
	}
});

test("Steer reserves priority through cancellation; duplicate and reconciliation await one admission", async () => {
	const f = await fixture(true);
	try {
		const a = await f.ask("A");
		const first = await f.call(0);
		await f.queue("B");
		const payload = {
			prompt: "D",
			intent: "steer",
			targetAgentId: a.agentId,
			submissionId: "D",
		};
		const pending = f.request(f.route, "POST", payload);
		await until(async () => first.aborted);
		const duplicate = f.request(f.route, "POST", payload);
		const reconcile = f.request(`${f.route}/submissions/D`, "POST", {});
		assert.equal((await f.request(`${f.route}/queue`, "POST", {})).status, 409);
		assert.equal(
			(await f.request(f.route, "POST", { prompt: "competing" })).status,
			409,
		);
		assert.equal(f.calls.length, 1);
		assert.equal((await f.state()).queue.length, 1);
		first.fail();
		const accepted = await (await pending).json();
		assert.deepEqual(await (await duplicate).json(), accepted);
		assert.deepEqual(await (await reconcile).json(), accepted);
		(await f.call(1)).finish();
		(await f.call(2)).finish();
		await until(async () => !(await f.state()).busy);
		assert.deepEqual(
			f.calls.map((call) => call.body.input.at(-1)?.content),
			["A", "D", "B"],
		);
	} finally {
		await f.close();
	}
});

test("Steer cancels the whole descendant tree before admitting the replacement", async () => {
	const f = await fixture(true);
	try {
		const a = await f.ask("A");
		await f.queue("B");
		(await f.call(0)).finish([
			{
				type: "function_call",
				name: "create_sub_agent",
				call_id: "child",
				arguments: JSON.stringify({ prompt: "child", context: "background" }),
			},
		]);
		await f.call(2);
		const active = f.calls.slice(1);
		const pending = f.request(f.route, "POST", {
			prompt: "D",
			intent: "steer",
			targetAgentId: a.agentId,
		});
		await until(async () => active.every((call) => call.aborted));
		active
			.find((call) => call.body.input.some((item) => item.content === "child"))
			?.fail();
		assert.equal(f.calls.length, 3);
		active.forEach((call) => {
			call.fail();
		});
		const d = await (await pending).json();
		const tree = await f.json(`/api/agents/${a.agentId}/tree`);
		assert.equal(tree.agents.length, 2);
		assert(
			tree.agents.every(
				(agent: { status: string }) => agent.status === "cancelled",
			),
		);
		(await f.call(3)).finish();
		(await f.call(4)).finish();
		await f.wait(d.agentId);
		await until(async () => !(await f.state()).busy);
		assert.deepEqual(
			f.calls.slice(3).map((call) => call.body.input.at(-1)?.content),
			["D", "B"],
		);
	} finally {
		await f.close();
	}
});

test("Steer cancellation persistence failure admits no replacement and retains B/C", async () => {
	const f = await fixture();
	try {
		await f.ask("A");
		await f.call(0);
		await f.queue("B");
		await f.queue("C");
		const a = (await f.state()).agents[0];
		f.db.exec(`CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON agents
			WHEN NEW.status='cancelled' BEGIN SELECT RAISE(FAIL, 'controlled terminal write failure'); END`);
		const payload = {
			prompt: "D",
			intent: "steer",
			targetAgentId: a.id,
			submissionId: "failed-D",
		};
		assert.equal((await f.request(f.route, "POST", payload)).status, 500);
		assert.equal((await f.request(f.route, "POST", payload)).status, 409);
		assert.equal(
			(await f.request(`${f.route}/submissions/failed-D`, "POST", {})).status,
			404,
		);
		assert.equal(f.calls.length, 1);
		assert.deepEqual(
			(await f.state()).queue.map((item: { prompt: string }) => item.prompt),
			["B", "C"],
		);
		assert.equal((await f.state()).agents.length, 1);
		f.db.exec("DROP TRIGGER fail_terminal");
	} finally {
		await f.close();
	}
});

test("Concurrent duplicate Queue requests admit only one pending input", async () => {
	const f = await fixture();
	try {
		await f.ask("A");
		await f.call(0);
		const payload = { prompt: "B", intent: "queue", submissionId: "same-B" };
		const responses = await Promise.all([
			f.json(f.route, "POST", payload),
			f.json(f.route, "POST", payload),
		]);
		assert.deepEqual(responses[0], responses[1]);
		assert.equal((await f.state()).queue.length, 1);
		f.calls[0].finish();
		(await f.call(1)).finish();
		await until(async () => !(await f.state()).busy);
		assert.equal(f.calls.length, 2);
	} finally {
		await f.close();
	}
});

test("Steer revalidates configuration after held cancellation and retains pending work on failure", async () => {
	const f = await fixture(true);
	try {
		const a = await f.ask("A");
		const first = await f.call(0);
		await f.queue("B");
		const payload = {
			prompt: "D",
			intent: "steer",
			targetAgentId: a.agentId,
			submissionId: "D",
		};
		const pending = f.request(f.route, "POST", payload);
		await until(async () => first.aborted);
		await f.json("/api/model-settings", "PUT", { apiKey: "" });
		first.fail();
		assert.equal((await pending).status, 400);
		assert.equal((await f.request(f.route, "POST", payload)).status, 409);
		assert.equal(f.calls.length, 1);
		assert.equal((await f.state()).queue[0].prompt, "B");
		assert.equal((await f.state()).agents.length, 1);
	} finally {
		await f.close();
	}
});

test("Steer and manual Stop then Send carry identical interrupted context and D/B/C progression", async () => {
	const inputs = [];
	for (const action of ["steer", "stop-send"] as const) {
		const f = await fixture();
		try {
			const a = await f.ask("A");
			await f.call(0);
			await f.queue("B");
			await f.queue("C");
			if (action === "stop-send")
				await f.json(`/api/agents/${a.agentId}/cancel`, "POST", {});
			const d = await f.json(f.route, "POST", {
				prompt: "D",
				...(action === "steer"
					? { intent: "steer", targetAgentId: a.agentId }
					: {}),
			});
			const replacement = await f.call(1);
			assert.equal(replacement.body.input[0].content, "A");
			assert.equal(replacement.body.input.at(-1)?.content, "D");
			assert.equal(
				replacement.body.input.filter((item) => item.content === "A").length,
				1,
			);
			assert.equal(replacement.body.input.length, 3);
			const history = replacement.body.input[1].content;
			assert.equal(typeof history, "string");
			assert.match(String(history), /^\[Historical interrupted task records:/);
			const records = JSON.parse(
				String(history).slice(String(history).indexOf("] ") + 2),
			);
			assert.equal(records.length, 1);
			assert.equal(records[0].status, "cancelled");
			assert.equal(records[0].error, "agentCancelled");
			replacement.finish();
			(await f.call(2)).finish();
			(await f.call(3)).finish();
			await f.wait(d.agentId);
			await until(async () => !(await f.state()).busy);
			assert.deepEqual(
				f.calls.map((call) => call.body.input.at(-1)?.content),
				["A", "D", "B", "C"],
			);
			assert.deepEqual((await f.state()).queue, []);
			inputs.push(f.calls.slice(1).map((call) => call.body.input));
		} finally {
			await f.close();
		}
	}
	assert.deepEqual(inputs[0], inputs[1]);
});
