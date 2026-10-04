import { expect, test } from "./fixtures.ts";

test("local literal search highlights complete displayed text, navigates only the body and retains page state", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.setViewportSize({ width: 1280, height: 720 });
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Search" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
		data: { name: "Other" },
	});
	app.failModel(
		"http",
		JSON.stringify({
			first: "İNeedle .* [x]",
			padding: Array.from({ length: 160 }, (_, index) => `line ${index}`),
			last: "needle .* [x]",
		}),
	);
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const response = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^(Response|响应) 1/ }),
	});
	const request = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^(Request|请求) 1/ }) });
	await expect(
		response.getByRole("button", { name: "Search communication" }),
	).toHaveCount(0);
	await expect(response.getByRole("searchbox")).toHaveCount(0);
	await response.locator("summary").click();
	await response.getByRole("button", { name: "Search communication" }).click();
	const input = response.getByRole("searchbox", {
		name: "Search communication",
	});
	const counter = response.getByRole("status", { name: "Search matches" });
	const next = response.getByRole("button", { name: "Next match" });
	await expect(response).toHaveAttribute("open", "");
	await expect(input).toBeFocused();
	await expect(counter).toHaveText("0 / 0");
	await expect(next).toBeDisabled();
	await input.fill("HTTP 500");
	await expect(counter).toHaveText("1 / 1");
	await expect(response.locator("mark")).toHaveText("HTTP 500");
	await input.fill("İ");
	await expect(response.locator("mark")).toHaveText("İ");
	await input.fill('"first": "İNEEDLE .* [x]"');
	await expect(counter).toHaveText("1 / 1");
	await input.fill("needle .* [x]");
	await expect(counter).toHaveText("1 / 2");
	await expect(response.locator("mark")).toHaveText([
		"Needle .* [x]",
		"needle .* [x]",
	]);
	const body = response.locator(".communication-body");
	const outer = page.getByRole("region", { name: "Chat", exact: true });
	const outerTop = await outer.evaluate((el) => el.scrollTop);
	await input.press("Enter");
	await expect(counter).toHaveText("2 / 2");
	await expect
		.poll(() => body.evaluate((el) => el.scrollTop))
		.toBeGreaterThan(0);
	expect(await outer.evaluate((el) => el.scrollTop)).toBe(outerTop);
	const selectedBounds = await response
		.locator('[data-search-match="1"].bg-orange-300')
		.boundingBox();
	const outerBounds = await outer.boundingBox();
	expect(
		(selectedBounds?.y ?? 0) + (selectedBounds?.height ?? 0),
	).toBeLessThanOrEqual((outerBounds?.y ?? 0) + (outerBounds?.height ?? 0) + 1);
	await input.press("Enter");
	await expect(counter).toHaveText("1 / 2");
	await input.press("Shift+Enter");
	await expect(counter).toHaveText("2 / 2");
	expect(await outer.evaluate((el) => el.scrollTop)).toBe(outerTop);
	const top = await body.evaluate((el) => el.scrollTop);
	const original = await response.locator(".communication-text").textContent();
	await response.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(original);
	await input.focus();
	await input.press("Escape");
	await expect(input).toHaveCount(0);
	await expect(response.locator("mark")).toHaveCount(0);
	expect(await body.evaluate((el) => el.scrollTop)).toBe(top);
	await response.getByRole("button", { name: "Search communication" }).click();
	await expect(input).toHaveValue("needle .* [x]");
	expect(await body.evaluate((el) => el.scrollTop)).toBe(top);
	await response.locator("summary").click();
	await expect(
		response.getByRole("button", { name: "Search communication" }),
	).toHaveCount(0);
	await response.locator("summary").click();
	await expect(input).toHaveValue("needle .* [x]");
	expect(await body.evaluate((el) => el.scrollTop)).toBe(top);
	await request.locator("summary").click();
	await request.getByRole("button", { name: "Search communication" }).click();
	await request.getByRole("searchbox").fill("POST");
	await expect(
		request.getByRole("status", { name: "Search matches" }),
	).toHaveText("1 / 1");
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(input).toHaveValue("needle .* [x]");
	await expect(request.getByRole("searchbox")).toHaveValue("POST");
	expect(await body.evaluate((el) => el.scrollTop)).toBe(top);
	await input.fill("needle  .* [x]");
	await expect(counter).toHaveText("0 / 0");
	await expect(next).toBeDisabled();
	await response.getByRole("button", { name: "Close search" }).focus();
	await page.keyboard.press("Escape");
	await expect(input).toHaveCount(0);
	await response.getByRole("button", { name: "Search communication" }).click();
	await input.fill("HTTP 500");
	await expect(counter).toHaveText("1 / 1");
	await response.getByRole("button", { name: "Close search" }).click();
	await expect(input).toHaveCount(0);
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await response.getByRole("button", { name: "搜索通信" }).click();
	await expect(
		response.getByRole("searchbox", { name: "搜索通信" }),
	).toBeFocused();
	await expect(
		response.getByRole("button", { name: "下一个匹配" }),
	).toBeVisible();
	await page.reload();
	await response.locator("summary").click();
	await expect(response.getByRole("searchbox")).toHaveCount(0);
	await response.getByRole("button", { name: "搜索通信" }).click();
	await expect(response.getByRole("searchbox")).toHaveValue("");
	expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
});

