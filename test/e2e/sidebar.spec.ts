import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const sidebar = (page: Page) =>
	page.getByRole("complementary", { name: "Projects" });
const divider = (page: Page) =>
	page.getByRole("separator", { name: "Resize sidebar" });
async function startDrag(page: Page) {
	const bounds = await divider(page).boundingBox();
	if (!bounds) throw new Error("Missing divider");
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
	await page.mouse.down();
	return { x: bounds.x + bounds.width / 2, y: bounds.y + 100 };
}
async function drag(page: Page, offset: number) {
	const point = await startDrag(page);
	await page.mouse.move(point.x + offset, point.y);
	await page.mouse.up();
}

test("drag saves once after release; fixed limits, double click and server restart restore width", async ({
	page,
	app,
	browser,
}) => {
	await page.goto(app.url);
	await expect(sidebar(page)).toHaveCSS("width", "320px");
	const saved: number[] = [];
	page.on("request", (request) => {
		if (
			request.url().endsWith("/api/sidebar-width") &&
			request.method() === "PUT"
		)
			saved.push(request.postDataJSON().width);
	});
	const point = await startDrag(page);
	await page.mouse.move(point.x + 40, point.y + 30);
	await expect(sidebar(page)).toHaveCSS("width", "360px");
	await page.mouse.move(point.x + 80, point.y + 60);
	await expect(sidebar(page)).toHaveCSS("width", "400px");
	expect(saved).toEqual([]);
	await page.mouse.up();
	await expect.poll(() => saved).toEqual([400]);
	await expect
		.poll(
			async () =>
				(await (await page.request.get(`${app.url}/api/sidebar-width`)).json())
					.width,
		)
		.toBe(400);
	await page.mouse.move(point.x + 180, point.y);
	await expect(sidebar(page)).toHaveCSS("width", "400px");
	await drag(page, -1000);
	await expect(sidebar(page)).toHaveCSS("width", "240px");
	await drag(page, 1000);
	await expect(sidebar(page)).toHaveCSS("width", "600px");
	await page.setViewportSize({ width: 800, height: 720 });
	await expect(sidebar(page)).toHaveCSS("width", "600px");
	await expect(divider(page)).not.toHaveAttribute("tabindex", "0");
	saved.length = 0;
	await divider(page).dblclick();
	await expect(sidebar(page)).toHaveCSS("width", "320px");
	await expect.poll(() => saved).toEqual([320]);
	await drag(page, 100);
	await expect
		.poll(
			async () =>
				(await (await page.request.get(`${app.url}/api/sidebar-width`)).json())
					.width,
		)
		.toBe(420);
	await app.restart();
	const fresh = await browser.newContext();
	try {
		const reopened = await fresh.newPage();
		await reopened.goto(app.url);
		await expect(sidebar(reopened)).toHaveCSS("width", "420px");
	} finally {
		await fresh.close();
	}
});

test("blur ends drag and restores selection; other windows and project events keep their widths", async ({
	page,
	context,
	app,
}) => {
	await page.goto(app.url);
	const other = await context.newPage();
	await other.goto(app.url);
	await expect(sidebar(other)).toHaveCSS("width", "320px");
	const saved: number[] = [];
	page.on("request", (request) => {
		if (
			request.url().endsWith("/api/sidebar-width") &&
			request.method() === "PUT"
		)
			saved.push(request.postDataJSON().width);
	});
	const point = await startDrag(page);
	await page.mouse.move(point.x + 110, point.y + 100);
	await expect(sidebar(page)).toHaveCSS("width", "430px");
	await expect(page.locator("body")).toHaveCSS("cursor", "col-resize");
	await expect(page.locator("body")).toHaveCSS("user-select", "none");
	await page.evaluate(() => window.dispatchEvent(new Event("blur")));
	await expect.poll(() => saved).toEqual([430]);
	await page.mouse.up();
	await page.mouse.move(point.x + 180, point.y);
	await expect(sidebar(page)).toHaveCSS("width", "430px");
	await expect(page.locator("body")).not.toHaveCSS("user-select", "none");
	await expect(page.locator("body")).not.toHaveCSS("cursor", "col-resize");
	const canceled = await startDrag(page);
	await page.mouse.move(canceled.x + 10, canceled.y);
	await divider(page).dispatchEvent("pointercancel", {
		pointerId: 1,
		pointerType: "mouse",
	});
	await page.mouse.up();
	await expect.poll(() => saved).toEqual([430, 440]);
	await page.mouse.move(canceled.x + 100, canceled.y);
	await expect(sidebar(page)).toHaveCSS("width", "440px");
	await expect(page.locator("body")).not.toHaveCSS("user-select", "none");
	await page.request.post(`${app.url}/api/projects`, {
		data: { name: "Synced", folders: [app.folder] },
	});
	for (const current of [page, other])
		await expect(
			current.getByRole("heading", { name: "Synced", exact: true }),
		).toBeVisible();
	await expect(sidebar(page)).toHaveCSS("width", "440px");
	await expect(sidebar(other)).toHaveCSS("width", "320px");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await other.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByLabel("Off", { exact: true }).click();
	await expect(other.getByLabel("Off", { exact: true })).toBeChecked();
	await expect(sidebar(page)).toHaveCSS("width", "440px");
	await expect(sidebar(other)).toHaveCSS("width", "320px");
	for (const current of [page, other])
		await current
			.getByRole("dialog", { name: "Settings", exact: true })
			.getByRole("button", { name: "Close", exact: true })
			.click();
	await other.reload();
	await expect(sidebar(other)).toHaveCSS("width", "440px");
	await drag(other, -50);
	await expect
		.poll(
			async () =>
				(await (await page.request.get(`${app.url}/api/sidebar-width`)).json())
					.width,
		)
		.toBe(390);
	await expect(sidebar(page)).toHaveCSS("width", "440px");
	await page.reload();
	await expect(sidebar(page)).toHaveCSS("width", "390px");
});

test("failed preference requests preserve layout without alerts or retries", async ({
	page,
	app,
}) => {
	let reads = 0;
	let writes = 0;
	await page.route("**/api/sidebar-width", async (route) => {
		if (route.request().method() === "GET") reads++;
		else writes++;
		await route.fulfill({
			status: 500,
			contentType: "application/json",
			body: '{"error":"failure"}',
		});
	});
	await page.goto(app.url);
	await expect.poll(() => reads).toBe(1);
	await expect(sidebar(page)).toHaveCSS("width", "320px");
	await drag(page, 80);
	await expect.poll(() => writes).toBe(1);
	await expect(sidebar(page)).toHaveCSS("width", "400px");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	expect(reads).toBe(1);
	expect(writes).toBe(1);
});
