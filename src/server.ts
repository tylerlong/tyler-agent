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
import { executeTool, type ToolExecutor } from "./count-files.ts";
import {
	listProjects,
	type ManagedModel,
	modelSettings,
	openDatabase,
} from "./database.ts";
import { supportedReasoningEfforts } from "./model-options.ts";
import {
	answerText,
	ModelError,
	type OutputItem,
	requestModel,
} from "./openrouter.ts";

const readableParts = (item: OutputItem) =>
	item.content.filter(
		(part) =>
			["output_text", "refusal", "reasoning_text", "summary_text"].includes(
				part.type,
			) && part.text.trim().length > 0,
	);
// Reader summaries preserve block order without downloading folded thinking.
const outputSummary = (output: OutputItem[]) =>
	output.map((item) => ({
		...item,
		content: readableParts(item).map((part) =>
			item.type === "reasoning" ? { index: part.index, type: part.type } : part,
		),
	}));

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
	invalidEnterBehavior: "Unsupported Enter key behavior",
	enterBehaviorReadFailed: "Could not read Enter key behavior",
	enterBehaviorWriteFailed: "Could not save Enter key behavior",
	invalidLanguage: "Unsupported interface language",
	languageReadFailed: "Could not read interface language",
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
	toolWriteFailed: "Could not save the Tool Call or Tool Result",
	chatCreateFailed: "Could not create chat",
	notFound: "Not found",
	languageWriteFailed: "Could not save interface language",
	modelSettingsFailed: "Could not read or save model settings",
	modelCatalogFailed: "Could not load model catalog",
	invalidModel: "Choose an enabled model",
	invalidReasoning: "Choose a supported reasoning level",
	invalidApiKey: "Invalid API key",
	modelConfigMissing: "OpenRouter configuration is missing",
	modelCallLimit: "Agent reached the five model request limit",
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
	fetchCatalog: typeof fetch = fetch,
	runTool: ToolExecutor = executeTool,
) {
	const database = openDatabase(
		databasePath === undefined ? defaultDatabasePath : resolve(databasePath),
		databasePath === undefined,
	);
	const home = homedir();
	const busy = new Set<number>();
	const unsavedAgents = new Set<number>();
	const unsavedCalls = new Set<number>();
	const unsavedTools = new Set<number>();
	let closed = false;
	const callPersistenceError = (callId: unknown) =>
		unsavedCalls.has(Number(callId))
			? { status: "failed", errorCode: "answerWriteFailed" }
			: {};
	const persistenceError = (agentId: unknown) =>
		unsavedAgents.has(Number(agentId))
			? { status: "failed", errorCode: "answerWriteFailed" }
			: {};
	const projects = () =>
		listProjects(database).map((project) => ({
			...project,
			chats: project.chats.map((chat) => ({
				...chat,
				busy: busy.has(Number(chat.id)),
			})),
		}));
	const callMetadata = (agentId: number) =>
		database
			.prepare("SELECT id,status FROM model_calls WHERE agent_id=? ORDER BY id")
			.all(agentId)
			.map((call, index) => ({
				id: Number(call.id),
				status: String(call.status),
				...callPersistenceError(call.id),
				ordinal: index + 1,
			}));
	const toolCalls = (agentId: number, content = false) =>
		database
			.prepare(
				`SELECT tool_calls.id,model_calls.agent_id AS agentId,model_call_id AS modelCallId,call_id AS callId,name,tool_calls.ordinal,tool_calls.status,reason${content ? ",arguments,result" : ""} FROM tool_calls JOIN model_calls ON model_calls.id=tool_calls.model_call_id WHERE model_calls.agent_id=? ORDER BY model_call_id,ordinal`,
			)
			.all(agentId)
			.map((call) => ({
				...call,
				id: call.id,
				...(unsavedTools.has(Number(call.id)) && {
					status: "interrupted",
					reason: "toolSaveFailed",
				}),
			}));

	const agentOutput = (agentId: number) =>
		database
			.prepare(
				"SELECT id,output_json FROM model_calls WHERE agent_id=? ORDER BY id",
			)
			.all(agentId)
			.flatMap((call) =>
				(JSON.parse(String(call.output_json)) as OutputItem[]).map((item) => ({
					...item,
					callId: Number(call.id),
				})),
			);
	const agentResult = (row: Record<string, unknown>) => {
		const output = agentOutput(Number(row.id));
		const failedCall = database
			.prepare(
				"SELECT id,status,error_code,error FROM model_calls WHERE agent_id=? ORDER BY id DESC",
			)
			.all(Number(row.id))
			.find(
				(call) => call.status === "failed" || unsavedCalls.has(Number(call.id)),
			);
		return {
			...row,
			answer: answerText(output) || null,
			output: outputSummary(output),
			errorCode:
				row.errorCode ??
				(failedCall
					? (callPersistenceError(failedCall.id).errorCode ??
						failedCall.error_code)
					: null),
			errorDetails: row.errorCode ? null : (failedCall?.error ?? null),
			...persistenceError(row.id),
			calls: callMetadata(Number(row.id)),
			toolCalls: toolCalls(Number(row.id)),
		};
	};
	const agentPage = (
		id: number,
		before: number | null,
		after: number | null,
	) => {
		const rows = database
			.prepare(
				`SELECT id, prompt AS question, status, created_at AS createdAt, error_code AS errorCode FROM agents WHERE chat_id=? ${before !== null ? "AND id<?" : after !== null ? "AND id>?" : ""} ORDER BY id ${after !== null ? "ASC" : "DESC"} LIMIT 11`,
			)
			.all(
				...(before !== null
					? [id, before]
					: after !== null
						? [id, after]
						: [id]),
			);
		const more = rows.length > 10;
		const page = rows.slice(0, 10).map(agentResult);
		if (after === null) page.reverse();
		return {
			agents: page,
			hasMore: after === null && more,
			hasMoreNewer: after !== null && more,
		};
	};
	const chatOptions = (id: number) => {
		const calls = database
			.prepare(
				"SELECT request_body FROM model_calls JOIN agents ON agents.id=model_calls.agent_id WHERE agents.chat_id=? ORDER BY agents.id DESC,model_calls.id DESC",
			)
			.iterate(id);
		for (const call of calls) {
			try {
				const body = JSON.parse(String(call.request_body));
				if (typeof body?.model !== "string" || !body.model.trim()) continue;
				return {
					modelId: body.model,
					reasoningEffort:
						typeof body.reasoning?.effort === "string"
							? body.reasoning.effort
							: null,
				};
			} catch {
				// Legacy or interrupted request records may not contain usable JSON.
			}
		}
		return {
			modelId: modelSettings(database).defaultModelId,
			reasoningEffort: null,
		};
	};

	const successfulMessages = (chatId: number, beforeAgentId: number) =>
		database
			.prepare(
				"SELECT id,prompt FROM agents WHERE chat_id=? AND id<? AND status='succeeded' ORDER BY id",
			)
			.all(chatId, beforeAgentId)
			.flatMap((row) => [
				{ role: "user" as const, content: String(row.prompt) },
				{
					role: "assistant" as const,
					content: answerText(agentOutput(Number(row.id))),
				},
			]);
	const agentMessages = (
		agents: {
			id?: unknown;
			question?: unknown;
			answer?: unknown;
			status?: unknown;
			errorCode?: unknown;
			errorDetails?: unknown;
			output: unknown;
		}[],
	) =>
		agents.flatMap((agent) => [
			{ id: `${agent.id}-user`, role: "user", content: agent.question },
			{
				id: `${agent.id}-assistant`,
				role: "assistant",
				content: agent.answer ?? "",
				output: agent.output,
				...(agent.status !== "succeeded" && {
					status: agent.status,
					errorCode: agent.errorCode,
					errorDetails: agent.errorDetails,
				}),
			},
		]);
	const subscribers = new Set<ServerResponse>();
	const notifyAgent = (chatId: number, agentId: number) => {
		for (const subscriber of subscribers)
			subscriber.write(
				`event: agent\ndata: ${JSON.stringify({ chatId, agentId })}\n\n`,
			);
	};
	const notifyChange = () => {
		for (const subscriber of subscribers) subscriber.write("data: changed\n\n");
	};
	let catalog: ManagedModel[] | undefined;
	let catalogLoading: Promise<ManagedModel[]> | undefined;
	const loadCatalog = (refresh = false): Promise<ManagedModel[]> => {
		if (!refresh && catalog) return Promise.resolve(catalog);
		if (catalogLoading) return catalogLoading;
		catalogLoading = (async () => {
			const response = await fetchCatalog(
				"https://openrouter.ai/api/v1/models?sort=most-popular&limit=100&output_modalities=text",
				{ method: "GET" },
			);
			if (!response.ok) throw new InputError("modelCatalogFailed");
			const body = await response.json();
			if (!Array.isArray(body?.data))
				throw new InputError("modelCatalogFailed");
			const rows = body.data as {
				id: string;
				name: string;
				architecture?: { output_modalities?: string[] };
				reasoning?: { supported_efforts?: unknown; mandatory?: boolean };
			}[];
			if (
				rows.some(
					(row) =>
						typeof row?.id !== "string" ||
						!row.id.trim() ||
						typeof row.name !== "string" ||
						!Array.isArray(row.architecture?.output_modalities),
				)
			)
				throw new InputError("modelCatalogFailed");
			const next: ManagedModel[] = rows
				.filter(
					(row) =>
						typeof row?.id === "string" &&
						row.id.trim() &&
						typeof row.name === "string" &&
						Array.isArray(row.architecture?.output_modalities) &&
						row.architecture.output_modalities.includes("text"),
				)
				.slice(0, 100)
				.map((row) => ({
					id: row.id,
					name: row.name,
					...(row.reasoning &&
					Object.hasOwn(row.reasoning, "supported_efforts") &&
					(row.reasoning.supported_efforts === null ||
						(Array.isArray(row.reasoning.supported_efforts) &&
							row.reasoning.supported_efforts.every(
								(effort: unknown) => typeof effort === "string",
							)))
						? { supportedEfforts: row.reasoning.supported_efforts }
						: {}),
					reasoningRequired: row.reasoning?.mandatory === true,
					catalogMissing: false,
				}));
			database.exec("BEGIN");
			try {
				// Read membership after the network wait, preserving concurrent additions/removals.
				for (const model of modelSettings(database).models) {
					const found = next.find((row) => row.id === model.id);
					if (!found) continue;
					const { id, name, ...metadata } = found;
					database
						.prepare("UPDATE managed_models SET name=?,metadata=? WHERE id=?")
						.run(name, JSON.stringify(metadata), id);
				}
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
			catalog = next;
			notifyChange();
			return next;
		})().finally(() => {
			catalogLoading = undefined;
		});
		return catalogLoading;
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
			path === "/api/model-settings" &&
			["GET", "PUT"].includes(request.method ?? "")
		) {
			try {
				if (request.method === "PUT") {
					const input = await readJson(request);
					if (
						input.apiKey !== undefined &&
						(typeof input.apiKey !== "string" || /[\r\n]/.test(input.apiKey))
					)
						throw new InputError("invalidApiKey");
					if (
						input.removeApiKey !== undefined &&
						typeof input.removeApiKey !== "boolean"
					)
						throw new InputError("invalidInput");
					if (
						input.defaultModelId !== undefined &&
						input.defaultModelId !== null &&
						(typeof input.defaultModelId !== "string" ||
							!database
								.prepare("SELECT 1 FROM managed_models WHERE id=?")
								.get(input.defaultModelId))
					)
						throw new InputError("invalidModel");
					database.exec("BEGIN");
					try {
						if (input.removeApiKey === true)
							database
								.prepare("UPDATE settings SET api_key=NULL WHERE id=1")
								.run();
						else if (typeof input.apiKey === "string" && input.apiKey.trim())
							database
								.prepare("UPDATE settings SET api_key=? WHERE id=1")
								.run(input.apiKey.trim());
						if (input.defaultModelId !== undefined)
							database
								.prepare("UPDATE settings SET default_model_id=? WHERE id=1")
								.run(input.defaultModelId as string | null);
						database.exec("COMMIT");
					} catch (error) {
						database.exec("ROLLBACK");
						throw error;
					}
					notifyChange();
				}
				json(response, 200, modelSettings(database));
			} catch (error) {
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "modelSettingsFailed"),
				);
			}
			return;
		}
		if (
			path === "/api/model-catalog" &&
			["GET", "POST"].includes(request.method ?? "")
		) {
			try {
				json(response, 200, {
					models: await loadCatalog(request.method === "POST"),
				});
			} catch {
				json(response, 502, errorBody("modelCatalogFailed"));
			}
			return;
		}
		if (path === "/api/models" && request.method === "POST") {
			try {
				const { id } = await readJson(request);
				if (typeof id !== "string" || !id.trim())
					throw new InputError("invalidModel");
				const existing = modelSettings(database);
				if (existing.models.some((model) => model.id === id)) {
					json(response, 200, { ...existing, firstModelAdded: false });
					return;
				}
				const model = catalog?.find((model) => model.id === id);
				if (!model) throw new InputError("invalidModel");
				const { name, ...metadata } = model;
				delete (metadata as Partial<ManagedModel>).id;
				let firstModelAdded = false;
				database.exec("BEGIN");
				try {
					const wasEmpty = modelSettings(database).models.length === 0;
					const inserted = database
						.prepare(
							"INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
						)
						.run(id, name, JSON.stringify(metadata));
					firstModelAdded = wasEmpty && inserted.changes > 0;
					if (firstModelAdded)
						database
							.prepare("UPDATE settings SET default_model_id=? WHERE id=1")
							.run(id);
					database.exec("COMMIT");
				} catch (error) {
					database.exec("ROLLBACK");
					throw error;
				}
				notifyChange();
				json(response, 200, { ...modelSettings(database), firstModelAdded });
			} catch (error) {
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "modelSettingsFailed"),
				);
			}
			return;
		}
		if (path.startsWith("/api/models/") && request.method === "DELETE") {
			try {
				const id = decodeURIComponent(path.slice("/api/models/".length));
				database.exec("BEGIN");
				try {
					const settings = modelSettings(database);
					database.prepare("DELETE FROM managed_models WHERE id=?").run(id);
					if (settings.defaultModelId === id) {
						const remaining = settings.models.filter(
							(model) => model.id !== id,
						);
						const replacement =
							catalog?.find((model) =>
								remaining.some((enabled) => enabled.id === model.id),
							) ?? remaining[0];
						database
							.prepare("UPDATE settings SET default_model_id=? WHERE id=1")
							.run(replacement?.id ?? null);
					}
					database.exec("COMMIT");
				} catch (error) {
					database.exec("ROLLBACK");
					throw error;
				}
				notifyChange();
				json(response, 200, modelSettings(database));
			} catch {
				json(response, 500, errorBody("modelSettingsFailed"));
			}
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
		if (
			path === "/api/enter-behavior" &&
			(request.method === "GET" || request.method === "PUT")
		) {
			try {
				if (request.method === "PUT") {
					const { behavior } = await readJson(request);
					if (behavior !== "send" && behavior !== "newline")
						throw new InputError("invalidEnterBehavior");
					database
						.prepare("UPDATE settings SET enter_behavior=? WHERE id=1")
						.run(behavior);
				}
				const behavior = database
					.prepare("SELECT enter_behavior FROM settings WHERE id=1")
					.get()?.enter_behavior;
				if (behavior !== "send" && behavior !== "newline")
					throw new Error("Invalid saved Enter behavior");
				json(response, 200, { behavior });
				if (request.method === "PUT") notifyChange();
			} catch (error) {
				if (!(error instanceof InputError))
					console.error("Enter behavior setting read/write failed", error);
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(
						error,
						request.method === "PUT"
							? "enterBehaviorWriteFailed"
							: "enterBehaviorReadFailed",
					),
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
		const reasoningRoute = path.match(/^\/api\/agents\/(\d+)\/reasoning$/);
		if (reasoningRoute && request.method === "GET") {
			const callId = url.searchParams.get("callId");
			if (
				!callId ||
				!/^[1-9]\d*$/.test(callId) ||
				url.searchParams.has("callOrdinal")
			) {
				json(response, 400, errorBody("invalidInput"));
				return;
			}
			const row = database
				.prepare(
					"SELECT output_json FROM model_calls WHERE id=? AND agent_id=?",
				)
				.get(Number(callId), Number(reasoningRoute[1]));
			if (!row) {
				json(response, 404, errorBody("notFound"));
				return;
			}
			const output: OutputItem[] = JSON.parse(String(row.output_json));
			json(response, 200, {
				output: output
					.filter((item) => item.type === "reasoning")
					.map((item) => ({
						...item,
						content: readableParts(item),
					})),
			});
			return;
		}
		const agentRoute = path.match(/^\/api\/agents\/(\d+)$/);
		if (agentRoute && request.method === "GET") {
			const row = database
				.prepare(
					"SELECT id,chat_id AS chatId,prompt AS question,status,created_at AS createdAt,error_code AS errorCode FROM agents WHERE id=?",
				)
				.get(Number(agentRoute[1]));
			if (!row) {
				json(response, 404, errorBody("notFound"));
				return;
			}
			const agents = [agentResult(row)];
			json(response, 200, {
				agents,
				messages: agentMessages(agents),
				busy: busy.has(Number(row.chatId)),
				hasMore: false,
			});
			return;
		}
		const toolsRoute = path.match(/^\/api\/agents\/(\d+)\/tools$/);
		if (toolsRoute && request.method === "GET") {
			const agentId = Number(toolsRoute[1]);
			const toolId = url.searchParams.get("toolId");
			if (
				toolId !== null &&
				(!/^\d+$/.test(toolId) ||
					!Number.isSafeInteger(Number(toolId)) ||
					Number(toolId) <= 0)
			) {
				json(response, 400, errorBody("invalidInput"));
				return;
			}
			if (!database.prepare("SELECT id FROM agents WHERE id=?").get(agentId)) {
				json(response, 404, errorBody("notFound"));
				return;
			}
			const calls = toolCalls(agentId, true).filter(
				(call) => toolId === null || call.id === Number(toolId),
			);
			if (toolId !== null && !calls.length) {
				json(response, 404, errorBody("notFound"));
				return;
			}
			json(response, 200, { toolCalls: calls });
			return;
		}
		const callRoute = path.match(/^\/api\/agents\/(\d+)\/calls$/);
		if (callRoute && request.method === "GET") {
			const agentId = Number(callRoute[1]);
			if (!database.prepare("SELECT id FROM agents WHERE id=?").get(agentId)) {
				json(response, 404, errorBody("notFound"));
				return;
			}
			const kind = url.searchParams.get("kind");
			const callId = url.searchParams.get("callId");
			if (
				(kind !== null &&
					!["request", "response", "metadata"].includes(kind)) ||
				(callId !== null && !/^[1-9]\d*$/.test(callId))
			) {
				json(response, 400, errorBody("invalidInput"));
				return;
			}
			if (
				callId !== null &&
				!database
					.prepare("SELECT id FROM model_calls WHERE agent_id=? AND id=?")
					.get(agentId, Number(callId))
			) {
				json(response, 404, errorBody("notFound"));
				return;
			}
			json(response, 200, {
				calls:
					kind === "metadata"
						? callMetadata(agentId).filter(
								(call) => callId === null || call.id === Number(callId),
							)
						: database
								.prepare(
									`SELECT id,agent_id AS agentId,url,method,requested_at AS requestedAt,${kind === "response" ? "NULL" : "request_body"} AS requestBody,status,http_status AS httpStatus,${kind === "request" ? "NULL" : "response_body"} AS responseBody,duration_ms AS durationMs,error,error_code AS errorCode FROM model_calls WHERE agent_id=? ${callId !== null ? "AND id=?" : ""} ORDER BY id`,
								)
								.all(
									...(callId === null ? [agentId] : [agentId, Number(callId)]),
								)
								.map((call) => ({
									...call,
									...callPersistenceError(call.id),
									...(unsavedCalls.has(Number(call.id)) && {
										error: errorMessages.answerWriteFailed,
									}),
								})),
			});
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
				const before = url.searchParams.get("before");
				const after = url.searchParams.get("after");
				if (
					(before !== null && after !== null) ||
					[before, after].some(
						(value) =>
							value !== null &&
							(!/^(0|[1-9]\d*)$/.test(value) ||
								!Number.isSafeInteger(Number(value))),
					)
				) {
					json(response, 400, errorBody("invalidInput"));
					return;
				}
				const page = agentPage(
					id,
					before === null ? null : Number(before),
					after === null ? null : Number(after),
				);
				json(response, 200, {
					...page,
					messages: agentMessages(page.agents),
					chatOptions: chatOptions(id),
					busy: busy.has(id),
				});
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
			let acceptedAgentId: number | undefined;
			try {
				const input = await readJson(request);
				if (typeof input.prompt !== "string" || !input.prompt.trim())
					throw new InputError("promptRequired");
				if (busy.has(id)) {
					json(response, 409, errorBody("chatBusy"));
					return;
				}
				const settings = database
					.prepare("SELECT api_key,default_model_id FROM settings WHERE id=1")
					.get();
				if (
					input.reasoningEffort != null &&
					typeof input.reasoningEffort !== "string"
				)
					throw new InputError("invalidReasoning");
				const config = {
					apiKey: String(settings?.api_key ?? ""),
					model: typeof input.modelId === "string" ? input.modelId : "",
					reasoningEffort:
						typeof input.reasoningEffort === "string"
							? input.reasoningEffort
							: null,
				};
				if (!config.apiKey) throw new InputError("modelConfigMissing");
				const selected = modelSettings(database).models.find(
					(model) => model.id === config.model,
				);
				if (!selected) throw new InputError("invalidModel");
				if (
					config.reasoningEffort !== null &&
					(typeof config.reasoningEffort !== "string" ||
						!supportedReasoningEfforts(selected)?.includes(
							config.reasoningEffort,
						))
				)
					throw new InputError("invalidReasoning");
				const targetFolders = database
					.prepare(
						"SELECT folders.path FROM folders JOIN chats ON chats.project_id=folders.project_id WHERE chats.id=? ORDER BY folders.rowid",
					)
					.all(id)
					.map((row) => String(row.path));
				const agentConfig = { ...config, targetFolders };
				busy.add(id);
				locked = true;
				let agentId: number;
				database.exec("BEGIN");
				try {
					const key = config.apiKey;
					const question = [key, JSON.stringify(key).slice(1, -1)].reduce(
						(text, secret) => text.replaceAll(secret, "[REDACTED]"),
						input.prompt,
					);
					agentId = Number(
						database
							.prepare(
								"INSERT INTO agents(chat_id,prompt,status,created_at) VALUES (?,?,'pending',?)",
							)
							.run(id, question, Date.now()).lastInsertRowid,
					);
					database.exec("COMMIT");
				} catch (error) {
					database.exec("ROLLBACK");
					throw error;
				}
				acceptedAgentId = agentId;
				json(response, 202, { agentId });
				notifyChange();

				let failure: unknown;
				let callId: number | undefined;
				let savedToolIds: number[] = [];
				const secrets = [
					...new Set([
						agentConfig.apiKey,
						JSON.stringify(agentConfig.apiKey).slice(1, -1),
					]),
				];
				const redactTool = (text: string) =>
					secrets.reduce(
						(value, secret) => value.replaceAll(secret, "[REDACTED]"),
						text,
					);
				try {
					await requestModel(
						successfulMessages(id, agentId),
						input.prompt,
						fetchModel,
						{
							tools: (calls, reason) => {
								if (closed) throw new Error("Service closed");
								if (callId === undefined)
									throw new Error("Missing saved model call");
								const ownerId = callId;
								database.exec("BEGIN");
								try {
									savedToolIds = calls.map((call, index) =>
										Number(
											database
												.prepare(
													"INSERT INTO tool_calls(model_call_id,call_id,name,arguments,ordinal,status,reason) VALUES(?,?,?,?,?,?,?)",
												)
												.run(
													ownerId,
													redactTool(call.call_id),
													redactTool(call.name),
													redactTool(call.arguments),
													index + 1,
													reason ? "not_executed" : "waiting",
													reason ?? null,
												).lastInsertRowid,
										),
									);
									database.exec("COMMIT");
								} catch {
									database.exec("ROLLBACK");
									throw new ModelError(
										"toolWriteFailed",
										errorMessages.toolWriteFailed,
									);
								}
								notifyAgent(id, agentId);
							},
							toolStarted: (ordinal) => {
								if (closed) throw new Error("Service closed");
								try {
									database
										.prepare(
											"UPDATE tool_calls SET status='running' WHERE id=?",
										)
										.run(savedToolIds[ordinal - 1]);
								} catch {
									throw new ModelError(
										"toolWriteFailed",
										errorMessages.toolWriteFailed,
									);
								}
								notifyAgent(id, agentId);
							},
							toolFinished: (ordinal, result) => {
								if (closed) throw new Error("Service closed");
								try {
									database
										.prepare(
											"UPDATE tool_calls SET status=?,result=? WHERE id=?",
										)
										.run(
											result.status,
											redactTool(result.result),
											savedToolIds[ordinal - 1],
										);
								} catch {
									throw new ModelError(
										"toolWriteFailed",
										errorMessages.toolWriteFailed,
									);
								}
								notifyAgent(id, agentId);
							},
							request: (call) => {
								callId = Number(
									database
										.prepare(
											"INSERT INTO model_calls(agent_id,url,method,requested_at,request_body,status) VALUES (?,?,?,?,?,'pending')",
										)
										.run(
											agentId,
											call.url,
											call.method,
											call.requestedAt,
											call.requestBody,
										).lastInsertRowid,
								);
								notifyAgent(id, agentId);
							},
							result: (result, output) => {
								if (callId === undefined)
									throw new Error("Missing saved model call");
								database.exec("BEGIN");
								try {
									database
										.prepare(
											"UPDATE model_calls SET status=?,http_status=?,response_body=?,duration_ms=?,error=?,error_code=?,output_json=? WHERE id=?",
										)
										.run(
											result.status,
											result.httpStatus,
											result.responseBody,
											result.durationMs,
											result.error,
											result.errorCode ?? null,
											JSON.stringify(output),
											callId,
										);

									database.exec("COMMIT");
								} catch (error) {
									database.exec("ROLLBACK");
									// A failed recorder write ends this call, but its body stays at the last commit.
									unsavedCalls.add(callId);
									throw error;
								}
								notifyAgent(id, agentId);
							},
						},
						agentConfig,
						runTool,
					);
				} catch (error) {
					failure = error;
				}
				if (closed) return;
				if (failure) {
					const reason =
						failure instanceof ModelError && failure.code === "toolWriteFailed"
							? "toolSaveFailed"
							: "toolExecutionStopped";
					const unfinished = database
						.prepare(
							"SELECT id FROM tool_calls WHERE model_call_id IN (SELECT id FROM model_calls WHERE agent_id=?) AND status IN ('waiting','running')",
						)
						.all(agentId);
					try {
						database
							.prepare(
								"UPDATE tool_calls SET status='interrupted',reason=? WHERE model_call_id IN (SELECT id FROM model_calls WHERE agent_id=?) AND status IN ('waiting','running')",
							)
							.run(reason, agentId);
					} catch {
						for (const call of unfinished) unsavedTools.add(Number(call.id));
					}
				}
				database.exec("BEGIN");
				try {
					const savedError = failure
						? caughtError(failure, "answerWriteFailed")
						: null;
					database
						.prepare("UPDATE agents SET status=?,error_code=? WHERE id=?")
						.run(
							failure ? "failed" : "succeeded",
							(callId !== undefined &&
								database
									.prepare("SELECT status FROM model_calls WHERE id=?")
									.get(callId)?.status === "failed") ||
								(callId !== undefined && unsavedCalls.has(callId))
								? null
								: (savedError?.code ?? null),
							agentId,
						);
					database.exec("COMMIT");
				} catch (error) {
					database.exec("ROLLBACK");
					throw error;
				}
			} catch (error) {
				if (acceptedAgentId !== undefined) {
					// Keep unsaved failures visible without claiming the result was persisted.
					unsavedAgents.add(acceptedAgentId);
					console.error("Accepted Agent persistence failed", error);
				} else
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
					if (!closed && acceptedAgentId !== undefined)
						notifyAgent(id, acceptedAgentId);
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
	}).on("close", () => {
		closed = true;
		database.close();
	});
}
if (import.meta.main) {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: { db: { type: "string" }, port: { type: "string" } },
	});
	if (values.db === "") throw new Error("--db requires a database file path");
	const portValue = values.port ?? "3000";
	const port = Number(portValue);
	if (
		!/^\d+$/.test(portValue) ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	)
		throw new Error("--port must be an integer between 1 and 65535");
	createServer(fetch, values.db).listen(port, "127.0.0.1", () =>
		console.log(`Open http://127.0.0.1:${port}`),
	);
}
