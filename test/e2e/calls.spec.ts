import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

async function displayedText(record: Locator) {
	return record
		.locator(".communication-text")
		.evaluate((element) => element.textContent ?? "");
}

test("large failed responses stay folded and keep the composer visible until requested", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Failure" },
		})
	).json();
	const raw = JSON.stringify({ error: "private diagnostic\n".repeat(1000) });
	app.failModel("http", raw);
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto(`${app.url}/?chat=${chat.id}`);
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().includes("/calls")) reads++;
	});
	await page.getByLabel("Prompt").fill("question");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect(page.getByRole("log")).toContainText(
		"OpenRouter request failed.",
	);
	await expect(page.getByLabel("Prompt")).toBeInViewport();
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeInViewport();
	await expect(page.getByRole("log")).not.toContainText("private diagnostic");
	expect(reads).toBe(0);
	const response = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^Response \d+/ }),
	});
	await expect(response.locator("pre")).toHaveCount(0);
	await response.locator("summary").click();
	await expect(response.locator("pre")).toHaveText(
		JSON.stringify(JSON.parse(raw), null, 2),
	);
	expect(reads).toBeGreaterThan(0);
	await expect(page.getByLabel("Prompt")).toBeInViewport();
});

test("communication is lazy, formatted and copied as displayed text, retained across chats and updated after completion", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "First" },
		})
	).json();
	await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Other" },
		})
	).json();
	const gate = app.holdModel();
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "question" },
	});
	await gate.entered;
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().includes("/calls")) reads++;
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const request = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^(Request|请求) \d+$/ }),
	});
	const response = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^(Response|响应) \d+/ }),
	});
	await expect(request).toHaveCount(1);
	expect(reads).toBe(0);
	await request.locator("summary").click();
	await expect(request.locator("pre")).toContainText('  "model"');
	await expect(
		request.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	const history = await (
		await page.request.get(`${app.url}/api/chats/${chat.id}`)
	).json();
	const savedRequests = await (
		await page.request.get(
			`${app.url}/api/agents/${history.agents[0].id}/calls?kind=request`,
		)
	).json();
	const requestBody = savedRequests.calls[0].requestBody;
	expect(JSON.parse(requestBody)).toMatchObject({
		model: "test",
		input: [{ role: "user", content: "question" }],
		stream: true,
		tools: [
			{ type: "function", name: "count_files" },
			{ type: "function", name: "create_sub_agent" },
			{ type: "function", name: "cancel_sub_agent" },
		],
	});
	await expect(
		response.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	await response.locator("summary").click();
	await expect(
		response.getByRole("status", { name: "Working…" }),
	).toBeVisible();
	gate.release();
	await pending;
	await expect(response.locator("pre")).toContainText(
		'  "status": "completed"',
	);
	await expect(response.locator("pre")).toContainText("Test answer");
	await request.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await displayedText(request));
	await expect(request).toHaveAttribute("open", "");
	await response.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await displayedText(response));
	await expect(response).toHaveAttribute("open", "");
	await expect(response.locator("summary")).not.toContainText("Completed");
	const cachedReads = reads;
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await page.getByRole("button", { name: "First", exact: true }).click();
	await expect(request.locator("pre")).toBeVisible();
	await expect(response.locator("pre")).toBeVisible();
	expect(reads).toBe(cachedReads);
	const hiddenGate = app.holdModel();
	const hiddenPending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Complete while away" },
	});
	await hiddenGate.entered;
	await expect(response).toHaveCount(2);
	await response.last().locator("summary").click();
	await expect(
		response.last().getByRole("status", { name: "Working…" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await expect(page.getByRole("log")).toBeEmpty();
	hiddenGate.release();
	await hiddenPending;
	await page.getByRole("button", { name: "First", exact: true }).click();
	await expect(response.last().locator("pre")).toContainText("Test answer");
	await expect(response.last()).not.toContainText("Working");
	await expect(response.first().locator("pre")).toBeVisible();
	await page.reload();
	await expect(request.first().locator("pre")).not.toBeVisible();
	await expect(response.last().locator("pre")).not.toBeVisible();
});

test("failed responses show actual text, retry reading, copy displayed information and remain readable when archived and translated", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Failed" },
		})
	).json();
	app.failModel();
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "failure" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	let fail = true;
	await page.route("**/calls?kind=response&callId=*", (route) =>
		fail
			? route.fulfill({ status: 503, json: { error: "offline" } })
			: route.continue(),
	);
	const response = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^(Response|响应) \d+/ }),
	});
	await response.locator("summary").click();
	await expect(response.getByRole("alert")).toContainText(
		"Unable to read communication",
	);
	await expect(response.getByRole("button", { name: "Copy" })).toHaveCount(0);
	fail = false;
	await response.getByRole("button", { name: "Retry" }).click();
	await expect(response).toContainText("HTTP 500");
	await expect(response.locator("pre")).toHaveText("upstream failure");
	await response.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await displayedText(response));
	await page.request.put(`${app.url}/api/chats/${chat.id}/archive`, {
		data: { archived: true },
	});
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(
		response.getByRole("button", { name: "复制", exact: true }),
	).toBeVisible();
	await expect(response.locator("pre")).toHaveText("upstream failure");
	await response.locator("summary").click();
	await response.locator("summary").click();
	await expect(response.locator("pre")).toHaveText("upstream failure");
});

