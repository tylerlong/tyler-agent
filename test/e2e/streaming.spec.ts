import { expect, test } from "./fixtures.ts";

test("two pages show saved answer increments before completion using targeted agent reads", async ({
	page,
	context,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [app.folder] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Stream" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${chat.id}`);
	for (const browserPage of [page, other]) {
		await browserPage.getByLabel("Prompt").fill("next local draft");
		await expect(
			browserPage.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
		).toBeEnabled();
	}
	const stream = app.streamModel();
	await page.getByLabel("Prompt").fill("stream question");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await stream.entered;
	for (const browserPage of [page, other]) {
		await expect(browserPage.getByRole("log")).toContainText("Test ");
		await expect(browserPage.getByRole("log")).not.toContainText("Test answer");
		await expect(
			browserPage.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
		).toBeDisabled();
	}
	const reads: string[] = [];
	other.on("request", (request) => {
		if (request.method() === "GET") reads.push(new URL(request.url()).pathname);
	});
	await page.getByLabel("Prompt").fill("edited next draft");
	stream.release();
	for (const browserPage of [page, other]) {
		await expect(browserPage.getByRole("log")).toContainText("Test answer");
		await expect(
			browserPage.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
		).toBeEnabled();
	}
	expect(reads.some((path) => /^\/api\/agents\/\d+$/.test(path))).toBe(true);
	expect(reads).not.toContain("/api/projects");
	expect(reads).not.toContain(`/api/chats/${chat.id}`);
	const closingStream = app.streamModel();
	await page.getByLabel("Prompt").fill("continue after closing this page");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await closingStream.entered;
	await expect(other.getByRole("log")).toContainText(
		"continue after closing this page",
	);
	await expect(
		other.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeDisabled();
	await page.close();
	closingStream.release();
	await expect(
		other.getByRole("log").getByText("Test answer", { exact: true }),
	).toHaveCount(2);
	await expect(
		other.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeEnabled();
});

test("a live agent arriving before initial history preserves load-earlier pagination", async ({
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
			data: { name: "History race" },
		})
	).json();
	for (let index = 1; index <= 11; index++)
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: `old question ${index}` },
		});
	let releaseHistory!: () => void;
	let historyStarted!: () => void;
	const held = new Promise<void>((resolve) => {
		releaseHistory = resolve;
	});
	const started = new Promise<void>((resolve) => {
		historyStarted = resolve;
	});
	await page.route(`**/api/chats/${chat.id}`, async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		const response = await route.fetch();
		historyStarted();
		await held;
		await route.fulfill({ response });
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await started;
	const stream = app.streamModel();
	const submitted = page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "live question" },
	});
	await stream.entered;
	await expect(page.getByRole("log")).toContainText("live question");
	await expect(page.getByRole("log")).toContainText("Test ");
	releaseHistory();
	const earlier = page.getByRole("button", {
		name: "Load earlier agents",
		exact: true,
	});
	await expect(earlier).toBeVisible();
	await expect(page.locator('[data-message-id="1-user"]')).toHaveCount(0);
	await earlier.click();
	await expect(page.getByRole("log")).toContainText("old question 1");
	await expect(earlier).not.toBeVisible();
	stream.release();
	await submitted;
});

test("restart retains partial answers and labels them incomplete", async ({
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
			data: { name: "Interrupted" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await page.getByLabel("Prompt").fill("draft");
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeEnabled();
	const stream = app.streamModel();
	const submitted = page.request
		.post(`${app.url}/api/chats/${chat.id}`, {
			data: { modelId: "test", prompt: "partial question" },
		})
		.catch(() => undefined);
	await stream.entered;
	await expect(page.getByRole("log")).toContainText("Test ");
	await app.restart();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await page.getByLabel("Prompt").fill("draft");
	await expect(page.getByRole("log")).toContainText("Test ");
	await expect(page.getByRole("log")).toContainText("Incomplete answer.");
	await page.getByLabel("Prompt").fill("new draft");
	await expect(
		page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
	).toBeEnabled();
	stream.release();
	await submitted;
});
