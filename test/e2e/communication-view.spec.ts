import { completedBody, frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

test("successful Response hides a provisional cache until its failed final read is retried", async ({
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
			data: { name: "Final read" },
		})
	).json();
	const stream = app.rawStreamModel();
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect" },
	});
	stream.push(
		frame("response.output_text.delta", {
			output_index: 0,
			item_id: "answer",
			content_index: 0,
			delta: Array.from({ length: 100 }, (_, i) => `provisional ${i}`).join(
				"\n",
			),
		}),
	);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const response = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response 1/ }) });
	await response.locator("summary").click();
	await expect(response).toContainText("provisional 99");
	const body = response.locator(".communication-body");
	await body.evaluate((el) => {
		el.scrollTop = 120;
		el.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	let fail = true;
	let release!: () => void;
	const held = new Promise<void>((r) => {
		release = r;
	});
	let entered!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	await page.route("**/calls?kind=response&callId=*", async (route) => {
		if (fail) {
			entered();
			await held;
			await route.fulfill({ status: 503, json: {} });
		} else await route.continue();
	});
	const final = {
		status: "completed",
		id: "final-response-authority",
		output: [
			{
				id: "answer",
				type: "message",
				content: [
					{
						type: "output_text",
						text: Array.from(
							{ length: 100 },
							(_, i) => `actual final ${i}`,
						).join("\n"),
					},
				],
			},
		],
	};
	stream.push(completedBody(final));
	stream.end();
	await started;
	await expect(page.getByRole("log")).toContainText("actual final 99");
	await expect(response).not.toContainText("provisional 99");
	await expect(
		response.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	await expect(response.getByRole("searchbox")).toHaveCount(0);
	release();
	await expect(response.getByRole("alert")).toBeVisible();
	await expect(response).not.toContainText("provisional 99");
	await expect(
		response.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	await expect(response.getByRole("searchbox")).toHaveCount(0);
	await expect(response).toHaveAttribute("open", "");
	fail = false;
	await response.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(response.locator("pre")).toHaveText(
		JSON.stringify(final, null, 2),
	);
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	await response.getByRole("searchbox").fill("final-response-authority");
	await expect(response.locator("mark")).toHaveText("final-response-authority");
	await response.getByRole("button", { name: "Copy", exact: true }).click();
	const displayed = await response.locator(".communication-text").textContent();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(displayed);
});

test("one bounded wrapped viewer preserves internal position through live growth, folds and chat switches", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.setViewportSize({ width: 1280, height: 720 });
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Viewer" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
		data: { name: "Other" },
	});
	const stream = app.rawStreamModel();
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect" },
	});
	stream.push(
		frame("response.output_text.delta", {
			output_index: 0,
			item_id: "answer",
			content_index: 0,
			delta:
				Array.from({ length: 80 }, (_, i) => `record ${i}`).join("\n") +
				"x".repeat(2000),
		}),
	);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const request = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Request 1/ }) });
	const response = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^(Response|响应) 1/ }),
	});
	await response.locator("summary").click();
	await expect(response.locator("pre")).toHaveCount(1);
	const running = response
		.locator("summary")
		.getByRole("status", { name: "Working…" });
	await expect(running).toBeVisible();
	expect(
		await running.evaluate((el) => getComputedStyle(el).animationName),
	).toBe("none");
	await expect(
		response.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	const body = response.locator(".communication-body");
	await expect(body).toHaveCount(1);
	const geometry = await body.evaluate((el) => ({
		height: el.clientHeight,
		scroll: el.scrollHeight,
		width: el.clientWidth,
		scrollWidth: el.scrollWidth,
		preOverflow: Array.from(
			el.querySelectorAll("pre"),
			(pre) => getComputedStyle(pre).overflowY,
		),
	}));
	expect(geometry.height).toBe(360);
	expect(geometry.scroll).toBeGreaterThan(geometry.height);
	expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
	expect(geometry.preOverflow).not.toContain("auto");
	const heading = await response.locator("summary").boundingBox();
	const area = await body.boundingBox();
	expect(heading && area && heading.y + heading.height <= area.y).toBeTruthy();
	await body.evaluate((el) => {
		el.scrollTop = 120;
		el.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	const responseTop = (await response.locator("summary").boundingBox())?.y;
	stream.push(
		frame("response.output_text.delta", {
			output_index: 0,
			item_id: "answer",
			content_index: 0,
			delta: Array.from({ length: 100 }, (_, i) => `later ${i}`).join("\n"),
		}),
	);
	await expect(response).toContainText("later 99");
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	await expect
		.poll(async () => (await response.locator("summary").boundingBox())?.y)
		.toBeCloseTo(responseTop ?? 0, 0);
	await response.locator("summary").click();
	await response.locator("summary").click();
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await page.getByRole("button", { name: /^Viewer(?: \(running\))?$/ }).click();
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	stream.push(
		completedBody({
			id: "final-provider-response",
			status: "completed",
			usage: { output_tokens: 42 },
			output: [
				{
					id: "answer",
					type: "message",
					content: [
						{
							type: "output_text",
							text: Array.from({ length: 100 }, (_, i) => `final ${i}`).join(
								"\n",
							),
						},
					],
				},
			],
		}),
	);
	stream.end();
	await pending;
	await expect(response.locator("pre")).toHaveCount(1);
	await expect(response).toContainText("final-provider-response");
	await expect(response).not.toContainText("record 0");
	const search = response.getByRole("searchbox", {
		name: "Search communication",
	});
	await search.fill("record 0");
	await expect(response.locator("mark")).toHaveCount(0);
	await search.fill("response.output_text.delta");
	await expect(response.locator("mark")).toHaveCount(0);
	await search.fill("final-provider-response");
	await expect(response.locator("mark")).toHaveText("final-provider-response");
	await response
		.locator("summary")
		.getByRole("button", { name: "Copy", exact: true })
		.click();
	const completeText = await response
		.locator(".communication-text")
		.textContent();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(completeText);
	expect(completeText).toContain("final 99");
	expect(completeText).toContain('"output_tokens": 42');
	expect(completeText).not.toContain("response.completed");
	expect(completeText).not.toContain("later 99");
	await search.fill('"output_tokens": 42');
	await expect(response.locator("mark")).toHaveText('"output_tokens": 42');
	await expect(response.locator(".communication-text")).toHaveText(
		completeText ?? "",
	);
	await search.fill("");
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	await page.route("**/calls?kind=request&callId=*", async (route) => {
		const saved = await (await route.fetch()).json();
		saved.calls[0].requestBody = '{"short":true}';
		await route.fulfill({ json: saved });
	});
	await request.locator("summary").click();
	await expect(request.locator("pre")).toHaveText('{\n  "short": true\n}');
	const short = await request
		.locator(".communication-body")
		.evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }));
	expect(short.height).toBeLessThan(360);
	expect(short.scroll).toBeLessThanOrEqual(short.height + 1);
	await page.setViewportSize({ width: 1280, height: 1000 });
	await expect.poll(() => body.evaluate((el) => el.clientHeight)).toBe(400);
	await page.reload();
	await response.locator("summary").click();
	await expect(response.locator("pre")).toHaveCount(1);
	await expect(response).toContainText("final-provider-response");
	await expect(response).not.toContainText("record 0");
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);
});

