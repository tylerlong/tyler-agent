import { expect, test } from "./fixtures.ts";

test("settings language synchronizes hidden dialogs, survives refresh and restart", async ({
	page,
	context,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "Interface language" }),
	).toHaveValue("en");
	const other = await context.newPage();
	await other.goto(app.url);
	await page
		.getByRole("combobox", { name: "Interface language" })
		.selectOption("zh-CN");
	await expect(
		page.getByRole("heading", { name: "设置", exact: true }),
	).toBeVisible();
	await other.getByRole("button", { name: "设置", exact: true }).click();
	await expect(other.getByRole("combobox", { name: "界面语言" })).toHaveValue(
		"zh-CN",
	);
	await expect(other.locator("html")).toHaveAttribute("lang", "zh-CN");
	await page.reload();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "界面语言" })).toHaveValue(
		"zh-CN",
	);
	await app.restart();
	await page.goto(app.url);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "界面语言" })).toHaveValue(
		"zh-CN",
	);
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	await page.getByRole("button", { name: "新建项目", exact: true }).click();
	await expect(page.getByLabel("名称", { exact: true })).toHaveValue("新项目");
});

test("initial saved language waits for its response and initial failure retries without writing defaults", async ({
	page,
	app,
}) => {
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/language", async (route) => {
		await gate;
		await route.continue();
	});
	await page.goto(app.url);
	await expect(page.getByRole("navigation")).toHaveCount(0);
	await expect(page.getByRole("status")).toHaveText("Loading…");
	release();
	await expect(
		page.getByRole("button", { name: "设置", exact: true }),
	).toBeVisible();
	await page.unroute("**/api/language");
	await page.route("**/api/language", (route) => route.abort());
	await page.reload();
	await expect(page.getByRole("alert")).toHaveText(
		"Unable to read language settings. Please retry.",
	);
	await expect(page.getByRole("navigation")).toHaveCount(0);
	await expect
		.poll(
			async () =>
				(await (await page.request.get(`${app.url}/api/language`)).json())
					.language,
		)
		.toBe("zh-CN");
	await page.unroute("**/api/language");
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "设置", exact: true }),
	).toBeVisible();
});

test("failed and ambiguous language saves reconcile to server and existing errors translate", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Add model", exact: true }).click();
	await expect(
		dialog.getByRole("listbox", { name: "Popular models" }).getByRole("option"),
	).toHaveCount(1);
	await expect(dialog.getByRole("status")).toHaveCount(0);
	await page.route("**/api/language", (route) =>
		route.request().method() === "PUT"
			? route.fulfill({
					status: 500,
					json: { code: "languageWriteFailed", error: "failed" },
				})
			: route.continue(),
	);
	await page
		.getByRole("combobox", { name: "Interface language" })
		.selectOption("zh-CN");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await expect(
		dialog.getByRole("alert").filter({ hasText: "Unable to confirm language" }),
	).toBeVisible();
	await page.unroute("**/api/language");
	await page.route("**/api/language", async (route) => {
		if (route.request().method() === "PUT") {
			await route.fetch();
			await route.abort();
		} else await route.continue();
	});
	await page
		.getByRole("combobox", { name: "Interface language" })
		.selectOption("zh-CN");
	await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
	await page.unroute("**/api/language");
	await page.getByRole("combobox", { name: "界面语言" }).selectOption("en");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("interface text and existing validation errors change language without rewriting creation drafts", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const modal = page.getByRole("dialog", { name: "New project", exact: true });
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue(
		"New project",
	);
	await modal.getByLabel("Name", { exact: true }).fill(" ");
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveText("Name must not be empty.");
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	const chinese = page.getByRole("dialog", { name: "新建项目", exact: true });
	await expect(chinese.getByRole("alert")).toHaveText("名称不得为空");
	await expect(chinese.getByLabel("名称", { exact: true })).toHaveValue(" ");
	await chinese.getByLabel("名称", { exact: true }).fill("unchanged name");
	await chinese.getByRole("button", { name: "创建", exact: true }).click();
	await expect(chinese).toBeHidden();
	await page.getByRole("button", { name: "新建项目", exact: true }).click();
	await expect(chinese.getByLabel("名称", { exact: true })).toHaveValue(
		"新项目",
	);
	await chinese.getByRole("button", { name: "取消", exact: true }).click();
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "en" },
	});
	await page.getByRole("button", { name: "New project", exact: true }).click();
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue("新项目");
});

