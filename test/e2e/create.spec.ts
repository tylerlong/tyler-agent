import { expect, test } from "./fixtures.ts";

test("all modals dismiss outside without clearing drafts or closing their parent", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	const trigger = page.getByRole("button", {
		name: "New project",
		exact: true,
	});
	const create = page.getByRole("dialog", { name: "New project", exact: true });
	await trigger.click();
	await create.getByLabel("Name").fill("Draft project");
	await create.click({ position: { x: 8, y: 8 } });
	await expect(create).toBeVisible();
	await create.getByRole("button", { name: "Add folder", exact: true }).click();
	const folder = page.getByRole("dialog", {
		name: "Select folder",
		exact: true,
	});
	await expect(folder).toBeVisible();
	await page.mouse.click(5, 5);
	await expect(folder).toBeHidden();
	await expect(create).toBeVisible();
	await expect(create.getByLabel("Name")).toHaveValue("Draft project");
	await page.mouse.click(5, 5);
	await expect(create).toBeHidden();
	await trigger.click();
	await expect(create.getByLabel("Name")).toHaveValue("Draft project");
	await create.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(settings).toBeVisible();
	await page.mouse.click(5, 5);
	await expect(settings).toBeHidden();
});

test("default names submit without folders and fresh drafts reset after success", async ({
	page,
	context,
	app,
}) => {
	await page.goto(app.url);
	const other = await context.newPage();
	await other.goto(app.url);
	const trigger = page.getByRole("button", {
		name: "New project",
		exact: true,
	});
	const modal = page.getByRole("dialog", { name: /^New/ });
	await trigger.click();
	await expect(modal.getByLabel("Name")).toHaveValue("New project");
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await expect(
		other.getByRole("heading", { name: "New project", exact: true }),
	).toBeVisible();
	await trigger.click();
	await expect(modal.getByLabel("Name")).toHaveValue("New project");
	await modal.getByLabel("Name").fill(" ");
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveText("Name must not be empty.");
	await modal.getByRole("button", { name: "Cancel" }).click();
	await trigger.click();
	await expect(modal.getByLabel("Name")).toHaveValue(" ");
	await expect(modal.getByRole("alert")).toHaveText("Name must not be empty.");
	await modal.getByLabel("Name").fill("Personal");
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal).not.toBeVisible();
	const personal = page.getByRole("region", {
		name: "Project Personal",
		exact: true,
	});
	await personal.getByTitle("New chat", { exact: true }).click();
	await expect(modal.getByLabel("Name")).toHaveValue("New chat");
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await expect(
		other
			.getByRole("list")
			.getByRole("button", { name: "New chat", exact: true }),
	).toBeVisible();
	await personal.getByTitle("New chat", { exact: true }).click();
	await expect(modal.getByLabel("Name")).toHaveValue("New chat");
	await modal.getByLabel("Name").fill("Draft");
	await modal.getByRole("button", { name: "Cancel" }).click();
	await personal.getByTitle("New chat", { exact: true }).click();
	await expect(modal.getByLabel("Name")).toHaveValue("Draft");
	await modal.getByRole("button", { name: "Cancel" }).click();
	await trigger.click();
	await expect(modal.getByLabel("Name")).toHaveValue("New project");
});

test("native creation modals support validation, cancellation and shared lists", async ({
	page,
	context,
	app,
}) => {
	await page.goto(app.url);
	const other = await context.newPage();
	await other.goto(app.url);
	const createProject = page.getByRole("button", {
		name: "New project",
		exact: true,
	});
	await createProject.click();
	const modal = page.getByRole("dialog", { name: /^New/ });
	await expect(modal).toBeVisible();
	await modal.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await createProject.click();
	await modal.getByRole("button", { name: "Cancel" }).click();
	await expect(modal).not.toBeVisible();
	await createProject.click();
	await modal.getByLabel("Name").fill(" ");
	await modal.getByRole("button", { name: "Add folder" }).click();
	await page
		.getByRole("dialog", { name: "Select folder" })
		.getByRole("button", { name: "Select current folder" })
		.click();
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveText("Name must not be empty.");
	await expect(modal).toBeVisible();
	await modal.getByLabel("Name").fill("Work");
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await expect(page.getByRole("region", { name: "Chat" })).toBeEmpty();
	await expect(
		other.getByRole("heading", { name: "Work", exact: true }),
	).toBeVisible();
	const createChat = page.getByRole("button", {
		name: "New chat",
		exact: true,
	});
	await createChat.click();
	await modal.getByLabel("Name").fill(" ");
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveText("Name must not be empty.");
	await modal.getByLabel("Name").fill("Question");
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await expect(
		page
			.getByRole("region", { name: "Chat" })
			.getByRole("heading", { name: "Question" }),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "Chat" })).toContainText(
		app.folder,
	);
	await expect(
		other.getByRole("button", { name: "Question", exact: true }),
	).toBeVisible();
	await expect(other.getByRole("region", { name: "Chat" })).toBeEmpty();
	await page.getByRole("button", { name: "Collapse Work" }).click();
	await expect(
		page.getByRole("button", { name: "Question", exact: true }),
	).not.toBeVisible();
	await expect(
		other.getByRole("button", { name: "Question", exact: true }),
	).toBeVisible();
});

test("pending project creation can hide and reopen without cancelling or closing settings", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/projects", async (route) => {
		if (route.request().method() === "POST") await held;
		await route.continue();
	});
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const modal = page.getByRole("dialog", { name: /^New/ });
	await modal.getByLabel("Name").fill("First");
	await modal.getByRole("button", { name: "Add folder" }).click();
	await page
		.getByRole("dialog", { name: "Select folder" })
		.getByRole("button", { name: "Select current folder" })
		.click();
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal.getByRole("button", { name: "Cancel" })).toBeEnabled();
	await page.mouse.click(5, 5);
	await expect(modal).not.toBeVisible();
	await page.getByRole("button", { name: "New project", exact: true }).click();
	await expect(modal.getByLabel("Name")).toHaveValue("First");
	await expect(
		modal.getByRole("button", { name: "Create", exact: true }),
	).toBeDisabled();
	await modal.getByRole("button", { name: "Cancel" }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(settings).toBeVisible();
	if (!release) throw new Error("Missing release");
	release();
	await expect(modal).not.toBeVisible();
	await expect(settings).toBeVisible();
	await settings.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "First", exact: true }),
	).toBeVisible();
});

test("pending chat creation keeps its input while hidden and completes in its original project", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [app.folder] },
		})
	).json();
	await page.goto(app.url);
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`**/api/projects/${project.id}/chats`, async (route) => {
		await held;
		await route.continue();
	});
	const trigger = page.getByRole("button", { name: "New chat", exact: true });
	await trigger.click();
	const modal = page.getByRole("dialog", { name: "New chat", exact: true });
	await modal.getByLabel("Name").fill("Pending chat");
	await modal.getByRole("button", { name: "Cancel" }).click();
	await trigger.click();
	await expect(modal.getByLabel("Name")).toHaveValue("Pending chat");
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal.getByLabel("Name")).toBeDisabled();
	await modal.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(modal).not.toBeVisible();
	await trigger.click();
	await expect(modal.getByLabel("Name")).toHaveValue("Pending chat");
	await modal.getByRole("button", { name: "Cancel" }).click();
	release();
	await expect(
		page
			.getByRole("region", { name: "Chat", exact: true })
			.getByRole("heading", { name: "Pending chat" }),
	).toBeVisible();
	await trigger.click();
	await expect(modal.getByLabel("Name")).toHaveValue("New chat");
});
