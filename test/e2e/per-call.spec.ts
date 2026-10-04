import { completedBody, frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

test("tool-only calls omit empty output and a later failed call retains its ordered partial output and manual folds", async ({
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
			data: { name: "Partial" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const first = app.rawStreamModel();
	await page.getByLabel("Prompt").fill("Inspect files");
	await page.getByRole("button", { name: /^Send(?: \(.+\))?$/ }).click();
	const log = page.getByRole("log");
	await expect(log.getByText("Request 1", { exact: true })).toBeVisible();
	const second = app.rawStreamModel();
	first.push(
		completedBody({
			status: "completed",
			output: [
				{
					id: "same-id",
					type: "function_call",
					name: "count_files",
					call_id: "count-only",
					arguments: JSON.stringify({ path: app.folder }),
				},
			],
		}),
	);
	first.end();
	await expect(log.getByText("Request 2", { exact: true })).toBeVisible();
	const groups = log.locator("[data-model-call-id]");
	await expect(groups).toHaveCount(2);
	await expect(groups.first().locator("[data-output-index]")).toHaveCount(0);
	await expect(groups.first()).toContainText("Response 1 · Completed");
	await expect(groups.last()).toContainText("Response 2 · Working");
	const items = [
		{
			id: "same-id",
			type: "message",
			content: [{ type: "output_text", text: "first partial" }],
		},
		{
			id: "think",
			type: "reasoning",
			summary: [{ type: "summary_text", text: "partial thinking" }],
		},
		{
			id: "last",
			type: "message",
			content: [{ type: "refusal", text: "last partial" }],
		},
	];
	for (const [output_index, item] of items.entries())
		second.push(frame("response.output_item.added", { output_index, item }));
	const thinking = groups.last().getByRole("button", { name: /Thinking/ });
	await expect(thinking).toHaveAttribute("aria-expanded", "true");
	await expect(groups.last()).toContainText("partial thinking");
	await thinking.click();
	second.end();
	await expect(groups.last()).toContainText("Response 2 · Failed");
	await expect(thinking).toHaveAttribute("aria-expanded", "false");
	await expect(log).toContainText("first partial");
	await expect(log).toContainText("last partial");
	await expect(log.getByText("first partial", { exact: true })).toHaveCount(1);
	const response = groups
		.last()
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response 2/ }) });
	await response.locator("summary").click();
	await expect(response.locator("pre")).toContainText([
		"first partial",
		"partial thinking",
		"last partial",
	]);
	await expect(response).toContainText("HTTP 200");
	await page.reload();
	await expect(log.getByText("first partial", { exact: true })).toHaveCount(1);
	await expect(groups.first().locator("[data-output-index]")).toHaveCount(0);
	await expect(thinking).toHaveAttribute("aria-expanded", "false");
	await expect(response).not.toHaveAttribute("open", "");
	await expect(groups.last()).toContainText("Response 2 · Failed");
});
