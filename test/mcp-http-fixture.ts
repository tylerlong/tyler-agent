// Controlled Streamable HTTP peer; no external account or model calls.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

export async function httpMcpFixture() {
	const requests: {
		method: string;
		session?: string;
		headers: Record<string, string | string[] | undefined>;
		params?: { name?: string; arguments?: Record<string, unknown> };
	}[] = [];
	const streams = new Set<import("node:http").ServerResponse>();
	const pending = new Map<import("node:http").ServerResponse, () => void>();
	const server = createServer(async (req, res) => {
		if (
			(req.url === "/auth" &&
				req.headers.authorization !== "Bearer controlled-<ONCE>") ||
			(req.url === "/key" && req.headers["x-api-key"] !== "controlled-key")
		) {
			requests.push({ method: "unauthorized", headers: req.headers });
			res
				.writeHead(401, {
					"www-authenticate":
						'Bearer resource_metadata="https://example.invalid/oauth"',
				})
				.end("controlled auth rejection");
			return;
		}
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.flushHeaders();
			streams.add(res);
			res.on("close", () => streams.delete(res));
			return;
		}
		if (req.method === "DELETE") {
			requests.push({
				method: "DELETE",
				session: String(req.headers["mcp-session-id"]),
				headers: req.headers,
			});
			res.writeHead(200).end();
			return;
		}
		let body = "";
		for await (const chunk of req) body += chunk;
		const message = JSON.parse(body);
		requests.push({
			method: message.method,
			params: message.params,
			session: req.headers["mcp-session-id"]?.toString(),
			headers: req.headers,
		});
		if (message.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		const respond = (result: unknown) =>
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		if (message.method === "initialize") {
			res.setHeader("mcp-session-id", randomUUID());
			respond({
				protocolVersion: message.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "controlled-http", version: "1" },
			});
		} else if (message.method === "tools/list") {
			respond({
				tools: [
					{
						name: "read_file",
						description: "controlled HTTP tool",
						inputSchema: {
							type: "object",
							properties: {
								mode: { type: "string" },
								payload: { type: "object" },
							},
							required: ["mode", "payload"],
							additionalProperties: false,
						},
					},
				],
			});
		} else if (message.method === "tools/call") {
			const mode = message.params.arguments.mode;
			if (mode === "hold") {
				pending.set(res, () =>
					respond({
						content: [{ type: "text", text: "inflight HTTP result" }],
					}),
				);
				res.on("close", () => pending.delete(res));
			} else if (mode === "wait") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.flushHeaders();
				streams.add(res);
				res.on("close", () => streams.delete(res));
			} else if (mode === "http-error" || mode === "auth-error")
				res
					.writeHead(mode === "http-error" ? 503 : 401)
					.end("controlled call rejection");
			else if (mode === "protocol")
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: message.id,
						error: {
							code: -32603,
							message: "controlled HTTP protocol error",
						},
					}),
				);
			else
				respond({
					content: [{ type: "text", text: "HTTP result" }],
					structuredContent: { payload: message.params.arguments.payload },
					isError: mode === "error",
				});
		} else respond({});
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing HTTP fixture address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		release: () => {
			for (const release of pending.values()) release();
		},
		requests,
		streams,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
