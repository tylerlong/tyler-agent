import type { Locator } from "@playwright/test";
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
			data: { prompt: `Question ${i}.\n${"long line\n".repeat(8)}` },
		});
	await page.setViewportSize({ width: 900, height: 600 });
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
	await page.getByRole("button", { name: "Load earlier turns" }).click();
	await expect(page.getByRole("log")).toContainText("Question 6.");
	await expect
		.poll(async () => (await question.boundingBox())?.y)
		.toBeCloseTo(before?.y ?? 0, 0);
	await question.locator("details summary").click();
	await expect(question.locator("pre")).toContainText('"model"');
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
		data: { prompt: "New while away\n".repeat(20) },
	});
	await page.getByRole("button", { name: "Alpha", exact: true }).click();
	await expect(page.getByRole("log")).toContainText("New while away");
	await expect
		.poll(async () => (await scrollState(content)).top)
		.toBeCloseTo(position, 0);
	await expect(prompt).toHaveValue("saved draft");
	await expect(prompt).toBeInViewport();
	await expect(question.locator("details")).toHaveAttribute("open", "");
	await content.hover();
	await page.mouse.wheel(0, 100000);
	await expect
		.poll(async () => (await scrollState(content)).bottom)
		.toBeLessThan(2);
	const oldBottom = (await scrollState(content)).top;
	await page.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(page.getByRole("log")).toBeEmpty();
	await page.request.post(`${app.url}/api/chats/${alpha.id}`, {
		data: { prompt: "Another while away\n".repeat(20) },
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
			data: { prompt: `Question ${i}.\n${"long line\n".repeat(8)}` },
		});
	await page.setViewportSize({ width: 900, height: 600 });
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
		data: { prompt: "From another window\n".repeat(30) },
	});
	await gate.entered;
	try {
		for (const current of [page, other])
			await expect(current.getByRole("log")).toContainText(
				"Waiting for response",
			);
		await expect.poll(async () => (await scrollState(content)).top).toBe(0);
		await expect
			.poll(async () => (await scrollState(otherContent)).bottom)
			.toBeLessThan(2);
	} finally {
		gate.release();
		await pending;
	}
	await expect(page.getByRole("log")).not.toContainText("Waiting for response");
	await expect.poll(async () => (await scrollState(content)).top).toBe(0);
	await expect
		.poll(async () => (await scrollState(otherContent)).bottom)
		.toBeLessThan(2);
	await page.getByLabel("Prompt").fill("My question\n".repeat(20));
	const ownGate = app.holdModel();
	await page.getByRole("button", { name: "Submit", exact: true }).click();
	await ownGate.entered;
	try {
		await expect(page.getByRole("log")).toContainText("My question");
		await expect
			.poll(async () => (await scrollState(content)).bottom)
			.toBeLessThan(2);
		await expect(
			page.getByRole("button", { name: "Submit", exact: true }),
		).toBeDisabled();
		await page
			.getByRole("log")
			.locator("details")
			.last()
			.locator("summary")
			.click();
		await expect(page.getByRole("log").locator("details").last()).toContainText(
			"Waiting for response",
		);
	} finally {
		ownGate.release();
	}
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();
	await expect(page.getByRole("log").locator("details").last()).toContainText(
		"HTTP 200",
	);
	await expect
		.poll(async () => (await scrollState(content)).bottom)
		.toBeLessThan(2);
	await page.setViewportSize({ width: 480, height: 400 });
	await expect(page.getByLabel("Prompt")).toBeInViewport();
	await expect(
		page.getByRole("button", { name: "Submit", exact: true }),
	).toBeInViewport();
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
