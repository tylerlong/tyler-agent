import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completedBody, frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

test("a tool agent retains output and exposes both communications while Send stays busy", async ({
	page,
	context,
	app,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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
			name: "list_files",
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
					`${app.url}/api/agents/${history.agents[0].id}/calls?kind=request`,
				)
			).json();
			return calls.calls.length;
		})
		.toBe(2);
	await continuation.entered;
	await page.getByLabel("Prompt").fill("next draft");
	await expect(send).toBeDisabled();
	await expect(log.getByRole("button", { name: /Reasoning/ })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await expect(log).toContainText("I will count the files.");
	const request = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Request 2$/ }) });
	const response = page
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Response 1/ }) });
	await request.locator("summary").click();
	await response.locator("summary").click();
	await expect(request).toContainText("function_call_output");
	await expect(request).toContainText("count-1");
	await expect(request).toContainText('\\"entries\\"');
	await expect(response).toContainText("list_files");
	await expect(
		request.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(0);
	const firstRequest = log
		.locator("details")
		.filter({ has: page.locator("summary", { hasText: /^Request 1$/ }) });
	await firstRequest.locator("summary").click();
	await firstRequest.getByRole("button", { name: "Copy", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(await firstRequest.locator(".communication-text").textContent());
	await expect(request).toHaveAttribute("open", "");
	await firstRequest.locator("summary").click();
	await expect(request).toHaveAttribute("open", "");
	continuation.release();
	await expect(log).toContainText("Test answer");
	await expect(log).toContainText("I will count the files.");
	await expect(send).toBeEnabled();
	expect(
		await log
			.locator("summary:not([data-output-index] summary), [data-output-index]")
			.evaluateAll((elements) =>
				elements.map((element) =>
					element.tagName === "SUMMARY"
						? element.querySelector("span > span")?.textContent
						: element.getAttribute("data-output-index"),
				),
			),
	).toEqual([
		"Request 1",
		"0",
		"1",
		"Response 1",
		"Tool Call · list_files",
		"Request 2",
		"0",
		"Response 2",
	]);
	await request.locator("summary").click();
	await response.locator("summary").click();
	await page.reload();
	await expect(log).toContainText("I will count the files.");
	await expect(log).toContainText("Test answer");
	await log.getByRole("button", { name: /Reasoning/ }).click();
	await expect(log).toContainText("Checking the local directory");
});

test("generic tool cards appear only after completed protocol and show waiting, running and unchanged results", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Tools", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Calls" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const first = app.rawStreamModel();
	const escaped = JSON.stringify('a "quote", \\ path: [x] {y}\nend');
	const success = app.holdTool({
		status: "succeeded",
		result:
			'{"error":"business field","nested":{"values":[null,3,true]},"path":"zkey","large":9007199254740993,"overflow":1e400,"duplicate":1,"duplicate":2,"text":' +
			escaped +
			"}",
	});
	const plain = app.holdTool({
		status: "succeeded",
		result: "not JSON\nraw text",
	});
	const empty = app.holdTool({ status: "succeeded", result: "" });
	const failure = app.holdTool({
		status: "failed",
		result: '{"error":"zkey failure","extra":7}',
	});
	const output = ["write_file", "edit_file", "move_path", "delete_path"].map(
		(name, index) => ({
			id: `tool-${index}`,
			type: "function_call",
			name,
			call_id: `call-${index}`,
			arguments: JSON.stringify({ index, key: "zkey", nested: [false, null] }),
		}),
	);
	await page.getByLabel("Prompt").fill("Run tools");
	await page.getByRole("button", { name: /^Send/ }).click();
	for (const [output_index, item] of output.entries())
		first.push(frame("response.output_item.added", { output_index, item }));
	await expect(page.locator("[data-tool-call-id]")).toHaveCount(0);
	first.push(completedBody({ status: "completed", output }));
	first.end();
	await success.entered;
	const cards = page.locator("[data-tool-call-id]");
	await expect(cards).toHaveCount(4);
	const inspect = cards.nth(0);
	await expect(inspect).not.toHaveAttribute("open");
	await inspect.locator("summary").click();
	await expect(inspect).toHaveAttribute("open", "");
	await expect(inspect).toContainText('"key": "[REDACTED]"');
	await expect(inspect.getByRole("status")).toHaveCount(2);
	await expect(cards.nth(1).locator("summary")).toContainText("Waiting");
	await expect(cards.nth(2).locator("summary")).toContainText("Waiting");
	await expect(page.getByRole("button", { name: /^Send/ })).toBeDisabled();
	await inspect.locator("summary").click();
	await expect(inspect).not.toHaveAttribute("open");
	success.release();
	await plain.entered;
	await expect(inspect.locator("summary")).toHaveText("Tool Call · write_file");
	await expect(inspect).not.toHaveAttribute("open");
	await inspect.locator("summary").click();
	await expect(inspect).toContainText('"error": "business field"');
	await expect(inspect).toContainText('"path": "[REDACTED]"');
	await expect(inspect).toContainText('"large": 9007199254740993');
	await expect(inspect).toContainText('"overflow": 1e400');
	await expect(inspect).toContainText('"duplicate": 1');
	await expect(inspect).toContainText('"duplicate": 2');
	await expect(inspect).toContainText(`"text": ${escaped}`);
	await expect(inspect).not.toContainText("Completed");
	await expect(inspect).not.toContainText("zkey");
	plain.release();
	await empty.entered;
	await cards.nth(1).locator("summary").click();
	await expect(cards.nth(1)).toContainText("not JSON\nraw text");
	empty.release();
	await failure.entered;
	failure.release();
	await expect(cards.nth(3).locator("summary")).toHaveText(
		"Tool Call · delete_path · Failed",
	);
	await cards.nth(3).locator("summary").click();
	await expect(cards.nth(3)).toContainText('"error": "[REDACTED] failure"');
	await expect(cards.nth(3)).toContainText('"extra": 7');
	await expect(page.getByRole("log")).toContainText("Test answer");
	const order = await page
		.getByRole("log")
		.locator("summary")
		.allTextContents();
	expect(order).toEqual([
		"Request 1",
		"Response 1",
		"Tool Call · write_file",
		"Tool Call · edit_file",
		"Tool Call · move_path",
		"Tool Call · delete_path · Failed",
		"Request 2",
		"Response 2",
	]);
	await app.restart();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	await expect(page.locator("[data-tool-call-id]")).toHaveCount(4);
	await page.locator("[data-tool-call-id]").nth(0).locator("summary").click();
	await page.locator("[data-tool-call-id]").nth(2).locator("summary").click();
	await expect(page.locator("[data-tool-call-id]").nth(0)).toContainText(
		'"error": "business field"',
	);
	await expect(
		page.locator("[data-tool-call-id]").nth(2).locator("pre").nth(1),
	).toHaveText("");
});