test("network failures have copyable diagnostics and unavailable saved records are explicit", async ({
	page,
	context,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Network" },
		})
	).json();
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	app.failModel("network");
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "failure" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const response = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^(Response|响应) \d+/ }),
	});
	await response.locator("summary").click();
	await expect(response).toContainText("No response body was received");
	await expect(response).toContainText("network disconnected");
	await response.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await displayedText(response));
	await page.route("**/calls?kind=request&callId=*", (route) =>
		route.fulfill({ json: { calls: [] } }),
	);
	const request = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^(Request|请求) \d+$/ }),
	});
	await request.locator("summary").click();
	await expect(request).toContainText("No communication record is available");
});

test("saved SSE events stay lazy, update while pending, retain cached text on read errors and copy formatted redacted text", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Live records" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
		data: { name: "Other" },
	});
	const frame = (type: string, value: object) =>
		`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
	const prefix =
		frame("response.output_item.added", {
			output_index: 0,
			item: { id: "answer", type: "message", content: [] },
		}) +
		frame("response.output_text.delta", {
			output_index: 0,
			item_id: "answer",
			content_index: 0,
			delta: "early",
		});
	const stream = app.rawStreamModel();
	const submitted = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect live SSE" },
	});
	stream.push(`:\n\n: keepalive\r\n\r\n${prefix}`);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(page.getByRole("log")).toContainText("early");
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().includes("/calls")) reads++;
	});
	const response = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response \d+/ }) });
	await expect(response.locator("pre")).toHaveCount(0);
	expect(reads).toBe(0);
	await response.locator("summary").click();
	await expect(response.locator("pre")).toHaveCount(2);
	await expect(response.locator("pre").last()).toContainText(
		'  "delta": "early"',
	);
	let failReads = true;
	await page.route("**/calls?kind=response&callId=*", (route) =>
		failReads ? route.fulfill({ status: 503 }) : route.continue(),
	);
	const second = frame("response.output_text.delta", {
		output_index: 0,
		item_id: "answer",
		content_index: 0,
		delta: " later",
	});
	stream.push(second);
	await expect(response.getByRole("alert")).toContainText(
		"Unable to read communication",
	);
	await expect(response.locator("pre")).toHaveCount(2);
	failReads = false;
	await response.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(response.locator("pre")).toHaveCount(3);
	await expect(response.locator("pre").last()).toContainText(
		'  "delta": " later"',
	);
	await page.getByLabel("Prompt").fill("next draft");
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeDisabled();
	await response.locator("summary").click();
	await page.getByRole("button", { name: "Other", exact: true }).click();
	const hidden = frame("response.output_text.delta", {
		output_index: 0,
		item_id: "answer",
		content_index: 0,
		delta: " away",
	});
	stream.push(hidden);
	await page
		.getByRole("button", { name: /^Live records(?: \(running\))?$/ })
		.click();
	await response.locator("summary").click();
	await expect(response.locator("pre")).toHaveCount(4);
	await expect(response.locator("pre").last()).toContainText(
		'  "delta": " away"',
	);
	await response.locator("summary").click();
	const unknown =
		'event: vendor.unknown\ndata: {"private":"zkey","payload":{"count":1}}\n\r\n';
	const split = unknown.indexOf("zkey") + 2;
	stream.push(unknown.slice(0, split));
	stream.push(unknown.slice(split));
	const malformed = "event: vendor.raw\r\ndata: not-json\r\n\n";
	const tail = 'data: {"unfinished":';
	stream.push(`: inside stream\n\n${malformed}: before tail\n${tail}`);
	stream.end();
	await submitted;
	await expect(page.getByRole("log")).toContainText("Incomplete answer.");
	await response.locator("summary").click();
	await expect(response.locator("pre")).toHaveCount(7);
	await expect(response.locator("pre").nth(4)).toContainText(
		'  "private": "[REDACTED]"',
	);
	await expect(response.locator("pre").nth(5)).toHaveText(malformed.trimEnd());
	await expect(response.locator("pre").last()).toHaveText(tail);
	const raw =
		prefix +
		second +
		hidden +
		unknown.replace('"zkey"', '"[REDACTED]"') +
		malformed +
		tail;
	await response.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await displayedText(response));
	const history = await (
		await page.request.get(`${app.url}/api/chats/${chat.id}`)
	).json();
	expect(JSON.stringify(history)).not.toMatch(
		/responseBody|requestBody|vendor\.unknown|unfinished/,
	);
	const call = await (
		await page.request.get(
			`${app.url}/api/agents/${history.agents[0].id}/calls?kind=response`,
		)
	).json();
	expect(call.calls[0].responseBody).toBe(raw);
	expect(call.calls[0]).not.toHaveProperty("headers");
	const cachedReads = reads;
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await page
		.getByRole("button", { name: /^Live records(?: \(running\))?$/ })
		.click();
	await expect(response.locator("pre").last()).toBeVisible();
	expect(reads).toBe(cachedReads);
	await page.request.put(`${app.url}/api/chats/${chat.id}/archive`, {
		data: { archived: true },
	});
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(
		page.getByRole("button", { name: "复制", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("log")).not.toContainText('"private": "test"');
});

test("older downloads cannot overwrite newer per-call response and thinking content", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Stale reads" },
		})
	).json();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const intercepted = new Set<string>();
	await page.route(
		/\/api\/agents\/\d+\/(?:calls\?kind=response&callId=\d+|reasoning\?callId=\d+)$/,
		async (route) => {
			const kind = route.request().url().includes("/reasoning?")
				? "reasoning"
				: "response";
			if (intercepted.has(kind)) return route.continue();
			intercepted.add(kind);
			const old = await route.fetch();
			await held;
			await route.fulfill({ response: old });
		},
	);
	const frame = (type: string, value: object) =>
		`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
	const stream = app.rawStreamModel();
	const submitted = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Keep the newest content" },
	});
	stream.push(
		frame("response.output_item.added", {
			output_index: 0,
			item: {
				id: "reason",
				type: "reasoning",
				content: [{ type: "reasoning_text", text: "old" }],
			},
		}),
	);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const response = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response 1/ }) });
	await response.locator("summary").click();
	await expect.poll(() => intercepted.size).toBe(2);
	stream.push(
		frame("response.reasoning_text.delta", {
			output_index: 0,
			item_id: "reason",
			content_index: 0,
			delta: " newest",
		}),
	);
	await expect(page.getByRole("log")).toContainText("old newest");
	await expect(response.locator("pre").last()).toContainText("newest");
	release();
	await expect(page.getByRole("log")).toContainText("old newest");
	stream.push(
		frame("response.completed", {
			response: {
				status: "completed",
				output: [
					{
						id: "reason",
						type: "reasoning",
						content: [{ type: "reasoning_text", text: "old newest final" }],
					},
					{
						id: "answer",
						type: "message",
						content: [{ type: "output_text", text: "done" }],
					},
				],
			},
		}),
	);
	stream.end();
	await submitted;
	await expect(response.locator("pre").last()).toContainText(
		"old newest final",
	);
	await page
		.getByRole("log")
		.getByRole("button", { name: /Thinking/ })
		.click();
	await expect(page.getByRole("log")).toContainText("old newest final");
	await expect(response.locator("summary")).toHaveText("Response 1");
});

