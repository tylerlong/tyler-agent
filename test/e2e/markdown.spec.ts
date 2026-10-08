import { completedBody, frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

const markdown = `## Result 结果

Ordinary **strong** and *emphasis* prose.

- first item
- 第二项

1. ordered item

[Safe link](https://example.com) [Unsafe link](javascript:alert(1))

<script>window.markdownExecuted = true</script>
<img src=x onerror="window.markdownExecuted = true">

\`\`\`ts
const result = 10;
\`\`\`

| Task | Result |
| --- | --- |
| 子任务 | 10 |`;
const output = (text: string) => [
	{
		id: "reason",
		type: "reasoning",
		content: [{ type: "reasoning_text", text }],
	},
	{ id: "answer", type: "message", content: [{ type: "output_text", text }] },
];

for (const child of [false, true]) {
	test(`${child ? "child" : "root"} Markdown stays live, accepts final authority and preserves source records`, async ({
		page,
		app,
	}) => {
		const headers = { Origin: app.url };
		await page.setViewportSize(
			child ? { width: 1600, height: 900 } : { width: 1280, height: 720 },
		);
		if (child)
			await page.request.put(`${app.url}/api/language`, {
				headers,
				data: { language: "zh-CN" },
			});
		const project = await (
			await page.request.post(`${app.url}/api/projects`, {
				headers,
				data: { name: "Markdown", folders: [] },
			})
		).json();
		const chat = await (
			await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
				headers,
				data: { name: "Read output" },
			})
		).json();
		const rootStream = app.rawStreamModel();
		const childStream = child ? app.rawStreamModel() : undefined;
		if (child) app.rawStreamModel(); // Parent continuation awaits its own cancellation.
		const accepted = await (
			await page.request.post(`${app.url}/api/chats/${chat.id}`, {
				headers,
				data: { prompt: "Read **original** prompt" },
			})
		).json();
		let agentId = accepted.agentId;
		if (child) {
			rootStream.push(
				completedBody({
					output: [
						{
							id: "create",
							type: "function_call",
							name: "create_sub_agent",
							call_id: "create",
							arguments: JSON.stringify({
								prompt: "Child **original** prompt",
							}),
						},
					],
				}),
			);
			rootStream.end();
			await expect
				.poll(async () => {
					const tools = await (
						await page.request.get(
							`${app.url}/api/agents/${accepted.agentId}/tools`,
						)
					).json();
					agentId = tools.toolCalls[0]?.result
						? JSON.parse(tools.toolCalls[0].result).agent_id
						: 0;
					return agentId;
				})
				.toBeGreaterThan(0);
		}
		const stream = childStream ?? rootStream;
		await page.goto(
			`${app.url}/?chat=${chat.id}${child ? `&agent=${agentId}` : ""}`,
		);
		const view = child
			? page.getByRole("region", {
					name: child ? "Agent 详情" : "Agent details",
					exact: true,
				})
			: page.getByRole("log");
		for (const [output_index, item] of output(
			"## Live draft\n\n- provisional item",
		).entries()) {
			stream.push(frame("response.output_item.added", { output_index, item }));
		}
		await expect(view.getByRole("heading", { name: "Live draft" })).toHaveCount(
			2,
		);
		const reasoning = view
			.getByRole("button", { name: /^(Reasoning|推理)/ })
			.first();
		await reasoning.click();
		await reasoning.click(); // Explicit open choice survives final replacement.
		stream.push(
			frame("response.output_text.delta", {
				output_index: 1,
				content_index: 0,
				item_id: "answer",
				delta: "\n- live growth",
			}),
		);
		await expect(view.getByText("live growth", { exact: true })).toBeVisible();
		stream.push(completedBody({ output: output(markdown) }));
		stream.end();
		await expect(
			view.getByRole("heading", { name: "Result 结果" }),
		).toHaveCount(2);
		await expect(view.getByRole("heading", { name: "Live draft" })).toHaveCount(
			0,
		);
		await expect(view.locator("li").filter({ hasText: "第二项" })).toHaveCount(
			2,
		);
		await expect(
			view.locator("strong").filter({ hasText: /^strong$/ }),
		).toHaveCount(2);
		await expect(
			view.locator("em").filter({ hasText: /^emphasis$/ }),
		).toHaveCount(2);
		await expect(view.locator("pre code")).toHaveCount(2);
		await expect(
			view.getByRole("cell", { name: "子任务", exact: true }),
		).toHaveCount(2);
		await expect(
			view.getByRole("link", { name: "Safe link", exact: true }).first(),
		).toHaveAttribute("href", "https://example.com");
		for (const link of await view
			.getByText("Unsafe link", { exact: true })
			.all())
			await expect(link).not.toHaveAttribute("href", /javascript:/);
		await expect(view.locator("script, img[onerror]")).toHaveCount(0);
		expect(
			await page.evaluate(() => Reflect.get(window, "markdownExecuted")),
		).toBeUndefined();
		await page.mouse.move(1000, 550);
		await page.mouse.wheel(0, 500);

		const response = view.getByText(child ? "响应 1" : "Response 1", {
			exact: true,
		});
		await response.click();
		const record = response.locator("xpath=ancestor::details");
		await expect(record).toContainText("**strong**");
		await expect(record.locator("table")).toHaveCount(0);
		await page.evaluate(() =>
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async (value: string) =>
						Reflect.set(window, "copiedSource", value),
				},
			}),
		);
		await record
			.getByRole("button", { name: child ? "复制" : "Copy", exact: true })
			.click();
		const copied = await page.evaluate(() =>
			Reflect.get(window, "copiedSource"),
		);
		expect(copied).toContain(JSON.stringify(markdown).slice(1, -1));
		const calls = await (
			await page.request.get(
				`${app.url}/api/agents/${agentId}/calls?kind=response`,
			)
		).json();
		expect(JSON.parse(calls.calls[0].responseBody).output).toEqual(
			output(markdown),
		);
		if (child) {
			await page.getByRole("button", { name: "返回对话", exact: true }).click();
			const tool = page.locator("[data-tool-call-id]").first();
			await tool.locator("summary").click();
			await expect(tool).toContainText("Child **original** prompt");
			await expect(tool.locator("pre").first()).toContainText(
				"Child **original** prompt",
			);
			await tool.getByRole("button", { name: "复制", exact: true }).click();
			expect(
				await page.evaluate(() => Reflect.get(window, "copiedSource")),
			).toContain("Child **original** prompt");
		}
		await page.request.post(
			`${app.url}/api/agents/${accepted.agentId}/cancel`,
			{ headers },
		);
	});
}
