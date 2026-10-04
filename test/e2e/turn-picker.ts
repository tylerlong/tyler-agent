import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

const names: Record<string, string> = {
	test: "Test",
	second: "Second",
	gateway: "Gateway",
	"": "Choose a model",
};

export function turnPicker(page: Page) {
	return page.locator('button[aria-haspopup="dialog"]');
}
export async function expectModel(page: Page, id: string) {
	await expect(turnPicker(page)).toContainText(names[id] ?? id);
}
export async function expectEffort(page: Page, effort: string) {
	await expect(turnPicker(page)).toContainText(
		`Reasoning: ${effort || "Default"}`,
	);
}
export async function openTurnPicker(page: Page) {
	const popup = page.getByRole("dialog", { name: "Model", exact: true });
	if (!(await popup.isVisible())) await turnPicker(page).click();
	await expect(popup).toBeVisible();
	return popup;
}
export async function selectModel(page: Page, id: string) {
	const popup = await openTurnPicker(page);
	await popup
		.getByRole("radiogroup", { name: "Model", exact: true })
		.getByRole("radio", { name: names[id] ?? id, exact: true })
		.click();
	await page.keyboard.press("Escape");
}
export async function selectEffort(page: Page, effort: string) {
	const popup = await openTurnPicker(page);
	await popup
		.getByRole("radio", { name: effort || "Default", exact: true })
		.click();
	await page.keyboard.press("Escape");
}
