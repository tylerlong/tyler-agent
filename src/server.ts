import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { listProjects, openDatabase } from "./database.ts";
import { ModelError, requestModel } from "./openrouter.ts";

const defaultDatabasePath = fileURLToPath(
	new URL("../data/tyler-agent.sqlite", import.meta.url),
);
class InputError extends Error {}
async function readJson(
	request: IncomingMessage,
): Promise<Record<string, unknown>> {
	let body = "";
	for await (const chunk of request) {
		body += chunk;
		if (body.length > 8192) throw new InputError("请求过大");
	}
	try {
		const input: unknown = JSON.parse(body);
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error();
		return input as Record<string, unknown>;
	} catch {
		throw new InputError("无效的输入");
	}
}
function name(input: Record<string, unknown>) {
	if (typeof input.name !== "string" || !input.name.trim())
		throw new InputError("名称不得为空");
	return input.name.trim();
}
function json(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(body));
}

export function createServer(
	fetchModel: typeof fetch = fetch,
	databasePath?: string,
) {
	const database = openDatabase(
		databasePath === undefined ? defaultDatabasePath : resolve(databasePath),
		databasePath === undefined,
	);
	let debugEnabled = Boolean(
		database.prepare("SELECT debug_enabled FROM settings WHERE id=1").get()
			?.debug_enabled,
	);
	const home = homedir();
	const busy = new Set<number>();
	const projects = () =>
		listProjects(database).map((project) => ({
			...project,
			chats: project.chats.map((chat) => ({
				...chat,
				busy: busy.has(Number(chat.id)),
			})),
		}));
	const messages = (id: number) =>
		database
			.prepare(
				"SELECT id, user_content, assistant_content FROM turns WHERE chat_id=? ORDER BY id",
			)
			.all(id)
			.flatMap((row) => [
				{
					id: `${row.id}-user`,
					role: "user" as const,
					content: String(row.user_content),
				},
				{
					id: `${row.id}-assistant`,
					role: "assistant" as const,
					content: String(row.assistant_content),
				},
			]);
	const subscribers = new Set<ServerResponse>();
	const notifyChange = () => {
		for (const subscriber of subscribers) subscriber.write("data: changed\n\n");
	};
	return createHttpServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const path = url.pathname;
		if (request.method === "GET" && path === "/") {
			try {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(
					await readFile(new URL("../dist/index.html", import.meta.url)),
				);
			} catch {
				response.end("Build the frontend first");
			}
			return;
		}
		if (request.method === "GET" && path.startsWith("/assets/")) {
			const filename = path.slice("/assets/".length);
			if (/^[\w.-]+\.(?:js|css)$/.test(filename)) {
				try {
					const contents = await readFile(
						new URL(`../dist/assets/${filename}`, import.meta.url),
					);
					response.writeHead(200, {
						"content-type": filename.endsWith(".js")
							? "text/javascript; charset=utf-8"
							: "text/css; charset=utf-8",
					});
					response.end(contents);
					return;
				} catch {
					/* Missing assets return 404. */
				}
			}
		}
		if (path === "/api/events" && request.method === "GET") {
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
			});
			response.write(": connected\n\n");
			subscribers.add(response);
			response.on("close", () => subscribers.delete(response));
			return;
		}
		if (
			path === "/api/sidebar-width" &&
			(request.method === "GET" || request.method === "PUT")
		) {
			try {
				if (request.method === "PUT") {
					const { width } = await readJson(request);
					if (
						typeof width !== "number" ||
						!Number.isFinite(width) ||
						width < 240 ||
						width > 600
					)
						throw new InputError("无效的面板宽度");
					database
						.prepare("UPDATE settings SET sidebar_width=? WHERE id=1")
						.run(width);
				}
				const width =
					database
						.prepare("SELECT sidebar_width AS width FROM settings WHERE id=1")
						.get()?.width ?? 320;
				json(response, 200, { width });
			} catch (error) {
				if (!(error instanceof InputError))
					console.error("Sidebar width read/write failed", error);
				json(response, error instanceof InputError ? 400 : 500, {
					error: "面板宽度读写失败",
				});
			}
			return;
		}
		if (path === "/api/debug" && request.method === "GET") {
			json(response, 200, { enabled: debugEnabled });
			return;
		}
		if (path === "/api/debug" && request.method === "PUT") {
			try {
				const input = await readJson(request);
				if (typeof input.enabled !== "boolean")
					throw new InputError("无效的日志设置");
				database
					.prepare("UPDATE settings SET debug_enabled=? WHERE id=1")
					.run(Number(input.enabled));
				const changed = input.enabled !== debugEnabled;
				debugEnabled = input.enabled;
				json(response, 200, { enabled: debugEnabled });
				if (changed) notifyChange();
			} catch (error) {
				if (!(error instanceof InputError))
					console.error("Debug setting write failed", error);
				json(response, error instanceof InputError ? 400 : 500, {
					error:
						error instanceof InputError ? "无效的日志设置" : "保存日志设置失败",
				});
			}
			return;
		}
		if (path === "/api/directories" && request.method === "GET") {
			try {
				const paths = url.searchParams.getAll("path");
				if (paths.length > 1 || (paths.length && !paths[0]?.trim()))
					throw new InputError("无效的目录路径");
				const current = resolve(paths[0]?.trim() ?? home);
				if (!(await stat(current)).isDirectory())
					throw new InputError("目标路径不是文件夹");
				await access(current, constants.R_OK | constants.X_OK);
				const entries = await readdir(current, { withFileTypes: true });
				const directories = [];
				for (const entry of entries) {
					if (entry.name.startsWith(".")) continue;
					const child = join(current, entry.name);
					let directory = entry.isDirectory();
					if (entry.isSymbolicLink()) {
						try {
							directory = (await stat(child)).isDirectory();
						} catch {
							continue;
						}
					}
					if (directory) directories.push({ name: entry.name, path: child });
				}
				directories.sort((a, b) =>
					a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
				);
				json(response, 200, {
					path: current,
					parent: dirname(current) === current ? null : dirname(current),
					directories,
				});
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				json(
					response,
					error instanceof InputError
						? 400
						: code === "ENOENT"
							? 404
							: code === "EACCES" || code === "EPERM"
								? 403
								: 400,
					{
						error:
							error instanceof InputError
								? error.message
								: code === "ENOENT"
									? "目标文件夹不存在"
									: "无法浏览目标文件夹",
					},
				);
			}
			return;
		}
		if (path === "/api/projects" && request.method === "GET") {
			json(response, 200, { projects: projects() });
			return;
		}
		if (path === "/api/projects" && request.method === "POST") {
			try {
				const input = await readJson(request);
				const projectName = name(input);
				if (
					!Array.isArray(input.folders) ||
					!input.folders.length ||
					input.folders.some(
						(folder) => typeof folder !== "string" || !folder.trim(),
					)
				)
					throw new InputError("至少需要一个非空文件夹路径");
				const folders = input.folders.map((folder: string) =>
					resolve(folder.trim()),
				);
				if (new Set(folders).size !== folders.length)
					throw new InputError("文件夹路径重复");
				for (const folder of folders) {
					try {
						if (!(await stat(folder)).isDirectory())
							throw new InputError("目标路径不是文件夹");
						await access(folder, constants.R_OK | constants.X_OK);
					} catch (error) {
						if (error instanceof InputError) throw error;
						throw new InputError(
							(error as NodeJS.ErrnoException).code === "ENOENT"
								? "目标文件夹不存在"
								: "无法访问目标文件夹",
						);
					}
				}
				database.exec("BEGIN");
				let id: number;
				try {
					id = Number(
						database
							.prepare("INSERT INTO projects(name,created_at) VALUES (?,?)")
							.run(projectName, Date.now()).lastInsertRowid,
					);
					for (const folder of folders)
						database
							.prepare("INSERT INTO folders(project_id,path) VALUES (?,?)")
							.run(id, folder);
					database.exec("COMMIT");
				} catch (error) {
					database.exec("ROLLBACK");
					throw error;
				}
				json(
					response,
					201,
					listProjects(database).find((project) => project.id === id),
				);
				notifyChange();
			} catch (error) {
				json(response, error instanceof InputError ? 400 : 500, {
					error:
						error instanceof InputError ? error.message : "创建 project 失败",
				});
			}
			return;
		}
		const chatRoute = path.match(/^\/api\/chats\/(\d+)$/);
		if (chatRoute && (request.method === "GET" || request.method === "POST")) {
			const id = Number(chatRoute[1]);
			if (!database.prepare("SELECT id FROM chats WHERE id=?").get(id)) {
				json(response, 404, { error: "Chat 不存在" });
				return;
			}
			if (request.method === "GET") {
				json(response, 200, { messages: messages(id), busy: busy.has(id) });
				return;
			}
			let locked = false;
			try {
				const input = await readJson(request);
				if (typeof input.prompt !== "string" || !input.prompt.trim())
					throw new InputError("Prompt 不得为空");
				if (busy.has(id)) {
					json(response, 409, { error: "Chat 正在处理请求" });
					return;
				}
				busy.add(id);
				locked = true;
				database
					.prepare("UPDATE chats SET last_question_at=? WHERE id=?")
					.run(Date.now(), id);
				notifyChange();
				let answer: string;
				try {
					answer = await requestModel(
						messages(id).map(({ role, content }) => ({ role, content })),
						input.prompt,
						fetchModel,
						debugEnabled,
					);
				} catch (error) {
					throw new ModelError(
						error instanceof ModelError ? error.message : "OpenRouter 请求失败",
					);
				}
				database
					.prepare(
						"INSERT INTO turns(chat_id,user_content,assistant_content) VALUES (?,?,?)",
					)
					.run(id, input.prompt, answer);
				json(response, 200, { answer });
			} catch (error) {
				json(
					response,
					error instanceof InputError
						? 400
						: error instanceof ModelError
							? 502
							: 500,
					{
						error:
							error instanceof InputError || error instanceof ModelError
								? error.message
								: "保存回答失败",
					},
				);
			} finally {
				if (locked) {
					busy.delete(id);
					notifyChange();
				}
			}
			return;
		}
		const createChat = path.match(/^\/api\/projects\/(\d+)\/chats$/);
		if (createChat && request.method === "POST") {
			try {
				const projectId = Number(createChat[1]);
				if (
					!database.prepare("SELECT id FROM projects WHERE id=?").get(projectId)
				) {
					json(response, 404, { error: "Project 不存在" });
					return;
				}
				const chatName = name(await readJson(request));
				const createdAt = Date.now();
				const id = Number(
					database
						.prepare(
							"INSERT INTO chats(project_id,name,created_at) VALUES (?,?,?)",
						)
						.run(projectId, chatName, createdAt).lastInsertRowid,
				);
				json(response, 201, {
					id,
					projectId,
					name: chatName,
					createdAt,
					lastQuestionAt: null,
				});
				notifyChange();
			} catch (error) {
				json(response, error instanceof InputError ? 400 : 500, {
					error: error instanceof InputError ? error.message : "创建 chat 失败",
				});
			}
			return;
		}
		json(response, 404, { error: "未找到" });
	}).on("close", () => database.close());
}
if (import.meta.main) {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: { db: { type: "string" } },
	});
	if (values.db === "") throw new Error("--db requires a database file path");
	const port = Number(process.env.PORT ?? 3000);
	createServer(fetch, values.db).listen(port, "127.0.0.1", () =>
		console.log(`Open http://127.0.0.1:${port}`),
	);
}
