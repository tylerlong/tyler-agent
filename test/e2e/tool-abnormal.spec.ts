import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "@playwright/test";
import { completedBody } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

const output = (count = 1) =>
	Array.from({ length: count }, (_, i) => ({
		id: `item-${i}`,
		type: "function_call",
		name: "inspect",
		call_id: `call-${i}`,
		arguments: '{"key":"zkey","path":"/tmp"}',
	}));

test.beforeEach(async ({ context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

async function copySavedContent(page: Page, card: Locator) {
	const copy = card.getByRole("button", { name: "Copy", exact: true });
	await expect(copy).toBeVisible();
	const displayed = await card.locator(".communication-text").textContent();
	expect(displayed).not.toMatch(/zkey|unsaved|never saved/);
	await page.evaluate(() => navigator.clipboard.writeText("before tool Copy"));
	await copy.click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(displayed);
}

test("restart removes running and waiting loading and rereads interrupted history without replay", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "P", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "C" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const model = app.rawStreamModel();
	const held = app.holdTool({
		status: "succeeded",
		result: "never saved zkey",
	});
	await page.getByLabel("Prompt").fill("Run");
	await page.getByRole("button", { name: /^Send/ }).click();
	model.push(completedBody({ status: "completed", output: output(2) }));
	model.end();
	await held.entered;
	await expect(
		page.locator("[data-tool-call-id]").nth(0).getByRole("status"),
	).toHaveCount(1);
	await expect(
		page.locator("[data-tool-call-id]").nth(1).locator("summary"),
	).toContainText("Waiting");
	await app.restart();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const cards = page.locator("[data-tool-call-id]");
	await expect(cards).toHaveCount(2);
	for (const card of await cards.all()) {
		await expect(card).not.toHaveAttribute("open");
		await card.locator("summary").click();
		await expect(card.locator("summary")).toContainText("Interrupted");
		await expect(card).toContainText(
			"Service restarted before this tool completed",
		);
		await expect(card.getByRole("status")).toHaveCount(0);
		await expect(card).toContainText('"key": "[REDACTED]"');
		await expect(card).not.toContainText("never saved");
		await copySavedContent(page, card);
	}
	held.release();
	await page.getByLabel("Prompt").fill("next");
	await expect(page.getByRole("button", { name: /^Send/ })).toBeEnabled();
	await page.reload();
	await expect(cards.nth(0).locator("summary")).toContainText("Interrupted");
	const history = await (
		await page.request.get(`${app.url}/api/chats/${chat.id}`)
	).json();
	expect(history.agents).toHaveLength(1);
	expect(history.agents[0].calls).toHaveLength(1);
});

for (const boundary of ["establish", "start", "result", "terminal"]) {
	test(`tool ${boundary} save failure stops loading with a real save explanation`, async ({
		page,
		app,
	}) => {
		const project = await (
			await page.request.post(`${app.url}/api/projects`, {
				data: { name: "P", folders: [] },
			})
		).json();
		const chat = await (
			await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
				data: { name: "C" },
			})
		).json();
		await page.goto(`${app.url}/?chat=${chat.id}`);
		const db = new DatabaseSync(join(app.folder, "db.sqlite"));
		const condition =
			boundary === "establish"
				? "BEFORE INSERT ON tool_calls"
				: boundary === "start"
					? "BEFORE UPDATE ON tool_calls WHEN NEW.status='running'"
					: boundary === "result"
						? "BEFORE UPDATE OF result ON tool_calls"
						: "BEFORE UPDATE ON tool_calls WHEN NEW.status IN ('succeeded','interrupted')";
		db.exec(
			`CREATE TRIGGER fail_tool ${condition} BEGIN SELECT RAISE(FAIL,'zkey save failed'); END`,
		);
		db.close();
		const model = app.rawStreamModel();
		const held = app.holdTool({
			status: "succeeded",
			result: "unsaved zkey tool result",
		});
		await page.getByLabel("Prompt").fill("Run");
		await page.getByRole("button", { name: /^Send/ }).click();
		model.push(completedBody({ status: "completed", output: output(2) }));
		model.end();
		if (boundary === "result" || boundary === "terminal") {
			await held.entered;
			held.release();
		}
		await expect(page.getByRole("log")).toContainText(
			"Could not save tool execution. No automatic retry.",
		);
		const cards = page.locator("[data-tool-call-id]");
		await expect(cards).toHaveCount(boundary === "establish" ? 0 : 2);
		for (const card of await cards.all()) {
			await expect(card).not.toHaveAttribute("open");
			await card.locator("summary").click();
			await expect(card.locator("summary")).toContainText("Interrupted");
			await expect(card).toContainText("Tool record could not be saved.");
			await expect(card.getByRole("status")).toHaveCount(0);
			await expect(card).not.toContainText("unsaved");
			await expect(card).not.toContainText("zkey");
			await copySavedContent(page, card);
		}
		await page.getByLabel("Prompt").fill("next");
		await expect(page.getByRole("button", { name: /^Send/ })).toBeEnabled();
		const history = await (
			await page.request.get(`${app.url}/api/chats/${chat.id}`)
		).json();
		expect(history.agents[0].calls).toHaveLength(1);
		await page.reload();
		await expect(cards).toHaveCount(boundary === "establish" ? 0 : 2);
		if (boundary !== "establish") {
			await cards.nth(0).locator("summary").click();
			await expect(cards.nth(0)).toContainText(
				"Tool record could not be saved.",
			);
			await copySavedContent(page, cards.nth(0));
		}
	});
}

