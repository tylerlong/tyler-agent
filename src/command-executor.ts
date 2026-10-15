import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

import type { ExecutionPermissions } from "./execution-permissions.ts";
import { imageFromBytes, MAX_IMAGE_BYTES } from "./image-content.ts";

export class ExecutionInterruptedError extends Error {}

type Stream = "stdout" | "stderr" | "pty";

export class NativeExecutionError extends Error {
	code: number;
	data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}
export const executionError = (error: unknown) => ({
	error: error instanceof Error ? error.message : String(error),
	...(error instanceof NativeExecutionError
		? {
				error_code: error.code,
				...(error.data === undefined ? {} : { error_data: error.data }),
			}
		: {}),
});

type ExecutionResult = {
	exitCode: number | null;
	error?: string;
	error_code?: number;
	error_data?: unknown;
	session_id?: number;
	running?: boolean;
	sandboxDenied?: boolean;
	timedOut?: boolean;
	cancelled?: boolean;
	interrupted?: boolean;
};
type Execution = {
	command: string;
	patch?: string;
	cwd: string;
	targetFolders: string[];
	extraPermissions?: ExecutionPermissions;
	resolvePermissions?: () => Pick<
		Execution,
		"targetFolders" | "extraPermissions"
	>;
	agentId: string;
	timeoutMs?: number;
	yieldTimeMs?: number;
	tty?: boolean;
	shell?: string;
	login?: boolean;
	toolCallId?: number;
	onState?: (result: ExecutionResult) => void;
	signal: AbortSignal;
	onOutput: (stream: Stream, text: string, data?: string) => void;
};
type Running = {
	exitCode: number | null;
	closed: boolean;
	error?: ExecutionResult["error"];
	agentId: string;
	toolCallId?: number;
	tty: boolean;
	sandboxDenied?: boolean;
	completed: Promise<void>;
	cancelled: boolean;
	timedOut: boolean;
	stop: () => Promise<void>;
	cleanup: () => void;
	decoders: Record<Stream, StringDecoder>;
	onOutput: Execution["onOutput"];
	finish: () => void;
};

export function agentScratch(agentId: string) {
	if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error("Invalid Agent ID");
	const scratch = join("/tmp/tyler-agent", agentId);
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	const actual = realpathSync(scratch);
	if (actual !== join(realpathSync("/tmp"), "tyler-agent", agentId))
		throw new Error("Agent scratch must not be a symbolic link");
	return actual;
}

const uri = (path: string) => pathToFileURL(path).href;
const entry = (path: string, access: "read" | "write" | "deny") => ({
	path: { type: "path", path: uri(path) },
	access,
});

