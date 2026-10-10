import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	agentScratch,
	CommandExecutor,
	ExecutionInterruptedError,
} from "./command-executor.ts";
import { outputPage } from "./command-tools.ts";
import { listProjects, openDatabase } from "./database.ts";
import {
	type ExecutionPermissions,
	emptyPermissions,
	needsApproval,
	requestedPermissions,
	unmetPermissions,
} from "./execution-permissions.ts";
import type { ToolExecutor } from "./file-tools.ts";
import { supportedReasoningEfforts } from "./model-options.ts";
import { createModelSettings, ModelSettingsError } from "./model-settings.ts";
import {
	answerText,
	ModelError,
	type OutputItem,
	requestModel,
	responseOutput,
} from "./openrouter.ts";
import { releasePort } from "./port.ts";

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
	agentCancelled: "Agent cancelled",
	agentCancelFailed: "Could not stop Agent",
	invalidCancellationTarget:
		"Only directly created sub-agents can be cancelled",
	requestTooLarge: "Request is too large",
	invalidInput: "Invalid input",
	nameRequired: "Name must not be empty",
	invalidFolders: "Folders must contain valid nonempty paths",
	duplicateFolders: "Duplicate folder paths",
	notDirectory: "The target path is not a directory",
	directoryNotFound: "The target directory does not exist",
	directoryAccessFailed: "Cannot access the target directory",
	invalidExecutionLimits: "Execution limits must be positive integers",
	executionLimitsFailed: "Could not read or save execution limits",
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
	modelCallLimit: "Agent reached the model request limit",
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
	if (error instanceof ModelSettingsError) return errorBody(error.code);
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
	runTool?: ToolExecutor,
) {
	const database = openDatabase(
		databasePath === undefined ? defaultDatabasePath : resolve(databasePath),
		databasePath === undefined,
	);
	const commands = new CommandExecutor();
	const managementToken = randomBytes(32).toString("hex");
	const savedOutput = (toolId: number) =>
		database
			.prepare(
				"SELECT ordinal,stream,text,data,byte_count AS byteCount FROM tool_output WHERE tool_call_id=? ORDER BY ordinal",
			)
			.all(toolId) as { ordinal: number; stream: string; text: string }[];
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
	const callOutput = (call: Record<string, unknown>): OutputItem[] =>
		call.status === "succeeded"
			? responseOutput(call.response_body as string | null)
			: JSON.parse(String(call.output_json));
	const callMetadata = (agentId: number) =>
		database
			.prepare(
				"SELECT id,status,error_code AS errorCode FROM model_calls WHERE agent_id=? ORDER BY id",
			)
			.all(agentId)
			.map((call, index) => ({
				id: Number(call.id),
				status: String(call.status),
				errorCode: call.errorCode,
				...callPersistenceError(call.id),
				ordinal: index + 1,
			}));
	const toolCalls = (agentId: number, content = false) =>
		database
			.prepare(
				`SELECT tool_calls.id,model_calls.agent_id AS agentId,model_call_id AS modelCallId,call_id AS callId,name,tool_calls.ordinal,tool_calls.status,reason,approval${content ? ",arguments,result" : ""} FROM tool_calls JOIN model_calls ON model_calls.id=tool_calls.model_call_id WHERE model_calls.agent_id=? ORDER BY model_call_id,ordinal`,
			)
			.all(agentId)
			.map((call) => ({
				...call,
				approval: call.approval ? JSON.parse(String(call.approval)) : null,
				id: call.id,
				...(content &&
					["exec_command", "apply_patch"].includes(String(call.name)) && {
						output: savedOutput(Number(call.id)),
					}),
				...(!content && { child: childOverview(Number(call.id)) }),
				...(unsavedTools.has(Number(call.id)) && {
					status: "interrupted",
					reason: "toolSaveFailed",
				}),
			}));

	const agentOutput = (agentId: number) =>
		database
			.prepare(
				"SELECT id,status,response_body,output_json FROM model_calls WHERE agent_id=? ORDER BY id",
			)
			.all(agentId)
			.flatMap((call) =>
				callOutput(call).map((item) => ({
					...item,
					callId: Number(call.id),
				})),
			);
	const agentSource = (
		agentId: number,
	): {
		chatId: number;
		projectId: number;
		rootAgentId: number;
		parentAgentId: number | null;
		createdByToolCallId: number | null;
		question: string;
		context: string;
		creationArguments: Record<string, unknown> | null;
	} => {
		const row = database
			.prepare(
				"SELECT chat_id,prompt,created_by_tool_call_id FROM agents WHERE id=?",
			)
			.get(agentId);
		if (!row) throw new InputError("notFound");
		if (row.chat_id !== null)
			return {
				chatId: Number(row.chat_id),
				projectId: Number(
					database
						.prepare("SELECT project_id FROM chats WHERE id=?")
						.get(row.chat_id)?.project_id,
				),
				rootAgentId: agentId,
				parentAgentId: null,
				createdByToolCallId: null,
				question: String(row.prompt),
				context: "",
				creationArguments: null,
			};
		const creator = database
			.prepare(
				"SELECT model_calls.agent_id,tool_calls.arguments FROM tool_calls JOIN model_calls ON model_calls.id=tool_calls.model_call_id WHERE tool_calls.id=?",
			)
			.get(row.created_by_tool_call_id);
		if (!creator) throw new InputError("notFound");
		const source = agentSource(Number(creator.agent_id));
		const args = JSON.parse(String(creator.arguments));
		return {
			...source,
			parentAgentId: Number(creator.agent_id),
			createdByToolCallId: Number(row.created_by_tool_call_id),
			question: args.prompt,
			context: args.context ?? "",
			creationArguments: args,
		};
	};
	const children = (agentId: number) =>
		database
			.prepare(
				"SELECT agents.id,agents.status FROM agents JOIN tool_calls ON tool_calls.id=agents.created_by_tool_call_id JOIN model_calls ON model_calls.id=tool_calls.model_call_id WHERE model_calls.agent_id=? ORDER BY agents.id",
			)
			.all(agentId);
	const descendants = (agentId: number): number[] =>
		children(agentId).flatMap((child) => [
			Number(child.id),
			...descendants(Number(child.id)),
		]);
	const running = new Map<
		number,
		{
			events: unknown[];
			wake?: () => void;
			done: Promise<void>;
			controller: AbortController;
			suppressed: boolean;
			stopped: boolean;
		}
	>();
	const terminalResult = (agentId: number) => {
		const row = database
			.prepare(
				"SELECT id,status,error_code AS errorCode FROM agents WHERE id=?",
			)
			.get(agentId);
		if (!row) throw new InputError("notFound");
		const result = agentResult(row);
		return {
			agent_id: agentId,
			status: result.status,
			tool_calls: toolCalls(agentId, true),
			output: agentOutput(agentId).map((item) => ({
				...item,
				content: readableParts(item),
			})),
			error: result.errorDetails ?? result.errorCode ?? null,
			errors: database
				.prepare(
					"SELECT id AS modelCallId,error_code AS code,error AS message FROM model_calls WHERE agent_id=? AND status='failed' ORDER BY id",
				)
				.all(agentId),
		};
	};

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
			...agentSource(Number(row.id)),
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
	const childOverview = (toolId: number) => {
		const row = database
			.prepare(
				"SELECT id,status,error_code AS errorCode FROM agents WHERE created_by_tool_call_id=?",
			)
			.get(toolId);
		if (!row) return null;
		const id = Number(row.id);
		const status = persistenceError(id).status ?? row.status;
		const prompt = agentSource(id).question.trim();
		const firstLine = prompt.split(/\r?\n/)[0];
		return {
			id,
			status,
			promptSummary:
				firstLine.slice(0, 120) +
				(firstLine.length > 120 || prompt.includes("\n") ? "…" : ""),
			preview:
				status === "pending" ? null : answerText(agentOutput(id)).slice(0, 500),
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
	const chatOptions = (id: number) =>
		database
			.prepare(
				"SELECT model_id AS modelId,reasoning_effort AS reasoningEffort,file_access AS fileAccess,network_access AS networkAccess FROM chats WHERE id=?",
			)
			.get(id) as {
			modelId: string | null;
			reasoningEffort: string | null;
			fileAccess: "restricted" | "full";
			networkAccess: "restricted" | "full";
		};
	const currentFolders = (id: number) =>
		database
			.prepare(
				"SELECT folders.path FROM folders JOIN chats ON chats.project_id=folders.project_id WHERE chats.id=? ORDER BY folders.rowid",
			)
			.all(id)
			.map((row) => String(row.path));

	const currentConfig = (
		id: number,
		agentId?: number,
		override?: Record<string, unknown>,
	) => {
		let options = chatOptions(id);
		const models = modelSettings.read().models;
		const overrides: Record<string, unknown>[] = [];
		while (agentId !== undefined) {
			const source = agentSource(agentId);
			if (source.createdByToolCallId === null) break;
			overrides.unshift(
				JSON.parse(
					String(
						database
							.prepare("SELECT arguments FROM tool_calls WHERE id=?")
							.get(source.createdByToolCallId)?.arguments,
					),
				),
			);
			agentId = source.parentAgentId ?? undefined;
		}
		if (override) overrides.push(override);
		for (const value of overrides) {
			if (value.model_id !== undefined) {
				const model = models.find((model) => model.id === value.model_id);
				options = {
					...options,
					modelId: value.model_id as string,
					reasoningEffort:
						options.reasoningEffort !== null &&
						model &&
						supportedReasoningEfforts(model)?.includes(options.reasoningEffort)
							? options.reasoningEffort
							: null,
				};
			}
			if (Object.hasOwn(value, "reasoning_effort"))
				options.reasoningEffort = value.reasoning_effort as string | null;
		}
		const apiKey = String(modelSettings.readCredential());
		if (!apiKey) throw new InputError("modelConfigMissing");
		const model = models.find((model) => model.id === options.modelId);
		if (!model) throw new InputError("invalidModel");
		if (
			options.reasoningEffort !== null &&
			!supportedReasoningEfforts(model)?.includes(options.reasoningEffort)
		)
			throw new InputError("invalidReasoning");
		return {
			apiKey,
			model: model.id,
			reasoningEffort: options.reasoningEffort,
			targetFolders: currentFolders(id),
			fileAccess: options.fileAccess,
			networkAccess: options.networkAccess,
			models: models.map((model) => ({
				id: model.id,
				name: model.name,
				reasoningEfforts: supportedReasoningEfforts(model) ?? [],
			})),
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
				`event: agent\ndata: ${JSON.stringify({ chatId, agentId, parentAgentId: agentSource(agentId).parentAgentId })}\n\n`,
			);
	};
	const notifyChange = () => {
		for (const subscriber of subscribers) subscriber.write("data: changed\n\n");
	};

	type Approval = {
		toolCallId: number;
		requestId: string;
		projectId: number;
		projectName: string;
		chatId: number;
		chatName: string;
		agentId: number;
		name: string;
		arguments: string;
		cwd: string;
		reason: string;
		permissions: ExecutionPermissions;
		status:
			| "pending"
			| "denied"
			| "once"
			| "always"
			| "covered"
			| "interrupted";
	};
	const approvals = new Map<
		number,
		{
			view: Approval;
			requested: ExecutionPermissions;
			signal: AbortSignal;
			settle: (decision: Approval["status"]) => void;
		}
	>();
	const projectGrants = (chatId: number): ExecutionPermissions =>
		JSON.parse(
			String(
				database
					.prepare(
						"SELECT projects.grants FROM projects JOIN chats ON chats.project_id=projects.id WHERE chats.id=?",
					)
					.get(chatId)?.grants,
			),
		);
	const currentPermissions = async (
		chatId: number,
		agentId: number,
	): Promise<ExecutionPermissions> => {
		const folders = await Promise.all(
			currentFolders(chatId).map((path) => realpath(path)),
		);
		const grants = projectGrants(chatId);
		return {
			...grants,
			fullFile: chatOptions(chatId).fileAccess === "full",
			fullNetwork: chatOptions(chatId).networkAccess === "full",
			paths: [
				...folders
					.concat(agentScratch(String(agentId)))
					.map((path) => ({ path, access: "write" as const })),
				...grants.paths,
			],
		};
	};
	const saveApproval = (view: Approval) => {
		database
			.prepare("UPDATE tool_calls SET approval=? WHERE id=?")
			.run(JSON.stringify(view), view.toolCallId);
		notifyAgent(view.chatId, view.agentId);
		notifyChange();
	};
	const recheckApprovals = async () => {
		for (const [toolId, pending] of approvals) {
			if (pending.signal.aborted) {
				pending.settle("interrupted");
				continue;
			}
			const unmet = unmetPermissions(
				pending.requested,
				await currentPermissions(pending.view.chatId, pending.view.agentId),
			);
			if (approvals.get(toolId) !== pending) continue;
			if (!needsApproval(unmet)) pending.settle("covered");
			else if (
				JSON.stringify(unmet) !== JSON.stringify(pending.view.permissions)
			) {
				pending.view.permissions = unmet;
				pending.view.requestId = randomUUID();
				saveApproval(pending.view);
			}
		}
	};
	const authorize = async (
		toolCallId: number,
		chatId: number,
		agentId: number,
		name: string,
		args: string,
		cwd: string,
		requested: ExecutionPermissions,
		reason: string,
		signal: AbortSignal,
	) => {
		signal.throwIfAborted();
		const unmet = unmetPermissions(
			requested,
			await currentPermissions(chatId, agentId),
		);
		let extra = emptyPermissions();
		if (needsApproval(unmet)) {
			const chat = database
				.prepare(
					"SELECT chats.project_id, chats.name AS chatName, projects.name AS projectName FROM chats JOIN projects ON projects.id=chats.project_id WHERE chats.id=?",
				)
				.get(chatId);
			if (!chat) throw new Error("Approval Chat no longer exists");
			const view: Approval = {
				toolCallId,
				requestId: randomUUID(),
				projectId: Number(chat.project_id),
				projectName: String(chat.projectName),
				chatId,
				chatName: String(chat.chatName),
				agentId,
				name,
				arguments: args,
				cwd,
				reason,
				permissions: unmet,
				status: "pending",
			};
			const decision = await new Promise<Approval["status"]>(
				(resolve, reject) => {
					const interrupted = () => pending.settle("interrupted");
					const pending = {
						view,
						requested,
						signal,
						settle: (decision: Approval["status"]) => {
							if (approvals.get(toolCallId) !== pending) return;
							approvals.delete(toolCallId);
							signal.removeEventListener("abort", interrupted);
							view.status = decision;
							try {
								saveApproval(view);
								resolve(decision);
							} catch {
								reject(
									new ModelError(
										"toolWriteFailed",
										errorMessages.toolWriteFailed,
									),
								);
							}
						},
					};
					approvals.set(toolCallId, pending);
					try {
						database
							.prepare(
								"UPDATE tool_calls SET status='waiting',reason='approvalRequired' WHERE id=?",
							)
							.run(toolCallId);
						saveApproval(view);
						signal.addEventListener("abort", interrupted, { once: true });
						if (signal.aborted) interrupted();
					} catch (error) {
						approvals.delete(toolCallId);
						reject(error);
					}
				},
			);
			signal.throwIfAborted();
			if (decision === "denied")
				throw new Error(
					"User denied extra permissions; operation was not executed",
				);
			if (decision === "interrupted")
				throw new ExecutionInterruptedError(
					"Approval interrupted; operation was not executed",
				);
			if (decision === "once") extra = view.permissions;
		}
		signal.throwIfAborted();
		database
			.prepare("UPDATE tool_calls SET status='running',reason=NULL WHERE id=?")
			.run(toolCallId);
		notifyAgent(chatId, agentId);
		return () => {
			const grants = projectGrants(chatId);
			return {
				fullFile: chatOptions(chatId).fileAccess === "full",
				fullNetwork: chatOptions(chatId).networkAccess === "full",
				paths: [...grants.paths, ...extra.paths],
				domains: [...new Set([...grants.domains, ...extra.domains])],
				localNetwork: grants.localNetwork || extra.localNetwork,
			};
		};
	};

	const modelSettings = createModelSettings(
		database,
		fetchCatalog,
		notifyChange,
	);
	const cancelAgent = async (agentId: number, callerId?: number) => {
		const source = agentSource(agentId);
		if (callerId !== undefined && source.parentAgentId !== callerId)
			throw new InputError("invalidCancellationTarget");
		const targets = [agentId, ...descendants(agentId)];
		if (callerId !== undefined) {
			const target = running.get(agentId);
			if (target) target.suppressed = true;
		}
		// Stop the whole subtree before awaiting any cleanup so no node can start new work.
		for (const id of targets) {
			const target = running.get(id);
			if (target) {
				target.controller.abort(
					new ModelError("agentCancelled", "Agent cancelled"),
				);
				target.wake?.();
			}
		}
		await Promise.all(targets.map((id) => running.get(id)?.done));
		if (callerId !== undefined) {
			const parent = running.get(callerId);
			if (parent)
				parent.events = parent.events.filter((event) => {
					const content = (event as { content?: string }).content;
					if (!content?.startsWith("[Runtime service:")) return true;
					return !content.startsWith(
						`[Runtime service: sub-agent terminal result] {"agent_id":${agentId},`,
					);
				});
		}
		return terminalResult(agentId);
	};
	const startAgent = (agentId: number) => {
		const state = {
			events: [] as unknown[],
			wake: undefined as (() => void) | undefined,
			done: Promise.resolve(),
			controller: new AbortController(),
			suppressed: false,
			stopped: false,
		};
		running.set(agentId, state);
		const source = agentSource(agentId);
		state.done = runAgent(agentId, state)
			.catch((error) => {
				if (!closed) {
					unsavedAgents.add(agentId);
					console.error("Accepted Agent persistence failed", error);
				}
			})
			.finally(() => {
				running.delete(agentId);
				if (closed) return;
				if (source.parentAgentId === null) busy.delete(source.chatId);
				else {
					const parent = running.get(source.parentAgentId);
					if (parent) {
						if (
							!state.suppressed &&
							!parent.stopped &&
							!parent.controller.signal.aborted
						)
							parent.events.push({
								role: "user",
								content: `[Runtime service: sub-agent terminal result] ${JSON.stringify(terminalResult(agentId))}`,
							});
						parent.wake?.();
						parent.wake = undefined;
					}
				}
				notifyAgent(source.chatId, agentId);
			});
		return state.done;
	};
	const runAgent = async (
		agentId: number,
		state: {
			events: unknown[];
			wake?: () => void;
			controller: AbortController;
			stopped: boolean;
		},
	) => {
		const id = agentSource(agentId).chatId;
		const apiKey = String(modelSettings.readCredential());

		let failure: unknown;
		let callId: number | undefined;
		let savedToolIds: number[] = [];
		let activeToolId = 0;
		const secrets = [
			...new Set([apiKey, JSON.stringify(apiKey).slice(1, -1)]),
		].filter(Boolean);
		const rememberKey = (key: string) => {
			for (const secret of [key, JSON.stringify(key).slice(1, -1)])
				if (secret && !secrets.includes(secret)) secrets.push(secret);
		};
		const redactTool = (text: string) =>
			secrets.reduce(
				(value, secret) => value.replaceAll(secret, "[REDACTED]"),
				text,
			);
		try {
			const scratch = agentScratch(String(agentId));
			await requestModel(
				agentSource(agentId).parentAgentId === null
					? successfulMessages(id, agentId)
					: agentSource(agentId).context
						? [{ role: "user", content: agentSource(agentId).context }]
						: [],
				agentSource(agentId).question,
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
						activeToolId = savedToolIds[ordinal - 1];
						if (closed) throw new Error("Service closed");
						try {
							database
								.prepare("UPDATE tool_calls SET status='running' WHERE id=?")
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
									"UPDATE tool_calls SET status=?,result=?,reason=CASE WHEN reason='approvalRequired' THEN NULL ELSE reason END WHERE id=?",
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
						if (closed) return;
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
									JSON.stringify(result.status === "succeeded" ? [] : output),
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
				() => {
					const next = currentConfig(id, agentId);
					rememberKey(next.apiKey);
					return { ...next, scratch };
				},
				async (name, args, roots, signal) => {
					signal?.throwIfAborted();
					if (
						name === "exec_command" ||
						name === "read_tool_output" ||
						name === "apply_patch" ||
						name === "read_file"
					) {
						try {
							const value = JSON.parse(args);
							if (runTool && (name === "read_file" || name === "apply_patch")) {
								const requested = await requestedPermissions(
									value?.extra_permissions,
									value?.reason,
								);
								if (needsApproval(requested))
									await authorize(
										activeToolId,
										id,
										agentId,
										name,
										redactTool(args),
										value.cwd ?? scratch,
										requested,
										redactTool(value.reason ?? ""),
										state.controller.signal,
									);
								return runTool(name, args, roots, signal);
							}
							if (!value || typeof value !== "object" || Array.isArray(value))
								throw new InputError("invalidInput");
							if (name === "read_tool_output") {
								const offset = value.offset ?? 0;
								const limit = value.limit ?? 16000;
								if (
									Object.keys(value).some(
										(key) => !["tool_call_id", "offset", "limit"].includes(key),
									) ||
									!Number.isSafeInteger(value.tool_call_id) ||
									value.tool_call_id <= 0 ||
									!Number.isSafeInteger(offset) ||
									offset < 0 ||
									!Number.isSafeInteger(limit) ||
									limit < 1 ||
									limit > 16000
								)
									throw new InputError("invalidInput");
								const owner = database
									.prepare(
										"SELECT model_calls.agent_id FROM tool_calls JOIN model_calls ON model_calls.id=tool_calls.model_call_id WHERE tool_calls.id=? AND tool_calls.name IN ('exec_command','apply_patch')",
									)
									.get(value.tool_call_id);
								if (owner?.agent_id !== agentId)
									throw new Error(
										"Output is available only for this Agent's command calls",
									);
								return {
									status: "succeeded",
									result: JSON.stringify(
										outputPage(savedOutput(value.tool_call_id), offset, limit),
									),
								};
							}
							if (name === "read_file") {
								const offset = value.offset ?? 0,
									limit = value.limit ?? 51200;
								if (
									Object.keys(value).some(
										(key) =>
											![
												"path",
												"offset",
												"limit",
												"extra_permissions",
												"reason",
											].includes(key),
									) ||
									typeof value.path !== "string" ||
									!isAbsolute(value.path) ||
									value.path.includes("\0") ||
									!Number.isSafeInteger(offset) ||
									offset < 0 ||
									!Number.isSafeInteger(limit) ||
									limit < 1 ||
									limit > 51200 ||
									!Number.isSafeInteger(offset + limit)
								)
									throw new InputError("invalidInput");
								const requested = await requestedPermissions(
									value.extra_permissions,
									value.reason,
								);
								const extraPermissions = await authorize(
									activeToolId,
									id,
									agentId,
									name,
									redactTool(args),
									scratch,
									requested,
									redactTool(value.reason ?? ""),
									state.controller.signal,
								);
								const result = await commands.read({
									extraPermissions: extraPermissions(),
									resolvePermissions: () => ({
										targetFolders: currentFolders(id),
										extraPermissions: extraPermissions(),
									}),
									path: value.path,
									offset,
									limit,
									targetFolders: currentFolders(id),
									agentId: String(agentId),
									signal: state.controller.signal,
								});
								return { status: "succeeded", result: JSON.stringify(result) };
							}
							if (name === "apply_patch") value.timeout_ms ??= 30000;

							if (
								Object.keys(value).some(
									(key) =>
										![
											name === "apply_patch" ? "patch" : "command",
											"cwd",
											"timeout_ms",
											"extra_permissions",
											"reason",
										].includes(key),
								) ||
								typeof value[name === "apply_patch" ? "patch" : "command"] !==
									"string" ||
								!value[name === "apply_patch" ? "patch" : "command"].trim() ||
								typeof value.cwd !== "string" ||
								!value.cwd.startsWith("/") ||
								!Number.isSafeInteger(value.timeout_ms) ||
								value.timeout_ms < 1 ||
								value.timeout_ms > 3600000
							)
								throw new InputError("invalidInput");
							const toolId = activeToolId;
							const requested = await requestedPermissions(
								value.extra_permissions,
								value.reason,
							);
							const extraPermissions = await authorize(
								toolId,
								id,
								agentId,
								name,
								redactTool(args),
								value.cwd,
								requested,
								redactTool(value.reason ?? ""),
								state.controller.signal,
							);
							let ordinal = 0;
							const result = await commands.execute({
								extraPermissions: extraPermissions(),
								resolvePermissions: () => ({
									targetFolders: currentFolders(id),
									extraPermissions: extraPermissions(),
								}),
								command: name === "apply_patch" ? "apply_patch" : value.command,
								...(name === "apply_patch" ? { patch: value.patch } : {}),
								cwd: value.cwd,
								targetFolders: currentFolders(id),
								agentId: String(agentId),
								timeoutMs: value.timeout_ms,
								signal: state.controller.signal,
								onOutput: (stream, text, data = "") => {
									database
										.prepare(
											"INSERT INTO tool_output(tool_call_id,ordinal,stream,text,data,byte_count) VALUES(?,?,?,?,?,?)",
										)
										.run(
											toolId,
											++ordinal,
											stream,
											text,
											data,
											Buffer.from(data, "base64").length,
										);
								},
							});
							return {
								status:
									result.interrupted || result.cancelled
										? "interrupted"
										: result.exitCode === 0 && !result.error && !result.timedOut
											? "succeeded"
											: "failed",
								result: JSON.stringify({
									tool_call_id: toolId,
									...result,
									output: outputPage(savedOutput(toolId)),
								}),
							};
						} catch (error) {
							return {
								status:
									state.controller.signal.aborted ||
									error instanceof ExecutionInterruptedError
										? "interrupted"
										: "failed",
								result: JSON.stringify({
									error: error instanceof Error ? error.message : String(error),
								}),
							};
						}
					}
					if (name === "cancel_sub_agent") {
						try {
							const value = JSON.parse(args);
							if (
								!value ||
								typeof value !== "object" ||
								Array.isArray(value) ||
								Object.keys(value).length !== 1 ||
								!Number.isSafeInteger(value.agent_id) ||
								value.agent_id <= 0
							)
								throw new InputError("invalidInput");
							const result = await cancelAgent(value.agent_id, agentId);
							return { status: "succeeded", result: JSON.stringify(result) };
						} catch (error) {
							return {
								status: "failed",
								result: JSON.stringify({
									error: caughtError(
										error instanceof SyntaxError
											? new InputError("invalidInput")
											: error,
										"agentCancelFailed",
									),
								}),
							};
						}
					}
					if (name !== "create_sub_agent")
						return runTool
							? runTool(name, args, roots, signal)
							: {
									status: "failed",
									result: JSON.stringify({ error: "Unknown tool" }),
								};
					try {
						const input: unknown = JSON.parse(args);
						if (!input || typeof input !== "object" || Array.isArray(input))
							throw new InputError("invalidInput");
						const value = input as Record<string, unknown>;
						if (
							Object.keys(value).some(
								(key) =>
									![
										"prompt",
										"context",
										"model_id",
										"reasoning_effort",
									].includes(key),
							) ||
							typeof value.prompt !== "string" ||
							!value.prompt.trim() ||
							(value.context !== undefined &&
								typeof value.context !== "string") ||
							(value.model_id !== undefined &&
								(typeof value.model_id !== "string" ||
									!value.model_id.trim())) ||
							(Object.hasOwn(value, "reasoning_effort") &&
								value.reasoning_effort !== null &&
								typeof value.reasoning_effort !== "string")
						)
							throw new InputError("invalidInput");
						currentConfig(id, agentId, value);
						const limit = Number(
							database
								.prepare("SELECT sub_agent_limit FROM settings WHERE id=1")
								.get()?.sub_agent_limit,
						);
						if (descendants(agentSource(agentId).rootAgentId).length >= limit)
							return {
								status: "failed",
								result: JSON.stringify({
									error: {
										code: "subAgentLimit",
										message: "Root tree reached the sub-agent limit",
									},
								}),
							};
						const toolId = savedToolIds.find(
							(toolId) =>
								database
									.prepare("SELECT status FROM tool_calls WHERE id=?")
									.get(toolId)?.status === "running",
						);
						if (!toolId) throw new Error("Missing creating Tool Call");
						const childId = Number(
							database
								.prepare(
									"INSERT INTO agents(created_by_tool_call_id,status,created_at) VALUES (?,'pending',?)",
								)
								.run(toolId, Date.now()).lastInsertRowid,
						);
						startAgent(childId);
						return {
							status: "succeeded",
							result: JSON.stringify({ agent_id: childId, status: "pending" }),
						};
					} catch (error) {
						return {
							status: "failed",
							result: JSON.stringify({
								error:
									error instanceof InputError || error instanceof SyntaxError
										? caughtError(
												error instanceof InputError
													? error
													: new InputError("invalidInput"),
												"invalidInput",
											)
										: {
												code: "subAgentCreateFailed",
												error: redactTool(String(error)),
											},
							}),
						};
					}
				},
				{
					signal: state.controller.signal,
					targetFolders: () => {
						rememberKey(String(modelSettings.readCredential()));
						return currentFolders(id);
					},
					limit: () =>
						Number(
							database
								.prepare("SELECT model_call_limit FROM settings WHERE id=1")
								.get()?.model_call_limit,
						),
					pending: () =>
						children(agentId).some((child) => running.has(Number(child.id))),
					events: () => state.events.splice(0),
					wait: () =>
						state.events.length ||
						!children(agentId).some((child) => running.has(Number(child.id)))
							? Promise.resolve()
							: new Promise<void>((resolve) => {
									state.wake = resolve;
								}),
				},
			);
		} catch (error) {
			failure = error;
		}
		state.stopped = true;
		if (closed) return;
		while (children(agentId).some((child) => running.has(Number(child.id)))) {
			await new Promise<void>((resolve) => {
				state.wake = resolve;
			});
			if (closed) return;
		}
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
					state.controller.signal.aborted
						? "cancelled"
						: failure
							? "failed"
							: "succeeded",
					state.controller.signal.aborted
						? "agentCancelled"
						: (callId !== undefined &&
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
	};

	const server = createHttpServer(async (request, response) => {
		const host = request.headers.host;
		// Only canonical loopback aliases and this listener's actual port are valid.
		const match = host?.match(
			/^(127\.0\.0\.1|localhost|\[::1\])(?::([1-9]\d*))?$/,
		);
		if (!match || Number(match[2] ?? "80") !== request.socket.localPort) {
			request.resume();
			json(response, 403, { error: "Invalid local Host" });
			return;
		}
		const origin = new URL(`http://${host}`).origin;
		let url: URL;
		try {
			url = new URL(request.url ?? "/", origin);
		} catch {
			request.resume();
			json(response, 403, { error: "Invalid request target" });
			return;
		}
		if (url.origin !== origin) {
			request.resume();
			json(response, 403, { error: "Invalid request target" });
			return;
		}
		if (
			url.pathname.startsWith("/api/") &&
			!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "") &&
			request.headers.origin !== origin
		) {
			request.resume();
			json(response, 403, { error: "Matching Origin required" });
			return;
		}
		const path = url.pathname;
		if (
			path.startsWith("/api/") &&
			!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")
		) {
			const token = request.headers["x-tyler-management-token"];
			if (
				typeof token !== "string" ||
				!/^[a-f0-9]{64}$/.test(token) ||
				!timingSafeEqual(Buffer.from(token), Buffer.from(managementToken))
			) {
				request.resume();
				json(response, 403, {
					code: "managementAuthorizationRequired",
					error: "Reopen the management URL printed at service startup",
				});
				return;
			}
		}
		if (path === "/api/approvals" && request.method === "GET") {
			json(response, 200, {
				approvals: [...approvals.values()].map((pending) => pending.view),
			});
			return;
		}
		const approvalRoute = path.match(/^\/api\/approvals\/(\d+)$/);
		if (approvalRoute && request.method === "POST") {
			try {
				const input = await readJson(request);
				if (
					Object.keys(input).some(
						(key) => !["requestId", "decision"].includes(key),
					) ||
					typeof input.requestId !== "string" ||
					!["deny", "once", "always"].includes(String(input.decision))
				)
					throw new InputError("invalidInput");
				await recheckApprovals();
				const pending = approvals.get(Number(approvalRoute[1]));
				if (
					!pending ||
					pending.signal.aborted ||
					pending.view.requestId !== input.requestId ||
					database
						.prepare("SELECT status FROM tool_calls WHERE id=?")
						.get(pending.view.toolCallId)?.status !== "waiting"
				) {
					json(response, 409, {
						error: "Approval is stale or no longer pending",
					});
					return;
				}
				if (input.decision === "always") {
					const grants = projectGrants(pending.view.chatId);
					const approved = pending.view.permissions;
					database.prepare("UPDATE projects SET grants=? WHERE id=?").run(
						JSON.stringify({
							paths: [...grants.paths, ...approved.paths],
							domains: [...new Set([...grants.domains, ...approved.domains])],
							localNetwork: grants.localNetwork || approved.localNetwork,
						}),
						pending.view.projectId,
					);
				}
				pending.settle(
					input.decision === "deny"
						? "denied"
						: input.decision === "always"
							? "always"
							: "once",
				);
				await recheckApprovals();
				json(response, 200, { decision: input.decision });
			} catch (error) {
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "toolWriteFailed"),
				);
			}
			return;
		}
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
		if (path === "/api/settings/credential" && request.method === "GET") {
			response.setHeader("cache-control", "no-store");
			try {
				json(response, 200, {
					apiKey: modelSettings.readCredential(),
				});
			} catch (error) {
				json(response, 500, caughtError(error, "modelSettingsFailed"));
			}
			return;
		}
		if (
			path === "/api/model-settings" &&
			["GET", "PUT"].includes(request.method ?? "")
		) {
			try {
				json(
					response,
					200,
					request.method === "PUT"
						? modelSettings.update(await readJson(request))
						: modelSettings.read(),
				);
			} catch (error) {
				json(
					response,
					error instanceof InputError || error instanceof ModelSettingsError
						? 400
						: 500,
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
					models: await modelSettings.loadCatalog(request.method === "POST"),
				});
			} catch {
				json(response, 502, errorBody("modelCatalogFailed"));
			}
			return;
		}
		if (path === "/api/models" && request.method === "POST") {
			try {
				const { id } = await readJson(request);
				json(response, 200, modelSettings.add(id));
			} catch (error) {
				json(
					response,
					error instanceof InputError || error instanceof ModelSettingsError
						? 400
						: 500,
					caughtError(error, "modelSettingsFailed"),
				);
			}
			return;
		}
		if (path.startsWith("/api/models/") && request.method === "DELETE") {
			try {
				const id = decodeURIComponent(path.slice("/api/models/".length));
				json(response, 200, modelSettings.remove(id));
			} catch {
				json(response, 500, errorBody("modelSettingsFailed"));
			}
			return;
		}

		if (
			path === "/api/access-defaults" &&
			(request.method === "GET" || request.method === "PATCH")
		) {
			try {
				if (request.method === "PATCH") {
					const input = await readJson(request);
					if (
						!Object.keys(input).length ||
						Object.entries(input).some(
							([key, value]) =>
								!["fileAccess", "networkAccess"].includes(key) ||
								(value !== "restricted" && value !== "full"),
						)
					)
						throw new InputError("invalidAccessMode");
					database
						.prepare(
							"UPDATE settings SET default_file_access=COALESCE(?,default_file_access),default_network_access=COALESCE(?,default_network_access) WHERE id=1",
						)
						.run(
							input.fileAccess === undefined ? null : String(input.fileAccess),
							input.networkAccess === undefined
								? null
								: String(input.networkAccess),
						);
				}
				json(
					response,
					200,
					database
						.prepare(
							"SELECT default_file_access AS fileAccess,default_network_access AS networkAccess FROM settings WHERE id=1",
						)
						.get(),
				);
				if (request.method === "PATCH") notifyChange();
			} catch (error) {
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "chatWriteFailed"),
				);
			}
			return;
		}

		if (
			path === "/api/execution-limits" &&
			(request.method === "GET" || request.method === "PATCH")
		) {
			try {
				if (request.method === "PATCH") {
					const input = await readJson(request);
					const keys = ["modelCallLimit", "subAgentLimit"];
					if (
						Object.keys(input).length === 0 ||
						Object.entries(input).some(
							([key, value]) =>
								!keys.includes(key) ||
								typeof value !== "number" ||
								!Number.isSafeInteger(value) ||
								value <= 0,
						)
					)
						throw new InputError("invalidExecutionLimits");
					database
						.prepare(
							"UPDATE settings SET model_call_limit=COALESCE(?,model_call_limit), sub_agent_limit=COALESCE(?,sub_agent_limit) WHERE id=1",
						)
						.run(
							input.modelCallLimit === undefined
								? null
								: Number(input.modelCallLimit),
							input.subAgentLimit === undefined
								? null
								: Number(input.subAgentLimit),
						);
				}
				const limits = database
					.prepare(
						"SELECT model_call_limit AS modelCallLimit, sub_agent_limit AS subAgentLimit FROM settings WHERE id=1",
					)
					.get();
				json(response, 200, limits);
				if (request.method === "PATCH") notifyChange();
			} catch (error) {
				if (!(error instanceof InputError))
					console.error("Execution limits read/write failed", error);
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "executionLimitsFailed"),
				);
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
		const grantsRoute = path.match(/^\/api\/projects\/(\d+)\/grants$/);
		if (grantsRoute && request.method === "PUT") {
			const id = Number(grantsRoute[1]);
			const project = listProjects(database).find((item) => item.id === id);
			if (!project || project.archived) {
				json(
					response,
					project ? 409 : 404,
					errorBody(project ? "projectArchived" : "projectNotFound"),
				);
				return;
			}
			try {
				const input = await readJson(request);
				let grants: ExecutionPermissions;
				try {
					// Empty grants explicitly revoke every persistent extra permission.
					grants = await requestedPermissions(input, "Project Edit");
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "Extra permission request must not be empty"
					)
						grants = emptyPermissions();
					else throw new InputError("invalidInput");
				}
				database
					.prepare("UPDATE projects SET grants=? WHERE id=?")
					.run(JSON.stringify(grants), id);
				await recheckApprovals();
				notifyChange();
				json(response, 200, { grants });
			} catch (error) {
				json(
					response,
					error instanceof InputError ? 400 : 500,
					caughtError(error, "projectWriteFailed"),
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
				await recheckApprovals();
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
					"SELECT status,response_body,output_json FROM model_calls WHERE id=? AND agent_id=?",
				)
				.get(Number(callId), Number(reasoningRoute[1]));
			if (!row) {
				json(response, 404, errorBody("notFound"));
				return;
			}
			const output = callOutput(row);
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
		const cancelRoute = path.match(/^\/api\/agents\/(\d+)\/cancel$/);
		if (cancelRoute && request.method === "POST") {
			try {
				json(response, 200, await cancelAgent(Number(cancelRoute[1])));
			} catch (error) {
				json(
					response,
					error instanceof InputError ? 404 : 500,
					caughtError(error, "agentCancelFailed"),
				);
			}
			return;
		}
		const treeRoute = path.match(/^\/api\/agents\/(\d+)\/tree$/);
		if (treeRoute && request.method === "GET") {
			const agentId = Number(treeRoute[1]);
			if (!database.prepare("SELECT id FROM agents WHERE id=?").get(agentId)) {
				json(response, 404, errorBody("notFound"));
				return;
			}
			const { rootAgentId, chatId, projectId } = agentSource(agentId);
			json(response, 200, {
				rootAgentId,
				chatId,
				projectId,
				agents: [rootAgentId, ...descendants(rootAgentId)].map((id) => {
					const row = database
						.prepare(
							"SELECT id,status,created_at AS createdAt,error_code AS errorCode FROM agents WHERE id=?",
						)
						.get(id);
					const { question, parentAgentId, createdByToolCallId } =
						agentSource(id);
					return {
						...row,
						...persistenceError(id),
						question,
						parentAgentId,
						createdByToolCallId,
						rootAgentId,
						chatId,
						projectId,
					};
				}),
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
				busy: busy.has(agentSource(Number(row.id)).chatId),
				agentBusy: agents[0]?.status === "pending",
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
									`SELECT id,agent_id AS agentId,url,method,requested_at AS requestedAt,${kind === "response" ? "NULL" : "request_body"} AS requestBody,status,http_status AS httpStatus,${kind === "request" ? "NULL" : "response_body"} AS responseBody,duration_ms AS durationMs,error,error_code AS errorCode${kind === "request" ? "" : ",output_json"} FROM model_calls WHERE agent_id=? ${callId !== null ? "AND id=?" : ""} ORDER BY id`,
								)
								.all(
									...(callId === null ? [agentId] : [agentId, Number(callId)]),
								)
								.map(({ output_json, ...call }) => ({
									...call,
									...(output_json !== undefined &&
										call.status !== "succeeded" && {
											partialOutput: JSON.parse(String(output_json)),
										}),
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
					const input = await readJson(request);
					const options = chatOptions(id);
					const fileAccess = input.fileAccess ?? options.fileAccess;
					const networkAccess = input.networkAccess ?? options.networkAccess;
					if (
						![fileAccess, networkAccess].every(
							(value) => value === "restricted" || value === "full",
						) ||
						input.fileAccess === null ||
						input.networkAccess === null
					)
						throw new InputError("invalidAccessMode");
					const modelId =
						input.modelId === undefined ? options.modelId : input.modelId;
					if (modelId !== null && typeof modelId !== "string")
						throw new InputError("invalidModel");
					const selected = modelSettings
						.read()
						.models.find((model) => model.id === modelId);
					if (modelId !== null && !selected)
						throw new InputError("invalidModel");
					let effort =
						input.reasoningEffort === undefined
							? options.reasoningEffort
							: input.reasoningEffort;
					if (effort !== null && typeof effort !== "string")
						throw new InputError("invalidReasoning");
					if (!selected) effort = null;
					else if (
						(input.modelId !== undefined ||
							input.reasoningEffort !== undefined) &&
						effort !== null &&
						!supportedReasoningEfforts(selected)?.includes(effort)
					) {
						if (
							input.reasoningEffort !== undefined &&
							modelId === options.modelId
						)
							throw new InputError("invalidReasoning");
						effort = null;
					}
					const chatName =
						input.name === undefined
							? String(
									database.prepare("SELECT name FROM chats WHERE id=?").get(id)
										?.name,
								)
							: name(input);
					database
						.prepare(
							"UPDATE chats SET name=?,model_id=?,reasoning_effort=?,file_access=?,network_access=? WHERE id=?",
						)
						.run(
							chatName,
							modelId,
							effort,
							String(fileAccess),
							String(networkAccess),
							id,
						);
					await recheckApprovals();
					json(response, 200, {
						id,
						name: chatName,
						chatOptions: chatOptions(id),
					});
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
				const config = currentConfig(id);
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

				await startAgent(agentId);
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
							"INSERT INTO chats(project_id,name,created_at,model_id,file_access,network_access) VALUES (?,?,?,?,(SELECT default_file_access FROM settings WHERE id=1),(SELECT default_network_access FROM settings WHERE id=1))",
						)
						.run(
							projectId,
							chatName,
							createdAt,
							modelSettings.read().defaultModelId,
						).lastInsertRowid,
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
		for (const pending of [...approvals.values()])
			pending.settle("interrupted");
		closed = true;
		const agents = [...running.values()];
		for (const agent of agents) {
			agent.controller.abort(new ExecutionInterruptedError("Service stopped"));
			agent.wake?.();
		}
		void Promise.all(agents.map((agent) => agent.done))
			.then(() => commands.close())
			.finally(() => database.close());
	});
	return Object.assign(server, { managementToken });
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
	await releasePort(port);
	const server = createServer(fetch, values.db);
	server.listen(port, "127.0.0.1", () =>
		console.log(
			`Open http://127.0.0.1:${port}/#management=${server.managementToken}`,
		),
	);
}
