import { join } from "node:path";
import type { Page } from "@playwright/test";
import { openDatabase } from "../../src/database.ts";
import { completedBody } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

async function chats(page: Page, url: string) {
	const project = await (
		await page.request.post(`${url}/api/projects`, {
			data: { name: "Tools", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${url}/api/projects/${project.id}/chats`, {
			data: { name: "Reading" },
		})
	).json();
	await page.request.post(`${url}/api/projects/${project.id}/chats`, {
		data: { name: "Other" },
	});
	return chat;
}
function output(args = '{"key":"zkey"}') {
	return [
		{
			id: "tool",
			type: "function_call",
			name: "generic_inspection",
			call_id: "same",
			arguments: args,
		},
	];
}

test("tool reading stays bounded and retained through completion, folds, chat changes, archive and refresh", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.setViewportSize({ width: 1280, height: 720 });
	const chat = await chats(page, app.url);
	const stream = app.rawStreamModel();
	const tool = app.holdTool({
		status: "succeeded",
		result: JSON.stringify({
			error: "business field",
			lines: Array.from({ length: 100 }, (_, i) => `result ${i}`),
			long: "x".repeat(2000),
			private: "zkey",
		}),
	});
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect" },
	});
	stream.push(
		completedBody({
			status: "completed",
			output: output(
				JSON.stringify({
					lines: Array.from({ length: 80 }, (_, i) => `argument ${i}`),
					long: "y".repeat(2000),
				}),
			),
		}),
	);
	stream.end();
	await tool.entered;
	let reads = 0;
	page.on("request", (req) => {
		if (req.url().includes("/tools?")) reads++;
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const card = page.locator("[data-tool-call-id]");
	const body = card.locator(".tool-body");
	await expect(card.locator("pre")).toContainText("argument 79");
	await expect(
		card.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	const geometry = await body.evaluate((el) => ({
		height: el.clientHeight,
		scroll: el.scrollHeight,
		width: el.clientWidth,
		scrollWidth: el.scrollWidth,
	}));
	expect(geometry.height).toBe(360);
	expect(geometry.scroll).toBeGreaterThan(geometry.height);
	expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
	const heading = await card.locator("summary").boundingBox();
	const area = await body.boundingBox();
	expect(heading && area && heading.y + heading.height <= area.y).toBeTruthy();
	await body.evaluate((el) => {
		el.scrollTop = 120;
		el.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	tool.release();
	await pending;
	await expect(card.locator("pre").nth(1)).toContainText("result 99");
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	await expect(card.locator("summary")).toHaveText("generic_inspection");
	const copy = card.getByRole("button", { name: "Copy", exact: true });
	await copy.click();
	const displayed = await card.locator(".communication-text").textContent();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(displayed);
	expect(displayed).toContain('"error": "business field"');
	expect(displayed).toContain("[REDACTED]");
	expect(displayed).not.toMatch(/zkey|Loading|Working|generic_inspection/);
	await card.locator("summary").click();
	await copy.click();
	await expect(card).not.toHaveAttribute("open");
	await expect(copy).toHaveText("✓");
	const beforeSwitch = reads;
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await page.getByRole("button", { name: "Reading", exact: true }).click();
	await expect(card).not.toHaveAttribute("open");
	await expect(copy).toBeVisible();
	await card.locator("summary").click();
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(120);
	expect(reads).toBe(beforeSwitch);
	await page.request.post(`${app.url}/api/chats/${chat.id}/archive`);
	await expect(card.locator("pre").nth(1)).toContainText("result 99");
	await page.setViewportSize({ width: 1280, height: 1000 });
	await expect.poll(() => body.evaluate((el) => el.clientHeight)).toBe(400);
	await card.locator("summary").click();
	await page.reload();
	await expect(card).toHaveAttribute("open", "");
	await expect(card.locator("pre").nth(1)).toContainText("result 99");
	await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);
	expect(reads).toBeGreaterThan(beforeSwitch);
});

test("all terminal kinds copy complete generic display including absent and empty results and reasons", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const chat = await chats(page, app.url);
	const stream = app.rawStreamModel();
	const tool = app.holdTool({ status: "succeeded", result: "" });
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect" },
	});
	stream.push(completedBody({ status: "completed", output: output() }));
	stream.end();
	await tool.entered;
	tool.release();
	await pending;
	const db = openDatabase(join(app.folder, "db.sqlite"), false);
	const saved = db.prepare("SELECT * FROM tool_calls").get();
	if (!saved) throw new Error("Missing call");
	for (const [index, status, result, reason] of [
		[1, "failed", "{invalid JSON\nactual error", null],
		[2, "not_executed", null, "modelCallLimit"],
		[3, "interrupted", null, "toolSaveFailed"],
	] as const)
		db.prepare(
			"INSERT INTO tool_calls(turn_id,model_call_id,call_id,name,arguments,ordinal,status,result,reason) VALUES(?,?,?,?,?,?,?,?,?)",
		).run(
			saved.turn_id,
			saved.model_call_id,
			"same",
			`arbitrary_${index}`,
			'{"nested":{"all":[false,null]},"number":9007199254740993,"duplicate":1,"duplicate":2}',
			index + 1,
			status,
			result,
			reason,
		);
	db.close();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const cards = page.locator("[data-tool-call-id]");
	await expect(cards).toHaveCount(4);
	for (const [index, label] of [
		"generic_inspection",
		"arbitrary_1 · Failed",
		"arbitrary_2 · Not executed",
		"arbitrary_3 · Interrupted",
	].entries()) {
		const card = cards.nth(index);
		await expect(
			card.getByRole("button", { name: "Copy", exact: true }),
		).toBeVisible();
		await expect(card.locator("summary")).toHaveText(label);
		await card.getByRole("button", { name: "Copy", exact: true }).click();
		const displayed = await card.locator(".communication-text").textContent();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toBe(displayed);
		if (index > 0) {
			expect(displayed).toContain("9007199254740993");
			expect(displayed).toContain('"duplicate": 1');
			expect(displayed).toContain('"duplicate": 2');
		}
		const short = await card
			.locator(".tool-body")
			.evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }));
		expect(short.height).toBeLessThan(360);
		expect(short.scroll).toBeLessThanOrEqual(short.height + 1);
	}
	await expect(cards.nth(0).locator("pre").nth(1)).toHaveText("");
	await expect(cards.nth(2).locator("pre")).toHaveCount(1);
	await expect(cards.nth(3)).toContainText("Tool record could not be saved");
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(cards.nth(3).locator("summary")).toHaveText(
		"arbitrary_3 · 执行中断",
	);
	await cards.nth(3).getByRole("button", { name: "复制", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await cards.nth(3).locator(".communication-text").textContent());
});

test("failed refresh retains downloaded text and retries reading without executing; Copy feedback stays separate", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const chat = await chats(page, app.url);
	const stream = app.rawStreamModel();
	const tool = app.holdTool({
		status: "succeeded",
		result: "raw text\nall fields",
	});
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect" },
	});
	stream.push(completedBody({ status: "completed", output: output() }));
	stream.end();
	await tool.entered;
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const card = page.locator("[data-tool-call-id]");
	await expect(card.locator("pre")).toContainText("[REDACTED]");
	let reads = 0;
	await page.route("**/tools?toolId=*", async (route) => {
		reads++;
		if (reads === 1) await route.fulfill({ status: 500 });
		else await route.continue();
	});
	tool.release();
	await pending;
	await expect(card.getByRole("alert")).toContainText(
		"Could not read tool record",
	);
	await expect(card.locator("pre")).toContainText("[REDACTED]");
	await expect(
		card.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	await expect(card.locator("summary").getByRole("status")).toHaveCount(0);
	await card.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(card.locator("pre").nth(1)).toHaveText("raw text\nall fields");
	const copy = card.getByRole("button", { name: "Copy", exact: true });
	await page.evaluate(() => {
		Object.defineProperty(navigator.clipboard, "writeText", {
			configurable: true,
			value: async () => {
				throw new Error("denied");
			},
		});
	});
	await copy.click();
	await expect(card.getByRole("alert")).toHaveText(
		"Unable to copy. Please retry.",
	);
	await page.evaluate(() => {
		delete (navigator.clipboard as Partial<Clipboard>).writeText;
	});
	await copy.focus();
	await page.keyboard.press("Enter");
	await expect(copy).toHaveText("✓");
	await expect(card.getByRole("alert")).toHaveCount(0);
	expect(reads).toBe(2);
});

test("unread and stale downloads cannot enable Copy or replace newer terminal data", async ({
	page,
	app,
}) => {
	const chat = await chats(page, app.url);
	const stream = app.rawStreamModel();
	const tool = app.holdTool({
		status: "succeeded",
		result: "new terminal result",
	});
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect" },
	});
	stream.push(completedBody({ status: "completed", output: output() }));
	stream.end();
	await tool.entered;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	let reads = 0;
	await page.route("**/tools?toolId=*", async (route) => {
		reads++;
		if (reads === 1) {
			const data = await (await route.fetch()).json();
			enter();
			await held;
			await route.fulfill({ json: data });
		} else await route.continue();
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await entered;
	const card = page.locator("[data-tool-call-id]");
	await expect(
		card.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	await card.locator("summary").click();
	await expect(card).not.toHaveAttribute("open");
	const initialReads = reads;
	tool.release();
	await pending;
	// Collapsed unread cards stay lazy, and the stale running read is invalidated.
	await expect(card.locator("summary")).toHaveText("generic_inspection");
	await expect(
		card.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	await card.locator("summary").click();
	await expect(card.locator("pre").nth(1)).toHaveText("new terminal result");
	await expect(
		card.getByRole("button", { name: "Copy", exact: true }),
	).toBeVisible();
	release();
	await expect(card.locator("pre").nth(1)).toHaveText("new terminal result");
	expect(reads).toBe(initialReads + 1);
});

test("two pages reconnect to stable tool identities while each call retains independent cached reading", async ({
	page,
	context,
	app,
}) => {
	const chat = await chats(page, app.url);
	const stream = app.rawStreamModel();
	const first = app.holdTool({ status: "succeeded", result: "first result" });
	const second = app.holdTool({ status: "succeeded", result: "second result" });
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect twice" },
	});
	const calls = [0, 1].map((index) => ({
		...output(
			JSON.stringify({
				index,
				lines: Array.from({ length: 80 }, (_, i) => `call ${index} line ${i}`),
			}),
		)[0],
		id: `tool-${index}`,
		call_id: `call-${index}`,
	}));
	stream.push(completedBody({ status: "completed", output: calls }));
	stream.end();
	await first.entered;
	const other = await context.newPage();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await other.goto(`${app.url}/?chat=${chat.id}`);
	const cards = page.locator("[data-tool-call-id]");
	const otherCards = other.locator("[data-tool-call-id]");
	await expect(cards).toHaveCount(2);
	await expect(otherCards).toHaveCount(2);
	await expect(cards.nth(0).locator("pre")).toContainText("call 0 line 79");
	await expect(cards.nth(1).locator("pre")).toContainText("call 1 line 79");
	const ids = await cards.evaluateAll((elements) =>
		elements.map((el) => el.getAttribute("data-tool-call-id")),
	);
	expect(
		await otherCards.evaluateAll((elements) =>
			elements.map((el) => el.getAttribute("data-tool-call-id")),
		),
	).toEqual(ids);
	for (const [index, top] of [90, 180].entries())
		await cards
			.nth(index)
			.locator(".tool-body")
			.evaluate((el, value) => {
				el.scrollTop = value;
				el.dispatchEvent(new Event("scroll", { bubbles: true }));
			}, top);
	await cards.nth(1).locator("summary").click();
	await expect(cards.nth(1)).not.toHaveAttribute("open");
	await otherCards.nth(0).locator("summary").click();
	app.disconnectClients();
	first.release();
	await second.entered;
	second.release();
	await pending;
	for (const view of [cards, otherCards]) {
		await expect(
			view.nth(0).getByRole("button", { name: "Copy", exact: true }),
		).toBeVisible();
		await expect(
			view.nth(1).getByRole("button", { name: "Copy", exact: true }),
		).toBeVisible();
		await expect(view.nth(0).locator("summary")).toHaveText(
			"generic_inspection",
		);
		await expect(view.nth(1).locator("summary")).toHaveText(
			"generic_inspection",
		);
		await expect(view.nth(0).locator("pre").nth(1)).toHaveText("first result");
		await expect(view.nth(1).locator("pre").nth(1)).toHaveText("second result");
	}
	await expect(cards.nth(1)).not.toHaveAttribute("open");
	await expect(otherCards.nth(0)).not.toHaveAttribute("open");
	await expect(otherCards.nth(1)).toHaveAttribute("open", "");
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await page.getByRole("button", { name: "Reading", exact: true }).click();
	await expect(cards.nth(1)).not.toHaveAttribute("open");
	await expect
		.poll(() =>
			cards
				.nth(0)
				.locator(".tool-body")
				.evaluate((el) => el.scrollTop),
		)
		.toBe(90);
	await cards.nth(1).locator("summary").click();
	await expect
		.poll(() =>
			cards
				.nth(1)
				.locator(".tool-body")
				.evaluate((el) => el.scrollTop),
		)
		.toBe(180);
	expect(
		await cards.evaluateAll((elements) =>
			elements.map((el) => el.getAttribute("data-tool-call-id")),
		),
	).toEqual(ids);
	await other.close();
});