test("running search follows saved text without scrolling, stale reads or folded terminal updates losing state", async ({
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
			data: { name: "Live search" },
		})
	).json();
	const stream = app.rawStreamModel();
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Read" },
	});
	const frame = (n: number) =>
		`event: vendor.custom\ndata: ${JSON.stringify({ needle: `123-${n}`, padding: Array.from({ length: 60 }, (_, index) => `line ${index}`) })}\n\n`;
	stream.push(frame(1));
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const response = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^(Response|响应) 1/ }),
	});
	await response.locator("summary").click();
	await response.getByRole("button", { name: "Search communication" }).click();
	const input = response.getByRole("searchbox");
	const counter = response.getByRole("status", { name: "Search matches" });
	await input.fill("123");
	await expect(counter).toHaveText("1 / 1");
	await expect(
		response.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	const body = response.locator(".communication-body");
	await body.evaluate(async (el) => {
		el.scrollTop = 200;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	});
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(200);
	let release!: () => void;
	let intercepted!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const readStarted = new Promise<void>((resolve) => {
		intercepted = resolve;
	});
	let first = true;
	await page.route("**/calls?kind=response&callId=*", async (route) => {
		if (!first) {
			const response = await route.fetch();
			const data = await response.json();
			if (data.calls[0].status !== "pending") data.calls[0].durationMs = 123;
			return route.fulfill({ json: data });
		}
		first = false;
		const old = await route.fetch();
		intercepted();
		await held;
		await route.fulfill({ response: old });
	});
	stream.push(frame(2));
	await readStarted;
	stream.push(frame(3));
	await expect(counter).toHaveText("1 / 3");
	expect(await body.evaluate((el) => el.scrollTop)).toBe(200);
	release();
	await expect(counter).toHaveText("1 / 3");
	await input.press("Enter");
	await expect(counter).toHaveText("2 / 3");
	const selectedTop = await body.evaluate((el) => el.scrollTop);
	await response.locator("summary").click();
	stream.push(frame(4));
	stream.end();
	await pending;
	await expect(
		response.getByRole("button", { name: "Copy", exact: true }),
	).toBeVisible();
	await response.locator("summary").click();
	await expect(counter).toHaveText("3 / 5");
	await expect(
		response.locator('[data-search-match="2"].bg-orange-300'),
	).toHaveText("123");
	await expect(input).toHaveValue("123");
	expect(await body.evaluate((el) => el.scrollTop)).toBe(selectedTop);
	await response.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await response.locator(".communication-text").textContent());
});
