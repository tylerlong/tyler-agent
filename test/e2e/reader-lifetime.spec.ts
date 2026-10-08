import type { Page } from "@playwright/test";
import { completedBody } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

async function chats(page: Page, url: string) {
	const project = await (
		await page.request.post(`${url}/api/projects`, {
			data: { name: "Readers", folders: [] },
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

const releaseHeldReads: (() => void)[] = [];
test.afterEach(() => {
	for (const release of releaseHeldReads.splice(0)) release();
});

function gate() {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	releaseHeldReads.push(release);
	return { wait, release };
}

async function away(page: Page) {
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await expect(
		page.locator("summary", { hasText: /^Response 1$/ }),
	).toHaveCount(0);
}
async function back(page: Page) {
	await page.getByRole("button", { name: "Reading", exact: true }).click();
}

const responseCard = (page: Page) =>
	page.locator("details").filter({
		has: page.locator("summary", { hasText: /^Response 1$/ }),
	});

test("communication body finishing away fills its page cache", async ({
	page,
	app,
}) => {
	const chat = await chats(page, app.url);
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "question" },
	});
	const held = gate();
	const entered = gate();
	let reads = 0;
	await page.route("**/calls?kind=response&callId=*", async (route) => {
		reads++;
		const data = await (await route.fetch()).json();
		entered.release();
		await held.wait;
		await route.fulfill({ json: data });
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const card = responseCard(page);
	await card.locator("summary").click();
	await entered.wait;
	await away(page);
	const delivered = page.waitForResponse("**/calls?kind=response&callId=*");
	held.release();
	await (await delivered).finished();
	await back(page);
	await expect(card.locator("pre")).toContainText("Test answer");
	await expect(card.getByRole("status")).toHaveCount(0);
	expect(reads).toBe(1);
});

test("communication read errors survive chat navigation until retry", async ({
	page,
	app,
}) => {
	const chat = await chats(page, app.url);
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "question" },
	});
	let reads = 0;
	await page.route("**/calls?kind=response&callId=*", async (route) => {
		reads++;
		if (reads === 1) await route.fulfill({ status: 500 });
		else await route.continue();
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const card = responseCard(page);
	await card.locator("summary").click();
	await expect(card.getByRole("alert")).toContainText(
		"Unable to read communication",
	);
	await card.locator("summary").click();
	await away(page);
	await back(page);
	await expect(card).not.toHaveAttribute("open");
	await expect(card.getByRole("alert", { includeHidden: true })).toContainText(
		"Unable to read communication",
	);
	expect(reads).toBe(1);
	await card.locator("summary").click();
	await expect(card.locator("pre")).toContainText("Test answer");
	await expect(card.getByRole("alert")).toHaveCount(0);
	expect(reads).toBe(2);
});

test("reasoning ignores a body finishing away and resets mounted read errors", async ({
	page,
	app,
}) => {
	const chat = await chats(page, app.url);
	const stream = app.rawStreamModel();
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "question" },
	});
	stream.push(
		completedBody({
			output: [
				{
					id: "reason",
					type: "reasoning",
					content: [
						{ type: "reasoning_text", text: "authoritative reasoning" },
					],
				},
				{
					id: "answer",
					type: "message",
					content: [{ type: "output_text", text: "Test answer" }],
				},
			],
		}),
	);
	stream.end();
	const first = gate();
	const entered = gate();
	const retry = gate();
	let resetError = false;
	let reads = 0;
	await page.route("**/reasoning?callId=*", async (route) => {
		reads++;
		if (reads === 1) {
			const data = await (await route.fetch()).json();
			data.output[0].content[0].text = "stale reasoning";
			entered.release();
			await first.wait;
			await route.fulfill({ json: data });
		} else if (!resetError) await route.fulfill({ status: 500 });
		else {
			await retry.wait;
			await route.continue();
		}
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const log = page.getByRole("log");
	const reasoning = log.getByRole("button", { name: "Reasoning", exact: true });
	await reasoning.click();
	await entered.wait;
	await away(page);
	const delivered = page.waitForResponse("**/reasoning?callId=*");
	first.release();
	await (await delivered).finished();
	await back(page);
	await expect(log.getByRole("alert")).toContainText(
		"Unable to read reasoning",
	);
	await expect(log).not.toContainText("stale reasoning");
	expect(reads).toBeGreaterThan(1);
	const beforeRemount = reads;
	resetError = true;
	await away(page);
	await back(page);
	await expect.poll(() => reads).toBeGreaterThan(beforeRemount);
	await expect(log.getByRole("alert")).toHaveCount(0);
	await expect(log).toContainText("Loading");
	retry.release();
	await expect(log).toContainText("authoritative reasoning");
	await expect(log).not.toContainText("stale reasoning");
});

test("tool bodies finishing away are invalidated, loading clears, and errors survive navigation", async ({
	page,
	app,
}) => {
	const chat = await chats(page, app.url);
	const stream = app.rawStreamModel();
	const tool = app.holdTool({
		status: "succeeded",
		result: "authoritative tool result",
	});
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "Inspect" },
	});
	stream.push(
		completedBody({
			output: [
				{
					id: "tool",
					type: "function_call",
					name: "generic_inspection",
					call_id: "call",
					arguments: "{}",
				},
			],
		}),
	);
	stream.end();
	await tool.entered;
	tool.release();
	const first = gate();
	const entered = gate();
	const second = gate();
	let reads = 0;
	await page.route("**/tools?toolId=*", async (route) => {
		reads++;
		if (reads === 1) {
			const data = await (await route.fetch()).json();
			data.toolCalls[0].result = "stale tool result";
			entered.release();
			await first.wait;
			await route.fulfill({ json: data });
		} else if (reads === 2) {
			await second.wait;
			await route.fulfill({ status: 500 });
		} else await route.continue();
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const card = page.locator("[data-tool-call-id]");
	await card.locator("summary").click();
	await entered.wait;
	await card.locator("summary").click();
	await away(page);
	const delivered = page.waitForResponse("**/tools?toolId=*");
	first.release();
	await (await delivered).finished();
	await back(page);
	await expect(card.getByRole("status", { includeHidden: true })).toHaveCount(
		0,
	);
	await expect(card.locator("pre")).toHaveCount(0);
	expect(reads).toBe(1);
	await card.locator("summary").click();
	await expect.poll(() => reads).toBe(2);
	await expect(card).not.toContainText("stale tool result");
	second.release();
	await expect(card.getByRole("alert")).toContainText(
		"Could not read tool record",
	);
	await card.locator("summary").click();
	await away(page);
	await back(page);
	await expect(card.getByRole("alert", { includeHidden: true })).toContainText(
		"Could not read tool record",
	);
	expect(reads).toBe(2);
	await card.locator("summary").click();
	await expect(card.locator("pre").nth(1)).toHaveText(
		"authoritative tool result",
	);
	await expect(card.getByRole("alert")).toHaveCount(0);
	expect(reads).toBe(3);
});
