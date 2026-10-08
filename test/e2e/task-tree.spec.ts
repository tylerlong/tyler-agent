import type { Page } from "@playwright/test";
import { completedBody, frame } from "../model-fixture.ts";
import { expect, test } from "./fixtures.ts";

const answer = (text: string) => ({
	id: "same-answer",
	type: "message",
	content: [{ type: "output_text", text }],
});
const creation = (prompt: string, context = "") => ({
	id: prompt,
	type: "function_call",
	name: "create_sub_agent",
	call_id: prompt,
	arguments: JSON.stringify({
		prompt,
		context,
		model_id: "test",
		reasoning_effort: "high",
	}),
});
function partial(stream: { push: (text: string) => void }, text: string) {
	stream.push(
		frame("response.output_item.added", {
			output_index: 0,
			item: { id: "same-answer", type: "message", content: [] },
		}),
	);
	stream.push(
		frame("response.output_text.delta", {
			item_id: "same-answer",
			output_index: 0,
			content_index: 0,
			delta: text,
		}),
	);
}
async function children(page: Page, url: string, id: number, count: number) {
	let ids: number[] = [];
	await expect
		.poll(async () => {
			const data = await (
				await page.request.get(`${url}/api/agents/${id}/tools`)
			).json();
			ids = data.toolCalls
				.filter((tool: { result: string | null }) => tool.result)
				.map((tool: { result: string }) => JSON.parse(tool.result).agent_id);
			if (ids.length !== count) return 0;
			const calls = await Promise.all(
				ids.map(async (child) =>
					(await page.request.get(`${url}/api/agents/${child}/calls`)).json(),
				),
			);
			return calls.filter((child) => child.calls.length > 0).length;
		})
		.toBe(count);
	return ids;
}