test("ended unread communications stay lazy during downloads and clipboard feedback is separate from read and call failures", async ({
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
			data: { name: "Copy" },
		})
	).json();
	app.failModel(
		"http",
		JSON.stringify({ error: "diagnostic", private: "zkey" }),
	);
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect failure" },
	});
	let reads = 0;
	page.on("request", (req) => {
		if (req.url().includes("/calls?")) reads++;
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/calls?kind=response&callId=*", async (route) => {
		await held;
		await route.continue();
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const response = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^(Response|响应) 1/ }),
	});
	await expect(response.locator("summary")).toHaveText("Response 1 · Failed");
	await expect(
		response.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	expect(reads).toBe(0);
	await response.locator("summary").click();
	await expect(response).toContainText("Loading");
	await expect(response.locator("summary").getByRole("status")).toHaveCount(0);
	await expect(
		response.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	release();
	await expect(response.locator("pre").last()).toHaveText(
		JSON.stringify({ error: "diagnostic", private: "[REDACTED]" }, null, 2),
	);
	const copy = response
		.locator("summary")
		.getByRole("button", { name: "Copy", exact: true });
	await expect(copy).toHaveAttribute("title", "Copy");
	await copy.focus();
	await page.keyboard.press("Enter");
	await expect(copy).toHaveText("✓");
	const displayed = await response.locator(".communication-text").textContent();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(displayed);
	expect(displayed).toContain("HTTP 500");
	expect(displayed).toContain("[REDACTED]");
	expect(displayed).not.toMatch(/Copy|Retry|Response 1|Loading|zkey/);
	await expect(response).toHaveAttribute("open", "");
	await expect(copy).not.toHaveText("✓");
	await response.locator("summary").click();
	await copy.click();
	await expect(response).not.toHaveAttribute("open", "");
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(displayed);
	await response.locator("summary").click();
	await page.evaluate(() => {
		Object.defineProperty(navigator.clipboard, "writeText", {
			configurable: true,
			value: async () => {
				throw new Error("denied");
			},
		});
	});
	await copy.click();
	await expect(response.getByRole("alert")).toHaveText(
		"Unable to copy. Please retry.",
	);
	await expect(response.locator("summary")).toContainText("Failed");
	await expect(response).not.toContainText("Unable to read communication");
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(response.getByRole("alert")).toHaveText("复制失败，请重试。");
	await expect(
		response
			.locator("summary")
			.getByRole("button", { name: "复制", exact: true }),
	).toHaveAttribute("title", "复制");
	expect(reads).toBe(1);
});