test("failure before a model call shows its question and agent error without communications", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "No call" },
		})
	).json();
	// Browser seam: a saved failure without any call metadata or readable output.
	await page.route(`**/api/chats/${chat.id}`, (route) =>
		route.fulfill({
			json: {
				id: chat.id,
				busy: false,
				hasMore: false,
				agents: [{ id: 1, status: "failed", output: [], calls: [] }],
				messages: [
					{ id: "1-user", role: "user", content: "the accepted question" },
					{
						id: "1-assistant",
						role: "assistant",
						content: "",
						status: "failed",
						output: [],
						errorCode: "modelRequestFailed",
						errorDetails: "Execution failed before creating a model call",
					},
				],
			},
		}),
	);
	let reads = 0;
	page.on("request", (request) => {
		if (/\/calls|\/reasoning/.test(request.url())) reads++;
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const log = page.getByRole("log");
	await expect(log).toContainText("the accepted question");
	await expect(log).toContainText(
		"Execution failed before creating a model call",
	);
	await expect(log.locator("details")).toHaveCount(0);
	await expect(log.locator("[data-output-index]")).toHaveCount(0);
	expect(reads).toBe(0);
});

test("comment-only Response has no content blocks and copies received HTTP diagnostics after download", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Comments" },
		})
	).json();
	const stream = app.rawStreamModel();
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "question" },
	});
	stream.push(":\n\n: keepalive\r\n\r\n: trailing");
	stream.end();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(page.getByRole("log")).toContainText(
		"OpenRouter returned an invalid response.",
	);
	const response = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^Response 1/ }),
	});
	await expect(
		response.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	await response.locator("summary").click();
	await expect(response).toContainText("HTTP 200");
	await expect(response.locator("pre")).toHaveCount(0);
	await expect(response).not.toContainText("keepalive");
	await response.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await displayedText(response));
	expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
		"HTTP 200",
	);
});