export class CommandExecutor {
	private server?: ChildProcessWithoutNullStreams;
	private initialized?: Promise<void>;
	private failure?: string;
	private closing = false;
	private binary = "";
	private toolPaths: string[] = [];
	private commandPath = "";
	private disconnected?: Promise<void>;
	private nextId = 1;
	private shutdownTimer?: ReturnType<typeof setTimeout>;
	private pending = new Map<
		number,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void }
	>();
	private processes = new Map<string, Running>();
	private sessions = new Map<number, string>();
	private nextSession = 1;

	private fail(message: string, disconnected = false) {
		this.failure ??= message;
		for (const request of this.pending.values())
			request.reject(new ExecutionInterruptedError(this.failure));
		this.pending.clear();
		for (const proc of this.processes.values()) {
			proc.error = this.failure;
			if (disconnected) proc.finish();
		}
		if (!disconnected) this.stopServer();
	}

	private stopServer() {
		const server = this.server;
		if (!server || server.exitCode !== null || server.signalCode !== null)
			return;
		server.stdin.end();
		if (this.shutdownTimer) return;
		// A dead/stopped backend cannot acknowledge EOF or native termination.
		this.shutdownTimer = setTimeout(() => server.kill("SIGKILL"), 5000);
		this.shutdownTimer.unref();
		server.once("close", () => clearTimeout(this.shutdownTimer));
	}

	private async initialize() {
		if (this.closing) throw new Error("Command executor is closed");
		if (process.platform !== "darwin")
			throw new Error("Restricted command execution currently requires macOS");
		const require = createRequire(import.meta.url);
		const codexRequire = createRequire(
			require.resolve("@openai/codex/package.json"),
		);
		const platformRoot = dirname(
			codexRequire.resolve(`@openai/codex-darwin-${process.arch}/package.json`),
		);
		const triple = process.arch === "arm64" ? "aarch64" : "x86_64";
		this.binary = join(
			platformRoot,
			"vendor",
			`${triple}-apple-darwin`,
			"bin/codex",
		);
		const rgFolder = join(
			platformRoot,
			"vendor",
			`${triple}-apple-darwin`,
			"codex-path",
		);
		this.toolPaths = [
			dirname(dirname(await realpath(process.execPath))),
			"/System/Library/OpenSSL",
			"/Library/Developer/CommandLineTools",
			"/opt/homebrew/Cellar",
			"/opt/homebrew/opt",
			"/opt/homebrew/etc/openssl@3",
			"/opt/homebrew/etc/openssl@4",
			this.binary,
			rgFolder,
		];
		// The supported macOS installation uses Homebrew; no user PATH or config is inherited.
		try {
			this.toolPaths.push(
				dirname(dirname(await realpath("/opt/homebrew/bin/pnpm"))),
			);
		} catch {
			// pnpm is optional; missing commands return their ordinary shell error.
		}
		this.commandPath = `${dirname(process.execPath)}:${rgFolder}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
		const home = await realpath(await mkdtemp("/tmp/tyler-agent-executor-"));
		await mkdir(join(home, "tmp"));
		await writeFile(
			join(home, "config.toml"),
			'[analytics]\nenabled = false\n[otel]\nexporter = "none"\ntrace_exporter = "none"\n',
		);
		if (this.closing) throw new Error("Command executor is closed");
		const server = spawn(
			this.binary,
			[
				"exec-server",
				"--listen",
				"stdio://",
				"--concurrent-requests",
				"64",
				"--strict-config",
			],
			{
				cwd: home,
				env: {
					PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
					HOME: home,
					CODEX_HOME: home,
					TMPDIR: join(home, "tmp"),
					LANG: "en_US.UTF-8",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.server = server;
		this.disconnected = new Promise((resolve) => server.once("close", resolve));
		let stderr = "";
		server.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-4000);
		});
		server.on("error", (error) =>
			this.fail(`Command executor failed: ${error.message}`),
		);
		server.on("close", (code) =>
			this.fail(`Command executor disconnected (${code}): ${stderr}`, true),
		);
		server.stdin.on("error", (error) =>
			this.fail(`Command executor input failed: ${error.message}`),
		);
		createInterface({ input: server.stdout }).on("line", (line) => {
			try {
				const message = JSON.parse(line);
				if (message.id !== undefined) {
					const request = this.pending.get(message.id);
					if (!request) return;
					this.pending.delete(message.id);
					if (message.error)
						request.reject(
							new NativeExecutionError(
								message.error.code,
								message.error.message,
								message.error.data,
							),
						);
					else request.resolve(message.result);
					return;
				}
				const proc = this.processes.get(message.params?.processId);
				if (!proc) return;
				if (message.method === "process/output") {
					const stream = message.params.stream as Stream;
					if (stream !== "stdout" && stream !== "stderr" && stream !== "pty")
						throw new Error("Invalid command output stream");
					proc.onOutput(
						stream,
						proc.decoders[stream].write(
							Buffer.from(message.params.chunk, "base64"),
						),
						message.params.chunk,
					);
				} else if (message.method === "process/exited") {
					proc.exitCode = message.params.exitCode ?? null;
					proc.sandboxDenied = message.params.sandboxDenied;
				} else if (message.method === "process/closed") {
					proc.finish();
				}
			} catch (error) {
				this.fail(`Command executor protocol/output failure: ${String(error)}`);
			}
		});
		await this.rpc("initialize", { clientName: "tyler-agent" });
		server.stdin.write(
			`${JSON.stringify({ method: "initialized", params: {} })}\n`,
		);
	}

	private async rpc(method: string, params: object): Promise<unknown> {
		if (this.failure) throw new ExecutionInterruptedError(this.failure);
		const id = this.nextId++;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (this.closing) throw new Error("Command executor is closed");
			return await new Promise((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				timer = setTimeout(() => {
					this.fail(`Command executor RPC timed out: ${method}`);
				}, 30000);
				this.server?.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
			});
		} finally {
			clearTimeout(timer);
		}
	}

	private async latestScope(
		options: Pick<
			Execution,
			| "cwd"
			| "targetFolders"
			| "agentId"
			| "extraPermissions"
			| "resolvePermissions"
			| "signal"
		>,
	) {
		for (;;) {
			options.signal.throwIfAborted();
			const snapshot = options.resolvePermissions?.();
			if (snapshot) Object.assign(options, snapshot);
			const sandbox = await this.scope(options);
			// Filesystem preparation yields; a management edit must affect an unstarted operation.
			if (
				JSON.stringify(snapshot) ===
				JSON.stringify(options.resolvePermissions?.())
			)
				return sandbox;
		}
	}

	private async scope(
		options: Pick<
			Execution,
			"cwd" | "targetFolders" | "agentId" | "extraPermissions"
		>,
	) {
		const scratch = await agentScratch(options.agentId);
		const targets = await Promise.all(
			(options.extraPermissions?.fullFile ? [] : options.targetFolders).map(
				async (path) => {
					if (!isAbsolute(path))
						throw new Error("Target Folders must be absolute literal paths");
					return realpath(path);
				},
			),
		);
		const extraPaths = await Promise.all(
			(options.extraPermissions?.fullFile
				? []
				: (options.extraPermissions?.paths ?? [])
			).map(async (scope) => {
				if ((await realpath(scope.path)) !== scope.path)
					throw new Error("Approved path changed before execution");
				return scope;
			}),
		);
		const writes = [
			...targets,
			scratch,
			...extraPaths
				.filter((scope) => scope.access === "write")
				.map((scope) => scope.path),
		];
		const writeDirectories = new Set(
			(
				await Promise.all(
					writes.map(async (path) =>
						(await stat(path)).isDirectory() ? path : null,
					),
				)
			).filter((path) => path !== null),
		);
		const cwd = await realpath(options.cwd);
		if (
			!options.extraPermissions?.fullFile &&
			![...writes, ...extraPaths.map((scope) => scope.path)].some((root) => {
				const within = relative(root, cwd);
				return (
					within === "" ||
					(within !== ".." &&
						!within.startsWith(`..${sep}`) &&
						!isAbsolute(within))
				);
			})
		)
			throw new Error(
				"Working directory is outside Target Folders and Agent scratch",
			);
		return {
			permissions: {
				type: "managed",
				file_system: options.extraPermissions?.fullFile
					? { type: "unrestricted" }
					: {
							type: "restricted",
							entries: [
								{
									path: { type: "special", value: { kind: "minimal" } },
									access: "read",
								},
								entry("/private/tmp", "deny"),
								entry("/private/var/tmp", "deny"),
								...this.toolPaths.map((path) => entry(path, "read")),
								...extraPaths
									.filter((scope) => scope.access === "read")
									.map((scope) => entry(scope.path, "read")),
								...writes.flatMap((path) => [
									entry(path, "write"),
									...(writeDirectories.has(path)
										? [".git", ".agents", ".codex", ".aws"]
										: []
									).map((name) => entry(join(path, name), "write")),
								]),
							],
						},
				network: options.extraPermissions?.fullNetwork
					? "enabled"
					: "restricted",
			},
			cwd: uri(cwd),
			workspaceRoots: targets.map(uri),
			windowsSandboxLevel: "disabled",
			useLegacyLandlock: false,
		};
	}

	async read(
		options: Pick<
			Execution,
			| "targetFolders"
			| "agentId"
			| "signal"
			| "extraPermissions"
			| "resolvePermissions"
		> & {
			path: string;
			offset: number;
			limit: number;
		},
	) {
		const handleId = randomUUID().replaceAll("-", "");
		let opened = false;
		try {
			options.signal.throwIfAborted();
			this.initialized ??= this.initialize();
			await this.initialized;
			const sandbox = await this.latestScope({
				...options,
				cwd: agentScratch(options.agentId),
			});
			options.signal.throwIfAborted();
			await this.rpc("fs/open", {
				handleId,
				path: uri(options.path),
				mode: "read",
				sandbox,
			});
			opened = true;
			const chunks: Buffer[] = [];
			let bytes = 0,
				eof = false;
			while (bytes < options.limit && !eof) {
				options.signal.throwIfAborted();
				const block = (await this.rpc("fs/readBlock", {
					handleId,
					offset: options.offset + bytes,
					len: Math.min(16384, options.limit - bytes),
				})) as { chunk: string; eof: boolean };
				const chunk = Buffer.from(block.chunk, "base64");
				if (
					chunk.length > options.limit - bytes ||
					(!chunk.length && !block.eof)
				)
					throw new Error("Invalid native file block");
				chunks.push(chunk);
				bytes += chunk.length;
				eof = block.eof;
			}
			options.signal.throwIfAborted();
			const content = Buffer.concat(chunks);
			return {
				path: options.path,
				content: content.toString("base64"),
				text: content.toString("utf8"),
				bytes_read: bytes,
				next_offset: options.offset + bytes,
				eof,
			};
		} finally {
			if (opened) await this.rpc("fs/close", { handleId });
		}
	}

	async readImage(
		options: Omit<Parameters<CommandExecutor["read"]>[0], "offset" | "limit">,
	) {
		const file = await this.read({
			...options,
			offset: 0,
			limit: MAX_IMAGE_BYTES + 1,
		});
		if (!file.eof || file.bytes_read > MAX_IMAGE_BYTES)
			throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
		return [imageFromBytes(Buffer.from(file.content, "base64"))];
	}

	async execute(options: Execution): Promise<ExecutionResult> {
		let proc: Running | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		const interactive = options.timeoutMs === undefined;
		const sessionId = this.nextSession++;
		const processId = randomUUID();
		try {
			if (!options.command || !isAbsolute(options.cwd))
				throw new Error("Invalid command or working directory");
			if (options.signal.aborted) return { exitCode: null, cancelled: true };
			this.initialized ??= this.initialize();
			await this.initialized;
			const sandbox = await this.latestScope(options);
			const scratch = agentScratch(options.agentId);
			options.signal.throwIfAborted();
			let complete!: () => void;
			const completed = new Promise<void>((resolve) => {
				complete = resolve;
			});
			proc = {
				exitCode: null,
				closed: false,
				agentId: options.agentId,
				toolCallId: options.toolCallId,
				tty: options.tty ?? false,
				completed,
				cancelled: false,
				timedOut: false,
				stop: async () => {
					if (!proc?.closed) await this.rpc("process/terminate", { processId });
				},
				cleanup: () => {
					clearTimeout(timer);
					if (abort) options.signal.removeEventListener("abort", abort);
				},
				decoders: {
					stdout: new StringDecoder("utf8"),
					stderr: new StringDecoder("utf8"),
					pty: new StringDecoder("utf8"),
				},
				onOutput: options.onOutput,
				finish: () => {
					if (!proc || proc.closed) return;
					proc.closed = true;
					try {
						for (const stream of ["stdout", "stderr", "pty"] as const) {
							const tail = proc.decoders[stream].end();
							if (tail) proc.onOutput(stream, tail, "");
						}
					} catch (error) {
						proc.error = `Command output persistence failed: ${String(error)}`;
					} finally {
						proc.cleanup();
						try {
							options.onState?.(this.result(proc));
						} catch (error) {
							proc.error = `Command state persistence failed: ${String(error)}`;
						} finally {
							complete();
						}
					}
				},
			};
			this.processes.set(processId, proc);
			if (interactive) this.sessions.set(sessionId, processId);
			await this.rpc("process/start", {
				processId,
				argv:
					options.patch === undefined
						? [
								options.shell ?? "/bin/sh",
								options.login === false ? "-c" : "-lc",
								options.command,
							]
						: [this.binary, "--codex-run-as-apply-patch", options.patch],
				cwd: uri(options.cwd),
				env: {
					PATH: this.commandPath,
					HOME: scratch,
					TMPDIR: scratch,
					TMP: scratch,
					TEMP: scratch,
					XDG_CACHE_HOME: join(scratch, "cache"),
					LANG: "en_US.UTF-8",
					GIT_CONFIG_NOSYSTEM: "1",
					DEVELOPER_DIR: "/Library/Developer/CommandLineTools",
				},
				tty: options.tty ?? false,
				pipeStdin: false,
				arg0: null,
				sandbox,
				...(!options.extraPermissions?.fullNetwork &&
				(options.extraPermissions?.domains.length ||
					options.extraPermissions?.localNetwork)
					? {
							enforceManagedNetwork: true,
							networkProxy: {
								proxy: {
									enabled: true,
									enableSocks5: false,
									enableSocks5Udp: false,
									allowUpstreamProxy: false,
									dangerouslyAllowAllUnixSockets: false,
									mode: "full",
									domains: Object.fromEntries(
										(options.extraPermissions?.domains ?? []).map((domain) => [
											domain,
											"allow",
										]),
									),
									unixSockets: {},
									allowLocalBinding:
										options.extraPermissions?.localNetwork === true,
								},
							},
						}
					: {}),
			});
			const stop = () => {
				void proc
					?.stop()
					.catch((error) =>
						this.fail(`Command termination failed: ${String(error)}`),
					);
			};
			abort = () => {
				if (proc && !proc.closed) {
					proc.cancelled = true;
					stop();
				}
			};
			options.signal.addEventListener("abort", abort, { once: true });
			if (options.signal.aborted) abort();
			else if (!proc.closed && options.timeoutMs !== undefined)
				timer = setTimeout(() => {
					if (proc) proc.timedOut = true;
					stop();
				}, options.timeoutMs);
			if (interactive) {
				if (!proc.closed)
					options.onState?.({
						exitCode: null,
						running: true,
						session_id: sessionId,
					});
				return await this.waitSession(
					sessionId,
					options.agentId,
					options.yieldTimeMs ?? 10000,
				);
			}
			await completed;
			return this.result(proc);
		} catch (error) {
			if (this.failure) await this.disconnected;
			if (proc && !abort) {
				proc.error = String(error);
				proc.finish();
			}
			return {
				exitCode: proc?.exitCode ?? null,
				error: String(error),
				...(error instanceof NativeExecutionError
					? { error_code: error.code, error_data: error.data }
					: {}),
				...(options.signal.aborted ? { cancelled: true } : {}),
				...(this.failure ? { interrupted: true } : {}),
			};
		} finally {
			if (!interactive || !proc || proc.closed || !abort) {
				clearTimeout(timer);
				if (abort) options.signal.removeEventListener("abort", abort);
				this.processes.delete(processId);
				this.sessions.delete(sessionId);
			}
		}
	}

	private result(proc: Running): ExecutionResult {
		return {
			exitCode: proc.exitCode,
			running: !proc.closed,
			...(proc.error ? { error: proc.error, interrupted: true } : {}),
			...(proc.sandboxDenied === undefined
				? {}
				: { sandboxDenied: proc.sandboxDenied }),
			...(proc.cancelled ? { cancelled: true } : {}),
			...(proc.timedOut ? { timedOut: true } : {}),
		};
	}

	private ownedSession(sessionId: number, agentId: string) {
		const processId = this.sessions.get(sessionId);
		const proc = processId && this.processes.get(processId);
		if (!proc || proc.agentId !== agentId)
			throw new Error("Session is available only to the Agent that started it");
		return { processId, proc };
	}

	private async waitSession(
		sessionId: number,
		agentId: string,
		yieldTimeMs: number,
	) {
		const { processId, proc } = this.ownedSession(sessionId, agentId);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				proc.completed,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, yieldTimeMs);
				}),
			]);
			const result = this.result(proc);
			return {
				...result,
				...(proc.closed ? {} : { session_id: sessionId }),
				tool_call_id: proc.toolCallId,
			};
		} finally {
			clearTimeout(timer);
			if (proc.closed) {
				this.processes.delete(processId);
				this.sessions.delete(sessionId);
			}
		}
	}

	async writeStdin(options: {
		sessionId: number;
		agentId: string;
		chars: string;
		yieldTimeMs: number;
	}) {
		const { processId, proc } = this.ownedSession(
			options.sessionId,
			options.agentId,
		);
		if (options.chars) {
			if (!proc.tty) {
				if (options.chars !== "\x03")
					throw new Error(
						"stdin is closed for this non-PTY session; only Ctrl-C is supported",
					);
				await this.rpc("process/signal", { processId, signal: "interrupt" });
			} else {
				const result = (await this.rpc("process/write", {
					processId,
					writeId: randomUUID(),
					chunk: Buffer.from(options.chars).toString("base64"),
				})) as { status: string };
				if (result.status !== "accepted")
					throw new Error(`Command stdin write: ${result.status}`);
			}
		}
		return this.waitSession(
			options.sessionId,
			options.agentId,
			options.yieldTimeMs,
		);
	}

	async closeAgent(agentId: string) {
		const owned = [...this.processes.entries()].filter(
			([, proc]) => proc.agentId === agentId,
		);
		await Promise.all(
			owned.map(async ([processId, proc]) => {
				if (!proc.closed) {
					try {
						await proc.stop();
					} catch (error) {
						this.fail(`Command termination failed: ${String(error)}`);
					}
				}
				await proc.completed;
				this.processes.delete(processId);
			}),
		);
		for (const [sessionId, processId] of this.sessions)
			if (!this.processes.has(processId)) this.sessions.delete(sessionId);
	}

	async close() {
		this.closing = true;
		await this.initialized?.catch(() => {});
		const server = this.server;
		if (!server || server.exitCode !== null || server.signalCode !== null)
			return;
		await new Promise<void>((resolve) => {
			server.once("close", resolve);
			this.stopServer();
		});
	}
}
