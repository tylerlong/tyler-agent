import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { subscribeEvents } from "../src/api-events.ts";

async function settle() {
	for (let i = 0; i < 10; i++) await setImmediate();
}

test("SSE decodes UTF-8 and CRLF across chunks and dispatches named and default events", async (t) => {
	const bytes = new TextEncoder().encode(
		": keepalive\r\nevent: agent\r\ndata: 中文😀\r\ndata: second\r\n\r\ndata: default\n\n",
	);
	let stream!: ReadableStreamDefaultController<Uint8Array>;
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					start: (value) => {
						stream = value;
					},
				}),
			),
	);
	const events: [string, string][] = [];
	let opens = 0;
	const stop = subscribeEvents({
		onOpen: () => {
			opens++;
		},
		onEvent: (name, data) => events.push([name, data]),
		onError: () => assert.fail("active stream must not fail"),
	});
	await settle();
	for (const byte of bytes) stream.enqueue(Uint8Array.of(byte));
	await settle();
	assert.equal(opens, 1);
	assert.deepEqual(events, [
		["agent", "中文😀\nsecond"],
		["message", "default"],
	]);
	stop();
	await settle();
});

test("SSE reconnects after EOF and network errors; disposal cancels connection and timer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	let signal: AbortSignal | null | undefined;
	t.mock.method(
		globalThis,
		"fetch",
		async (_path: string, init: RequestInit) => {
			calls++;
			signal = init.signal;
			if (calls === 2) throw new TypeError("disconnected");
			return new Response(
				new ReadableStream({ start: (stream) => stream.close() }),
			);
		},
	);
	const errors: string[] = [];
	const stop = subscribeEvents({
		onOpen: () => {},
		onEvent: () => {},
		onError: (error) => errors.push(error.code),
	});
	await settle();
	assert.equal(calls, 1);
	t.mock.timers.tick(1000);
	await settle();
	assert.equal(calls, 2);
	t.mock.timers.tick(1000);
	await settle();
	assert.equal(calls, 3);
	assert.deepEqual(errors, ["networkFailed", "networkFailed", "networkFailed"]);
	stop();
	assert.equal(signal?.aborted, true);
	t.mock.timers.tick(10000);
	await settle();
	assert.equal(calls, 3);
});

test("SSE authorization failure is actionable and never reconnects", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return Response.json(
			{ code: "managementAuthorizationRequired" },
			{ status: 403 },
		);
	});
	const errors: string[] = [];
	const stop = subscribeEvents({
		onOpen: () => assert.fail("unauthorized stream opened"),
		onEvent: () => {},
		onError: (error) => errors.push(error.code),
	});
	await settle();
	t.mock.timers.tick(10000);
	await settle();
	assert.equal(calls, 1);
	assert.deepEqual(errors, ["managementAuthorizationRequired"]);
	stop();
});

test("authenticated transport rejects URLs outside the local API before sending headers", async (t) => {
	const { apiFetch } = await import("../src/api.ts");
	const client = t.mock.method(globalThis, "fetch", async () => new Response());
	for (const path of [
		"https://provider.example/api/models",
		"//provider.example/api/models",
		"/assets/index.js",
		"/api/../outside",
		"/api/%2e%2e/outside",
	]) {
		await assert.rejects(apiFetch(path), { code: "invalidRequest" });
	}
	assert.equal(client.mock.callCount(), 0);
});
