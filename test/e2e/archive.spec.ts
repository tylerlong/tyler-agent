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
	await other.getByLabel("Prompt").fill("other draft");
	const archive = page.getByRole("group", { name: "Archived", exact: true });
	await expect(archive).toHaveCount(0);
	const hold = app.holdModel();
	await page
		.getByRole("textbox", { name: "Prompt", exact: true })
		.fill("Question");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await hold.entered;
	try {
		const work = page
			.getByRole("region", { name: "Project Work", exact: true })
			.first();
		await work
			.getByRole("button", { name: "Chat A actions", exact: true })
			.click();
		await work
			.getByRole("button", { name: "Archive chat", exact: true })
			.click();
		await expect(
			other
				.getByRole("region", { name: "Chat", exact: true })
				.getByRole("status")
				.filter({ hasText: "read-only" }),
		).toHaveText(
			"Chat is archived and read-only. Restore the chat to continue.",
		);
		await expect(
			other.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
		).toHaveCount(0);
		await expect(other.getByLabel("Prompt", { exact: true })).toHaveCount(0);
		await expect(other.getByLabel("Model", { exact: true })).toHaveCount(0);
		await expect(
			other.getByLabel("Reasoning level", { exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("heading", { name: "A", exact: true }),
		).toBeVisible();
		await expect(
			archive.getByRole("region", { name: "Project Work", exact: true }),
		).toBeHidden();
		await expect(page.getByText("Archived", { exact: true })).toBeVisible();
		await page.getByText("Archived", { exact: true }).click();
		await expect(
			archive
				.getByRole("region", { name: "Project Work", exact: true })
				.getByRole("button", { name: /^A/ }),
		).toBeVisible();
		await work
			.getByRole("button", { name: "Project actions", exact: true })
			.click();
		await work
			.getByRole("button", { name: "Archive project", exact: true })
			.click();
		await expect(
			archive.getByText(" (project archived)", { exact: true }),
		).toBeVisible();
		await expect(
			other
				.getByRole("region", { name: "Chat", exact: true })
				.getByRole("status")
				.filter({ hasText: "read-only" }),
		).toHaveText(
			"Project and chat are archived and read-only. Restore both to continue.",
		);
		await expect(
			archive.getByRole("button", { name: "B", exact: true }),
		).toBeVisible();
		const group = archive.getByRole("region", {
			name: "Project Work",
			exact: true,
		});
		await group
			.getByRole("button", { name: "Chat A actions", exact: true })
			.click();
		await group
			.getByRole("button", { name: "Restore chat", exact: true })
			.click();
		await expect(
			other
				.getByRole("region", { name: "Chat", exact: true })
				.getByRole("status")
				.filter({ hasText: "read-only" }),
		).toHaveText(
			"Project is archived; chat is read-only. Restore the project to continue.",
		);
		hold.release();
		await expect(other.getByRole("log")).toContainText("Test answer");
		await expect(
			other.getByRole("textbox", { name: "Prompt", exact: true }),
		).toHaveCount(0);
		await group
			.getByRole("button", { name: "Project actions", exact: true })
			.click();
		await group
			.getByRole("button", { name: "Restore project", exact: true })
			.click();
		await expect(
			other.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
		).toBeEnabled();
		await expect(other.getByLabel("Prompt", { exact: true })).toHaveValue(
			"other draft",
		);
		await expect(
			page
				.getByRole("region", { name: "Project Work", exact: true })
				.getByRole("button", { name: "B", exact: true }),
		).toBeVisible();
		await expect(archive).toHaveCount(0);
		await expect(
			other.getByRole("group", { name: "Archived", exact: true }),
		).toHaveCount(0);
		await page.reload();
		await expect(archive).toHaveCount(0);
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
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await section
		.getByRole("button", { name: "Edit project", exact: true })
		.click();
	const modal = page.getByRole("dialog", { name: "Edit project", exact: true });
	await modal.getByLabel("Name", { exact: true }).fill("local edit");
	await other.request.put(`${app.url}/api/projects/${work.id}/archive`, {
		headers: { Origin: app.url },
		data: { archived: true },
	});
	await expect(modal.getByLabel("Name", { exact: true })).toBeDisabled();
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue(
		"local edit",
	);
	await modal.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("textbox", { name: "Prompt", exact: true }),
	).toHaveCount(0);
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
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await expect(
		group.getByRole("button", { name: "Edit project", exact: true }),
	).toBeDisabled();
	await group
		.getByRole("button", { name: "Restore project", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveText(
		"Request failed.\nRestore failed",
	);
	await expect(group).toBeVisible();
	await group
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await group
		.getByRole("button", { name: "Restore project", exact: true })
		.click();
	await expect(normal.getByRole("heading")).toHaveText(["Work", "Newer"]);
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue("draft");
	await section
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await section
		.getByRole("button", { name: "Edit project", exact: true })
		.click();
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue(
		"local edit",
	);
	await modal.getByRole("button", { name: "Save", exact: true }).click();
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
	await page.getByText("Archived", { exact: true }).click();
	await expect(archived.getByRole("heading")).toHaveText([
		"local edit (project archived)",
		"Newer (project archived)",
	]);
	await app.restart();
	await page.goto(`${app.url}/?chat=${c.id}`);
	await expect(
		page.getByRole("status").filter({ hasText: "Project is archived" }),
	).toBeVisible();
	await page.getByText("Archived", { exact: true }).click();
	await expect(archived.getByRole("heading")).toHaveText([
		"local edit (project archived)",
		"Newer (project archived)",
	]);
});

test("archived history needs no configuration across chat switching and refresh", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "History", folders: [] },
		})
	).json();
	const createChat = async (name: string) =>
		(
			await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
				data: { name },
			})
		).json();
	const first = await createChat("First");
	await createChat("Second");
	await page.goto(`${app.url}/?chat=${first.id}`);
	await page.getByLabel("Prompt", { exact: true }).fill("Saved question");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await page.request.put(`${app.url}/api/chats/${first.id}/archive`, {
		data: { archived: true },
	});
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveCount(0);
	await page.request.put(`${app.url}/api/model-settings`, {
		data: { removeApiKey: true },
	});
	await page.request.delete(`${app.url}/api/models/test`);
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).toBeHidden();
	await page.reload();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveCount(0);
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).toBeHidden();
	await page.request.put(`${app.url}/api/projects/${project.id}/archive`, {
		data: { archived: true },
	});
	await page.getByText("Archived", { exact: true }).click();
	await page.getByRole("button", { name: "Second", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Second", exact: true }),
	).toBeVisible();
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveCount(0);
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).toBeHidden();
	await page.getByRole("button", { name: "First", exact: true }).click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await page.request.put(`${app.url}/api/chats/${first.id}/archive`, {
		data: { archived: false },
	});
	await expect(
		page.getByRole("status").filter({ hasText: "Project is archived" }),
	).toBeVisible();
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveCount(0);
	await page.request.put(`${app.url}/api/projects/${project.id}/archive`, {
		data: { archived: false },
	});
	await expect(
		page.getByRole("dialog", { name: "Settings", exact: true }),
	).toBeVisible();
	await expect(page.getByLabel("Prompt", { exact: true })).toHaveCount(1);
});
