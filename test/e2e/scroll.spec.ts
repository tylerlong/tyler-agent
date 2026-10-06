import type { Locator } from "@playwright/test";
import { frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

async function scrollState(content: Locator) {
	return content.evaluate((el) => ({
		top: el.scrollTop,
		bottom: el.scrollHeight - el.clientHeight - el.scrollTop,
	}));
}

test("composer stays visible while reading, paging and returning to a chat preserve position", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const alpha = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Alpha" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
		data: { name: "Beta" },
	});
	for (let i = 1; i <= 25; i++)
		await page.request.post(`${app.url}/api/chats/${alpha.id}`, {
			data: {
				modelId: "test",
				prompt: `Question ${i}.\n${"long line\n".repeat(8)}`,
			},
		});
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto(`${app.url}/?chat=${alpha.id}`);
	const content = page.getByRole("region", { name: "Chat", exact: true });
	const prompt = page.getByLabel("Prompt");
	await expect(page.getByRole("log")).toContainText("Question 25.");
	await expect
		.poll(async () => (await scrollState(content)).bottom)
		.toBeLessThan(2);
	await expect(prompt).toBeInViewport();
	const composerPosition = await prompt.boundingBox();
	await content.hover();
	await page.mouse.wheel(0, -100000);
	await expect.poll(async () => (await scrollState(content)).top).toBe(0);
	expect(await prompt.boundingBox()).toEqual(composerPosition);
	const question = page
		.getByRole("log")
		.locator(":scope > div")
		.filter({ hasText: "Question 16." })
		.first();
	const before = await question.boundingBox();
	await page.getByRole("button", { name: "Load earlier agents" }).click();
	await expect(page.getByRole("log")).toContainText("Question 6.");
	await expect
		.poll(async () => (await question.boundingBox())?.y)
		.toBeCloseTo(before?.y ?? 0, 0);
	const agentId = (await question.getAttribute("data-message-id"))?.split(
		"-",
	)[0];
	const request = page
		.getByRole("log")
		.locator(`[data-message-id="${agentId}-assistant"] details`)
		.filter({ has: page.locator("summary", { hasText: /^Request 1$/ }) });
	await request.locator("summary").click();
	await expect(request.locator("pre")).toContainText('"model"');
	const afterPaging = (await scrollState(content)).top;
	await content.hover();
	await page.mouse.wheel(0, -200);
	await expect
		.poll(async () => (await scrollState(content)).top)
		.toBeLessThan(afterPaging);
	const position = (await scrollState(content)).top;
	await prompt.fill("saved draft");
	await page.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(page.getByRole("log")).toBeEmpty();
	await page.request.post(`${app.url}/api/chats/${alpha.id}`, {
		data: { modelId: "test", prompt: "New while away\n".repeat(20) },
	});
	await page.getByRole("button", { name: "Alpha", exact: true }).click();
	await expect(page.getByRole("log")).toContainText("New while away");
	await expect
		.poll(async () => (await scrollState(content)).top)
		.toBeCloseTo(position, 0);
	await expect(prompt).toHaveValue("saved draft");
	await expect(prompt).toBeInViewport();
	await expect(request).toHaveAttribute("open", "");
	await content.hover();
	await page.mouse.wheel(0, 100000);
	await expect
		.poll(async () => (await scrollState(content)).bottom)
		.toBeLessThan(2);
	const oldBottom = (await scrollState(content)).top;
	await page.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(page.getByRole("log")).toBeEmpty();
	await page.request.post(`${app.url}/api/chats/${alpha.id}`, {
		data: { modelId: "test", prompt: "Another while away\n".repeat(20) },
	});
	await page.getByRole("button", { name: "Alpha", exact: true }).click();
	await expect(page.getByRole("log")).toContainText("Another while away");
	await expect
		.poll(async () => (await scrollState(content)).top)
		.toBeCloseTo(oldBottom, 0);
	await page.reload();
	await expect(page.getByRole("log")).toContainText("Another while away");
	await expect
		.poll(async () => (await scrollState(content)).bottom)
		.toBeLessThan(2);
});

