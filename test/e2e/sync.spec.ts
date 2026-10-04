import { expect, test } from "./fixtures.ts";

test("two pages share activity, busy and history while keeping selections, folds and drafts; different chats run together", async ({
	page,
	context,
	app,
}) => {
	const project = async (name: string) =>
		(
			await page.request.post(`${app.url}/api/projects`, {
				data: { name, folders: [app.folder] },
			})
		).json();
	const chat = async (projectId: number, name: string) =>
		(
			await page.request.post(`${app.url}/api/projects/${projectId}/chats`, {
				data: { name },
			})
		).json();
	const work = await project("Work");
	const alpha = await chat(work.id, "Alpha");
	await chat(work.id, "Beta");
	const newer = await project("Newer");
	await chat(newer.id, "Gamma");
	await page.goto(`${app.url}/?chat=${alpha.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${alpha.id}`);
	const nav = (p: typeof page) =>
		p.getByRole("navigation", { name: "Projects and chats" });
	const submit = (p: typeof page) =>
		p.getByRole("button", { name: /^Submit(?: \(.+\))?$/ });
	await expect(submit(page)).toBeDisabled();
	await expect(submit(other)).toBeDisabled();
	await expect(nav(page).getByRole("heading").first()).toHaveText("Newer");
	await page
		.getByRole("button", { name: "Collapse Newer", exact: true })
		.click();
	await other.getByLabel("Prompt").fill("other alpha draft");
	const first = app.holdModel();
	await page.getByLabel("Prompt").fill("alpha question");
	await submit(page).click();
	await first.entered;
	for (const p of [page, other]) {
		await expect(submit(p)).toBeDisabled();
		await expect(nav(p).getByRole("heading").first()).toHaveText("Work");
		await expect(
			nav(p)
				.getByRole("button", { name: /^Alpha/ })
				.first(),
		).toHaveText("Alpha");
		await expect(
			nav(p)
				.getByRole("listitem")
				.filter({
					has: p.getByRole("button", { name: "Alpha", exact: true }),
				})
				.getByRole("status", { name: "Working", exact: true }),
		).toBeVisible();
	}
	await expect(
		nav(page).getByRole("button", { name: "Gamma", exact: true }),
	).not.toBeVisible();
	await expect(other.getByLabel("Prompt")).toHaveValue("other alpha draft");
	await other.getByRole("button", { name: "Beta", exact: true }).click();
	await expect(submit(other)).toBeDisabled();
	const second = app.holdModel();
	await other.getByLabel("Prompt").fill("beta question");
	await submit(other).click();
	await second.entered;
	for (const p of [page, other]) {
		await expect(
			nav(p)
				.getByRole("listitem")
				.filter({
					has: p.getByRole("button", { name: "Beta", exact: true }),
				})
				.getByRole("status", { name: "Working", exact: true }),
		).toBeVisible();
		await expect(
			nav(p)
				.getByRole("region", { name: "Project Work", exact: true })
				.getByRole("listitem")
				.first()
				.getByRole("button")
				.first(),
		).toHaveText("Beta");
	}
	await page.getByLabel("Prompt").fill("later alpha draft");
	await other.getByLabel("Prompt").fill("next beta draft");
	second.release();
	await expect(other.getByRole("log")).toContainText("beta question");
	await expect(submit(other)).toBeEnabled();
	await expect(page.getByRole("log")).toContainText("alpha question");
	await expect(page.getByRole("log")).toContainText("Waiting for response");
	await expect(submit(page)).toBeDisabled();
	first.release();
	await expect(page.getByRole("log")).toContainText("alpha question");
	await expect(submit(page)).toBeEnabled();
	await expect(page.getByLabel("Prompt")).toHaveValue("later alpha draft");
	await expect(other.getByRole("log")).not.toContainText("alpha question");
	await other.getByRole("button", { name: "Alpha", exact: true }).click();
	await expect(other.getByRole("log")).toContainText("alpha question");
	await expect(other.getByLabel("Prompt")).toHaveValue("other alpha draft");
	await expect(
		nav(other).getByRole("button", { name: "Beta", exact: true }),
	).toBeVisible();
	// Shared creations must preserve existing selections, drafts and collapsed projects.
	const added = await project("Added");
	await chat(added.id, "Added chat");
	for (const p of [page, other]) {
		await expect(
			p.getByRole("button", { name: "Added chat", exact: true }),
		).toBeVisible();
		await expect(p).toHaveURL(`${app.url}/?chat=${alpha.id}`);
	}
	await expect(page.getByLabel("Prompt")).toHaveValue("later alpha draft");
	await expect(other.getByLabel("Prompt")).toHaveValue("other alpha draft");
	await expect(
		nav(page).getByRole("button", { name: "Gamma", exact: true }),
	).not.toBeVisible();
});

test("empty and unknown selections keep layout; language and missed updates recover after real SSE disconnect", async ({
	page,
	context,
	app,
}) => {
	await page.goto(app.url);
	await expect(page.getByRole("navigation")).toBeEmpty();
	await expect(
		page.getByRole("region", { name: "Chat", exact: true }),
	).toContainText("Create a project using New project");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "Interface language", exact: true }),
	).toHaveValue("en");
	await page
		.getByRole("combobox", { name: "Interface language", exact: true })
		.selectOption("en");
	await expect(
		page.getByRole("combobox", { name: "Interface language", exact: true }),
	).toHaveValue("en");
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=999`);
	await expect(other).toHaveURL(`${app.url}/`);
	await expect(other.getByRole("alert")).toHaveCount(0);
	await other.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		other.getByRole("region", { name: "Chat", exact: true }),
	).toContainText("Create a project using New project");
	await page
		.getByRole("combobox", { name: "Interface language", exact: true })
		.selectOption("en");
	await expect(
		other.getByRole("combobox", { name: "Interface language", exact: true }),
	).toHaveValue("en");
	const connection = page.waitForResponse(
		(response) => response.url() === `${app.url}/api/events`,
	);
	app.disconnectClients();
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await page.request.post(`${app.url}/api/projects`, {
		data: { name: "Missed", folders: [app.folder] },
	});
	await connection;
	for (const p of [page, other]) {
		await expect(
			p.getByRole("heading", { name: "Missed", exact: true }),
		).toBeVisible();
		await expect(
			p.getByRole("combobox", { name: "界面语言", exact: true }),
		).toHaveValue("zh-CN");
		await expect(
			p.getByRole("region", { name: "对话", exact: true }),
		).toContainText("从侧栏选择对话");
	}
	await expect(other).toHaveURL(`${app.url}/`);
});
