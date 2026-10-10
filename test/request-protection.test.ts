import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTestServer } from "./config-fixture.ts";
import { completedResponse } from "./model-fixture.ts";

// Deliberately use raw clients: absence and mismatches must reach the real guard.
test("local Host and exact Origin protect all mutations and bodyless cancellation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-origin-"));
	let calls = 0;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server = createTestServer(
		async (_url, options) => {
			calls++;
			await Promise.race([
				held,
				new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					}),
				),
			]);
			return completedResponse({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "answer" }],
					},
				],
			});
		},
		join(directory, "db.sqlite"),
	).listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address !== "string");
	assert.notEqual(address.port, 3000);
	const base = `http://127.0.0.1:${address.port}`;
	const send = (
		path: string,
		method = "GET",
		body?: unknown,
		headers: Record<string, string> = { Origin: base },
	) =>
		new Promise<Response>((resolve, reject) => {
			const req = request(
				base + path,
				{
					method,
					headers: {
						"x-tyler-management-token": server.managementToken,
						...headers,
						...(body === undefined
							? {}
							: {
									"Content-Length": String(
										Buffer.byteLength(JSON.stringify(body)),
									),
								}),
					},
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk) => chunks.push(chunk));
					response.on("end", () =>
						resolve(
							new Response(Buffer.concat(chunks), {
								status: response.statusCode,
								headers: response.headers as Record<string, string>,
							}),
						),
					);
				},
			);
			req.on("error", (error) =>
				reject(
					new Error(`${method} ${path} ${JSON.stringify(headers)}`, {
						cause: error,
					}),
				),
			);
			req.end(body === undefined ? undefined : JSON.stringify(body));
		});
	try {
		for (const host of [
			"evil.example",
			`evil.example:${address.port}`,
			"127.0.0.1:3000",
			"localhost",
			`localhost:0${address.port}`,
			`127.0.0.2:${address.port}`,
			`[::2]:${address.port}`,
			`localhost:${address.port}@evil.example`,
		]) {
			const response = await send(
				"/api/projects",
				"POST",
				{ name: "evil", folders: [] },
				{ Host: host, Origin: base, "X-Forwarded-Host": new URL(base).host },
			);
			assert.equal(response.status, 403, host);
		}
		// Supported aliases can address the same listener, but remain distinct origins.
		for (const host of [
			`localhost:${address.port}`,
			`[::1]:${address.port}`,
			new URL(base).host,
		]) {
			assert.equal(
				(
					await send(
						"/api/language",
						"PUT",
						{ language: "en" },
						{ Host: host, Origin: `http://${host}` },
					)
				).status,
				200,
			);
			if (host !== new URL(base).host)
				assert.equal(
					(
						await send(
							"/api/language",
							"PUT",
							{ language: "zh-CN" },
							{ Host: host, Origin: base },
						)
					).status,
					403,
				);
		}
		const project = await (
			await send("/api/projects", "POST", { name: "safe", folders: [] })
		).json();
		const chat = await (
			await send(`/api/projects/${project.id}/chats`, "POST", { name: "safe" })
		).json();
		for (const origin of [
			undefined,
			"null",
			"",
			`http://127.0.0.1:${address.port + 1}`,
			`http://localhost:${address.port}`,
			base + "/",
			base.replace("http:", "https:"),
		]) {
			const headers: Record<string, string> =
				origin === undefined ? {} : { Origin: origin };
			assert.equal(
				(
					await send(
						`/api/chats/${chat.id}`,
						"POST",
						{ prompt: "foreign" },
						headers,
					)
				).status,
				403,
			);
			for (const method of ["POST", "PUT", "PATCH", "DELETE"])
				assert.equal(
					(await send("/api/language", method, { language: "zh-CN" }, headers))
						.status,
					403,
				);
			assert.equal(
				(
					await send(
						`/api/projects/${project.id}`,
						"PUT",
						{ name: "changed", folders: [] },
						headers,
					)
				).status,
				403,
			);
			assert.equal(
				(
					await send(
						`/api/chats/${chat.id}/archive`,
						"PUT",
						{ archived: true },
						headers,
					)
				).status,
				403,
			);
			assert.equal(
				(await send("/api/models/test", "DELETE", undefined, headers)).status,
				403,
			);
		}
		assert.equal(calls, 0);
		assert.deepEqual(
			(await (await send(`/api/chats/${chat.id}`)).json()).agents,
			[],
		);
		assert.equal((await (await send("/api/language")).json()).language, "en");
		const projects = (await (await send("/api/projects")).json()).projects;
		assert.equal(projects.length, 1);
		assert.equal(projects[0].name, "safe");
		const accepted = await (
			await send(`/api/chats/${chat.id}`, "POST", { prompt: "accepted" })
		).json();
		assert.equal(calls, 1);
		const rejectedHeaders: Record<string, string>[] = [
			{},
			{ Origin: "null" },
			{ Origin: `http://localhost:${address.port}` },
		];
		for (const headers of rejectedHeaders) {
			assert.equal(
				(
					await send(
						`/api/agents/${accepted.agentId}/cancel`,
						"POST",
						undefined,
						headers,
					)
				).status,
				403,
			);
			assert.equal(
				(await (await send(`/api/agents/${accepted.agentId}`)).json()).agents[0]
					.status,
				"pending",
			);
		}
		assert.equal(
			(await send(`/api/agents/${accepted.agentId}/cancel`, "POST")).status,
			200,
		);
		assert.equal(
			(await (await send(`/api/agents/${accepted.agentId}`)).json()).agents[0]
				.status,
			"cancelled",
		);
		assert.equal(
			(
				await send("/api/projects", "OPTIONS", undefined, {
					Origin: "http://foreign.example",
				})
			).headers.get("access-control-allow-origin"),
			null,
		);
		// A missing Host is sent through node:http rather than fetch's automatic Host.
		const missing = await new Promise<number>((resolve) => {
			const r = request(
				base + "/api/projects",
				{ setHost: false },
				(response) => {
					response.resume();
					resolve(response.statusCode!);
				},
			);
			r.end();
		});
		assert.equal(missing, 400); // Node rejects HTTP/1.1 without Host before dispatch.
	} finally {
		release();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
