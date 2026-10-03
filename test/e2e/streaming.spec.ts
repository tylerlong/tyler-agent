import { expect, test } from "./fixtures.ts";

test("two pages show saved answer increments before completion using targeted turn reads", async ({
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
	for (const browserPage of [page, other])
		await expect(
			browserPage.getByRole("button", { name: "Submit", exact: true }),
		).toBeEnabled();
	const stream = app.streamModel();
	await page.getByLabel("Prompt").fill("stream question");
	await page.getByRole("button", { name: "Submit", exact: true }).click();
	await stream.entered;
	for (const browserPage of [page, other]) {
		await expect(browserPage.getByRole("log")).toContainText("Test ");
		await expect(browserPage.getByRole("log")).not.toContainText("Test answer");
		await expect(
			browserPage.getByRole("button", { name: "Submit", exact: true }),
		).toBeDisabled();
	}
	const reads: string[] = [];
	other.on("request", (request) => {
		if (request.method() === "GET") reads.push(new URL(request.url()).pathname);
	});
	stream.release();
	for (const browserPage of [page, other]) {
		await expect(browserPage.getByRole("log")).toContainText("Test answer");
		await expect(
			browserPage.getByRole("button", { name: "Submit", exact: true }),
		).toBeEnabled();
	}
	expect(reads.some((path) => /^\/api\/turns\/\d+$/.test(path))).toBe(true);
	expect(reads).not.toContain("/api/projects");
	expect(reads).not.toContain(`/api/chats/${chat.id}`);
});