test("language changes keep stored content, edit and question drafts, raw failures and new chat defaults", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work 原名", folders: [app.folder] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Saved 对话" },
		})
	).json();
	await page.request.post(`${app.url}/api/chats/${chat.id}`, {
		data: { modelId: "test", prompt: "original question" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(page.getByRole("log")).toContainText("original question");
	await page
		.getByRole("textbox", { name: "Prompt", exact: true })
		.fill("question draft 原样");
	await page
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await page.getByRole("button", { name: "Edit project", exact: true }).click();
	const edit = page.getByRole("dialog", { name: "Edit project", exact: true });
	await edit.getByLabel("Name", { exact: true }).fill("edit draft 原样");
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	const zhEdit = page.getByRole("dialog", { name: "编辑项目", exact: true });
	await expect(zhEdit.getByLabel("名称", { exact: true })).toHaveValue(
		"edit draft 原样",
	);
	await expect(
		zhEdit.getByRole("region", { name: "已选文件夹" }),
	).toContainText(app.folder);
	await zhEdit.getByRole("button", { name: "取消", exact: true }).click();
	await expect(
		page.getByRole("textbox", { name: "问题", exact: true }),
	).toHaveValue("question draft 原样");
	await expect(
		page.getByRole("heading", { name: "Saved 对话", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("log", { name: "聊天历史" })).toContainText(
		"original question",
	);
	await expect(page.getByRole("log")).toContainText("Agent: Test answer");
	await page.getByRole("button", { name: "项目操作", exact: true }).click();
	await page.getByRole("button", { name: "编辑项目", exact: true }).click();
	await expect(zhEdit.getByLabel("名称", { exact: true })).toHaveValue(
		"edit draft 原样",
	);
	await zhEdit.getByRole("button", { name: "取消", exact: true }).click();
	await page.getByRole("button", { name: "新建对话", exact: true }).click();
	const fresh = page.getByRole("dialog", { name: "新建对话", exact: true });
	await expect(fresh.getByLabel("名称", { exact: true })).toHaveValue("新对话");
	await fresh.getByRole("button", { name: "取消", exact: true }).click();
	app.failModel();
	await page.getByRole("button", { name: /^提交(?: \(.+\))?$/ }).click();
	await expect(page.getByRole("alert")).toHaveText("OpenRouter 请求失败");
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "en" },
	});
	await expect(page.getByRole("alert")).toHaveText(
		"OpenRouter request failed.",
	);
	await expect(
		page.getByRole("textbox", { name: "Prompt", exact: true }),
	).toHaveValue("question draft 原样");
	await page
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await page.getByRole("button", { name: "Edit project", exact: true }).click();
	await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(
		"Work 原名",
	);
	await edit.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.screenshot({ path: "/tmp/tyler-agent-50-en.png" });
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "界面语言" })).toHaveValue(
		"zh-CN",
	);
	await page.screenshot({ path: "/tmp/tyler-agent-50-zh-settings.png" });
	await page
		.getByRole("dialog", { name: "设置", exact: true })
		.getByRole("button", { name: "关闭", exact: true })
		.click();
	await page.getByRole("button", { name: "项目操作", exact: true }).click();
	await page.screenshot({ path: "/tmp/tyler-agent-50-zh-menu.png" });
});

test("a successful creation uses the language at completion for the next fresh draft", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const modal = page.getByRole("dialog", { name: "New project", exact: true });
	let release!: () => void;
	let enter!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	await page.route("**/api/projects", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		const response = await route.fetch();
		enter();
		await held;
		await route.fulfill({ response });
	});
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await entered;
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(
		page.getByRole("dialog", { name: "新建项目", exact: true }),
	).toBeVisible();
	release();
	await expect(
		page.getByRole("dialog", { name: "新建项目", exact: true }),
	).toBeHidden();
	await page.getByRole("button", { name: "新建项目", exact: true }).click();
	await expect(
		page
			.getByRole("dialog", { name: "新建项目", exact: true })
			.getByLabel("名称", { exact: true }),
	).toHaveValue("新项目");
});

test("directory network errors remain visible and translate while the picker stays open", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	await page.route("**/api/directories", (route) => route.abort());
	await page.getByRole("button", { name: "Add folder", exact: true }).click();
	const picker = page.getByRole("dialog", {
		name: "Select folder",
		exact: true,
	});
	await expect(picker.getByRole("alert")).toContainText(
		"Unable to reach the server. Please retry.",
	);
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	const chinese = page.getByRole("dialog", { name: "选择文件夹", exact: true });
	await expect(chinese.getByRole("alert")).toContainText(
		"无法连接服务器，请重试",
	);
	await expect(
		chinese.getByRole("button", { name: "返回上级", exact: true }),
	).toHaveText("返回上级");
	await expect(
		chinese.getByRole("button", { name: "选择当前文件夹", exact: true }),
	).toBeDisabled();
	await expect(
		chinese.getByRole("button", { name: "重试", exact: true }),
	).toBeVisible();
});
