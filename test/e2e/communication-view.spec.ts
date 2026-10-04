import { completedBody, frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

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
		frame("vendor.unknown", {
			lines: Array.from({ length: 80 }, (_, i) => `record ${i}`),
			long: "x".repeat(2000),
		}) + frame("vendor.next", { value: 1 }),
	);
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const request = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Request 1/ }) });
	const response = page.locator("details").filter({
		has: page.locator("summary", { hasText: /^(Response|响应) 1/ }),
	});
	await response.locator("summary").click();
	await expect(response.locator("pre")).toHaveCount(2);
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
	const outer = page.getByRole("region", { name: "Chat", exact: true });
	const outerTop = await outer.evaluate((el) => el.scrollTop);
	stream.push(
		frame("vendor.growth", {
			lines: Array.from({ length: 100 }, (_, i) => `later ${i}`),
		}),
	);
	await expect(response.locator("pre")).toHaveCount(3);
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	await expect
		.poll(() => outer.evaluate((el) => el.scrollTop))
		.toBeCloseTo(outerTop, 0);
	await response.locator("summary").click();
	await response.locator("summary").click();
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await page.getByRole("button", { name: /^Viewer(?: \(running\))?$/ }).click();
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	stream.push(completedBody({ status: "completed", output: [] }));
	stream.end();
	await pending;
	await expect(response.locator("pre")).toHaveCount(4);
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
	expect(completeText).toContain("record 0");
	expect(completeText).toContain("later 99");
	expect(completeText).toContain("event: response.completed");
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
	await expect(response.locator("pre")).toHaveCount(4);
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
	await expect(response.locator("pre")).toHaveText(
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
