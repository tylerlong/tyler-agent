import { expect, test } from "./fixtures.ts";

test("Archived groups independent states, preserves selection and syncs read-only during an answer", async ({
	page,
	context,
	app,
}) => {
	const p = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const a = await (
		await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
			data: { name: "A" },
		})
	).json();
	await (
		await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
			data: { name: "B" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${a.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${a.id}`);
	const archive = page.getByRole("group", { name: "Archived", exact: true });
	await expect(page.getByText("Archived", { exact: true })).toBeVisible();
	const hold = app.holdModel();
	await page
		.getByRole("textbox", { name: "Prompt", exact: true })
		.fill("Question");
	await page.getByRole("button", { name: "提交", exact: true }).click();
	await hold.entered;
	try {
		const work = page
			.getByRole("region", { name: "Project Work", exact: true })
			.first();
		await work
			.getByRole("button", { name: "Chat A 操作", exact: true })
			.click();
		await work.getByRole("button", { name: "归档 chat", exact: true }).click();
		await expect(other.getByRole("status")).toHaveText(
			"Chat 已归档，只读。恢复 chat 后可继续使用。",
		);
		await expect(
			other.getByRole("button", { name: "提交", exact: true }),
		).toBeDisabled();
		await expect(
			page.getByRole("heading", { name: "A", exact: true }),
		).toBeVisible();
		await expect(
			archive.getByRole("region", { name: "Project Work", exact: true }),
		).toBeHidden();
		await page.getByText("Archived", { exact: true }).click();
		await expect(
			archive
				.getByRole("region", { name: "Project Work", exact: true })
				.getByRole("button", { name: /^A/ }),
		).toBeVisible();
		await work
			.getByRole("button", { name: "Project 操作", exact: true })
			.click();
		await work
			.getByRole("button", { name: "归档 project", exact: true })
			.click();
		await expect(
			archive.getByText("（项目已归档）", { exact: true }),
		).toBeVisible();
		await expect(other.getByRole("status")).toHaveText(
			"Project 和 Chat 已归档，只读。恢复两者后可继续使用。",
		);
		await expect(
			archive.getByRole("button", { name: "B", exact: true }),
		).toBeVisible();
		const group = archive.getByRole("region", {
			name: "Project Work",
			exact: true,
		});
		await group
			.getByRole("button", { name: "Chat A 操作", exact: true })
			.click();
		await group.getByRole("button", { name: "恢复 chat", exact: true }).click();
		await expect(other.getByRole("status")).toHaveText(
			"Project 已归档，Chat 只读。恢复 project 后可继续使用。",
		);
		hold.release();
		await expect(other.getByRole("log")).toContainText("Test answer");
		await expect(
			other.getByRole("textbox", { name: "Prompt", exact: true }),
		).toHaveValue("");
		await group
			.getByRole("button", { name: "Project 操作", exact: true })
			.click();
		await group
			.getByRole("button", { name: "恢复 project", exact: true })
			.click();
		await expect(
			other.getByRole("button", { name: "提交", exact: true }),
		).toBeEnabled();
		await expect(
			page
				.getByRole("region", { name: "Project Work", exact: true })
				.getByRole("button", { name: "B", exact: true }),
		).toBeVisible();
		await page.reload();
		await expect(archive.getByRole("region")).toBeHidden();
	} finally {
		hold.release();
	}
});

test("archiving preserves edit drafts, shows failures and keeps activity order and local collapse", async ({
	page,
	context,
	app,
}) => {
	const create = async (name: string) =>
		await (
			await page.request.post(`${app.url}/api/projects`, {
				data: { name, folders: [] },
			})
		).json();
	const work = await create("Work");
	const newer = await create("Newer");
	const c = await (
		await page.request.post(`${app.url}/api/projects/${work.id}/chats`, {
			data: { name: "Chat" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${c.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${c.id}`);
	await page
		.getByRole("textbox", { name: "Prompt", exact: true })
		.fill("draft");
	const normal = page.getByRole("navigation", {
		name: "Projects and chats",
		exact: true,
	});
	await expect(normal.getByRole("heading")).toHaveText(["Work", "Newer"]);
	const section = normal.getByRole("region", {
		name: "Project Work",
		exact: true,
	});
	await section
		.getByRole("button", { name: "Project 操作", exact: true })
		.click();
	await section
		.getByRole("button", { name: "编辑 project", exact: true })
		.click();
	const modal = page.getByRole("dialog", { name: "编辑 project", exact: true });
	await modal.getByLabel("名称", { exact: true }).fill("local edit");
	await other.request.put(`${app.url}/api/projects/${work.id}/archive`, {
		data: { archived: true },
	});
	await expect(modal.getByLabel("名称", { exact: true })).toBeDisabled();
	await expect(modal.getByLabel("名称", { exact: true })).toHaveValue(
		"local edit",
	);
	await modal.getByRole("button", { name: "取消", exact: true }).click();
	await expect(
		page.getByRole("textbox", { name: "Prompt", exact: true }),
	).toHaveValue("draft");
	await expect(
		page.getByRole("textbox", { name: "Prompt", exact: true }),
	).not.toBeEditable();
	await page.getByText("Archived", { exact: true }).click();
	const archived = page.getByRole("group", { name: "Archived", exact: true });
	await expect(
		archived.getByRole("region", { name: "Project Work", exact: true }),
	).toBeVisible();
	await expect(
		other
			.getByRole("group", { name: "Archived", exact: true })
			.getByRole("region"),
	).toBeHidden();
	const savedOrder = (
		await (await page.request.get(`${app.url}/api/projects`)).json()
	).projects.map((p: { id: number }) => p.id);
	let fail = true;
	await page.route(`**/api/projects/${work.id}/archive`, async (route) => {
		if (fail) {
			fail = false;
			await route.fulfill({ status: 500, json: { error: "Restore failed" } });
		} else await route.continue();
	});
	const group = archived.getByRole("region", {
		name: "Project Work",
		exact: true,
	});
	await group
		.getByRole("button", { name: "Project 操作", exact: true })
		.click();
	await expect(
		group.getByRole("button", { name: "编辑 project", exact: true }),
	).toBeDisabled();
	await group
		.getByRole("button", { name: "恢复 project", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveText("Restore failed");
	await expect(group).toBeVisible();
	await group
		.getByRole("button", { name: "Project 操作", exact: true })
		.click();
	await group
		.getByRole("button", { name: "恢复 project", exact: true })
		.click();
	await expect(normal.getByRole("heading")).toHaveText(["Work", "Newer"]);
	await section
		.getByRole("button", { name: "Project 操作", exact: true })
		.click();
	await section
		.getByRole("button", { name: "编辑 project", exact: true })
		.click();
	await expect(modal.getByLabel("名称", { exact: true })).toHaveValue(
		"local edit",
	);
	await modal.getByRole("button", { name: "保存", exact: true }).click();
	await expect(modal).toBeHidden();
	expect(
		(
			await (await page.request.get(`${app.url}/api/projects`)).json()
		).projects.map((p: { id: number }) => p.id),
	).toEqual(savedOrder);
	await page.request.put(`${app.url}/api/projects/${newer.id}/archive`, {
		data: { archived: true },
	});
	await page.request.put(`${app.url}/api/projects/${work.id}/archive`, {
		data: { archived: true },
	});
	await expect(archived.getByRole("heading")).toHaveText([
		"local edit（项目已归档）",
		"Newer（项目已归档）",
	]);
	await app.restart();
	await page.goto(`${app.url}/?chat=${c.id}`);
	await expect(page.getByRole("status")).toContainText("Project 已归档");
	await page.getByText("Archived", { exact: true }).click();
	await expect(archived.getByRole("heading")).toHaveText([
		"local edit（项目已归档）",
		"Newer（项目已归档）",
	]);
});
