// Controlled external service: exercise the real client transport without credentials.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.argv[2];
const label = process.argv[3] ?? "one";
const log = (event: string, detail: unknown = null) => {
	if (logPath)
		appendFileSync(
			logPath,
			`${JSON.stringify({ event, pid: process.pid, label, detail })}\n`,
		);
};
const png =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYioAAAAASUVORK5CYII=";
const schema = {
	type: "object",
	properties: {
		mode: { type: "string", enum: ["mixed", "error", "protocol", "wait"] },
		payload: {
			type: "object",
			properties: { values: { type: "array", items: { type: "integer" } } },
			required: ["values"],
			additionalProperties: false,
		},
	},
	required: ["mode", "payload"],
	additionalProperties: false,
};
const stderrSecret = process.env.WEFT_MCP_STDERR_TEST_SECRET;
const stderrSplit = stderrSecret ? Math.floor(stderrSecret.length / 2) : 0;
let stderrPrefixWritten = false;
log("start");
process.on("SIGTERM", () => {
	log("stop");
	process.exit(0);
});
process.stdin.on("end", () => {
	log("end");
	process.exit(0);
});
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	log(request.method, request.params);
	const respond = (result: unknown) =>
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
		);
	if (request.method === "initialize") {
		if (stderrSecret) process.stderr.write(Buffer.from("界").subarray(0, 2));
		respond({
			protocolVersion: request.params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "controlled", version: "1" },
		});
	} else if (request.method === "tools/list") {
		if (stderrSecret && !stderrPrefixWritten) {
			stderrPrefixWritten = true;
			process.stderr.write(
				Buffer.concat([
					Buffer.from("界").subarray(2),
					Buffer.from(` stderr ${stderrSecret.slice(0, stderrSplit)}`),
				]),
			);
		}
		respond(
			request.params?.cursor
				? {
						tools: [
							{
								name: "second",
								description: `${label}: second page`,
								inputSchema: {
									type: "object",
									properties: {},
									additionalProperties: false,
								},
							},
						],
					}
				: {
						tools: [
							{
								name: "read_file",
								description: `${label}: controlled MCP tool`,
								inputSchema: schema,
							},
						],
						nextCursor: "page-two",
					},
		);
	} else if (request.method === "tools/call") {
		const mode = request.params.arguments.mode;
		if (stderrSecret)
			process.stderr.write(`${stderrSecret.slice(stderrSplit)}\n`);
		if (mode === "protocol") {
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "controlled protocol failure" } })}\n`,
			);
		} else {
			const result = {
				content: [
					{ type: "text", text: `${label}: first` },
					{ type: "image", data: png, mimeType: "image/png" },
					{ type: "text", text: `${label}: last` },
					{
						type: "resource_link",
						uri: "https://example.invalid/unread",
						name: "unread resource",
						mimeType: "text/plain",
					},
				],
				structuredContent: {
					payload: request.params.arguments.payload,
					label,
					inherited: process.env.WEFT_MCP_FIXTURE_VALUE,
				},
				isError: mode === "error",
			};
			if (mode === "wait" || stderrSecret)
				setTimeout(() => respond(result), mode === "wait" ? 350 : 50);
			else respond(result);
		}
	} else if (request.method === "ping") respond({});
});
