import { expect, test } from "./fixtures.ts";

test("compact composer grows and shrinks with drafts, bounds scrolling and guards whitespace", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Composer" },
		})
	).json();
	await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Other" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
	const send = page.getByRole("button", { name: "Submit", exact: true });
	await expect(prompt).toHaveAttribute("placeholder", "Prompt");
	await expect(page.getByText("Prompt", { exact: true })).toHaveCount(0);
	await expect(send).toBeHidden();
	const initial = (await prompt.boundingBox())?.height ?? 0;
	expect(initial).toBeGreaterThan(40);
	await prompt.fill(" \n\t ");
	await expect(send).toBeHidden();
	let posts = 0;
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			request.url().endsWith(`/chats/${chat.id}`)
		)
			posts++;
	});
	await prompt.evaluate((input: HTMLTextAreaElement) =>
		input.form?.requestSubmit(),
	);
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await expect(prompt).toHaveValue("");
	expect(posts).toBe(0);
	await page.getByRole("button", { name: "Composer", exact: true }).click();
	await prompt.fill("First line\nSecond line\nThird line\nFourth line");
	await expect(send).toBeVisible();
	const grown = (await prompt.boundingBox())?.height ?? 0;
	expect(grown).toBeGreaterThan(initial);
	await prompt.fill("Long draft line\n".repeat(30));
	const bounded = (await prompt.boundingBox())?.height ?? 0;
	expect(bounded).toBeGreaterThan(grown);
	expect(bounded).toBeLessThan(initial * 4);
	expect(
		await prompt.evaluate((input) => input.scrollHeight > input.clientHeight),
	).toBe(true);
	await expect(send).toBeInViewport();
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await expect(prompt).toHaveValue("");
	expect((await prompt.boundingBox())?.height).toBe(initial);
	await page.getByRole("button", { name: "Composer", exact: true }).click();
	await expect(prompt).toHaveValue("Long draft line\n".repeat(30));
	expect((await prompt.boundingBox())?.height).toBe(bounded);
	await page.screenshot({ path: "/tmp/tyler-agent-66-composer.png" });
	await page.setViewportSize({ width: 480, height: 400 });
	await expect(prompt).toBeInViewport();
	await expect(send).toBeInViewport();
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
	await page.screenshot({ path: "/tmp/tyler-agent-66-composer-small.png" });
	await prompt.fill("short draft");
	expect((await prompt.boundingBox())?.height).toBe(initial);
	await send.click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expect(prompt).toHaveValue("");
	await expect(send).toBeHidden();
	expect(posts).toBe(1);
	await page.request.put(`${app.url}/api/language`, {
		data: { language: "zh-CN" },
	});
	await expect(
		page.getByRole("textbox", { name: "问题", exact: true }),
	).toHaveAttribute("placeholder", "问题");
	await expect(
		page.getByRole("textbox", { name: "问题", exact: true }),
	).toBeVisible();
});
