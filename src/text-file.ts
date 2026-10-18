import { isBinaryFileSync } from "isbinaryfile";

const MAX_TEXT_BYTES = 51200;

// Blocks come from the native file RPC; returning early closes its iterator/handle.
export async function readTextPage(
	blocks: AsyncIterable<Buffer>,
	options: { path: string; start_line: number; max_lines: number },
) {
	let encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" = "utf-8";
	let decoder: TextDecoder | undefined;
	let prefix = Buffer.alloc(0);
	let line = 1,
		lineText = "",
		lineBytes = 0,
		page = "",
		pageBytes = 0,
		count = 0;
	let pendingCR = false,
		hasBody = false,
		classified = false;
	const result = (next_line: number | null) => ({
		path: options.path,
		text: page,
		encoding,
		next_line,
	});
	const finishLine = () => {
		if (line >= options.start_line) {
			page += lineText;
			pageBytes += lineBytes;
			count++;
		}
		line++;
		lineText = "";
		lineBytes = 0;
	};
	const consume = (text: string): number | undefined => {
		if (!classified && text) {
			classified = true;
			// The strict streaming decoder removes incomplete units from the sample.
			if (isBinaryFileSync(Buffer.from(text, "utf8")))
				throw new Error(
					"Binary content cannot be read as text; use read_image for images or an existing command or MCP tool",
				);
		}
		for (const char of text) {
			hasBody = true;
			if (pendingCR) {
				pendingCR = false;
				if (char !== "\n") finishLine();
			}
			if (count >= options.max_lines) return line;
			if (line >= options.start_line) {
				lineBytes += Buffer.byteLength(char, "utf8");
				if (pageBytes + lineBytes > MAX_TEXT_BYTES) {
					if (count) return line;
					throw new Error(
						`Line ${line} exceeds the 51200 UTF-8 byte text budget; use an existing command or MCP tool to extract content`,
					);
				}
				lineText += char;
			}
			if (char === "\r") pendingCR = true;
			else if (char === "\n") finishLine();
		}
	};
	for await (let block of blocks) {
		if (!decoder) {
			prefix = Buffer.concat([prefix, block]);
			// Four bytes distinguish UTF-32 BOMs from the supported UTF-16 BOMs.
			if (prefix.length < 4) continue;
			block = prefix;
			prefix = Buffer.alloc(0);
			decoder = createDecoder(block);
		}
		const next = consume(decode(decoder, block, true));
		if (next !== undefined) return result(next);
	}
	if (!decoder) decoder = createDecoder(prefix);
	const next = consume(decode(decoder, prefix, false));
	if (next !== undefined) return result(next);
	if (pendingCR || lineText) finishLine();
	if (hasBody && line <= options.start_line)
		throw new Error("start_line is beyond the end of the file");
	return result(null);

	function decode(decoder: TextDecoder, bytes: Buffer, stream: boolean) {
		try {
			return decoder.decode(bytes, { stream });
		} catch {
			throw new Error(
				"Unsupported or malformed text encoding; use read_image for images or an existing command or MCP tool to inspect or convert content",
			);
		}
	}

	function createDecoder(bytes: Buffer) {
		if (
			bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0])) ||
			bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))
		)
			throw new Error(
				"Unsupported text encoding; use an existing command or MCP tool to convert content",
			);
		if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
		else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
		else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
			encoding = "utf-8-bom";
		return new TextDecoder(encoding === "utf-8-bom" ? "utf-8" : encoding, {
			fatal: true,
		});
	}
}
