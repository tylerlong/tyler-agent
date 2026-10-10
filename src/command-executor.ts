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

export class ExecutionInterruptedError extends Error {}

type Stream = "stdout" | "stderr";
type ExecutionResult = {
	exitCode: number | null;
	error?: string;
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
	timeoutMs: number;
	signal: AbortSignal;
	onOutput: (stream: Stream, text: string, data?: string) => void;
};
type Running = {
	exitCode: number | null;
	closed: boolean;
	error?: string;
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
					if (message.error) request.reject(new Error(message.error.message));
					else request.resolve(message.result);
					return;
				}
				const proc = this.processes.get(message.params?.processId);
				if (!proc) return;
				if (message.method === "process/output") {
					const stream = message.params.stream as Stream;
					if (stream !== "stdout" && stream !== "stderr")
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
				} else if (message.method === "process/closed") {
					proc.finish();
				}
			} catch (error) {
				this.fail(`Command executor protocol/output failure: ${String(error)}`);
				server.stdin.end();
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
					this.server?.stdin.end();
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
			options.targetFolders.map(async (path) => {
				if (!isAbsolute(path))
					throw new Error("Target Folders must be absolute literal paths");
				return realpath(path);
			}),
		);
		const extraPaths = await Promise.all(
			(options.extraPermissions?.paths ?? []).map(async (scope) => {
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

	async execute(options: Execution): Promise<ExecutionResult> {
		let proc: Running | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		let cancelled = false;
		let timedOut = false;
		const processId = randomUUID();
		try {
			if (
				!options.command ||
				!isAbsolute(options.cwd) ||
				!Number.isInteger(options.timeoutMs) ||
				options.timeoutMs < 1 ||
				options.timeoutMs > 2147483647
			)
				throw new Error(
					"Invalid command, working directory or execution budget",
				);
			if (options.signal.aborted) return { exitCode: null, cancelled: true };
			this.initialized ??= this.initialize();
			await this.initialized;
			if (this.closing) throw new Error("Command executor is closed");
			const sandbox = await this.latestScope(options);
			const scratch = agentScratch(options.agentId);
			const cwd = options.cwd;
			if (options.signal.aborted) return { exitCode: null, cancelled: true };
			let complete!: () => void;
			const completed = new Promise<void>((resolve) => {
				complete = resolve;
			});
			proc = {
				exitCode: null,
				closed: false,
				decoders: {
					stdout: new StringDecoder("utf8"),
					stderr: new StringDecoder("utf8"),
				},
				onOutput: options.onOutput,
				finish() {
					if (this.closed) return;
					this.closed = true;
					try {
						for (const stream of ["stdout", "stderr"] as const) {
							const tail = this.decoders[stream].end();
							if (tail) this.onOutput(stream, tail, "");
						}
					} catch (error) {
						this.error = `Command output persistence failed: ${String(error)}`;
					} finally {
						complete();
					}
				},
			};
			this.processes.set(processId, proc);
			await this.rpc("process/start", {
				processId,
				argv:
					options.patch === undefined
						? ["/bin/sh", "-c", options.command]
						: [this.binary, "--codex-run-as-apply-patch", options.patch],
				cwd: uri(cwd),
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
				tty: false,
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
			const stop = async () => {
				if (proc?.closed) return;
				try {
					await this.rpc("process/terminate", { processId });
				} catch (error) {
					this.fail(`Command termination failed: ${String(error)}`);
					this.server?.stdin.end();
				}
			};
			abort = () => {
				if (proc?.closed) return;
				cancelled = true;
				void stop();
			};
			options.signal.addEventListener("abort", abort, { once: true });
			if (options.signal.aborted) abort();
			else if (!proc.closed)
				timer = setTimeout(() => {
					timedOut = true;
					void stop();
				}, options.timeoutMs);
			await completed;
			return {
				exitCode: proc.exitCode,
				...(proc.error ? { error: proc.error, interrupted: true } : {}),
				...(cancelled ? { cancelled } : {}),
				...(timedOut ? { timedOut } : {}),
			};
		} catch (error) {
			if (this.failure) await this.disconnected;
			return {
				exitCode: proc?.exitCode ?? null,
				error: String(error),
				...(options.signal.aborted && !proc?.closed ? { cancelled: true } : {}),
				...(this.failure ? { interrupted: true } : {}),
			};
		} finally {
			clearTimeout(timer);
			if (abort) options.signal.removeEventListener("abort", abort);
			this.processes.delete(processId);
		}
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
