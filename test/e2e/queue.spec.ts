import { expect, test } from "./fixtures.ts";

test("busy composer queues input; refresh, remove, Stop and continue use pending queue", async ({
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
			data: { name: "Submission queue" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const prompt = page.getByLabel("Prompt", { exact: true });
	const held = app.holdModel();
	try {
		await prompt.fill("Running A");
		await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
		await held.entered;
		await prompt.fill("Queued B");
		await page.getByRole("button", { name: /^Queue(?: \(.+\))?$/ }).click();
		const queue = page.getByRole("region", { name: "Pending queue" });
		await expect(queue).toContainText("Queued B");
		await expect(prompt).toHaveValue("");
		await prompt.fill("Remove C");
		await page.getByRole("button", { name: /^Queue(?: \(.+\))?$/ }).click();
		await expect(queue.getByRole("listitem")).toHaveCount(2);
		await page.reload();
		await expect(queue).toContainText("Queued B");
		await queue
			.getByRole("listitem")
			.filter({ hasText: "Remove C" })
			.getByRole("button", { name: "Remove queued message" })
			.click();
		await expect(queue.getByRole("listitem")).toHaveCount(1);
		await page.getByRole("button", { name: "Stop", exact: true }).click();
		held.release();
		await expect(
			queue.getByRole("button", { name: "Continue queue" }),
		).toBeEnabled();
		await page.request.put(`${app.url}/api/chats/${chat.id}/archive`, {
			data: { archived: true },
		});
		await expect(prompt).toHaveCount(0);
		await expect(queue).toContainText("Queued B");
		await expect(
			queue.getByRole("button", { name: "Remove queued message" }),
		).toBeDisabled();
		await expect(
			queue.getByRole("button", { name: "Continue queue" }),
		).toHaveCount(0);
		await page.request.put(`${app.url}/api/chats/${chat.id}/archive`, {
			data: { archived: false },
		});
		await expect(prompt).toBeVisible();
		await queue.getByRole("button", { name: "Continue queue" }).click();
		await expect(page.getByRole("log")).toContainText("Queued B");
		await expect(queue).toHaveCount(0);
		await expect(page.getByRole("log")).toContainText("Test answer");
	} finally {
		held.release();
	}
});

test("lost queue acknowledgement is reconciled by identity without another POST", async ({
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
			data: { name: "Submission queue" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const prompt = page.getByLabel("Prompt", { exact: true });
	const held = app.holdModel();
	try {
		await prompt.fill("Running");
		await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
		await held.entered;
		let posts = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route(`**/api/chats/${chat.id}`, async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			posts++;
			await route.fetch();
			await route.abort("connectionfailed");
		});
		await page.route(`**/api/chats/${chat.id}/submissions/*`, async (route) => {
			await gate;
			await route.continue();
		});
		await prompt.fill("Accepted once");
		await page.getByRole("button", { name: /^Queue(?: \(.+\))?$/ }).click();
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(prompt).toHaveValue("Accepted once");
		await expect(
			page.locator("button[type=submit][aria-label]"),
		).toBeDisabled();
		await prompt.evaluate((input: HTMLTextAreaElement) =>
			input.form?.requestSubmit(),
		);
		expect(posts).toBe(1);
		release();
		await expect(prompt).toHaveValue("");
		await expect(
			page.getByRole("region", { name: "Pending queue" }).getByRole("listitem"),
		).toHaveCount(1);
		expect(posts).toBe(1);
		await page.getByRole("button", { name: "Stop", exact: true }).click();
		held.release();
		await expect(
			page.getByRole("button", { name: "Continue queue" }),
		).toBeEnabled();
		await app.restart();
		await page.goto(`${app.url}/?chat=${chat.id}`);
		await expect(page.getByRole("log")).toContainText("Running");
		await expect(
			page.getByRole("region", { name: "Pending queue" }),
		).toHaveCount(0);
	} finally {
		held.release();
	}
});