for (const language of ["en", "zh-CN"]) {
	const zh = language === "zh-CN";
	const labels = {
		tree: zh ? "任务树" : "Task tree",
		detail: zh ? "Agent 详情" : "Agent details",
		path: zh ? "任务路径" : "Task path",
		siblings: zh ? "兄弟任务" : "Sibling agents",
		back: zh ? "返回对话" : "Back to chat",
		stop: zh ? "停止" : "Stop",
		parameters: zh ? "创建参数" : "Creation parameters",
		pending: zh ? "进行中" : "In progress",
		succeeded: zh ? "成功" : "Succeeded",
		failed: zh ? "失败" : "Failed",
		cancelled: zh ? "已取消" : "Cancelled",
	};
	for (const archived of [false, true]) {
		test(`task tree ${language}: ${archived ? "archived subtree stop" : "recursive navigation, streams and recovery"}`, async ({
			page,
			context,
			app,
		}) => {
			await context.grantPermissions(["clipboard-read", "clipboard-write"]);
			await page.setViewportSize({ width: 1280, height: 720 });
			await page.request.put(`${app.url}/api/language`, { data: { language } });
			const project = await (
				await page.request.post(`${app.url}/api/projects`, {
					data: { name: "Delegation", folders: [] },
				})
			).json();
			const chat = await (
				await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
					data: { name: "Task navigation" },
				})
			).json();
			const root = app.rawStreamModel();
			const branch = app.rawStreamModel();
			const sibling = app.rawStreamModel();
			const failed = app.rawStreamModel();
			app.rawStreamModel(); // Keep the root's continuation in flight while inspecting children.
			const accepted = await (
				await page.request.post(`${app.url}/api/chats/${chat.id}`, {
					data: {
						prompt:
							"Root delegation\n" +
							Array.from(
								{ length: 40 },
								(_, i) => `Root context line ${i}`,
							).join("\n"),
						modelId: "test",
					},
				})
			).json();
			root.push(
				completedBody({
					output: [
						creation("Branch\nFull branch prompt", "Explicit branch context"),
						creation("Sibling"),
						creation("Failed child"),
					],
				}),
			);
			root.end();
			const [branchId, siblingId, failedId] = await children(
				page,
				app.url,
				accepted.agentId,
				3,
			);
			const grandchild = app.rawStreamModel();
			app.rawStreamModel(); // Branch continuation remains pending until explicitly stopped.
			branch.push(
				completedBody({
					output: [
						creation(
							"Deep task\nComplete deep prompt",
							"Explicit deep context\n" +
								Array.from({ length: 40 }, (_, i) => `Context line ${i}`).join(
									"\n",
								),
						),
					],
				}),
			);
			branch.end();
			const [deepId] = await children(page, app.url, branchId, 1);
			partial(grandchild, "Deep partial output");
			partial(sibling, "Sibling partial output");
			failed.push(
				frame("response.failed", {
					response: { error: { message: "Controlled failure" } },
				}),
			);
			failed.end();
			let communicationReads = 0;
			page.on("request", (request) => {
				if (/\/calls\?kind=/.test(request.url())) communicationReads++;
			});
			await page.goto(`${app.url}/?chat=${chat.id}`);
			const chatView = page.getByRole("region", {
				name: zh ? "对话" : "Chat",
				exact: true,
			});
			await expect(page.getByRole("log")).toContainText("Root context line 39");
			await chatView.evaluate((element) => {
				element.scrollTop = 240;
				element.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
			const rootReadingTop = await chatView.evaluate(
				(element) => element.scrollTop,
			);
			expect(rootReadingTop).toBeGreaterThan(0);
			await page
				.getByRole("button", { name: labels.tree, exact: true })
				.evaluate((element: HTMLButtonElement) => element.click());
			await page
				.getByRole("button", { name: labels.back, exact: true })
				.click();
			await expect
				.poll(() => chatView.evaluate((element) => element.scrollTop))
				.toBe(rootReadingTop);

			await page
				.getByRole("button", { name: labels.tree, exact: true })
				.evaluate((element: HTMLButtonElement) => element.click());
			const tree = page.getByRole("region", { name: labels.tree, exact: true });
			const detail = page.getByRole("region", {
				name: labels.detail,
				exact: true,
			});
			await expect(
				tree.getByRole("button", {
					name: new RegExp(`#${failedId} Failed child.*${labels.failed}`),
				}),
			).toBeVisible();
			const branchNode = tree.getByRole("button", {
				name: new RegExp(`#${branchId} Branch`),
			});
			await branchNode.click();
			await expect(detail).toContainText("Full branch prompt");
			await expect(detail).toContainText("Explicit branch context");
			await detail.locator("summary", { hasText: labels.parameters }).click();
			await expect(detail).toContainText('"reasoning_effort": "high"');
			await expect(detail).toContainText('"model_id": "test"');
			const creationCard = detail.locator("[data-tool-call-id]");
			await expect(creationCard).not.toHaveAttribute("open");
			await creationCard.locator("summary").click();
			await expect(creationCard.locator("pre").nth(1)).toContainText(
				`"agent_id": ${deepId}`,
			);
			await expect(creationCard.locator("pre").nth(1)).toContainText(
				'"status": "pending"',
			);
			await creationCard
				.getByRole("button", { name: zh ? "复制" : "Copy", exact: true })
				.click();
			await expect
				.poll(() => page.evaluate(() => navigator.clipboard.readText()))
				.toBe(await creationCard.locator(".communication-text").textContent());

			await expect(
				page.getByRole("textbox", {
					name: zh ? "提示词" : "Prompt",
					exact: true,
				}),
			).toHaveCount(0);
			const branchDisclosure = tree
				.locator("details")
				.filter({
					has: page.getByRole("button", {
						name: new RegExp(`#${branchId} Branch`),
					}),
				})
				.last();
			if ((await branchDisclosure.getAttribute("open")) === null)
				await branchDisclosure.locator(":scope > summary").click();
			await creationCard.locator("summary").click();
			await expect(creationCard).not.toHaveAttribute("open");
			await detail
				.locator(`[data-child-agent-id="${deepId}"] > button`)
				.click();
			await expect(detail).toContainText("Complete deep prompt");
			await expect(detail).toContainText("Explicit deep context");
			await expect(detail).toContainText("Deep partial output");
			await expect(detail).not.toContainText("Sibling partial output");
			await page.screenshot({
				path: `/tmp/task-tree-${language}.png`,
				fullPage: true,
			});
			await expect(page).toHaveURL(new RegExp(`agent=${deepId}`));
			await expect(
				page.getByRole("navigation", { name: labels.path }),
			).toContainText("Branch");
			expect(communicationReads).toBe(0);
			const request = detail.locator("details").filter({
				has: page.locator("summary", { hasText: /^(Request|请求) \d+$/ }),
			});
			await request.locator("summary").click();
			await expect(request.locator("pre")).toContainText(
				"Explicit deep context",
			);
			expect(communicationReads).toBeGreaterThan(0);
			await page.reload();
			await expect(detail).toContainText("Deep partial output");
			await expect(page).toHaveURL(new RegExp(`agent=${deepId}`));
			app.disconnectClients();
			grandchild.push(
				frame("response.output_text.delta", {
					item_id: "same-answer",
					output_index: 0,
					content_index: 0,
					delta: " Reconnect deep output",
				}),
			);
			await expect(detail).toContainText("Reconnect deep output");
			await detail.evaluate((element) => {
				element.scrollTop = 420;
				element.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
			const readingTop = await detail.evaluate((element) => element.scrollTop);
			expect(readingTop).toBeGreaterThan(0);
			grandchild.push(
				frame("response.output_text.delta", {
					item_id: "same-answer",
					output_index: 0,
					content_index: 0,
					delta: " Stable reading update",
				}),
			);
			await expect(detail).toContainText("Stable reading update");
			await expect
				.poll(() => detail.evaluate((element) => element.scrollTop))
				.toBe(readingTop);
			await tree
				.getByRole("button", { name: new RegExp(`#${branchId} Branch`) })
				.evaluate((element: HTMLButtonElement) => element.click());
			await expect(detail).toContainText("Full branch prompt");
			await tree
				.getByRole("button", { name: new RegExp(`#${deepId} Deep task`) })
				.evaluate((element: HTMLButtonElement) => element.click());
			await expect(detail).toContainText("Complete deep prompt");
			await expect
				.poll(() => detail.evaluate((element) => element.scrollTop))
				.toBe(readingTop);

			// An earlier streaming item grows above the item currently being read.
			grandchild.push(
				frame("response.output_item.added", {
					output_index: 1,
					item: { id: "later-answer", type: "message", content: [] },
				}),
			);
			grandchild.push(
				frame("response.output_text.delta", {
					item_id: "later-answer",
					output_index: 1,
					content_index: 0,
					delta: Array.from(
						{ length: 50 },
						(_, i) => `Later output line ${i}`,
					).join("\n"),
				}),
			);
			await expect(detail).toContainText("Later output line 49");
			const laterOutput = detail.locator(
				'[data-output-index="1"] > [data-reading-anchor]',
			);
			await laterOutput.evaluate((element) => {
				const scroller = element.closest("section");
				if (!scroller) throw new Error("Missing detail scroller");
				scroller.scrollTop +=
					element.getBoundingClientRect().top -
					scroller.getBoundingClientRect().top +
					100;
				scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
			const outputOffset = () =>
				laterOutput.evaluate((element) => {
					const scroller = element.closest("section");
					if (!scroller) throw new Error("Missing detail scroller");
					return (
						element.getBoundingClientRect().top -
						scroller.getBoundingClientRect().top
					);
				});
			const savedOutputOffset = await outputOffset();
			expect(savedOutputOffset).toBe(-100);
			const beforeExpansion = await detail.evaluate(
				(element) => element.scrollTop,
			);
			grandchild.push(
				frame("response.output_text.delta", {
					item_id: "same-answer",
					output_index: 0,
					content_index: 0,
					delta:
						"\n" +
						Array.from(
							{ length: 30 },
							(_, i) => `Earlier output expansion ${i}`,
						).join("\n"),
				}),
			);
			await expect(detail).toContainText("Earlier output expansion 29");
			await expect.poll(outputOffset).toBe(savedOutputOffset);
			expect(
				await detail.evaluate((element) => element.scrollTop),
			).toBeGreaterThan(beforeExpansion);

			await page
				.getByRole("navigation", { name: labels.path })
				.getByRole("button", { name: new RegExp(`#${branchId} Branch`) })
				.click();
			await page
				.getByRole("navigation", { name: labels.siblings })
				.getByRole("button", { name: new RegExp(`#${siblingId} Sibling`) })
				.click();
			await expect(detail).toContainText("Sibling partial output");
			await expect(detail).not.toContainText("Deep partial output");
			sibling.push(completedBody({ output: [answer("Sibling completed")] }));
			sibling.end();
			await expect(
				tree.getByRole("button", {
					name: new RegExp(`#${siblingId} Sibling.*${labels.succeeded}`),
				}),
			).toBeVisible();
			await expect(
				tree.getByRole("button", {
					name: new RegExp(
						`#${accepted.agentId} Root delegation.*${labels.pending}`,
					),
				}),
			).toBeVisible();
			await tree
				.getByRole("button", { name: new RegExp(`#${branchId} Branch`) })
				.click();
			if (archived)
				await page.request.put(`${app.url}/api/chats/${chat.id}/archive`, {
					data: { archived: true },
				});
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route(`**/api/agents/${branchId}/cancel`, async (route) => {
				await gate;
				await route.continue();
			});
			const stop = detail.getByRole("button", {
				name: labels.stop,
				exact: true,
			});
			await stop.click();
			await expect(stop).toBeDisabled();
			await expect(
				tree.getByRole("button", {
					name: new RegExp(`#${branchId} Branch.*${labels.pending}`),
				}),
			).toBeVisible();
			release();
			await expect(
				tree.getByRole("button", {
					name: new RegExp(`#${branchId} Branch.*${labels.cancelled}`),
				}),
			).toBeVisible();
			if ((await branchDisclosure.getAttribute("open")) === null)
				await branchDisclosure.locator(":scope > summary").click();
			await tree
				.getByRole("button", { name: new RegExp(`#${deepId} Deep task`) })
				.click();
			await expect(detail).toContainText("Deep partial output");
			await expect(
				tree.getByRole("button", {
					name: new RegExp(`#${deepId} Deep task.*${labels.cancelled}`),
				}),
			).toBeVisible();
			await page
				.getByRole("button", { name: labels.back, exact: true })
				.click();
			await expect(page).not.toHaveURL(/agent=/);
			const history = await (
				await page.request.get(`${app.url}/api/chats/${chat.id}`)
			).json();
			expect(history.agents).toHaveLength(1);
			expect(history.agents[0].status).toBe("pending");
			if (archived) await expect(page.getByRole("textbox")).toHaveCount(0);
			else
				await expect(
					page.getByRole("button", { name: /^(Send|发送)/ }),
				).toBeDisabled();
			await page.request.post(
				`${app.url}/api/agents/${accepted.agentId}/cancel`,
			);
		});
	}
}

test("task preview keeps newer terminal data when an old unmounted read finishes", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Cache", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Read race" },
		})
	).json();
	const root = app.rawStreamModel();
	const child = app.rawStreamModel();
	app.rawStreamModel();
	const accepted = await (
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { prompt: "Root cache task" },
		})
	).json();
	root.push(completedBody({ output: [creation("Cache child")] }));
	root.end();
	const [childId] = await children(page, app.url, accepted.agentId, 1);
	partial(child, "Old partial preview");
	let releaseOld!: () => void, oldEntered!: () => void;
	const oldGate = new Promise<void>((resolve) => {
		releaseOld = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		oldEntered = resolve;
	});
	let releaseFresh!: () => void, freshEntered!: () => void;
	const freshGate = new Promise<void>((resolve) => {
		releaseFresh = resolve;
	});
	const freshStarted = new Promise<void>((resolve) => {
		freshEntered = resolve;
	});
	let phase: "old" | "current" | "preview" = "old";
	const oldReads: Promise<void>[] = [];
	await page.route(`**/api/agents/${childId}`, async (route) => {
		const readPhase = phase;
		const response = await route.fetch();
		if (readPhase === "old") {
			let done!: () => void;
			oldReads.push(
				new Promise<void>((resolve) => {
					done = resolve;
				}),
			);
			oldEntered();
			await oldGate;
			await route.fulfill({ response });
			done();
		} else if (readPhase === "preview") {
			freshEntered();
			await freshGate;
			await route.fulfill({ response });
		} else await route.fulfill({ response });
	});
	try {
		await page.goto(`${app.url}/?chat=${chat.id}&agent=${childId}`);
		await entered;
		const back = page.getByRole("button", {
			name: "Back to chat",
			exact: true,
		});
		await back.click();
		phase = "current";
		child.push(completedBody({ output: [answer("New terminal result")] }));
		child.end();
		await expect
			.poll(
				async () =>
					(
						await (
							await page.request.get(`${app.url}/api/agents/${childId}`)
						).json()
					).agents[0].status,
			)
			.toBe("succeeded");
		const reopen = async () => {
			await page
				.getByRole("button", { name: "Task tree", exact: true })
				.click();
			await page
				.getByRole("region", { name: "Task tree", exact: true })
				.getByRole("button", { name: new RegExp(`#${childId} Cache child`) })
				.click();
		};
		await reopen();
		const detail = page.getByRole("region", {
			name: "Agent details",
			exact: true,
		});
		await expect(detail).toContainText("New terminal result");
		releaseOld();
		await Promise.all(oldReads);
		// A completed same-origin fetch follows the held response before remounting.
		await page.evaluate(() =>
			fetch("/api/projects").then((response) => response.json()),
		);
		await back.click();
		phase = "preview";
		await reopen();
		await freshStarted;
		await expect(detail).toContainText("New terminal result");
		await expect(detail).not.toContainText("Old partial preview");
	} finally {
		releaseOld();
		releaseFresh();
		await page.unrouteAll({ behavior: "wait" });
		await page.request.post(`${app.url}/api/agents/${accepted.agentId}/cancel`);
	}
});

