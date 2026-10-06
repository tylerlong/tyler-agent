import { expect, test } from "./fixtures.ts";

for (const archived of [false, true]) {
	test(`root Stop preserves drafts and history${archived ? " in archived chats" : ""}`, async ({
		page,
		app,
	}) => {
		const project = await (
			await page.request.post(`${app.url}/api/projects`, {
				data: { name: "Work", folders: [app.folder] },
			})
		).json();
		const chat = await (
			await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
				data: { name: "Stop me" },
			})
		).json();
		const stream = app.rawStreamModel();
		await page.goto(`${app.url}/?chat=${chat.id}`);
		await page.getByLabel("Prompt").fill("cancel this root");
		await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
		stream.push(
			`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "answer", type: "message", content: [] } })}\n\n`,
		);
		stream.push(
			`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "answer", output_index: 0, content_index: 0, delta: "Saved partial output" })}\n\n`,
		);
		await expect(page.getByRole("log")).toContainText("Saved partial output");
		await page.getByLabel("Prompt").fill("next draft");
		if (archived) {
			await page.request.put(`${app.url}/api/chats/${chat.id}/archive`, {
				data: { archived: true },
			});
			await expect(page.getByLabel("Prompt")).toHaveCount(0);
		}
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/api/agents/*/cancel", async (route) => {
			await gate;
			await route.continue();
		});
		const stop = page.getByRole("button", { name: "Stop", exact: true });
		await stop.click();
		await expect(page.getByRole("log")).toContainText("Stopping…");
		await expect(stop).toBeDisabled();
		if (!archived)
			await expect(
				page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
			).toBeDisabled();
		release();
		await expect(page.getByRole("log")).toContainText("Agent cancelled.");
		await expect(stop).toHaveCount(0);
		await expect(page.getByRole("log")).toContainText("Saved partial output");
		if (archived) {
			await expect(page.getByLabel("Prompt")).toHaveCount(0);
			await page.request.put(`${app.url}/api/chats/${chat.id}/archive`, {
				data: { archived: false },
			});
		}
		await expect(page.getByLabel("Prompt")).toHaveValue("next draft");
		await expect(
			page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }),
		).toBeEnabled();
		await page.reload();
		await expect(page.getByRole("log")).toContainText("Agent cancelled.");
		await expect(page.getByRole("log")).toContainText("Saved partial output");
	});
}
