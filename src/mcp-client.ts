import { StringDecoder } from "node:string_decoder";
import { Client, ProtocolError } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ToolExecution } from "./file-tools.ts";
import { type InputContent, submittedImages } from "./image-content.ts";
import { type McpService, parseMcpConfig } from "./mcp-config.ts";

export type McpConnection = {
	id: string;
	name: string;
	status: "connecting" | "connected" | "closed" | "error";
	error?: string;
	stderr?: string;
};
export type McpTool = {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
};
export async function connectMcp(
	services: McpService[],
	readServices: () => McpService[],
	signal: AbortSignal,
	report: (connections: McpConnection[]) => void,
) {
	const connections: McpConnection[] = [];
	const clients: Client[] = [];
	const tools: McpTool[] = [];
	const owners = new Map<string, string>();
	const handlers = new Map<
		string,
		(args: string, imagesSupported: boolean) => Promise<ToolExecution>
	>();
	let closing: Promise<void> | undefined;
	const update = () => {
		if (connections.length) report(connections);
	};
	const close = async () => {
		if (!closing)
			closing = (async () => {
				await Promise.allSettled(clients.map((client) => client.close()));
				for (const connection of connections)
					if (connection.status !== "error") connection.status = "closed";
				update();
			})();
		return closing;
	};
	const cancelled = () => {
		void close().catch(() => {});
	};
	signal.addEventListener("abort", cancelled, { once: true });
	if (signal.aborted) await close();
	try {
		await Promise.all(
			services
				.filter((service) => service.enabled)
				.map(async (service, serviceIndex) => {
					const connection: McpConnection = {
						id: service.id,
						name: service.name,
						status: "connecting",
					};
					connections.push(connection);
					update();
					const client = new Client({ name: "Weft", version: "1.0.0" });
					clients.push(client);
					client.onerror = (error) => {
						connection.error = String(error);
						connection.status = "error";
						update();
					};
					client.onclose = () => {
						if (connection.status !== "error") connection.status = "closed";
						update();
					};
					try {
						signal.throwIfAborted();
						const config = parseMcpConfig(service.config, service.env);
						const transport = new StdioClientTransport({
							command: config.command,
							args: config.args,
							env: Object.fromEntries(
								service.env.map(({ name, value }) => [name, value]),
							),
							stderr: "pipe",
						});
						const stderrDecoder = new StringDecoder("utf8");
						transport.stderr?.on("data", (chunk: Buffer) => {
							connection.stderr =
								(connection.stderr ?? "") + stderrDecoder.write(chunk);
							update();
						});
						transport.stderr?.on("end", () => {
							connection.stderr =
								(connection.stderr ?? "") + stderrDecoder.end();
							update();
						});
						await client.connect(transport, {
							timeout: config.startup_timeout_sec * 1000,
							signal,
						});
						let cursor: string | undefined;
						do {
							const page = await client.listTools(cursor ? { cursor } : {}, {
								signal,
								cacheMode: "refresh",
							});
							for (const tool of page.tools) {
								const name = `mcp_${serviceIndex}_${tools.length}`;
								owners.set(name, service.id);
								tools.push({
									type: "function",
									name,
									description: `[MCP ${service.name}: ${tool.name}] ${tool.description ?? ""}`,
									parameters: tool.inputSchema,
								});
								handlers.set(name, async (args, imagesSupported) => {
									if (
										!readServices().some(
											(row) => row.id === service.id && row.enabled,
										)
									)
										return {
											status: "failed",
											result: JSON.stringify({
												mcpError: {
													kind: "disabled",
													service: service.name,
													message:
														"MCP service disabled or deleted; call was not executed",
												},
											}),
										};
									try {
										const argumentsValue: unknown = JSON.parse(args);
										if (
											!argumentsValue ||
											typeof argumentsValue !== "object" ||
											Array.isArray(argumentsValue)
										)
											throw new TypeError(
												"MCP tool arguments must be an object",
											);
										// Supplying the discovered definition prevents the SDK's modern-header refresh/replay path.
										const result = await client.callTool(
											{
												name: tool.name,
												arguments: argumentsValue as Record<string, unknown>,
											},
											{ signal, toolDefinition: tool },
										);
										const content: InputContent[] = [];
										for (const block of result.content) {
											if (block.type === "image" && imagesSupported) {
												try {
													const images = submittedImages([
														{
															type: "input_image",
															image_url: `data:${block.mimeType};base64,${block.data}`,
														},
													]);
													const { data: _data, ...metadata } = block;
													content.push(
														{
															type: "input_text",
															text: JSON.stringify({ mcpImage: metadata }),
														},
														...images,
													);
													continue;
												} catch {
													/* Preserve unsupported image bytes below. */
												}
											}
											content.push({
												type: "input_text",
												text: JSON.stringify({
													mcpContent: block,
													...(!["text", "image"].includes(block.type)
														? {
																notice:
																	block.type === "resource_link"
																		? "Resource link only; resource has not been read"
																		: "Unsupported MCP content retained as data",
															}
														: block.type === "image"
															? {
																	notice: imagesSupported
																		? "Unsupported image retained as data"
																		: "Current model does not support image input; image retained as data",
																}
															: {}),
												}),
											});
										}
										const { content: _content, ...metadata } = result;
										content.push({
											type: "input_text",
											text: JSON.stringify({ mcpResult: metadata }),
										});
										return {
											status: result.isError ? "failed" : "succeeded",
											result: content,
										};
									} catch (error) {
										return {
											status: "failed",
											result: JSON.stringify({
												mcpError: {
													kind:
														error instanceof ProtocolError
															? "protocol"
															: error instanceof SyntaxError ||
																	error instanceof TypeError
																? "input"
																: "connection",
													message: String(error),
													...(error instanceof Error && "code" in error
														? { code: error.code }
														: {}),
													...(error instanceof Error && "data" in error
														? { data: error.data }
														: {}),
												},
											}),
										};
									}
								});
							}
							cursor = page.nextCursor;
						} while (cursor);
						connection.status = "connected";
						update();
					} catch (error) {
						connection.status = "error";
						connection.error = String(error);
						await client.close().catch(() => {});
						update();
					}
				}),
		);
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
	return {
		tools: () =>
			tools.filter((tool) =>
				readServices().some(
					(service) => service.id === owners.get(tool.name) && service.enabled,
				),
			),
		connections,
		has: (name: string) => handlers.has(name),
		execute: (name: string, args: string, imagesSupported: boolean) => {
			const handler = handlers.get(name);
			if (!handler) throw new Error("Unknown MCP tool");
			return handler(args, imagesSupported);
		},
		close: async () => {
			signal.removeEventListener("abort", cancelled);
			await close();
		},
	};
}
