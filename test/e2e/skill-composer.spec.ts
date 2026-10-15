import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";

test("skill picker distinguishes sources, filters and selects without submitting, and retains failed drafts", async ({
	page,
	app,
}) => {
	const target = join(app.folder, "target");
	const homeSkill = join(app.folder, ".agents", "skills", "shared");
	const projectSkill = join(target, ".agents", "skills", "shared");
	for (const folder of [homeSkill, projectSkill])
		await mkdir(folder, { recursive: true });
	await writeFile(
		join(homeSkill, "SKILL.md"),
		"---\nname: shared\ndescription: Home explicit guidance\ndisable-model-invocation: true\n---\nHome body",
	);
	await writeFile(
		join(projectSkill, "SKILL.md"),
		"---\nname: shared\ndescription: Project explicit guidance\n---\nProject body",
	);
	await mkdir(join(projectSkill, "agents"));
	await writeFile(
		join(projectSkill, "agents", "openai.yaml"),
		"policy:\n  allow_implicit_invocation: false\n",
	);
	const project = await (
		await page.request.post(`${app.url}/api/projects`, {
			data: { name: "Skills", folders: [target] },
		})
	).json();
	const chat = await (
		await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
			data: { name: "Skills" },
		})
	).json();
	await page.request.post(`${app.url}/api/projects/${project.id}/chats`, {
		data: { name: "Other" },
	});
	await page.goto(`${app.url}/?chat=${chat.id}`);
	const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
	const options = page
		.getByRole("listbox", { name: "Skills", exact: true })
		.getByRole("option");
	const selections = page.getByRole("group", { name: "Selected skills" });
	const posts: { prompt: string; skillSources: string[] }[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			request.url().endsWith(`/api/chats/${chat.id}`)
		)
			posts.push(request.postDataJSON());
	});
	await prompt.fill("Do work /shared");
	await expect(options).toHaveCount(2);
	await prompt.press("Shift+Enter");
	await expect(prompt).toHaveValue("Do work /shared\n");
	await expect(selections).toHaveCount(0);
	expect(posts).toHaveLength(0);
	await expect(options).toHaveCount(0);
	await prompt.fill("Do work /shared");
	await expect(options).toHaveCount(2);
	await prompt.press("ArrowDown");
	await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
	await prompt.press("ArrowUp");
	await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
	await prompt.evaluate((input) => {
		input.dispatchEvent(
			new CompositionEvent("compositionstart", { bubbles: true }),
		);
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				isComposing: true,
				bubbles: true,
			}),
		);
		input.dispatchEvent(
			new CompositionEvent("compositionend", { bubbles: true }),
		);
		input.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
		input.dispatchEvent(
			new KeyboardEvent("keyup", { key: "Enter", bubbles: true }),
		);
	});
	await expect(options).toHaveCount(2);
	expect(posts).toHaveLength(0);
	await prompt.press("Escape");
	await expect(options).toHaveCount(0);
	await prompt.fill("Do work /Home explicit");
	await expect(options).toHaveCount(1);
	await prompt.press("Enter");
	await expect(prompt).toHaveValue("Do work ");
	await expect(selections).toContainText(join(homeSkill, "SKILL.md"));
	expect(posts).toHaveLength(0);
	await selections.getByRole("button").click();
	await expect(selections).toHaveCount(0);
	// Filter by a source fragment, preserving slash as the trigger.
	await prompt.fill(`Do work /${projectSkill}`);
	await expect(options).toHaveCount(1);
	await options.click();
	await expect(selections).toContainText(join(projectSkill, "SKILL.md"));
	await page.getByRole("button", { name: "Other", exact: true }).click();
	await expect(prompt).toHaveValue("");
	await expect(selections).toHaveCount(0);
	await page.getByRole("button", { name: "Skills", exact: true }).click();
	await expect(prompt).toHaveValue("Do work ");
	await expect(selections).toContainText(join(projectSkill, "SKILL.md"));
	await page.route(`**/api/chats/${chat.id}`, (route) =>
		route.request().method() === "POST"
			? route.fulfill({ status: 400, json: { code: "invalidRequest" } })
			: route.continue(),
	);
	const send = page.getByRole("button", { name: /^Send(?: \(.+\))?$/ });
	await send.click();
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(prompt).toHaveValue("Do work ");
	await expect(selections).toContainText(join(projectSkill, "SKILL.md"));
	expect(posts).toEqual([
		{ prompt: "Do work ", skillSources: [join(projectSkill, "SKILL.md")] },
	]);
	await page.unroute(`**/api/chats/${chat.id}`);
	await send.click();
	await expect(page.getByRole("log")).toContainText("Test answer");
	await expect(prompt).toHaveValue("");
	await expect(selections).toHaveCount(0);
	const added = join(target, ".agents", "skills", "fresh");
	await mkdir(added);
	await writeFile(
		join(added, "SKILL.md"),
		"---\nname: fresh\ndescription: Freshly installed\n---\nBody",
	);
	await prompt.fill("/fresh");
	await expect(options).toHaveCount(1);
	await expect(options).toContainText("Freshly installed");
	await page.request.put(`${app.url}/api/enter-behavior`, {
		data: { behavior: "newline" },
	});
	await expect(
		page.getByRole("button", { name: /^Send \((?:Ctrl|⌘)\+Enter\)$/ }),
	).toBeVisible();
	await expect(options).toHaveCount(1);
	await expect(options).toContainText("Freshly installed");
	await prompt.press("Enter");
	await expect(prompt).toHaveValue("");
	await expect(selections).toContainText("fresh");
	const broken = join(target, ".agents", "skills", "broken");
	await mkdir(broken);
	await writeFile(join(broken, "SKILL.md"), "---\nname: [\n---\nBroken");
	await prompt.fill("/broken");
	await expect(page.getByRole("alert")).toContainText(join(broken, "SKILL.md"));
	await expect(options).toContainText("broken");
	await prompt.press("Escape");
	expect(posts).toHaveLength(2);
});
