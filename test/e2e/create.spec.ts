import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "./fixtures.ts";

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
		.getByRole("button", { name: "Select this directory" })
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
		.getByRole("button", { name: "Select this directory" })
		.click();
	await modal.getByRole("button", { name: "Create", exact: true }).click();
	await expect(modal.getByRole("button", { name: "Cancel" })).toBeEnabled();
	await modal.getByRole("button", { name: "Cancel", exact: true }).click();
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

test("settings stays synchronized while hidden and failed updates can retry without losing errors", async ({
	page,
	context,
	app,
}) => {
	await page.goto(app.url);
	const trigger = page.getByRole("button", { name: "Settings", exact: true });
	const modal = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(page.getByRole("complementary").getByRole("radio")).toHaveCount(
		0,
	);
	await trigger.click();
	await expect(modal.getByLabel("On", { exact: true })).toBeChecked();
	await modal.getByRole("button", { name: "Close", exact: true }).click();
	const other = await context.newPage();
	await other.goto(app.url);
	await other.getByRole("button", { name: "Settings", exact: true }).click();
	await other.getByLabel("Off", { exact: true }).click();
	await expect(other.getByLabel("Off", { exact: true })).toBeChecked();
	await other.getByLabel("On", { exact: true }).click();
	await trigger.click();
	await expect(modal.getByLabel("On", { exact: true })).toBeChecked();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/debug", async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
		await held;
		await route.fulfill({ status: 500, json: { error: "test failure" } });
	});
	await modal.getByLabel("Off", { exact: true }).click();
	await expect(modal.getByLabel("On", { exact: true })).toBeDisabled();
	await modal.getByRole("button", { name: "Close", exact: true }).click();
	release();
	await trigger.click();
	await expect(modal.getByRole("alert")).toHaveText(
		"Unable to confirm logging settings. Please retry.",
	);
	await modal.getByRole("button", { name: "Close", exact: true }).click();
	await trigger.click();
	await expect(modal.getByRole("alert")).toHaveText(
		"Unable to confirm logging settings. Please retry.",
	);
	await page.unroute("**/api/debug");
	await modal.getByLabel("Off", { exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveCount(0);
	await expect(other.getByLabel("Off", { exact: true })).toBeChecked();
});

test("settings read errors remain in settings and a successful reread clears them", async ({
	page,
	app,
}) => {
	await page.route("**/api/debug", (route) =>
		route.fulfill({ status: 503, json: { error: "offline" } }),
	);
	await page.goto(app.url);
	await expect(page.getByRole("complementary").getByRole("alert")).toHaveCount(
		0,
	);
	const trigger = page.getByRole("button", { name: "Settings", exact: true });
	await trigger.click();
	const modal = page.getByRole("dialog", { name: "Settings", exact: true });
	await expect(modal.getByRole("alert")).toHaveText(
		"Unable to read logging settings. Please retry.",
	);
	await expect(modal.getByLabel("On", { exact: true })).toBeDisabled();
	await modal.getByRole("button", { name: "Close", exact: true }).click();
	await trigger.click();
	await expect(modal.getByRole("alert")).toBeVisible();
	await page.unroute("**/api/debug");
	await modal.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(modal.getByRole("alert")).toHaveCount(0);
	await expect(modal.getByLabel("On", { exact: true })).toBeChecked();
});

test("settings preserve each other across server restarts and fresh browsers", async ({
	page,
	browser,
	app,
}) => {
	await page.goto(app.url);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(page.getByLabel("On", { exact: true })).toBeChecked();
	await page.request.put(`${app.url}/api/sidebar-width`, {
		data: { width: 420 },
	});
	let width = 420;
	for (const enabled of [false, true]) {
		await page.getByLabel(enabled ? "On" : "Off", { exact: true }).click();
		await expect
			.poll(
				async () =>
					(await (await page.request.get(`${app.url}/api/debug`)).json())
						.enabled,
			)
			.toBe(enabled);
		const savedWidth = await page.request.get(`${app.url}/api/sidebar-width`);
		expect((await savedWidth.json()).width).toBe(width);
		if (!enabled) {
			width = 480;
			const saved = await page.request.put(`${app.url}/api/sidebar-width`, {
				data: { width },
			});
			expect(saved.ok()).toBe(true);
		}
		await app.restart();
		const fresh = await browser.newContext();
		try {
			const reopened = await fresh.newPage();
			await reopened.goto(app.url);
			await expect(
				reopened.getByRole("complementary", { name: "Projects" }),
			).toHaveCSS("width", `${width}px`);
			await reopened
				.getByRole("button", { name: "Settings", exact: true })
				.click();
			await expect(
				reopened.getByLabel(enabled ? "On" : "Off", { exact: true }),
			).toBeChecked();
		} finally {
			await fresh.close();
		}
		await page.goto(app.url);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
	}
});

test("database write failure preserves debug in both windows and retry saves it", async ({
	page,
	context,
	app,
}) => {
	const database = new DatabaseSync(join(app.folder, "db.sqlite"));
	try {
		database.exec(`CREATE TRIGGER reject_debug BEFORE UPDATE OF debug_enabled ON settings
			BEGIN SELECT RAISE(FAIL, 'test write failure'); END`);
		await page.goto(app.url);
		const other = await context.newPage();
		await other.goto(app.url);
		for (const current of [page, other]) {
			await current
				.getByRole("button", { name: "Settings", exact: true })
				.click();
			await expect(current.getByLabel("On", { exact: true })).toBeChecked();
		}
		await page.getByLabel("Off", { exact: true }).click();
		await expect(page.getByRole("alert")).toHaveText(
			"Unable to confirm logging settings. Please retry.",
		);
		for (const current of [page, other])
			await expect(current.getByLabel("On", { exact: true })).toBeChecked();
		expect(
			database.prepare("SELECT debug_enabled FROM settings").get()
				?.debug_enabled,
		).toBe(1);
		database.exec("DROP TRIGGER reject_debug");
		await page.getByLabel("Off", { exact: true }).click();
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(other.getByLabel("Off", { exact: true })).toBeChecked();
		expect(
			database.prepare("SELECT debug_enabled FROM settings").get()
				?.debug_enabled,
		).toBe(0);
	} finally {
		database.close();
	}
});
