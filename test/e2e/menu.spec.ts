import { expect, test } from "./fixtures.ts";

test("project row toggles from its name and padding while action controls stay independent", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
		data: { name: "First" },
	});
	await page.goto(app.url);
	const region = page.getByRole("region", {
		name: "Project Work",
		exact: true,
	});
	const chat = region.getByRole("button", { name: "First", exact: true });
	const heading = region.getByRole("heading", { name: "Work", exact: true });
	const row = heading.locator("..");
	const namePosition = await heading.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		return { x: bounds.x + 8, y: bounds.y + bounds.height / 2 };
	});
	await page.mouse.click(namePosition.x, namePosition.y);
	await expect(chat).toBeHidden();
	await row.click({ position: { x: 2, y: 2 } });
	await expect(chat).toBeVisible();
	await region
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await expect(chat).toBeVisible();
	await expect(
		region.getByRole("button", { name: "Edit project", exact: true }),
	).toBeVisible();
	await page.getByRole("heading", { name: "Tyler Agent", exact: true }).click();
	await region.getByRole("button", { name: "New chat", exact: true }).click();
	await expect(chat).toBeVisible();
	await expect(
		page.getByRole("dialog", { name: "New chat", exact: true }),
	).toBeVisible();
});

test("sidebar menus dismiss outside, switch targets and close before editing", async ({
	page,
	app,
}) => {
	await page.request.post(`${app.url}/api/projects`, {
		data: { name: "Work", folders: [] },
	});
	await page.goto(app.url);
	const project = page.getByRole("region", {
		name: "Project Work",
		exact: true,
	});
	const trigger = project.getByRole("button", {
		name: "Project actions",
		exact: true,
	});
	const edit = project.getByRole("button", {
		name: "Edit project",
		exact: true,
	});
	await trigger.click();
	await expect(edit).toBeVisible();
	await page.getByRole("heading", { name: "Tyler Agent", exact: true }).click();
	await expect(edit).toBeHidden();
	await trigger.click();
	await trigger.click();
	await expect(edit).toBeHidden();
	await trigger.click();
	await edit.click();
	await expect(edit).toBeHidden();
	await expect(
		page.getByRole("dialog", { name: "Edit project", exact: true }),
	).toBeVisible();
});

test("lightweight controls and menus have hover feedback and fit at the viewport bottom", async ({
	page,
	app,
}) => {
	const p = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
		data: { name: "First" },
	});
	await page.setViewportSize({ width: 800, height: 600 });
	await page.goto(app.url);
	const project = page.getByRole("region", {
		name: "Project Work",
		exact: true,
	});
	const create = page.getByRole("button", {
		name: "New project",
		exact: true,
	});
	const background = (locator: import("@playwright/test").Locator) =>
		locator.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(await background(create)).toBe("rgba(0, 0, 0, 0)");
	expect(await create.evaluate((el) => getComputedStyle(el).borderWidth)).toBe(
		"0px",
	);
	await expect(create).toHaveText("New project");
	await create.hover();
	expect(await background(create)).not.toBe("rgba(0, 0, 0, 0)");
	const plus = project.getByRole("button", { name: "New chat", exact: true });
	await expect(plus).toHaveAttribute("title", "New chat");
	await expect(plus).toHaveText("+");
	await expect(plus).toBeVisible();
	const row = project.getByRole("heading").locator("..");
	await row.hover();
	expect(await background(row)).not.toBe("rgba(0, 0, 0, 0)");
	expect(await background(project.locator("ul"))).toBe("rgba(0, 0, 0, 0)");
	await plus.hover();
	expect(await background(plus)).not.toBe("rgba(0, 0, 0, 0)");
	const trigger = project.getByRole("button", {
		name: "Project actions",
		exact: true,
	});
	await trigger.hover();
	expect(await background(trigger)).not.toBe("rgba(0, 0, 0, 0)");
	await trigger.click();
	const edit = project.getByRole("button", {
		name: "Edit project",
		exact: true,
	});
	await edit.hover();
	expect(await background(edit)).not.toBe("rgba(0, 0, 0, 0)");
	const bounds = await edit.locator("..").boundingBox();
	const anchor = await trigger.boundingBox();
	if (!bounds || !anchor) throw new Error("Menu or anchor not visible");
	expect(
		Math.abs(bounds.x + bounds.width - anchor.x - anchor.width),
	).toBeLessThan(2);
	expect(bounds.y - anchor.y - anchor.height).toBeGreaterThanOrEqual(0);
	expect(bounds.y - anchor.y - anchor.height).toBeLessThan(10);
	await page.screenshot({ path: "/tmp/tyler-agent-46-menu.png" });
	// Put a real trigger near the bottom using an Archived project.
	await page.getByRole("heading", { name: "Tyler Agent", exact: true }).click();
	await page.request.put(`${app.url}/api/projects/${p.id}/archive`, {
		data: { archived: true },
	});
	await page.getByText("Archived", { exact: true }).click();
	await page.setViewportSize({ width: 800, height: 280 });
	const archived = page.getByRole("group", { name: "Archived", exact: true });
	const bottomTrigger = archived.getByRole("button", {
		name: "Chat First actions",
		exact: true,
	});
	await bottomTrigger.click();
	const disabled = archived.getByRole("button", {
		name: "Edit chat",
		exact: true,
	});
	await expect(disabled).toBeDisabled();
	const before = await background(disabled);
	await disabled.hover();
	expect(await background(disabled)).toBe(before);
	const bottom = await bottomTrigger.boundingBox();
	const menu = await disabled.locator("..").boundingBox();
	if (!menu || !bottom) throw new Error("Bottom menu or anchor not visible");
	expect(menu.y + menu.height).toBeLessThanOrEqual(bottom.y);
	expect(menu.y).toBeGreaterThanOrEqual(0);
	expect(menu.x).toBeGreaterThanOrEqual(0);
	expect(menu.x + menu.width).toBeLessThanOrEqual(800);
	await page.screenshot({ path: "/tmp/tyler-agent-46-archived-menu.png" });
	await page.getByRole("heading", { name: "Tyler Agent", exact: true }).click();
	await archived
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await expect(disabled).toBeHidden();
	await archived
		.getByRole("button", { name: "Restore project", exact: true })
		.click();
	await expect(
		project.getByRole("button", { name: "New chat", exact: true }),
	).toBeVisible();
});

