import { expect, test } from "./fixtures.ts";

test.use({ viewport: { width: 1280, height: 720 } });

test("project reads distinguish loading and failure before empty home guidance", async ({
	page,
	app,
}) => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let fail = true;
	await page.route("**/api/projects", async (route) => {
		await held;
		if (fail)
			await route.fulfill({ status: 500, json: { code: "requestFailed" } });
		else await route.continue();
	});
	await page.goto(app.url);
	const home = page.getByRole("region", { name: "Chat", exact: true });
	await expect(home.getByText("Loading projects…")).toBeVisible();
	await expect(home.getByText(/Create a project using/)).toHaveCount(0);
	release();
	await expect(home.getByRole("button", { name: "Retry" })).toBeVisible();
	await expect(home.getByText(/Create a project using/)).toHaveCount(0);
	if (process.env.CAPTURE_EMPTY_STATES)
		await page.screenshot({ path: "/tmp/tyler-agent-81-project-error.png" });
	fail = false;
	await home.getByRole("button", { name: "Retry" }).click();
	await expect(home.getByText(/Create a project using/)).toBeVisible();
	await expect(home.getByRole("button", { name: "New chat" })).toHaveCount(0);
	if (process.env.CAPTURE_EMPTY_STATES)
		await page.screenshot({ path: "/tmp/tyler-agent-81-new-database.png" });
});

test("empty Project creation identifies owner, preserves cancellation and archive rules", async ({
	page,
	app,
	request,
}) => {
	const { id } = await (
		await request.post(`${app.url}/api/projects`, {
			data: {
				name: "A long Project name for ownership and readable sidebar wrapping ".repeat(
					2,
				),
				folders: [],
			},
		})
	).json();
	const { id: chatId } = await (
		await request.post(`${app.url}/api/projects/${id}/chats`, {
			data: { name: "Old chat" },
		})
	).json();
	await request.put(`${app.url}/api/chats/${chatId}/archive`, {
		data: { archived: true },
	});
	await page.goto(app.url);
	const project = page.getByRole("region", { name: /^Project A long/ });
	await expect(
		project.getByRole("button", { name: "New chat", exact: true }),
	).toHaveCount(2);
	if (process.env.CAPTURE_EMPTY_STATES)
		await page.screenshot({ path: "/tmp/tyler-agent-81-expanded-empty.png" });
	await project.getByRole("button", { name: /^Collapse/ }).click();
	await expect(
		project.getByRole("button", { name: "New chat", exact: true }),
	).toHaveCount(1);
	await project.getByRole("button", { name: /^Expand/ }).click();
	await project
		.getByRole("button", { name: "New chat", exact: true })
		.last()
		.click();
	const dialog = page.getByRole("dialog", { name: "New chat", exact: true });
	await expect(dialog.getByText(/^Project: A long/)).toBeVisible();
	await dialog.getByLabel("Name").fill("Draft");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await project.getByTitle("New chat", { exact: true }).click();
	await expect(dialog.getByLabel("Name")).toHaveValue("Draft");
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await expect(
		project.getByRole("button", { name: "New chat", exact: true }),
	).toHaveCount(1);
	await expect(
		page.getByText("Ask your first question below to begin this chat."),
	).toBeVisible();
	if (process.env.CAPTURE_EMPTY_STATES)
		await page.screenshot({ path: "/tmp/tyler-agent-81-empty-chat.png" });
	await project.getByRole("button", { name: /^Collapse/ }).click();
	await expect(
		project.getByRole("button", { name: "Draft", exact: true }),
	).toHaveCount(0);
	await request.put(`${app.url}/api/projects/${id}/archive`, {
		data: { archived: true },
	});
	await page.goto(app.url);
	await expect(page.getByText(/Create a project using/)).toBeVisible();
	await page.getByText("Archived", { exact: true }).click();
	await expect(
		project.getByRole("button", { name: "New chat", exact: true }),
	).toHaveCount(0);
	await page.setViewportSize({ width: 1600, height: 1000 });
	if (process.env.CAPTURE_EMPTY_STATES)
		await page.screenshot({ path: "/tmp/tyler-agent-81-archived-home.png" });
});

test("history loading and failure are distinct from empty history and invalid IDs return home", async ({
	page,
	app,
	request,
}) => {
	const { id } = await (
		await request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const { id: chatId } = await (
		await request.post(`${app.url}/api/projects/${id}/chats`, {
			data: { name: "Empty" },
		})
	).json();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let fail = true;
	await page.route(`**/api/chats/${chatId}`, async (route) => {
		await held;
		if (fail)
			await route.fulfill({ status: 500, json: { code: "requestFailed" } });
		else await route.continue();
	});
	await page.goto(`${app.url}/?chat=${chatId}`);
	await expect(page.getByText("Loading chat history…")).toBeVisible();
	await expect(page.getByText(/Ask your first question/)).toHaveCount(0);
	release();
	const home = page.getByRole("region", { name: "Chat", exact: true });
	await expect(home.getByRole("button", { name: "Retry" })).toBeVisible();
	await expect(page.getByText(/Ask your first question/)).toHaveCount(0);
	if (process.env.CAPTURE_EMPTY_STATES)
		await page.screenshot({ path: "/tmp/tyler-agent-81-history-error.png" });
	fail = false;
	await home.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByText(/Ask your first question/)).toBeVisible();
	await page
		.getByRole("textbox", { name: "Prompt", exact: true })
		.fill("A first question");
	await page.getByRole("button", { name: /^Submit(?: \(.+\))?$/ }).click();
	await expect(home.getByText("Test answer", { exact: true })).toBeVisible();
	await expect(page.getByText(/Ask your first question/)).toHaveCount(0);
	await page.goto(`${app.url}/?chat=999999`);
	await expect(page).toHaveURL(`${app.url}/`);
	await expect(page.getByText(/Select a chat from the sidebar/)).toBeVisible();
});

test("home and empty history guidance follow the saved Chinese language", async ({
	page,
	app,
	request,
}) => {
	await request.put(`${app.url}/api/language`, { data: { language: "zh-CN" } });
	await page.goto(app.url);
	await expect(page.getByText("欢迎使用 Tyler Agent")).toBeVisible();
	await expect(page.getByText(/点击侧栏的新建项目创建项目/)).toBeVisible();
	await (
		await request.post(`${app.url}/api/projects`, {
			data: { name: "工作", folders: [] },
		})
	).json();
	await expect(page.getByText(/从侧栏选择对话/)).toBeVisible();
	const project = page.getByRole("region", { name: "项目 工作", exact: true });
	await project
		.getByRole("button", { name: "新建对话", exact: true })
		.last()
		.click();
	const dialog = page.getByRole("dialog", { name: "新建对话", exact: true });
	await expect(dialog.getByText("所属项目：工作")).toBeVisible();
	await dialog.getByRole("button", { name: "创建", exact: true }).click();
	await expect(
		page.getByText("在下方输入第一个问题，开始此对话。"),
	).toBeVisible();
	if (process.env.CAPTURE_EMPTY_STATES)
		await page.screenshot({ path: "/tmp/tyler-agent-81-chinese-empty.png" });
});
