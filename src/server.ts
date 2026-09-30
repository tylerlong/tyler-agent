import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const page = new URL("../dist/index.html", import.meta.url);
const defaultDatabasePath = fileURLToPath(
	new URL("../data/tyler-agent.sqlite", import.meta.url),
);

type Message = { role: "user" | "assistant"; content: string };

function openDatabase(path: string, createDefaultDirectory: boolean) {
	if (createDefaultDirectory) mkdirSync(dirname(path), { recursive: true });
	const database = new DatabaseSync(path);
	try {
		database.exec(`
			CREATE TABLE IF NOT EXISTS turns (
				id INTEGER PRIMARY KEY,
				user_content TEXT NOT NULL,
				assistant_content TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS settings (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				folder TEXT NOT NULL
			);
		`);
		database.prepare(
			"SELECT user_content, assistant_content FROM turns ORDER BY id",
		);
		database.prepare("SELECT folder FROM settings WHERE id = 1");
		database.exec(`
			SAVEPOINT startup_check;
			INSERT INTO settings (id, folder) VALUES (1, '')
				ON CONFLICT(id) DO UPDATE SET folder = excluded.folder;
			INSERT INTO turns (user_content, assistant_content) VALUES ('', '');
			ROLLBACK TO startup_check;
			RELEASE startup_check;
		`);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

function readMessages(database: DatabaseSync): Message[] {
	return database
		.prepare("SELECT user_content, assistant_content FROM turns ORDER BY id")
		.all()
		.flatMap((row) => [
			{ role: "user" as const, content: String(row.user_content) },
			{ role: "assistant" as const, content: String(row.assistant_content) },
		]);
}

function saveTurn(database: DatabaseSync, prompt: string, answer: string) {
	database
		.prepare(
			"INSERT INTO turns (user_content, assistant_content) VALUES (?, ?)",
		)
		.run(prompt, answer);
}

class SafeResponseError extends Error {}

async function readJson(request: IncomingMessage): Promise<unknown> {
	let body = "";
	for await (const chunk of request) {
		body += chunk;
		if (body.length > 8192) throw new SafeResponseError("请求过大");
	}
	return JSON.parse(body);
}

export function createServer(
	fetchModel: typeof fetch = fetch,
	debugEnabled = false,
	databasePath?: string,
) {
	const database = openDatabase(
		databasePath === undefined ? defaultDatabasePath : resolve(databasePath),
		databasePath === undefined,
	);
	let callId = 0;
	let busy = false;
	const subscribers = new Set<ServerResponse>();
	const notifyChange = () => {
		for (const subscriber of subscribers) subscriber.write("data: changed\n\n");
	};
	return createHttpServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(await readFile(page));
			return;
		}

		if (request.method === "GET" && request.url?.startsWith("/assets/")) {
			const filename = request.url.slice("/assets/".length);
			if (/^[\w.-]+\.(?:js|css)$/.test(filename)) {
				try {
					const asset = new URL(`../dist/assets/${filename}`, import.meta.url);
					const contents = await readFile(asset);
					response.writeHead(200, {
						"content-type": filename.endsWith(".js")
							? "text/javascript; charset=utf-8"
							: "text/css; charset=utf-8",
					});
					response.end(contents);
					return;
				} catch {
					// Missing assets fall through to 404.
				}
			}
		}

		if (request.url === "/api/events" && request.method === "GET") {
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
			});
			response.write(": connected\n\n");
			subscribers.add(response);
			response.on("close", () => subscribers.delete(response));
			return;
		}

		if (request.url === "/api/debug" && request.method === "GET") {
			response.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
			});
			response.end(JSON.stringify({ enabled: debugEnabled }));
			return;
		}

		if (request.url === "/api/chat" && request.method === "GET") {
			response.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
			});
			response.end(
				JSON.stringify({
					messages: readMessages(database),
					busy,
					folder:
						database.prepare("SELECT folder FROM settings WHERE id = 1").get()
							?.folder ?? null,
				}),
			);
			return;
		}

		if (request.url === "/api/debug" && request.method === "PUT") {
			try {
				const input = await readJson(request);
				if (
					!input ||
					typeof input !== "object" ||
					!("enabled" in input) ||
					typeof input.enabled !== "boolean"
				) {
					throw new SafeResponseError("无效的日志设置");
				}
				const changed = debugEnabled !== input.enabled;
				debugEnabled = input.enabled;
				response.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
				});
				response.end(JSON.stringify({ enabled: debugEnabled }));
				if (changed) notifyChange();
			} catch {
				response.writeHead(400, {
					"content-type": "application/json; charset=utf-8",
				});
				response.end(JSON.stringify({ error: "无效的日志设置" }));
			}
			return;
		}

		if (request.method === "POST" && request.url === "/api/task") {
			if (busy) {
				response.writeHead(409, {
					"content-type": "application/json; charset=utf-8",
				});
				response.end(JSON.stringify({ error: "已有请求正在进行中" }));
				return;
			}
			busy = true;
			notifyChange();
			try {
				const input = await readJson(request);
				if (
					!input ||
					typeof input !== "object" ||
					!("folder" in input) ||
					typeof input.folder !== "string" ||
					!input.folder.trim() ||
					!("prompt" in input) ||
					typeof input.prompt !== "string" ||
					!input.prompt.trim()
				) {
					throw new SafeResponseError("请填写目标文件夹和 prompt");
				}
				let folder: Awaited<ReturnType<typeof stat>>;
				try {
					folder = await stat(input.folder);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT")
						throw new SafeResponseError("目标文件夹不存在");
					throw new SafeResponseError("无法访问目标文件夹");
				}
				if (!folder.isDirectory())
					throw new SafeResponseError("目标路径不是文件夹");
				const previousFolder = database
					.prepare("SELECT folder FROM settings WHERE id = 1")
					.get()?.folder;
				database
					.prepare(
						"INSERT INTO settings (id, folder) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET folder = excluded.folder",
					)
					.run(input.folder);
				if (previousFolder !== input.folder) notifyChange();
				const messages = readMessages(database);
				const apiKey = process.env.OPENROUTER_API_KEY;
				const model = process.env.OPENROUTER_MODEL;
				if (!apiKey || !model)
					throw new SafeResponseError("OpenRouter 配置缺失");
				const url = "https://openrouter.ai/api/v1/responses";
				const headers = {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				};
				const body = JSON.stringify({
					model,
					input: [...messages, { role: "user", content: input.prompt }],
					stream: false,
				});
				const shouldLog = debugEnabled;
				const id = shouldLog ? ++callId : 0;
				const started = performance.now();
				const escapedKey = JSON.stringify(apiKey).slice(1, -1);
				const redact = (value: string) =>
					value
						.replaceAll(apiKey, "[REDACTED]")
						.replaceAll(escapedKey, "[REDACTED]");
				const pretty = (value: unknown) =>
					redact(JSON.stringify(value, null, 2));
				const displayBody = (raw: string) => {
					try {
						return pretty(JSON.parse(raw));
					} catch {
						return redact(raw);
					}
				};
				const log = (kind: string, details: unknown, raw?: string) => {
					console.log(
						`[OpenRouter #${id}] ${kind}\n${pretty(details)}${raw === undefined ? "" : `\nbody:\n${displayBody(raw)}`}`,
					);
				};
				if (shouldLog)
					log(
						"request",
						{ time: new Date().toISOString(), url, method: "POST" },
						body,
					);
				let upstream: Response | undefined;
				let rawBody: string;
				try {
					upstream = await fetchModel(url, { method: "POST", headers, body });
					rawBody = await upstream.text();
				} catch (error) {
					if (shouldLog)
						log("error", {
							...(upstream && { status: upstream.status }),
							error: String(error),
							durationMs: Math.round(performance.now() - started),
						});
					throw error;
				}
				if (shouldLog) {
					log(
						"response",
						{
							status: upstream.status,
							durationMs: Math.round(performance.now() - started),
						},
						rawBody,
					);
				}
				if (!upstream.ok) throw new SafeResponseError("OpenRouter 请求失败");
				const data: unknown = JSON.parse(rawBody);
				const output =
					data && typeof data === "object" && "output" in data
						? data.output
						: null;
				const answer = Array.isArray(output)
					? output
							.flatMap((item) =>
								item.type === "message" && Array.isArray(item.content)
									? item.content
											.filter(
												(part: { type?: string; text?: unknown }) =>
													part.type === "output_text" &&
													typeof part.text === "string",
											)
											.map((part: { text: string }) => part.text)
									: [],
							)
							.join("\n")
							.trim()
					: "";
				if (!answer) throw new SafeResponseError("OpenRouter 没有返回文本答案");
				saveTurn(database, input.prompt, answer);
				notifyChange();
				response.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
				});
				response.end(JSON.stringify({ answer }));
			} catch (error) {
				response.writeHead(400, {
					"content-type": "application/json; charset=utf-8",
				});
				response.end(
					JSON.stringify({
						error:
							error instanceof SafeResponseError ? error.message : "请求失败",
					}),
				);
			} finally {
				busy = false;
				notifyChange();
			}
			return;
		}

		response.writeHead(404);
		response.end();
	}).on("close", () => database.close());
}

if (import.meta.main) {
	const port = Number(process.env.PORT ?? 3000);
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			debug: { type: "boolean" },
			db: { type: "string" },
		},
	});
	if (values.db === "") throw new Error("--db requires a database file path");
	createServer(fetch, values.debug ?? false, values.db).listen(
		port,
		"127.0.0.1",
		() => {
			console.log(`Open http://127.0.0.1:${port}`);
		},
	);
}
