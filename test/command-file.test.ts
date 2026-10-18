import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandExecutor } from "../src/command-executor.ts";

test("native text pagination bounds block reads and closes handles on success, failure and cancellation", {
	skip:
		process.platform !== "darwin"
			? "Native file integration requires macOS"
			: false,
}, async () => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "command-file-")),
	);
	const executor = new CommandExecutor();
	type Params = { handleId?: string; offset?: number; len?: number };
	const calls: { method: string; params: Params }[] = [];
	const rpc = Reflect.get(executor, "rpc").bind(executor) as (
		method: string,
		params: Params,
	) => Promise<unknown>;
	let cancelAfterBlock: AbortController | undefined;
	Reflect.set(executor, "rpc", async (method: string, params: Params) => {
		calls.push({ method, params });
		const result = await rpc(method, params);
		if (method === "fs/readBlock") {
			const block = result as { chunk: string };
			assert.equal(typeof params.len, "number");
			assert(Buffer.from(block.chunk, "base64").length <= (params.len ?? 0));
			cancelAfterBlock?.abort();
		}
		return result;
	});
	const closedRead = () => {
		const fileCalls = calls.filter(({ method }) => method.startsWith("fs/"));
		assert.equal(fileCalls[0]?.method, "fs/open");
		assert.equal(fileCalls.at(-1)?.method, "fs/close");
		assert.equal(
			fileCalls.filter(({ method }) => method === "fs/close").length,
			1,
		);
		assert(
			fileCalls.every(
				({ params }) => params.handleId === fileCalls[0].params.handleId,
			),
		);
		const blocks = fileCalls.filter(({ method }) => method === "fs/readBlock");
		assert(blocks.length > 0);
		for (const [index, { params }] of blocks.entries()) {
			assert.equal(params.len, 16384);
			assert.equal(params.offset, index * 16384);
		}
		calls.length = 0;
		return blocks.length;
	};
	const path = join(directory, "large.txt");
	const options = {
		path,
		start_line: 2,
		max_lines: 1,
		signal: new AbortController().signal,
	};
	try {
		// A skipped line may exceed the page budget; the unread suffix stays native.
		const prefix = "x".repeat(2 * 1024 * 1024);
		const text = `${prefix}\nselected\nunread\n${prefix}`;
		await writeFile(path, text);
		assert.deepEqual(await executor.readText(options), {
			path,
			text: "selected\n",
			encoding: "utf-8",
			next_line: 3,
		});
		const blocks = closedRead();
		assert(blocks * 16384 >= prefix.length);
		assert(blocks * 16384 < Buffer.byteLength(text));

		await writeFile(
			path,
			Buffer.concat([
				Buffer.from("valid\n"),
				Buffer.alloc(60000, 0x61),
				Buffer.from([0xff]),
			]),
		);
		await assert.rejects(executor.readText(options), /encoded|encoding/i);
		assert(closedRead() > 1);

		await writeFile(path, text);
		cancelAfterBlock = new AbortController();
		await assert.rejects(
			executor.readText({ ...options, signal: cancelAfterBlock.signal }),
			{ name: "AbortError" },
		);
		assert.equal(closedRead(), 1);
		cancelAfterBlock = undefined;

		await writeFile(path, "first\nsecond");
		assert.deepEqual(await executor.readText(options), {
			path,
			text: "second",
			encoding: "utf-8",
			next_line: null,
		});
		closedRead();
	} finally {
		await executor.close();
		await rm(directory, { recursive: true, force: true });
	}
});
