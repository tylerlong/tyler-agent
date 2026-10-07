import { completedBody, frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

const output = [
	{
		id: "r0",
		type: "reasoning",
		content: [
			{ type: "output_text", text: "parent body" },
			{ type: "reasoning_text", text: "second body" },
		],
		summary: [{ type: "summary_text", text: "brief" }],
	},
	{
		id: "m1",
		type: "message",
		content: [
			{ type: "output_text", text: "first answer" },
			{ type: "output_text", text: "second part" },
		],
	},
	{
		id: "r2",
		type: "reasoning",
		summary: [{ type: "summary_text", text: "later summary" }],
	},
	{
		id: "m3",
		type: "message",
		content: [{ type: "refusal", refusal: "later answer" }],
	},
	{
		id: "r4",
		type: "reasoning",
		content: [{ type: "encrypted", text: "ciphertext" }],
	},
];
const initial = output
	.map((item, output_index) =>
		frame("response.output_item.added", { output_index, item }),
	)
	.join("");

test("ordered thinking stays live while pending; manual choices survive updates, completion and chat switches", async ({
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
			data: { name: "Thinking" },
		})
	).json();
	const other = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Other" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const stream = app.rawStreamModel();
	const submitted = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "question" },
	});
	stream.push(initial);
	const log = page.getByRole("log");
	const thinking = log.getByRole("button", { name: /Reasoning/ });
	await expect(thinking).toHaveCount(2);
	await expect(thinking.first()).toHaveAttribute("aria-expanded", "true");
	await expect(log).toContainText("Reasoning: parent body");
	await expect(log).toContainText("Summary: brief");
	await expect(log).toContainText("later summary");
	await expect(log).not.toContainText("ciphertext");
	expect(
		await log
			.locator("[data-output-index]")
			.evaluateAll((elements) =>
				elements.map((element) => element.getAttribute("data-output-index")),
			),
	).toEqual(["0", "1", "2", "3"]);
	await thinking.first().click();
	stream.push(
		frame("response.output_text.delta", {
			output_index: 0,
			content_index: 0,
			item_id: "r0",
			delta: " growing",
		}),
	);
	await expect(thinking.first()).toHaveAttribute("aria-expanded", "false");
	await thinking.first().click();
	await expect(log).toContainText("parent body growing");
	stream.push(
		frame("response.output_item.done", { output_index: 2, item: output[2] }),
	);
	await expect(thinking.nth(1)).toHaveAttribute("aria-expanded", "true");
	await page.getByRole("button", { name: "Other", exact: true }).click();
	stream.push(
		frame("response.output_text.delta", {
			output_index: 0,
			content_index: 0,
			item_id: "r0",
			delta: " away",
		}),
	);
	await page.getByRole("button", { name: "Thinking", exact: true }).click();
	await expect(log).toContainText("parent body growing away");
	const final = structuredClone(output);
	final[0] = {
		...final[0],
		content: [
			{ type: "output_text", text: "parent body growing away" },
			{ type: "reasoning_text", text: "second body" },
		],
	};
	stream.push(completedBody({ output: final }));
	stream.end();
	await submitted;
	await expect(thinking.first()).toHaveAttribute("aria-expanded", "true");
	await expect(thinking.nth(1)).toHaveAttribute("aria-expanded", "false");
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await page.getByRole("button", { name: "Thinking", exact: true }).click();
	await expect(log).toContainText("parent body growing away");
	const reads: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/reasoning?")) reads.push(request.url());
	});
	await page.reload();
	await expect(thinking.first()).toHaveAttribute("aria-expanded", "false");
	await expect(thinking.nth(1)).toHaveAttribute("aria-expanded", "false");
	expect(reads).toHaveLength(0);
	await thinking.first().click();
	await expect(log).toContainText("parent body growing away");
	expect(reads).toHaveLength(1);
	await thinking.first().click();
	await thinking.first().click();
	await expect(log).toContainText("parent body growing away");
	expect(reads).toHaveLength(1);
	expect(other.id).not.toBe(chat.id);
});

test("failed thinking defaults folded and history loads body only after expansion", async ({
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
			data: { name: "Failed thinking" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const stream = app.rawStreamModel();
	const submitted = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "question" },
	});
	stream.push(initial);
	const thinking = page
		.getByRole("log")
		.getByRole("button", { name: /Reasoning/ });
	await expect(page.getByRole("log")).toContainText("parent body");
	stream.end();
	await submitted;
	await expect(thinking.first()).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByRole("log")).toContainText("Incomplete answer.");
	await app.restart();
	const reads: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/reasoning?")) reads.push(request.url());
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(thinking.first()).toHaveAttribute("aria-expanded", "false");
	expect(reads).toHaveLength(0);
	await thinking.first().click();
	await expect(page.getByRole("log")).toContainText("parent body");
	expect(reads).toHaveLength(1);
});

test("thinking reads retry and two pages catch up pending content with independent fold choices", async ({
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
			data: { name: "Live thinking" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${chat.id}`);
	let failed = true;
	await page.route("**/api/agents/*/reasoning?callId=*", async (route) => {
		if (failed) {
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: "{}",
			});
		} else await route.continue();
	});
	const stream = app.rawStreamModel();
	const submitted = page.request
		.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: "question" },
		})
		.catch(() => undefined);
	stream.push(
		frame("response.output_item.added", {
			output_index: 0,
			item: {
				id: "reason",
				type: "reasoning",
				content: [{ type: "reasoning_text", text: "body only" }],
			},
		}),
	);
	await expect(page.getByRole("log")).toContainText(
		"Unable to read reasoning. Please retry.",
	);
	failed = false;
	await page
		.getByRole("log")
		.getByRole("button", { name: "Retry", exact: true })
		.click();
	await expect(page.getByRole("log")).toContainText("body only");
	await expect(other.getByRole("log")).toContainText("body only");
	const firstFold = page
		.getByRole("log")
		.getByRole("button", { name: /Reasoning/ });
	await firstFold.click();
	await expect(
		other.getByRole("log").getByRole("button", { name: /Reasoning/ }),
	).toHaveAttribute("aria-expanded", "true");
	stream.push(
		frame("response.reasoning_text.delta", {
			output_index: 0,
			content_index: 0,
			item_id: "reason",
			delta: " live",
		}),
	);
	await expect(other.getByRole("log")).toContainText("body only live");
	await firstFold.click();
	await expect(page.getByRole("log")).toContainText("body only live");
	await page.unroute("**/api/agents/*/reasoning?callId=*");
	app.disconnectClients();
	stream.push(
		frame("response.reasoning_text.delta", {
			output_index: 0,
			content_index: 0,
			item_id: "reason",
			delta: " catchup",
		}),
	);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await other.evaluate(() =>
		document.dispatchEvent(new Event("visibilitychange")),
	);
	await expect(page.getByRole("log")).toContainText("body only live catchup");
	await expect(other.getByRole("log")).toContainText("body only live catchup");
	stream.push(
		completedBody({
			output: [
				{
					id: "reason",
					type: "reasoning",
					content: [{ type: "reasoning_text", text: "body only live catchup" }],
				},
				{
					id: "answer",
					type: "message",
					content: [{ type: "output_text", text: "done" }],
				},
			],
		}),
	);
	stream.end();
	await submitted.catch(() => undefined);
	await expect(
		other.getByRole("log").getByRole("button", { name: /Reasoning/ }),
	).toHaveAttribute("aria-expanded", "false");
	await expect(firstFold).toHaveAttribute("aria-expanded", "true");
});