test("passive updates follow only at bottom and submitting follows pending and expanded responses", async ({
	page,
	app,
	context,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Alpha" },
		})
	).json();
	for (let i = 1; i <= 10; i++)
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: {
				modelId: "test",
				prompt: `Question ${i}.\n${"long line\n".repeat(8)}`,
			},
		});
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${chat.id}`);
	const content = page.getByRole("region", { name: "Chat", exact: true });
	const otherContent = other.getByRole("region", { name: "Chat", exact: true });
	await expect
		.poll(async () => (await scrollState(content)).bottom)
		.toBeLessThan(2);
	await expect
		.poll(async () => (await scrollState(otherContent)).bottom)
		.toBeLessThan(2);
	await page.bringToFront();
	await content.hover();
	await page.mouse.wheel(0, -100000);
	await expect.poll(async () => (await scrollState(content)).top).toBe(0);
	const gate = app.holdModel();
	const pending = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "From another window\n".repeat(30) },
	});
	await gate.entered;
	try {
		for (const current of [page, other])
			await expect(current.getByRole("log")).toContainText("Working");
		await expect.poll(async () => (await scrollState(content)).top).toBe(0);
		await expect
			.poll(async () => (await scrollState(otherContent)).bottom)
			.toBeLessThan(2);
	} finally {
		gate.release();
		await pending;
	}
	await expect(page.getByRole("log")).not.toContainText("Working");
	await expect.poll(async () => (await scrollState(content)).top).toBe(0);
	await expect
		.poll(async () => (await scrollState(otherContent)).bottom)
		.toBeLessThan(2);
	await page.getByLabel("Prompt").fill("My question\n".repeat(20));
	const ownGate = app.holdModel();
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await ownGate.entered;
	try {
		await expect(page.getByRole("log")).toContainText("My question");
		await expect
			.poll(async () => (await scrollState(content)).bottom)
			.toBeLessThan(2);
		await expect(
			page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
		).toBeDisabled();
		await page
			.getByRole("log")
			.locator("details")
			.last()
			.locator("summary")
			.click();
		await expect(
			page
				.getByRole("log")
				.locator("details")
				.last()
				.getByRole("status", { name: "Working…" }),
		).toBeVisible();
	} finally {
		ownGate.release();
	}
	await page.getByLabel("Prompt").fill("local draft");
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeEnabled();
	await expect(page.getByRole("log").locator("details").last()).toContainText(
		"HTTP 200",
	);
	await expect
		.poll(async () => (await scrollState(content)).bottom)
		.toBeLessThan(2);
	await page.setViewportSize({ width: 1280, height: 720 });
	await expect(page.getByLabel("Prompt")).toBeInViewport();
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeInViewport();
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("returning to a previously non-scrollable chat keeps its original position", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const alpha = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Alpha" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
		data: { name: "Beta" },
	});
	await page.goto(`${app.url}/?chat=${alpha.id}`);
	const content = page.getByRole("region", { name: "Chat", exact: true });
	await page.getByLabel("Prompt").fill("local draft");
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeEnabled();
	expect((await scrollState(content)).top).toBe(0);
	await page.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Beta", exact: true }),
	).toBeVisible();
	await page.request.post(`${app.url}/api/chats/${alpha.id}`, {
		data: { modelId: "test", prompt: "Long new content\n".repeat(200) },
	});
	await page.getByRole("button", { name: "Alpha", exact: true }).click();
	await expect(page.getByRole("log")).toContainText("Long new content");
	await expect.poll(async () => (await scrollState(content)).top).toBe(0);
	await expect
		.poll(async () => (await scrollState(content)).bottom)
		.toBeGreaterThan(0);
});

test("growth and folding above an answer in the same agent preserve its reading anchor", async ({
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
			data: { name: "Stream" },
		})
	).json();
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const stream = app.rawStreamModel();
	const submitted = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "question" },
	});
	stream.push(
		frame("response.output_item.added", {
			output_index: 0,
			item: {
				id: "r",
				type: "reasoning",
				content: [{ type: "reasoning_text", text: "thinking\n".repeat(50) }],
			},
		}) +
			frame("response.output_item.added", {
				output_index: 1,
				item: {
					id: "m",
					type: "message",
					content: [{ type: "output_text", text: "answer\n".repeat(100) }],
				},
			}),
	);
	const log = page.getByRole("log");
	await expect(log).toContainText("Reasoning: thinking");
	const content = page.getByRole("region", { name: "Chat", exact: true });
	const answer = log.locator('[data-output-index="1"]');
	await answer.evaluate((element) => {
		const region = element.closest("section");
		if (region) {
			region.scrollTop +=
				element.getBoundingClientRect().top -
				region.getBoundingClientRect().top +
				20;
			region.dispatchEvent(new Event("scroll"));
		}
	});
	await expect
		.poll(async () => (await scrollState(content)).bottom)
		.toBeGreaterThan(100);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
	const before = (await answer.boundingBox())?.y ?? 0;
	stream.push(
		frame("response.reasoning_text.delta", {
			output_index: 0,
			content_index: 0,
			item_id: "r",
			delta: "growing\n".repeat(25),
		}),
	);
	await expect(log).toContainText("growing");
	await expect
		.poll(async () => (await answer.boundingBox())?.y)
		.toBeCloseTo(before, 0);
	// Toggle without scrolling the control into view; the user is reading the answer below it.
	await log
		.getByRole("button", { name: /Thinking/ })
		.evaluate((element: HTMLButtonElement) => element.click());
	await expect
		.poll(async () => (await answer.boundingBox())?.y)
		.toBeCloseTo(before, 0);
	await log
		.getByRole("button", { name: /Thinking/ })
		.evaluate((element: HTMLButtonElement) => element.click());
	await expect
		.poll(async () => (await answer.boundingBox())?.y)
		.toBeCloseTo(before, 0);
	stream.push(
		frame("response.output_text.delta", {
			output_index: 1,
			content_index: 1,
			item_id: "m",
			delta: "later answer part\n".repeat(100),
		}),
	);
	const laterPart = answer.locator(":scope > div").last();
	await expect(laterPart).toContainText("later answer part");
	await laterPart.evaluate((element) => {
		const region = element.closest("section");
		if (region) {
			region.scrollTop +=
				element.getBoundingClientRect().top -
				region.getBoundingClientRect().top +
				20;
			region.dispatchEvent(new Event("scroll"));
		}
	});
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
	const partBefore = (await laterPart.boundingBox())?.y ?? 0;
	stream.push(
		frame("response.output_text.delta", {
			output_index: 1,
			content_index: 0,
			item_id: "m",
			delta: "earlier part grows\n".repeat(25),
		}),
	);
	await expect(answer).toContainText("earlier part grows");
	await expect
		.poll(async () => (await laterPart.boundingBox())?.y)
		.toBeCloseTo(partBefore, 0);
	stream.push(
		frame("unknown.event", {
			lines: Array.from(
				{ length: 100 },
				(_, index) => `recorded line ${index}`,
			),
		}),
	);
	const response = log.locator("details").last();
	await response.locator("summary").click();
	const raw = response.locator("pre").filter({ hasText: "recorded line 99" });
	await expect(raw).toContainText("recorded line 99");
	await raw.evaluate((element) => {
		const region = element.closest("section");
		if (region) {
			region.scrollTop +=
				element.getBoundingClientRect().top -
				region.getBoundingClientRect().top +
				20;
			region.dispatchEvent(new Event("scroll"));
		}
	});
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
	);
	const rawBefore = (await raw.boundingBox())?.y ?? 0;
	stream.push(
		frame("response.reasoning_text.delta", {
			output_index: 0,
			content_index: 0,
			item_id: "r",
			delta: "more growth\n".repeat(25),
		}),
	);
	await expect(log).toContainText("more growth");
	await expect
		.poll(async () => (await raw.boundingBox())?.y)
		.toBeCloseTo(rawBefore, 0);
	await log
		.getByRole("button", { name: /Thinking/ })
		.evaluate((element: HTMLButtonElement) => element.click());
	await expect
		.poll(async () => (await raw.boundingBox())?.y)
		.toBeCloseTo(rawBefore, 0);
	await expect(page.getByLabel("Prompt")).toBeInViewport();
	stream.end();
	await submitted;
});
