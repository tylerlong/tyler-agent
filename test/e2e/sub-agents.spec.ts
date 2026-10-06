import { completedBody } from "../model-fixture.ts";
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
				arguments: JSON.stringify({ prompt }),
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
	await expect(cards).toHaveCount(2);
	for (const [index, prompt] of ["1 + 2", "3 + 4"].entries()) {
		await expect(cards.nth(index)).not.toHaveAttribute("open");
		await cards.nth(index).locator("summary").click();
		await expect(cards.nth(index)).toContainText(prompt);
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