test("normal and Archived project targets stay separate and actions close before delayed failures", async ({
	page,
	app,
}) => {
	const p = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const c = await (
		await page.request.post(`${app.url}/api/projects/${p.id}/chats`, {
			data: { name: "Archived chat" },
		})
	).json();
	await page.request.put(`${app.url}/api/chats/${c.id}/archive`, {
		data: { archived: true },
	});
	await page.goto(app.url);
	await page.getByText("Archived", { exact: true }).click();
	const normal = page.getByRole("navigation", {
		name: "Projects and chats",
		exact: true,
	});
	const archived = page.getByRole("group", { name: "Archived", exact: true });
	await normal
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	const edit = normal.getByRole("button", {
		name: "Edit project",
		exact: true,
	});
	await expect(edit).toBeVisible();
	// The open menu covers nearby rows; dismiss it before using that row's trigger.
	await page.getByRole("heading", { name: "Tyler Agent", exact: true }).click();
	await expect(edit).toBeHidden();
	await archived
		.getByRole("button", { name: "Project actions", exact: true })
		.click();
	await expect(edit).toBeHidden();
	await archived
		.getByRole("button", { name: "Edit project", exact: true })
		.click();
	await expect(
		page
			.getByRole("dialog", { name: "Edit project", exact: true })
			.getByLabel("Name", { exact: true }),
	).toHaveValue("Work");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	for (const action of ["Archive project", "Restore project"]) {
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route(`**/api/projects/${p.id}/archive`, async (route) => {
			entered();
			await held;
			await route.fulfill({ status: 500, json: { error: "Action failed" } });
		});
		const area = action === "Archive project" ? normal : archived;
		await area
			.getByRole("button", { name: "Project actions", exact: true })
			.click();
		const item = area.getByRole("button", { name: action, exact: true });
		await item.click();
		await started;
		await expect(item).toBeHidden();
		release();
		await expect(page.getByRole("alert")).toHaveText(
			"Request failed.\nAction failed",
		);
		await expect(item).toBeHidden();
		await page.unroute(`**/api/projects/${p.id}/archive`);
		await area
			.getByRole("button", { name: "Project actions", exact: true })
			.click();
		await area.getByRole("button", { name: action, exact: true }).click();
		await expect(
			area.getByRole("button", { name: action, exact: true }),
		).toBeHidden();
		await expect(
			(action === "Archive project" ? archived : normal).getByRole("heading"),
		).toContainText("Work");
	}
});
