import { expect, test } from "./fixtures.ts";

test("URL navigation isolates history and drafts; refresh discards drafts and stale reads cannot change selection", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [app.folder] },
		})
	).json();
	const a = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Alpha" },
		})
	).json();
	const b = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Beta" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${a.id}`);
	const prompt = page.getByLabel("Prompt");
	const submit = page.getByRole("button", { name: "Submit", exact: true });
	await expect(submit).toBeEnabled();
	await prompt.fill("alpha question");
	await submit.click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expect(prompt).toHaveValue("");
	await prompt.fill("alpha draft");
	await page.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(page).toHaveURL(`${app.url}/?chat=${b.id}`);
	await expect(prompt).toHaveValue("");
	await prompt.fill("beta draft");
	await page.goBack();
	await expect(prompt).toHaveValue("alpha draft");
	await expect(page.getByRole("log")).toContainText("alpha question");
	await page.goForward();
	await expect(prompt).toHaveValue("beta draft");
	await expect(page.getByRole("log")).toBeEmpty();
	await page.reload();
	await expect(prompt).toHaveValue("");
	await expect(page).toHaveURL(`${app.url}/?chat=${b.id}`);
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const holding = new Promise<void>((resolve) => {
		release = resolve;
	});
	const arrived = new Promise<void>((resolve) => {
		started = resolve;
	});
	await page.route(`**/api/chats/${a.id}`, async (route) => {
		const response = await route.fetch();
		started?.();
		await holding;
		await route.fulfill({ response });
	});
	await page.getByRole("button", { name: "Alpha", exact: true }).click();
	await arrived;
	await expect(submit).toBeDisabled();
	await page.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(submit).toBeEnabled();
	release?.();
	await expect(
		page.getByRole("heading", { name: "Beta", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("log")).toBeEmpty();
});

test("pending submission stays in original chat and does not clear later drafts or other chat", async ({
	page,
	context,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [app.folder] },
		})
	).json();
	const a = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Alpha" },
		})
	).json();
	const _b = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Beta" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${a.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${a.id}`);
	const pending = app.holdModel();
	const submit = page.getByRole("button", { name: "Submit", exact: true });
	await expect(submit).toBeEnabled();
	await page.getByLabel("Prompt").fill("original question");
	await submit.click();
	await pending.entered;
	await expect(
		other.getByRole("button", { name: "Submit", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Alpha (running)", exact: true }),
	).toBeVisible();
	await page.getByLabel("Prompt").fill("later alpha draft");
	await page.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(submit).toBeEnabled();
	await page.getByLabel("Prompt").fill("beta draft");
	pending.release();
	await expect(other.getByRole("log")).toContainText("original question");
	await expect(
		other.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();
	await expect(page.getByRole("log")).toBeEmpty();
	await expect(page.getByLabel("Prompt")).toHaveValue("beta draft");
	await page.getByRole("button", { name: "Alpha", exact: true }).click();
	await expect(page.getByLabel("Prompt")).toHaveValue("later alpha draft");
	await expect(page.getByRole("log")).toContainText("original question");
});

test("a failed request belongs to its chat and successful retry clears the error", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [app.folder] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Retry" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const submit = page.getByRole("button", { name: "Submit", exact: true });
	await expect(submit).toBeEnabled();
	app.failModel();
	await page.getByLabel("Prompt").fill("retry me");
	await submit.click();
	await expect(page.getByRole("alert")).toHaveText(
		"OpenRouter request failed.\nupstream failure",
	);
	await expect(page.getByLabel("Prompt")).toHaveValue("retry me");
	await expect(page.getByRole("log")).toBeEmpty();
	await expect(submit).toBeEnabled();
	await submit.click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expect(page.getByRole("alert")).not.toBeVisible();
});
