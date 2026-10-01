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
const errorMessages: Record<string, string> = {
	requestTooLarge: "Request is too large",
	invalidInput: "Invalid input",
	nameRequired: "Name must not be empty",
	invalidFolders: "Folders must contain valid nonempty paths",
	duplicateFolders: "Duplicate folder paths",
	notDirectory: "The target path is not a directory",
	directoryNotFound: "The target directory does not exist",
	directoryAccessFailed: "Cannot access the target directory",
	invalidSidebarWidth: "Invalid sidebar width",
	sidebarWidthFailed: "Could not read or save sidebar width",
	invalidLanguage: "Unsupported interface language",
	languageReadFailed: "Could not read interface language",
	invalidDebug: "Invalid debug setting",
	debugWriteFailed: "Could not save debug setting",
	invalidDirectoryPath: "Invalid directory path",
	directoryBrowseFailed: "Cannot browse the target directory",
	projectCreateFailed: "Could not create project",
	targetNotFound: "The target does not exist",
	invalidArchive: "Invalid archive status",
	projectArchivedChatReadOnly:
		"The project is archived; its chats are read-only",
	archiveWriteFailed: "Could not update archive status",
	projectNotFound: "Project does not exist",
	projectArchived: "The project is archived and read-only",
	projectWriteFailed: "Could not save project",
	chatNotFound: "Chat does not exist",
	chatArchived: "The chat is archived and read-only",
	chatWriteFailed: "Could not save chat",
	promptRequired: "Prompt must not be empty",
	chatBusy: "The chat is processing a request",
	answerWriteFailed: "Could not save the answer",
	chatCreateFailed: "Could not create chat",
	notFound: "Not found",
	languageWriteFailed: "Could not save interface language",
};
class InputError extends Error {
	code: string;
	constructor(code: string) {
		super(errorMessages[code]);
		this.code = code;
	}
}
function errorBody(code: string) {
	return { code, error: errorMessages[code] };
}
function caughtError(error: unknown, fallback: string) {
	return error instanceof InputError || error instanceof ModelError
		? {
				code: error.code,
				error: error.message,
				...(error instanceof ModelError &&
					error.details !== undefined && { details: error.details }),
			}
		: errorBody(fallback);
}
async function readJson(
	request: IncomingMessage,
): Promise<Record<string, unknown>> {
	let body = "";
	for await (const chunk of request) {
		body += chunk;
		if (body.length > 8192) throw new InputError("requestTooLarge");
	}
	try {
		const input: unknown = JSON.parse(body);
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error();
		return input as Record<string, unknown>;
	} catch {
		throw new InputError("invalidInput");
	}
}
function name(input: Record<string, unknown>) {
	if (typeof input.name !== "string" || !input.name.trim())
		throw new InputError("nameRequired");
	return input.name.trim();
}
async function projectFolders(
	input: Record<string, unknown>,
	existing: string[] = [],
) {
	if (
		!Array.isArray(input.folders) ||
		input.folders.some((folder) => typeof folder !== "string" || !folder.trim())
	)
		throw new InputError("invalidFolders");
	const folders = input.folders.map((folder: string) => resolve(folder.trim()));
	if (new Set(folders).size !== folders.length)
		throw new InputError("duplicateFolders");
	for (const folder of folders) {
		if (existing.includes(folder)) continue;
		try {
			if (!(await stat(folder)).isDirectory())
				throw new InputError("notDirectory");
			await access(folder, constants.R_OK | constants.X_OK);
		} catch (error) {
			if (error instanceof InputError) throw error;
			throw new InputError(
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "directoryNotFound"
					: "directoryAccessFailed",
			);
		}
	}
	return folders;
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
						throw new InputError("invalidSidebarWidth");
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
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "sidebarWidthFailed"),
				);
			}
			return;
		}
		if (
			path === "/api/language" &&
			(request.method === "GET" || request.method === "PUT")
		) {
			try {
				if (request.method === "PUT") {
					const { language } = await readJson(request);
					if (language !== "en" && language !== "zh-CN")
						throw new InputError("invalidLanguage");
					database
						.prepare("UPDATE settings SET language=? WHERE id=1")
						.run(language);
				}
				const language = database
					.prepare("SELECT language FROM settings WHERE id=1")
					.get()?.language;
				json(response, 200, { language });
				if (request.method === "PUT") notifyChange();
			} catch (error) {
				if (!(error instanceof InputError))
					console.error("Language setting read/write failed", error);
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(
						error,
						request.method === "PUT"
							? "languageWriteFailed"
							: "languageReadFailed",
					),
				);
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
					throw new InputError("invalidDebug");
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
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "debugWriteFailed"),
				);
			}
			return;
		}
		if (path === "/api/directories" && request.method === "GET") {
			try {
				const paths = url.searchParams.getAll("path");
				if (paths.length > 1 || (paths.length && !paths[0]?.trim()))
					throw new InputError("invalidDirectoryPath");
				const current = resolve(paths[0]?.trim() ?? home);
				if (!(await stat(current)).isDirectory())
					throw new InputError("notDirectory");
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
					caughtError(
						error,
						code === "ENOENT" ? "directoryNotFound" : "directoryBrowseFailed",
					),
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
				const folders = await projectFolders(input);
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
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "projectCreateFailed"),
				);
			}
			return;
		}
		const archiveRoute = path.match(
			/^\/api\/(projects|chats)\/(\d+)\/archive$/,
		);
		if (archiveRoute && request.method === "PUT") {
			const table = archiveRoute[1] === "projects" ? "projects" : "chats";
			const id = Number(archiveRoute[2]);
			if (!database.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id)) {
				json(response, 404, errorBody("targetNotFound"));
				return;
			}
			try {
				const { archived } = await readJson(request);
				if (typeof archived !== "boolean")
					throw new InputError("invalidArchive");
				if (table === "chats" && archived) {
					const state = database
						.prepare(
							"SELECT chats.archived, projects.archived AS projectArchived FROM chats JOIN projects ON projects.id=chats.project_id WHERE chats.id=?",
						)
						.get(id);
					if (state?.projectArchived && !state.archived) {
						json(response, 409, errorBody("projectArchivedChatReadOnly"));
						return;
					}
				}
				database
					.prepare(`UPDATE ${table} SET archived=? WHERE id=?`)
					.run(Number(archived), id);
				json(response, 200, { id, archived });
				notifyChange();
			} catch (error) {
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "archiveWriteFailed"),
				);
			}
			return;
		}
		const projectRoute = path.match(/^\/api\/projects\/(\d+)$/);
		if (projectRoute && request.method === "PUT") {
			const id = Number(projectRoute[1]);
			const project = listProjects(database).find((item) => item.id === id);
			if (!project) {
				json(response, 404, errorBody("projectNotFound"));
				return;
			}
			if (project.archived) {
				json(response, 409, errorBody("projectArchived"));
				return;
			}
			try {
				const input = await readJson(request);
				const projectName = name(input);
				const folders = await projectFolders(
					input,
					project.folders.map(String),
				);
				database.exec("BEGIN");
				try {
					database
						.prepare("UPDATE projects SET name=? WHERE id=?")
						.run(projectName, id);
					database.prepare("DELETE FROM folders WHERE project_id=?").run(id);
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
					200,
					listProjects(database).find((item) => item.id === id),
				);
				notifyChange();
			} catch (error) {
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "projectWriteFailed"),
				);
			}
			return;
		}
		const chatRoute = path.match(/^\/api\/chats\/(\d+)$/);
		if (
			chatRoute &&
			(request.method === "GET" ||
				request.method === "POST" ||
				request.method === "PUT")
		) {
			const id = Number(chatRoute[1]);
			const state = database
				.prepare(
					"SELECT chats.archived, projects.archived AS projectArchived FROM chats JOIN projects ON projects.id=chats.project_id WHERE chats.id=?",
				)
				.get(id);
			if (!state) {
				json(response, 404, errorBody("chatNotFound"));
				return;
			}
			if (request.method === "GET") {
				json(response, 200, { messages: messages(id), busy: busy.has(id) });
				return;
			}
			if (state.archived || state.projectArchived) {
				json(
					response,
					409,
					errorBody(
						state.projectArchived
							? "projectArchivedChatReadOnly"
							: "chatArchived",
					),
				);
				return;
			}
			if (request.method === "PUT") {
				try {
					const chatName = name(await readJson(request));
					database
						.prepare("UPDATE chats SET name=? WHERE id=?")
						.run(chatName, id);
					json(response, 200, { id, name: chatName });
					notifyChange();
				} catch (error) {
					json(
						response,
						error instanceof InputError ? 400 : 500,
						caughtError(error, "chatWriteFailed"),
					);
				}
				return;
			}
			let locked = false;
			try {
				const input = await readJson(request);
				if (typeof input.prompt !== "string" || !input.prompt.trim())
					throw new InputError("promptRequired");
				if (busy.has(id)) {
					json(response, 409, errorBody("chatBusy"));
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
					if (error instanceof ModelError) throw error;
					throw new ModelError(
						"modelRequestFailed",
						"OpenRouter request failed",
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
					caughtError(error, "answerWriteFailed"),
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
				const project = database
					.prepare("SELECT archived FROM projects WHERE id=?")
					.get(projectId);
				if (!project) {
					json(response, 404, errorBody("projectNotFound"));
					return;
				}
				if (project.archived) {
					json(response, 409, errorBody("projectArchived"));
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
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "chatCreateFailed"),
				);
			}
			return;
		}
		json(response, 404, errorBody("notFound"));
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
