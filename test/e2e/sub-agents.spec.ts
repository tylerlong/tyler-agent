import { completedBody, frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

const answer = (text: string) => ({
	id: "answer",
	type: "message",
	content: [{ type: "output_text", text }],
});

test("parallel delegation exposes complete creation cards and preserves root history and busy", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Delegation", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Arithmetic" },
		})
	).json();
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const root = app.rawStreamModel();
	const first = app.rawStreamModel();
	const second = app.rawStreamModel();
	const beforeEvents = app.rawStreamModel();
	await page
		.getByLabel("Prompt")
		.fill("Delegate two blind calculations and add their results");
	const send = page.getByRole("button", { name: /^Send/ });
	await send.click();
	root.push(
		completedBody({
			output: ["1 + 2", "3 + 4"].map((prompt, index) => ({
				id: `creation-${index}`,
				type: "function_call",
				name: "create_sub_agent",
				call_id: `create-${index}`,
				arguments: JSON.stringify({
					prompt,
					model_id: "test",
					reasoning_effort: index === 0 ? "high" : null,
				}),
			})),
		}),
	);
	root.end();
	await expect
		.poll(async () => {
			const history = await (
				await page.request.get(`${app.url}/api/chats/${chat.id}`)
			).json();
			if (!history.agents[0]) return 0;
			const tools = await (
				await page.request.get(
					`${app.url}/api/agents/${history.agents[0].id}/tools`,
				)
			).json();
			if (
				tools.toolCalls.length !== 2 ||
				tools.toolCalls.some((tool: { result: string | null }) => !tool.result)
			)
				return 0;
			const children = await Promise.all(
				tools.toolCalls.map(async (tool: { result: string }) =>
					(
						await page.request.get(
							`${app.url}/api/agents/${JSON.parse(tool.result).agent_id}/calls`,
						)
					).json(),
				),
			);
			return children.filter((child) => child.calls.length === 1).length;
		})
		.toBe(2);
	const cards = page.locator("[data-tool-call-id]");
	const overviews = page.locator("[data-child-agent-id]");
	await expect(overviews).toHaveCount(2);
	await expect(overviews.nth(0)).toContainText("1 + 2");
	await expect(overviews.nth(1)).toContainText("3 + 4");
	await expect(overviews.nth(0)).toContainText("In progress");
	await expect(cards).toHaveCount(2);
	for (const [index, prompt] of ["1 + 2", "3 + 4"].entries()) {
		await expect(cards.nth(index)).not.toHaveAttribute("open");
		await cards.nth(index).locator("summary").click();
		await expect(cards.nth(index)).toContainText(prompt);
		await expect(cards.nth(index)).toContainText('"model_id": "test"');
		await expect(cards.nth(index)).toContainText(
			index === 0 ? '"reasoning_effort": "high"' : '"reasoning_effort": null',
		);
		await expect(cards.nth(index)).toContainText('"agent_id"');
		await expect(cards.nth(index)).toContainText('"status": "pending"');
	}
	await page.getByLabel("Prompt").fill("next request");
	await expect(send).toBeDisabled();
	const afterEvents = app.rawStreamModel();
	first.push(completedBody({ output: [answer("3")] }));
	first.end();
	second.push(completedBody({ output: [answer("7")] }));
	second.end();
	await expect
		.poll(async () => {
			const history = await (
				await page.request.get(`${app.url}/api/chats/${chat.id}`)
			).json();
			const tools = await (
				await page.request.get(
					`${app.url}/api/agents/${history.agents[0].id}/tools`,
				)
			).json();
			const children = await Promise.all(
				tools.toolCalls.map(async (tool: { result: string }) =>
					(
						await page.request.get(
							`${app.url}/api/agents/${JSON.parse(tool.result).agent_id}`,
						)
					).json(),
				),
			);
			return children.filter((child) => child.agents[0].status === "succeeded")
				.length;
		})
		.toBe(2);
	beforeEvents.push(
		completedBody({ output: [answer("Preparing final result")] }),
	);
	beforeEvents.end();
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
			return calls.calls.at(-1)?.requestBody ?? "";
		})
		.toContain("sub-agent terminal result");
	afterEvents.push(completedBody({ output: [answer("10")] }));
	afterEvents.end();
	await expect(page.getByRole("log")).toContainText("10");
	await expect(overviews.nth(0).locator("[data-child-preview]")).toHaveText(
		"3",
	);
	await expect(overviews.nth(1).locator("[data-child-preview]")).toHaveText(
		"7",
	);
	await expect(overviews.nth(0)).toContainText("Succeeded");
	await expect(cards.nth(0)).toContainText('"status": "pending"');
	await cards.nth(0).locator("summary").click();
	await overviews.nth(0).getByRole("button").click();
	await expect(page).toHaveURL(/agent=\d+/);
	await expect(
		page.getByRole("region", { name: "Agent details", exact: true }),
	).toContainText("1 + 2");
	await page.getByRole("button", { name: "Back to chat", exact: true }).click();
	await expect(cards.nth(0)).not.toHaveAttribute("open");
	await expect(overviews.nth(0).locator("[data-child-preview]")).toHaveText(
		"3",
	);
	app.disconnectClients();
	await expect(overviews.nth(1).locator("[data-child-preview]")).toHaveText(
		"7",
	);
	await expect(send).toBeEnabled();
	const history = await (
		await page.request.get(`${app.url}/api/chats/${chat.id}`)
	).json();
	expect(history.agents).toHaveLength(1);
	expect(history.agents[0].status).toBe("succeeded");
	await page.reload();
	await expect(page.locator("[data-tool-call-id]")).toHaveCount(2);
	await expect(page.getByRole("log")).toContainText("10");
});

