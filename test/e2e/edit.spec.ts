import { expect, test } from "./fixtures.ts";

test("edit menus preserve hidden drafts, retry failures and sync without changing selection or order", async ({
	page,
	context,
	app,
}) => {
	const p = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const c = await (
		await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
			data: { name: "First" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
		data: { name: "Second" },
	});
	await page.goto(`${app.url}/?chat=${c.id}`);
	const other = await context.newPage();
	await other.goto(`${app.url}/?chat=${c.id}`);
	await other
		.getByRole("textbox", { name: "Prompt", exact: true })
		.fill("local draft");
	const section = page.getByRole("region", {
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
	await modal.getByLabel("Name", { exact: true }).fill("Unsaved");
	await modal.getByRole("button", { name: "Cancel", exact: true }).click();
	await section
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await section
		.getByRole("button", { name: "Edit project", exact: true })
		.click();
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue(
		"Unsaved",
	);
	await modal.getByRole("button", { name: "Add folder", exact: true }).click();
	await page
		.getByRole("dialog", { name: "Select folder", exact: true })
		.getByRole("button", { name: "Select current folder", exact: true })
		.click();
	let failed = false;
	await page.route("**/api/projects/*", async (route) => {
		if (route.request().method() === "PUT" && !failed) {
			failed = true;
			await route.fulfill({ status: 500, json: { error: "Save failed" } });
		} else await route.continue();
	});
	await modal.getByRole("button", { name: "Save", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveText(
		"Request failed.\nSave failed",
	);
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue(
		"Unsaved",
	);
	await modal.getByRole("button", { name: "Save", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await expect(
		other.getByRole("region", { name: "Project Unsaved", exact: true }),
	).toBeVisible();
	await expect(
		other.getByRole("textbox", { name: "Prompt", exact: true }),
	).toHaveValue("local draft");
	const otherProject = other.getByRole("region", {
		name: "Project Unsaved",
		exact: true,
	});
	await otherProject
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await otherProject
		.getByRole("button", { name: "Edit project", exact: true })
		.click();
	const otherModal = other.getByRole("dialog", {
		name: "Edit project",
		exact: true,
	});
	await otherModal.getByLabel("Name", { exact: true }).fill("Other local edit");
	const renamed = page.getByRole("region", {
		name: "Project Unsaved",
		exact: true,
	});
	await renamed
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await renamed
		.getByRole("button", { name: "Edit project", exact: true })
		.click();
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue(
		"Unsaved",
	);
	await modal
		.getByRole("button", { name: `Remove ${app.folder}`, exact: true })
		.click();
	await modal.getByRole("button", { name: "Save", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await expect(otherModal.getByLabel("Name", { exact: true })).toHaveValue(
		"Other local edit",
	);
	await otherModal.getByRole("button", { name: "Cancel", exact: true }).click();
	await renamed
		.getByRole("button", { name: "Chat First actions", exact: true })
		.click();
	await renamed.getByRole("button", { name: "Edit chat", exact: true }).click();
	const chatModal = page.getByRole("dialog", {
		name: "Edit chat",
		exact: true,
	});
	await chatModal.getByLabel("Name", { exact: true }).fill("Changed");
	await chatModal.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		other.getByRole("heading", { name: "Changed", exact: true }),
	).toBeVisible();
	await expect(renamed.locator("li > button")).toHaveText([
		"Second",
		"Changed",
	]);
	await app.restart();
	await page.goto(`${app.url}/?chat=${c.id}`);
	await expect(
		page.getByRole("heading", { name: "Changed", exact: true }),
	).toBeVisible();
});

test("switching edit targets loads their data and closing does not cancel pending saves", async ({
	page,
	app,
}) => {
	const p = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const a = await (
		await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
			data: { name: "Alpha" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
		data: { name: "Beta" },
	});
	await page.goto(`${app.url}/?chat=${a.id}`);
	const section = page.getByRole("region", {
		name: "Project Work",
		exact: true,
	});
	async function edit(name: string) {
		await section
			.getByRole("button", { name: `Chat ${name} actions`, exact: true })
			.click();
		await section
			.getByRole("button", { name: "Edit chat", exact: true })
			.click();
	}
	await edit("Alpha");
	const modal = page.getByRole("dialog", { name: "Edit chat", exact: true });
	await modal.getByLabel("Name", { exact: true }).fill("Alpha draft");
	await modal.getByRole("button", { name: "Cancel", exact: true }).click();
	await edit("Beta");
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue("Beta");
	await modal.getByRole("button", { name: "Cancel", exact: true }).click();
	await edit("Alpha");
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue("Alpha");
	await modal.getByRole("button", { name: "Cancel", exact: true }).click();
	const model = app.holdModel();
	await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Wait");
	await page.getByRole("button", { name: /^Submit(?: \(.+\))?$/ }).click();
	await model.entered;
	await edit("Alpha");
	await modal.getByLabel("Name", { exact: true }).fill("While running");
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	let entered!: () => void;
	const started = new Promise<void>((r) => (entered = r));
	await page.route(`**/api/chats/${a.id}`, async (route) => {
		if (route.request().method() === "PUT") {
			entered();
			await held;
		}
		await route.continue();
	});
	await modal.getByRole("button", { name: "Save", exact: true }).click();
	await started;
	await modal.getByRole("button", { name: "Cancel", exact: true }).click();
	await section
		.getByRole("button", { name: "Chat Beta actions", exact: true })
		.click();
	await expect(
		section.getByRole("button", { name: "Edit chat", exact: true }),
	).toBeDisabled();
	release();
	await expect(
		page.getByRole("heading", { name: "While running", exact: true }),
	).toBeVisible();
	model.release();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await edit("While running");
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue(
		"While running",
	);
});

test("successful edits reopen authoritative values even when list rereads fail", async ({
	page,
	app,
}) => {
	const p = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Before", folders: [] },
		})
	).json();
	await page.goto(app.url);
	const original = page.getByRole("region", {
		name: "Project Before",
		exact: true,
	});
	await original
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await original
		.getByRole("button", { name: "Edit project", exact: true })
		.click();
	const modal = page.getByRole("dialog", { name: "Edit project", exact: true });
	await modal.getByLabel("Name", { exact: true }).fill("Saved");
	await page.route("**/api/projects", (route) =>
		route.fulfill({ status: 500, json: { error: "Read failed" } }),
	);
	await modal.getByRole("button", { name: "Save", exact: true }).click();
	await expect(modal).not.toBeVisible();
	const saved = page.getByRole("region", {
		name: "Project Saved",
		exact: true,
	});
	await saved
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await saved
		.getByRole("button", { name: "Edit project", exact: true })
		.click();
	await expect(modal.getByLabel("Name", { exact: true })).toHaveValue("Saved");
	expect(
		(await (await page.request.get(`${app.url}/api/projects`)).json())
			.projects[0].id,
	).toBe(p.id);
});
