import assert from "node:assert/strict";
import { test } from "node:test";
import { readTextPage } from "../src/text-file.ts";

const path = "/tmp/text-file-boundaries";
const options = { path, start_line: 1, max_lines: 2000 };
async function* blocks(bytes: Buffer, size: number) {
	for (let index = 0; index < bytes.length; index += size)
		yield bytes.subarray(index, index + size);
}

test("text decoding preserves split BOMs, code units, graphemes and line endings across tiny blocks", async () => {
	const text = "中e\u0301👩🏽‍💻\r\nsecond\r\uFEFFthird\nlast";
	const encodings = {
		"utf-8": Buffer.from(text),
		"utf-8-bom": Buffer.from(`\uFEFF${text}`),
		"utf-16le": Buffer.from(`\uFEFF${text}`, "utf16le"),
		"utf-16be": Buffer.from(`\uFEFF${text}`, "utf16le").swap16(),
	};
	for (const [encoding, bytes] of Object.entries(encodings)) {
		for (const size of [1, 2, 3, 7]) {
			let start_line: number | null = 1;
			const pages: string[] = [];
			while (start_line !== null) {
				const result = await readTextPage(blocks(bytes, size), {
					...options,
					start_line,
					max_lines: 1,
				});
				assert.equal(result.encoding, encoding);
				assert(result.next_line === null || result.next_line > start_line);
				pages.push(result.text);
				start_line = result.next_line;
			}
			assert.deepEqual(
				pages,
				["中e\u0301👩🏽‍💻\r\n", "second\r", "\uFEFFthird\n", "last"],
				`${encoding}, chunk=${size}`,
			);
			assert.equal(pages.join(""), text);
		}
	}
});

test("text decoding distinguishes EOF from a page ending at a block boundary", async () => {
	for (const newline of ["\n", "\r", "\r\n"]) {
		const first = `first${newline}`;
		for (const tail of ["", "second"]) {
			assert.deepEqual(
				await readTextPage(blocks(Buffer.from(first + tail), first.length), {
					...options,
					max_lines: 1,
				}),
				{ path, text: first, encoding: "utf-8", next_line: tail ? 2 : null },
			);
		}
	}
});

test("text decoding scans past long unreturned lines and bounds early return and overlong lines", async () => {
	let yielded = 0;
	let closed = false;
	async function* source() {
		try {
			for (let index = 0; index < 1000; index++) {
				yielded++;
				yield Buffer.from("a".repeat(8192));
			}
			yield Buffer.from("\nselected\nmore");
		} finally {
			closed = true;
		}
	}
	assert.deepEqual(
		await readTextPage(source(), { ...options, start_line: 2, max_lines: 1 }),
		{
			path,
			text: "selected\n",
			encoding: "utf-8",
			next_line: 3,
		},
	);
	assert.equal(yielded, 1000);
	assert(closed);
	// The first line is already too large after seven 8 KiB blocks; never consume its full tail.
	yielded = 0;
	closed = false;
	await assert.rejects(readTextPage(source(), options), /51200/);
	assert.equal(yielded, 7);
	assert(closed);
});

test("strict decoding rejects truncated units while leaving unacquired trailing corruption unread", async () => {
	for (const bytes of [
		Buffer.from([0xef, 0xbb]),
		Buffer.from([0xe2, 0x82]),
		Buffer.from([0xff, 0xfe, 0x00, 0xd8]),
		Buffer.from([0xfe, 0xff, 0xdc, 0x00]),
		Buffer.from([0xff, 0xfe, 0x61]),
		Buffer.from([0xff, 0xfe, 0, 0, 0x61, 0, 0, 0]),
		Buffer.from([0, 0, 0xfe, 0xff, 0, 0, 0, 0x61]),
	])
		await assert.rejects(readTextPage(blocks(bytes, 1), options));
	let reachedCorruption = false;
	async function* source() {
		yield Buffer.from("first\nnext");
		reachedCorruption = true;
		yield Buffer.from([255]);
	}
	assert.deepEqual(await readTextPage(source(), { ...options, max_lines: 1 }), {
		path,
		text: "first\n",
		encoding: "utf-8",
		next_line: 2,
	});
	assert.equal(reachedCorruption, false);
});