for (const language of ["en", "zh-CN"]) {
	test(`creation overviews retain partial lifecycle states and bound long text (${language})`, async ({
		page,
		app,
	}) => {
		await page.request.put(`${app.url}/api/language`, { data: { language } });
		const project = await (
			await page.request.post(`${app.url}/api/projects`, {
				data: { name: "Child overview", folders: [] },
			})
		).json();
		const chat = await (
			await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
				data: { name: "Lifecycle" },
			})
		).json();
		const root = app.rawStreamModel();
		const failed = app.rawStreamModel();
		const cancelled = app.rawStreamModel();
		const succeeded = app.rawStreamModel();
		app.rawStreamModel();
		const { agentId } = await (
			await page.request.post(`${app.url}/api/chats/${chat.id}`, {
				data: { prompt: "Delegate complex work" },
			})
		).json();
		const prompts = [
			"Failure task",
			"Cancelled task",
			`${"Complex English 中文 ".repeat(20)}\nMore prompt`,
		];
		root.push(
			completedBody({
				output: prompts.map((prompt, index) => ({
					id: `create-${index}`,
					type: "function_call",
					name: "create_sub_agent",
					call_id: `create-${index}`,
					arguments: JSON.stringify({ prompt }),
				})),
			}),
		);
		root.end();
		await page.goto(`${app.url}/?chat=${chat.id}`);
		const overviews = page.locator("[data-child-agent-id]");
		await expect(overviews).toHaveCount(3);
		await expect(overviews.nth(2)).toContainText("…");
		await expect(overviews.nth(2)).not.toContainText("More prompt");
		const streamPartial = (stream: typeof failed, text: string) =>
			stream.push(
				frame("response.output_text.delta", {
					item_id: "partial",
					output_index: 0,
					content_index: 0,
					delta: text,
				}),
			);
		streamPartial(failed, "Failed partial text");
		failed.push(
			frame("response.failed", {
				response: { error: { message: "Actual child failure" } },
			}),
		);
		failed.end();
		streamPartial(cancelled, "Cancelled partial text");
		const cancelledId = await overviews
			.nth(1)
			.getAttribute("data-child-agent-id");
		await expect
			.poll(
				async () =>
					(
						await (
							await page.request.get(`${app.url}/api/agents/${cancelledId}`)
						).json()
					).agents[0].answer,
			)
			.toBe("Cancelled partial text");
		await page.request.post(`${app.url}/api/agents/${cancelledId}/cancel`);
		streamPartial(succeeded, "Discarded provisional result");
		const long =
			"# Full result\n" +
			"Long original result English 中文 words ".repeat(60) +
			"\nEnd of full result";
		succeeded.push(completedBody({ output: [answer(long)] }));
		succeeded.end();
		await expect(overviews.nth(0)).toContainText(
			language === "en" ? "Failed" : "失败",
		);
		await expect(overviews.nth(1)).toContainText(
			language === "en" ? "Cancelled" : "已取消",
		);
		await expect(overviews.nth(0)).toContainText(
			language === "en" ? "Incomplete" : "不完整",
		);
		await expect(overviews.nth(0).locator("[data-child-preview]")).toHaveText(
			"Failed partial text",
		);
		await expect(overviews.nth(1).locator("[data-child-preview]")).toHaveText(
			"Cancelled partial text",
		);
		await expect(overviews.nth(2)).not.toContainText(
			"Discarded provisional result",
		);
		const preview = overviews.nth(2).locator("[data-child-preview]");
		await expect(preview).toContainText("# Full result");
		expect(
			await preview.evaluate(
				(element) =>
					element.getBoundingClientRect().height <=
					parseFloat(getComputedStyle(element).lineHeight) * 2 + 1,
			),
		).toBe(true);
		await page.screenshot({
			path: `/tmp/worker136-${language}.png`,
			fullPage: true,
		});
		await overviews.nth(0).getByRole("button").click();
		await page
			.getByRole("region", {
				name: language === "en" ? "Agent details" : "Agent 详情",
				exact: true,
			})
			.locator("summary")
			.filter({ hasText: language === "en" ? "Response 1" : "响应 1" })
			.click();
		await expect(
			page.getByRole("region", {
				name: language === "en" ? "Agent details" : "Agent 详情",
				exact: true,
			}),
		).toContainText("Actual child failure");
		await page
			.getByRole("button", {
				name: language === "en" ? "Back to chat" : "返回对话",
				exact: true,
			})
			.click();
		await overviews.nth(2).getByRole("button").click();
		await expect(
			page.getByRole("region", {
				name: language === "en" ? "Agent details" : "Agent 详情",
				exact: true,
			}),
		).toContainText("End of full result");
		await page.reload();
		await expect(
			page.getByRole("region", {
				name: language === "en" ? "Agent details" : "Agent 详情",
				exact: true,
			}),
		).toContainText("More prompt");
		await page.request.post(`${app.url}/api/agents/${agentId}/cancel`);
	});
}