test("last allowed model response shows localized unexecuted tools without result or loading", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "P", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "C" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	let model = app.rawStreamModel();
	const tools = Array.from({ length: 15 }, () =>
		app.holdTool({ status: "succeeded", result: "" }),
	);
	await page.getByLabel("Prompt").fill("Run");
	await page.getByRole("button", { name: /^Send/ }).click();
	for (let round = 0; round < 16; round++) {
		model.push(completedBody({ status: "completed", output: output() }));
		model.end();
		if (round < 15) {
			await tools[round].entered;
			model = app.rawStreamModel();
			tools[round].release();
		}
	}
	const cards = page.locator("[data-tool-call-id]");
	await expect(cards).toHaveCount(16);
	await expect(cards.nth(15).locator("summary")).toContainText("Not executed");
	await cards.nth(15).locator("summary").click();
	await expect(cards.nth(15)).toContainText("model request limit");
	await expect(cards.nth(15).getByRole("status")).toHaveCount(0);
	await expect(cards.nth(15).locator("pre")).toHaveCount(1);
	await copySavedContent(page, cards.nth(15));
	const history = await (
		await page.request.get(`${app.url}/api/chats/${chat.id}`)
	).json();
	expect(history.agents[0].calls).toHaveLength(16);
	expect(history.agents[0].toolCalls[15].status).toBe("not_executed");
	await page.reload();
	await expect(cards.nth(15).locator("summary")).toContainText("Not executed");
	await cards.nth(15).locator("summary").click();
	await copySavedContent(page, cards.nth(15));
});

test("later model failure leaves a saved successful tool result readable across restart", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "P", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "C" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const model = app.rawStreamModel();
	const held = app.holdTool({
		status: "succeeded",
		result:
			'{"error":"ordinary business field","key":"zkey","nested":[true,null,7]}',
	});
	await page.getByLabel("Prompt").fill("Run");
	await page.getByRole("button", { name: /^Send/ }).click();
	model.push(completedBody({ status: "completed", output: output() }));
	model.end();
	await held.entered;
	app.failModel();
	held.release();
	const card = page.locator("[data-tool-call-id]");
	await expect(card.locator("summary")).toHaveText("Tool Call · inspect");
	await card.locator("summary").click();
	await expect(card).toContainText('"error": "ordinary business field"');
	await expect(card).toContainText('"key": "[REDACTED]"');
	await expect(card.getByRole("status")).toHaveCount(0);
	await expect(page.getByRole("log")).toContainText("OpenRouter");
	const history = await (
		await page.request.get(`${app.url}/api/chats/${chat.id}`)
	).json();
	expect(history.agents[0].status).toBe("failed");
	expect(history.agents[0].toolCalls[0].status).toBe("succeeded");
	await app.restart();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(card.locator("summary")).toHaveText("Tool Call · inspect");
	await card.locator("summary").click();
	await expect(card).toContainText('"error": "ordinary business field"');
	await expect(card).not.toContainText("zkey");
	await copySavedContent(page, card);
});