test("failed Stop after task detail remount clears stopping and permits retry", async ({
	page,
	app,
}) => {
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Stop race", folders: [] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Remount" },
		})
	).json();
	app.rawStreamModel();
	const { agentId } = await (
		await page.request.post(`${app.url}/api/chats/${chat.id}`, {
			data: { prompt: "Held task" },
		})
	).json();
	let release!: () => void, entered!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	await page.route(`**/api/agents/${agentId}/cancel`, async (route) => {
		entered();
		await held;
		await route.fulfill({ status: 503, body: "Unavailable" });
	});
	try {
		await page.goto(`${app.url}/?chat=${chat.id}&agent=${agentId}`);
		const detail = page.getByRole("region", {
			name: "Agent details",
			exact: true,
		});
		const stop = detail.getByRole("button", { name: "Stop", exact: true });
		await stop.click();
		await started;
		await expect(stop).toBeDisabled();
		await page
			.getByRole("button", { name: "Back to chat", exact: true })
			.click();
		await page.getByRole("button", { name: "Task tree", exact: true }).click();
		await expect(stop).toBeDisabled();
		release();
		await expect(detail.getByRole("alert")).toHaveText(
			"Unable to stop Agent. Please retry.",
		);
		await expect(stop).toBeEnabled();
		await expect(detail).not.toContainText("Stopping…");
		await page
			.getByRole("button", { name: "Back to chat", exact: true })
			.click();
		await page.getByRole("button", { name: "Task tree", exact: true }).click();
		await expect(detail.getByRole("alert")).toHaveText(
			"Unable to stop Agent. Please retry.",
		);
		await expect(stop).toBeEnabled();
		await page.unroute(`**/api/agents/${agentId}/cancel`);
		let finish!: () => void;
		const retry = new Promise<void>((resolve) => {
			finish = resolve;
		});
		await page.route(`**/api/agents/${agentId}/cancel`, async (route) => {
			await retry;
			await route.continue();
		});
		await stop.click();
		await expect(stop).toBeDisabled();
		await page
			.getByRole("button", { name: "Back to chat", exact: true })
			.click();
		await page.getByRole("button", { name: "Task tree", exact: true }).click();
		await expect(stop).toBeDisabled();
		finish();
		await expect(detail.getByRole("heading", { level: 2 })).toContainText(
			"Cancelled",
		);
	} finally {
		release();
		await page.unroute(`**/api/agents/${agentId}/cancel`);
		await page.request.post(`${app.url}/api/agents/${agentId}/cancel`);
	}
});
