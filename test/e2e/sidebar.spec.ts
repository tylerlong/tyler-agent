import { expect, test } from "./fixtures.ts";

test("sidebar supports dragging, keyboard limits and persists its width", async ({
	page,
	app,
}) => {
	await page.goto(app.url);
	const sidebar = page.getByRole("complementary", { name: "Projects" });
	const divider = page.getByRole("separator", { name: "调整左侧面板宽度" });
	await expect(sidebar).toHaveCSS("width", "320px");
	await expect(divider).toBeVisible();
	const bounds = await divider.boundingBox();
	if (!bounds) throw new Error("Missing divider");
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + 100);
	await page.mouse.up();
	await expect(sidebar).toHaveCSS("width", "400px");
	await page.reload();
	await expect(sidebar).toHaveCSS("width", "400px");
	await divider.focus();
	await page.keyboard.press("ArrowLeft");
	await expect(sidebar).toHaveCSS("width", "390px");
	await page.keyboard.press("Home");
	await page.keyboard.press("ArrowLeft");
	await expect(sidebar).toHaveCSS("width", "240px");
	await page.keyboard.press("End");
	await page.keyboard.press("ArrowRight");
	await expect(sidebar).toHaveCSS("width", "600px");
	await page.setViewportSize({ width: 800, height: 720 });
	await expect(sidebar).toHaveCSS("width", "400px");
});
