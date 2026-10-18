import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { browserCacheDirectory, playwrightRoot } from "./browser-tools.ts";
import { imageFromBytes, MAX_IMAGE_BYTES } from "./image-content.ts";
import { readTextPage } from "./text-file.ts";

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
	agentId: string;
	timeoutMs?: number;
	yieldTimeMs?: number;
	tty?: boolean;
	shell?: string;
	login?: boolean;
	toolCallId?: number;
	onState?: (result: ExecutionResult) => void;
	signal: AbortSignal;
	onOutput: (stream: Stream, text: string) => void;
};
type Running = {
	startup: Pick<Execution, "command" | "cwd" | "shell" | "login" | "tty">;
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
export class CommandExecutor {
	private server?: ChildProcessWithoutNullStreams;
	private initialized?: Promise<void>;
	private failure?: string;
	private closing = false;
	private binary = "";
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
			throw new Error("Native command execution currently requires macOS");
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
		const home = await realpath(await mkdtemp("/tmp/tyler-agent-executor-"));
		const bin = join(home, "bin");
		await mkdir(bin);
		const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
		await writeFile(
			join(bin, "playwright-cli"),
			`#!/bin/sh\nHOME="$TMPDIR" exec ${quote(process.execPath)} ${quote(join(playwrightRoot, "cli.js"))} cli "$@"\n`,
			{ mode: 0o755 },
		);
		this.commandPath = `${bin}:${dirname(process.execPath)}:${rgFolder}`;
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

	private async *fileBlocks(
		path: string,
		signal: AbortSignal,
		limit = Number.MAX_SAFE_INTEGER,
	) {
		const handleId = randomUUID().replaceAll("-", "");
		let opened = false;
		try {
			signal.throwIfAborted();
			this.initialized ??= this.initialize();
			await this.initialized;
			signal.throwIfAborted();
			await this.rpc("fs/open", {
				handleId,
				path: uri(path),
				mode: "read",
				sandbox: null,
			});
			opened = true;
			let offset = 0;
			while (offset < limit) {
				signal.throwIfAborted();
				const len = Math.min(16384, limit - offset);
				const block = (await this.rpc("fs/readBlock", {
					handleId,
					offset,
					len,
				})) as { chunk: string; eof: boolean };
				const chunk = Buffer.from(block.chunk, "base64");
				if (chunk.length > len || (!chunk.length && !block.eof))
					throw new Error("Invalid native file block");
				signal.throwIfAborted();
				yield chunk;
				offset += chunk.length;
				if (block.eof) return;
			}
		} finally {
			if (opened) await this.rpc("fs/close", { handleId });
		}
	}

	async readText(options: {
		path: string;
		start_line: number;
		max_lines: number;
		signal: AbortSignal;
	}) {
		return readTextPage(this.fileBlocks(options.path, options.signal), options);
	}

	async readImage(options: { path: string; signal: AbortSignal }) {
		const chunks: Buffer[] = [];
		for await (const chunk of this.fileBlocks(
			options.path,
			options.signal,
			MAX_IMAGE_BYTES + 1,
		))
			chunks.push(chunk);
		const content = Buffer.concat(chunks);
		if (content.length > MAX_IMAGE_BYTES)
			throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
		return [imageFromBytes(content)];
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
			const scratch = agentScratch(options.agentId);
			options.signal.throwIfAborted();
			let complete!: () => void;
			const completed = new Promise<void>((resolve) => {
				complete = resolve;
			});
			proc = {
				startup: {
					command: options.command,
					cwd: options.cwd,
					shell: options.shell ?? "/bin/sh",
					login: options.login ?? interactive,
					tty: options.tty ?? false,
				},
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
							if (tail) proc.onOutput(stream, tail);
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
			const environment = { ...process.env };
			delete environment.TYLER_MANAGEMENT_TOKEN;
			await this.rpc("process/start", {
				processId,
				argv:
					options.patch === undefined
						? [
								options.shell ?? "/bin/sh",
								(options.login ?? interactive) ? "-lc" : "-c",
								options.command,
							]
						: [this.binary, "--codex-run-as-apply-patch", options.patch],
				cwd: uri(options.cwd),
				env: {
					...environment,
					PATH: `${this.commandPath}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
					TMPDIR: scratch,
					TMP: scratch,
					TEMP: scratch,
					XDG_CACHE_HOME: join(scratch, "cache"),
					PLAYWRIGHT_BROWSERS_PATH: browserCacheDirectory,
				},
				tty: options.tty ?? false,
				pipeStdin: false,
				arg0: null,
				sandbox: null,
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

	sessionStartup(sessionId: number, agentId: string) {
		return { ...this.ownedSession(sessionId, agentId).proc.startup };
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
