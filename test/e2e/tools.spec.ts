import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completedBody, frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

test("a tool turn retains output and exposes both communications while Send stays busy", async ({
	page,
	app,
}) => {
	const folder = join(app.folder, "counted");
	await mkdir(folder);
	await writeFile(join(folder, "first"), "one");
	await writeFile(join(folder, "second"), "two");
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Work", folders: [folder] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Local count" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const first = app.rawStreamModel();
	const continuation = app.holdModel();
	await page.getByLabel("Prompt").fill("Count my files");
	const send = page.getByRole("button", { name: /^Send(?: \(.+\))?$/ });
	await send.click();
	const output = [
		{
			id: "reason",
			type: "reasoning",
			summary: [{ type: "summary_text", text: "Checking the local directory" }],
		},
		{
			id: "preface",
			type: "message",
			content: [{ type: "output_text", text: "I will count the files. " }],
		},
		{
			id: "tool",
			type: "function_call",
			name: "count_files",
			call_id: "count-1",
			arguments: JSON.stringify({ path: folder }),
		},
	];
	for (const [output_index, item] of output.entries())
		first.push(frame("response.output_item.added", { output_index, item }));
	const log = page.getByRole("log");
	await expect(log).toContainText("Checking the local directory");
	await expect(log).toContainText("I will count the files.");
	first.push(completedBody({ status: "completed", output }));
	first.end();
	await expect
		.poll(async () => {
			const history = await (
				await page.request.get(`${app.url}/api/chats/${chat.id}`)
			).json();
			const calls = await (
				await page.request.get(
					`${app.url}/api/turns/${history.turns[0].id}/calls?kind=request`,
				)
			).json();
			return calls.calls.length;
		})
		.toBe(2);
	await continuation.entered;
	await page.getByLabel("Prompt").fill("next draft");
	await expect(send).toBeDisabled();
	await expect(log).toContainText("Checking the local directory");
	await expect(log).toContainText("I will count the files.");
	const request = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Request$/ }) });
	const response = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response$/ }) });
	await request.locator("summary").click();
	await response.locator("summary").click();
	await expect(request).toContainText("function_call_output");
	await expect(request).toContainText("count-1");
	await expect(request).toContainText('\\"count\\":2');
	await expect(response).toContainText("count_files");
	continuation.release();
	await expect(log).toContainText("Test answer");
	await expect(log).toContainText("I will count the files.");
	await expect(send).toBeEnabled();
	await expect(request).toContainText("Model call #2");
	await expect(response).toContainText("Model call #2");
	await page.reload();
	await expect(log).toContainText("I will count the files.");
	await expect(log).toContainText("Test answer");
	await log.getByRole("button", { name: /Thinking/ }).click();
	await expect(log).toContainText("Checking the local directory");
});
