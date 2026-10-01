import {
	type FormEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { createDebugState } from "./debug-state.ts";
import "./style.css";

type Chat = {
	id: number;
	name: string;
	createdAt: number;
	lastQuestionAt: number | null;
	busy: boolean;
};
type Project = { id: number; name: string; folders: string[]; chats: Chat[] };
async function api(path: string, method = "GET", input?: unknown) {
	const response = await fetch(path, {
		method,
		...(input === undefined
			? {}
			: {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(input),
				}),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error ?? "请求失败");
	return data;
}
const control =
	"mt-2 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";
const button =
	"rounded-md border border-slate-300 px-3 py-2 hover:bg-slate-100 disabled:opacity-50";
const urlChat = () => {
	const value = new URL(location.href).searchParams.get("chat");
	return value && /^\d+$/.test(value) ? Number(value) : null;
};

function saveSidebarWidth(width: number) {
	void api("/api/sidebar-width", "PUT", { width }).catch(() => {});
}

function App() {
	const [sidebarWidth, setSidebarWidth] = useState(320);
	const [sidebarDragging, setSidebarDragging] = useState(false);
	const sidebarDrag = useRef<{
		pointerId: number;
		x: number;
		startWidth: number;
		width: number;
		element: HTMLHRElement;
	} | null>(null);
	const finishSidebarDrag = useCallback(() => {
		const drag = sidebarDrag.current;
		if (!drag) return;
		sidebarDrag.current = null;
		document.body.classList.remove("sidebar-dragging");
		setSidebarDragging(false);
		if (drag.element.hasPointerCapture(drag.pointerId))
			drag.element.releasePointerCapture(drag.pointerId);
		if (drag.width !== drag.startWidth) saveSidebarWidth(drag.width);
	}, []);
	useEffect(() => {
		void api("/api/sidebar-width")
			.then(({ width }) => setSidebarWidth(width))
			.catch(() => {});
		window.addEventListener("blur", finishSidebarDrag);
		return () => {
			window.removeEventListener("blur", finishSidebarDrag);
			finishSidebarDrag();
		};
	}, [finishSidebarDrag]);
	const [projects, setProjects] = useState<Project[]>([]);
	const [selected, setSelected] = useState<number | null>(urlChat);
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const [chatState, setChatState] = useState<{
		id: number;
		messages: { id: string; role: string; content: string }[];
		busy: boolean;
	} | null>(null);
	const chatRevision = useRef(0);
	const [drafts, setDrafts] = useState<Record<number, string>>({});
	const draftVersions = useRef<Record<number, number>>({});
	const [chatErrors, setChatErrors] = useState<Record<number, string>>({});
	const [submitting, setSubmitting] = useState<Set<number>>(() => new Set());
	function selectChat(id: number) {
		const url = new URL(location.href);
		url.searchParams.set("chat", String(id));
		history.pushState(null, "", url);
		setSelected(id);
	}
	const refreshChat = useCallback(async () => {
		const id = selectedRef.current;
		const revision = ++chatRevision.current;
		if (id === null) {
			setChatState(null);
			return;
		}
		try {
			const data = await api(`/api/chats/${id}`);
			if (revision === chatRevision.current && selectedRef.current === id) {
				setChatState({ id, ...data });
			}
		} catch (cause) {
			if (revision === chatRevision.current && selectedRef.current === id) {
				setChatState(null);
				setChatErrors((current) => ({
					...current,
					[id]: cause instanceof Error ? cause.message : "读取对话失败",
				}));
			}
		}
	}, []);
	useEffect(() => {
		selectedRef.current = selected;
		void refreshChat();
	}, [selected, refreshChat]);
	useEffect(() => {
		const pop = () => setSelected(urlChat());
		window.addEventListener("popstate", pop);
		return () => window.removeEventListener("popstate", pop);
	}, []);
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const id = selected;
		if (
			id === null ||
			chatState?.id !== id ||
			chatState.busy ||
			submitting.has(id)
		)
			return;
		const prompt = drafts[id] ?? "";
		const version = draftVersions.current[id] ?? 0;
		setSubmitting((current) => new Set(current).add(id));
		setChatErrors((current) => ({ ...current, [id]: "" }));
		try {
			await api(`/api/chats/${id}`, "POST", { prompt });
			if ((draftVersions.current[id] ?? 0) === version)
				setDrafts((current) => ({ ...current, [id]: "" }));
		} catch (cause) {
			setChatErrors((current) => ({
				...current,
				[id]: cause instanceof Error ? cause.message : "提问失败",
			}));
		} finally {
			setSubmitting((current) => {
				const next = new Set(current);
				next.delete(id);
				return next;
			});
			void refreshChat();
		}
	}
	const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
	const [error, setError] = useState("");
	const [debugEnabled, setDebugEnabled] = useState<boolean | null>(null);
	const [debugPending, setDebugPending] = useState(false);
	const [debugError, setDebugError] = useState("");
	const settingsDialog = useRef<HTMLDialogElement>(null);
	const [debugState] = useState(() =>
		createDebugState(
			async () => (await api("/api/debug")).enabled,
			async (enabled) => {
				await api("/api/debug", "PUT", { enabled });
			},
			(enabled) => {
				setDebugEnabled(enabled);
				setDebugError(enabled === null ? "读取日志设置失败，请重试" : "");
			},
		),
	);
	const refreshRevision = useRef(0);
	const refresh = useCallback(async () => {
		const revision = ++refreshRevision.current;
		try {
			const data = await api("/api/projects");
			if (revision === refreshRevision.current) setProjects(data.projects);
		} catch (cause) {
			if (revision === refreshRevision.current)
				setError(cause instanceof Error ? cause.message : "读取列表失败");
		}
		await debugState.refresh();
	}, [debugState]);
	useEffect(() => {
		void refresh();
		const events = new EventSource("/api/events");
		events.onopen = () => {
			void refresh();
			void refreshChat();
		};
		events.onmessage = () => {
			void refresh();
			void refreshChat();
		};
		events.onerror = () => {
			++chatRevision.current;
			setChatState(null);
		};
		return () => events.close();
	}, [refresh, refreshChat]);
	const dialog = useRef<HTMLDialogElement>(null);
	const [creatingProject, setCreatingProject] = useState<number | null>(null);
	const [name, setName] = useState("New project");
	const [folders, setFolders] = useState<string[]>([]);
	const folderDialog = useRef<HTMLDialogElement>(null);
	const [directory, setDirectory] = useState<{
		path: string;
		parent: string | null;
		directories: { name: string; path: string }[];
	} | null>(null);
	const [directoryError, setDirectoryError] = useState("");
	const [loadingDirectory, setLoadingDirectory] = useState(false);
	const directoryRevision = useRef(0);
	const directoryInitialized = useRef(false);
	async function browse(path?: string) {
		const revision = ++directoryRevision.current;
		setLoadingDirectory(true);
		setDirectoryError("");
		try {
			const data = await api(
				`/api/directories${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`,
			);
			if (revision === directoryRevision.current) setDirectory(data);
		} catch (cause) {
			if (revision === directoryRevision.current)
				setDirectoryError(
					cause instanceof Error ? cause.message : "目录读取失败",
				);
		} finally {
			if (revision === directoryRevision.current) setLoadingDirectory(false);
		}
	}
	function resetDirectory() {
		directoryInitialized.current = false;
		++directoryRevision.current;
		setDirectory(null);
		setDirectoryError("");
		setLoadingDirectory(false);
	}
	const [modalError, setModalError] = useState("");
	const [saving, setSaving] = useState(false);
	const [editing, setEditing] = useState<{
		kind: "project" | "chat";
		id: number;
	} | null>(null);
	const [menu, setMenu] = useState<string | null>(null);
	const editSaved = useRef(false);
	const modalRevision = useRef(0);
	function openEdit(kind: "project" | "chat", id: number) {
		if (saving && (editing?.kind !== kind || editing.id !== id)) return;
		if (editing?.kind !== kind || editing.id !== id || editSaved.current) {
			const project = projects.find((item) =>
				kind === "project"
					? item.id === id
					: item.chats.some((chat) => chat.id === id),
			);
			const target =
				kind === "project"
					? project
					: project?.chats.find((chat) => chat.id === id);
			if (!target) return;
			++modalRevision.current;
			setEditing({ kind, id });
			setName(target.name);
			setFolders(kind === "project" ? (project?.folders ?? []) : []);
			setModalError("");
			resetDirectory();
			editSaved.current = false;
		}
		setMenu(null);
		dialog.current?.showModal();
	}
	function openModal(projectId: number | null) {
		if (saving && (editing || projectId !== creatingProject)) return;
		if (editing || projectId !== creatingProject) {
			++modalRevision.current;
			setEditing(null);
			setCreatingProject(projectId);
			setName(projectId === null ? "New project" : "New chat");
			setFolders([]);
			resetDirectory();
			setModalError("");
		}
		dialog.current?.showModal();
	}
	async function saveModal(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (saving) return;
		const target = creatingProject;
		const input = { name, folders };
		const edit = editing;
		const revision = modalRevision.current;
		setSaving(true);
		setModalError("");
		try {
			if (edit) {
				const saved = await api(
					`/api/${edit.kind === "project" ? "projects" : "chats"}/${edit.id}`,
					"PUT",
					input,
				);
				++refreshRevision.current;
				setProjects((current) =>
					current.map((project) =>
						edit.kind === "project"
							? project.id === edit.id
								? { ...project, name: saved.name, folders: saved.folders }
								: project
							: {
									...project,
									chats: project.chats.map((chat) =>
										chat.id === edit.id ? { ...chat, name: saved.name } : chat,
									),
								},
					),
				);
			} else if (target === null) {
				await api("/api/projects", "POST", input);
			} else {
				const chat = await api(`/api/projects/${target}/chats`, "POST", {
					name: input.name,
				});
				selectChat(chat.id);
				setCollapsed((current) => {
					const next = new Set(current);
					next.delete(target);
					return next;
				});
			}
			await refresh();
			if (revision !== modalRevision.current) return;
			if (edit) editSaved.current = true;
			else setName(target === null ? "New project" : "New chat");
			if (!edit) {
				setFolders([]);
				resetDirectory();
			}
			dialog.current?.close();
		} catch (cause) {
			if (revision === modalRevision.current)
				setModalError(cause instanceof Error ? cause.message : "保存失败");
		} finally {
			setSaving(false);
		}
	}
	const project = projects.find((project) =>
		project.chats.some((chat) => chat.id === selected),
	);
	const chat = project?.chats.find((chat) => chat.id === selected);
	return (
		<main className="flex min-h-screen text-slate-900">
			<aside
				id="projects-panel"
				aria-label="Projects"
				style={{ width: sidebarWidth }}
				className="relative flex shrink-0 flex-col bg-slate-50 p-4"
			>
				<h1 className="mb-4 text-xl font-semibold">Tyler Agent</h1>
				<button
					type="button"
					className={button}
					disabled={saving && (editing !== null || creatingProject !== null)}
					onClick={() => openModal(null)}
				>
					新建 project
				</button>
				<nav aria-label="Projects and chats" className="mt-4 flex-1 space-y-4">
					{projects.map((project) => (
						<section key={project.id} aria-label={`Project ${project.name}`}>
							<div className="flex items-center gap-2">
								<button
									type="button"
									aria-expanded={!collapsed.has(project.id)}
									aria-label={`${collapsed.has(project.id) ? "展开" : "折叠"} ${project.name}`}
									onClick={() =>
										setCollapsed((current) => {
											const next = new Set(current);
											if (next.has(project.id)) next.delete(project.id);
											else next.add(project.id);
											return next;
										})
									}
								>
									{collapsed.has(project.id) ? "▸" : "▾"}
								</button>
								<h2 className="min-w-0 flex-1 break-words font-semibold">
									{project.name}
								</h2>
								<button
									type="button"
									className={button}
									disabled={
										saving &&
										(editing !== null || creatingProject !== project.id)
									}
									onClick={() => openModal(project.id)}
								>
									新建 chat
								</button>
								<div className="relative">
									<button
										type="button"
										aria-label="Project 操作"
										onClick={() =>
											setMenu(
												menu === `project-${project.id}`
													? null
													: `project-${project.id}`,
											)
										}
									>
										⋯
									</button>
									{menu === `project-${project.id}` && (
										<div className="absolute right-0 z-10 w-max rounded border bg-white p-2 shadow">
											<button
												type="button"
												disabled={
													saving &&
													(editing?.kind !== "project" ||
														editing.id !== project.id)
												}
												onClick={() => openEdit("project", project.id)}
											>
												编辑 project
											</button>
										</div>
									)}
								</div>
							</div>
							{!collapsed.has(project.id) && (
								<ul className="ml-5 mt-2 space-y-1">
									{project.chats.map((chat) => (
										<li key={chat.id} className="flex items-center">
											<button
												type="button"
												aria-current={selected === chat.id ? "page" : undefined}
												className={`w-full rounded px-3 py-2 text-left break-words ${selected === chat.id ? "bg-blue-100" : "hover:bg-slate-200"}`}
												onClick={() => selectChat(chat.id)}
											>
												{chat.name}
												{chat.busy && <span>（运行中）</span>}
											</button>
											<div className="relative">
												<button
													type="button"
													aria-label={`Chat ${chat.name} 操作`}
													onClick={() =>
														setMenu(
															menu === `chat-${chat.id}`
																? null
																: `chat-${chat.id}`,
														)
													}
												>
													⋯
												</button>
												{menu === `chat-${chat.id}` && (
													<div className="absolute right-0 z-10 w-max rounded border bg-white p-2 shadow">
														<button
															type="button"
															disabled={
																saving &&
																(editing?.kind !== "chat" ||
																	editing.id !== chat.id)
															}
															onClick={() => openEdit("chat", chat.id)}
														>
															编辑 chat
														</button>
													</div>
												)}
											</div>
										</li>
									))}
								</ul>
							)}
						</section>
					))}
				</nav>
				<button
					type="button"
					className={`${button} mt-6 self-start`}
					aria-label="设置"
					title="设置"
					onClick={() => settingsDialog.current?.showModal()}
				>
					<svg
						aria-hidden="true"
						width="24"
						height="24"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
					>
						<path d="m9 3-1 3-3 1-2 3 2 2-2 2 2 3 3 1 1 3h6l1-3 3-1 2-3-2-2 2-2-2-3-3-1-1-3Z" />
						<circle cx="12" cy="12" r="3" />
					</svg>
				</button>
				{error && (
					<p role="alert" className="mt-4 text-red-700">
						{error}
					</p>
				)}
				{selected !== null && !chat && chatErrors[selected] && (
					<p role="alert" className="mt-4 text-red-700">
						{chatErrors[selected]}
					</p>
				)}
				<hr
					aria-label="调整左侧面板宽度"
					aria-orientation="vertical"
					aria-controls="projects-panel"
					className="sidebar-divider"
					data-dragging={sidebarDragging}
					onPointerDown={(event) => {
						if (
							event.pointerType !== "mouse" ||
							event.button !== 0 ||
							!event.isPrimary
						)
							return;
						event.preventDefault();
						event.currentTarget.setPointerCapture(event.pointerId);
						sidebarDrag.current = {
							pointerId: event.pointerId,
							x: event.clientX,
							startWidth: sidebarWidth,
							width: sidebarWidth,
							element: event.currentTarget,
						};
						document.body.classList.add("sidebar-dragging");
						setSidebarDragging(true);
					}}
					onPointerMove={(event) => {
						const drag = sidebarDrag.current;
						if (drag?.pointerId === event.pointerId) {
							drag.width = Math.max(
								240,
								Math.min(600, drag.startWidth + event.clientX - drag.x),
							);
							setSidebarWidth(drag.width);
						}
					}}
					onPointerUp={finishSidebarDrag}
					onPointerCancel={finishSidebarDrag}
					onLostPointerCapture={finishSidebarDrag}
					onDoubleClick={() => {
						setSidebarWidth(320);
						saveSidebarWidth(320);
					}}
				/>
			</aside>
			<section aria-label="Chat" className="min-w-0 flex-1 px-6 py-10">
				{project && chat && (
					<div className="mx-auto max-w-2xl">
						<p className="text-slate-600">{project.name}</p>
						<h2 className="mt-2 text-2xl font-semibold">{chat.name}</h2>
						<h3 className="mt-6 font-medium">目标文件夹</h3>
						<ul className="mt-2 space-y-1 text-slate-600">
							{project.folders.map((folder) => (
								<li key={folder} className="break-all">
									{folder}
								</li>
							))}
						</ul>
						<div role="log" aria-label="聊天历史" className="mt-6 space-y-4">
							{chatState?.id === chat.id &&
								chatState.messages.map((message) => (
									<p key={message.id} className="whitespace-pre-wrap">
										<strong>
											{message.role === "user" ? "你" : "Agent"}：
										</strong>
										{message.content}
									</p>
								))}
						</div>
						<form className="mt-6" onSubmit={submit}>
							<label className="block">
								Prompt
								<textarea
									className={control}
									rows={4}
									value={drafts[chat.id] ?? ""}
									onChange={(event) => {
										draftVersions.current[chat.id] =
											(draftVersions.current[chat.id] ?? 0) + 1;
										setDrafts((current) => ({
											...current,
											[chat.id]: event.target.value,
										}));
									}}
									required
								/>
							</label>
							<button
								type="submit"
								className={`${button} mt-4`}
								disabled={
									chatState?.id !== chat.id ||
									chatState.busy ||
									submitting.has(chat.id)
								}
							>
								提交
							</button>
							{chatErrors[chat.id] && (
								<p role="alert" className="mt-4 text-red-700">
									{chatErrors[chat.id]}
								</p>
							)}
						</form>
					</div>
				)}
			</section>
			<dialog
				ref={dialog}
				aria-labelledby="create-title"
				className="m-auto w-full max-w-lg rounded-lg border border-slate-300 p-6 backdrop:bg-black/40"
			>
				<h2 id="create-title" className="text-xl font-semibold">
					{editing
						? `编辑 ${editing.kind}`
						: creatingProject === null
							? "新建 project"
							: "新建 chat"}
				</h2>
				<form className="mt-4 space-y-4" onSubmit={saveModal}>
					<label className="block">
						名称
						<input
							className={control}
							name="name"
							disabled={saving}
							value={name}
							onChange={(event) => setName(event.target.value)}
							required
						/>
					</label>
					{(editing
						? editing.kind === "project"
						: creatingProject === null) && (
						<section aria-label="已选文件夹">
							<h3>目标文件夹</h3>
							<ul>
								{folders.map((folder) => (
									<li key={folder} className="mt-2 flex items-center gap-2">
										<span className="min-w-0 flex-1 break-all">{folder}</span>
										<button
											type="button"
											className={button}
											disabled={saving}
											aria-label={`移除 ${folder}`}
											onClick={() =>
												setFolders((current) =>
													current.filter((path) => path !== folder),
												)
											}
										>
											移除
										</button>
									</li>
								))}
							</ul>
							<button
								type="button"
								className={`${button} mt-2`}
								disabled={saving}
								onClick={() => {
									folderDialog.current?.showModal();
									if (!directoryInitialized.current) {
										directoryInitialized.current = true;
										void browse();
									}
								}}
							>
								添加文件夹
							</button>
						</section>
					)}
					{modalError && (
						<p role="alert" className="text-red-700">
							{modalError}
						</p>
					)}
					<div className="flex justify-end gap-3">
						<button
							className={button}
							type="button"
							onClick={() => dialog.current?.close()}
						>
							取消
						</button>
						<button className={button} type="submit" disabled={saving}>
							{editing ? "保存" : "创建"}
						</button>
					</div>
				</form>
			</dialog>
			<dialog
				ref={folderDialog}
				aria-labelledby="folder-title"
				className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-lg border border-slate-300 p-6 backdrop:bg-black/40 open:flex open:flex-col"
			>
				<header className="shrink-0">
					<h2 id="folder-title" className="text-xl font-semibold">
						选择文件夹
					</h2>
					<div className="mt-4 flex items-start gap-3">
						<section
							aria-label="当前目录"
							title={directory?.path}
							className="line-clamp-4 min-w-0 flex-1 break-all font-mono"
						>
							{directory?.path}
						</section>

						<button
							type="button"
							className={`${button} shrink-0`}
							disabled={
								loadingDirectory ||
								!directory ||
								saving ||
								folders.includes(directory.path)
							}
							onClick={() => {
								if (directory)
									setFolders((current) => [...current, directory.path]);
								folderDialog.current?.close();
							}}
						>
							{directory && folders.includes(directory.path)
								? "已添加"
								: "选择此目录"}
						</button>
					</div>
					{loadingDirectory && <p role="status">加载中…</p>}

					{directoryError && (
						<div className="mt-4">
							<p role="alert" className="text-red-700">
								{directoryError}
							</p>
							<button
								type="button"
								className={button}
								disabled={loadingDirectory}
								onClick={() => void browse(directory?.path)}
							>
								重试
							</button>
						</div>
					)}
				</header>
				<ul
					aria-label="子目录"
					className="my-4 min-h-12 overflow-y-auto font-mono"
				>
					<li>
						<button
							type="button"
							aria-label="返回上级"
							className="text-left hover:underline disabled:text-slate-400 disabled:no-underline"
							disabled={!directory?.parent}
							onClick={() => {
								if (directory?.parent) void browse(directory.parent);
							}}
						>
							..
						</button>
					</li>
					{directory?.directories.map((child) => (
						<li key={child.path}>
							<button
								type="button"
								className="break-all text-left hover:underline"
								onClick={() => void browse(child.path)}
							>
								{child.name}/
							</button>
						</li>
					))}
				</ul>
				<footer className="flex shrink-0 justify-end">
					<button
						type="button"
						className={button}
						onClick={() => folderDialog.current?.close()}
					>
						取消
					</button>
				</footer>
			</dialog>
			<dialog
				ref={settingsDialog}
				aria-labelledby="settings-title"
				className="m-auto w-full max-w-lg rounded-lg border border-slate-300 p-6 backdrop:bg-black/40"
			>
				<h2 id="settings-title" className="text-xl font-semibold">
					设置
				</h2>
				<fieldset
					className="mt-4 disabled:opacity-60"
					disabled={debugEnabled === null || debugPending}
				>
					<legend className="text-sm font-medium">
						OpenRouter 调试日志（服务端 terminal）
					</legend>
					<div className="mt-2 flex gap-6">
						{[
							{ label: "关闭", enabled: false },
							{ label: "开启", enabled: true },
						].map(({ label, enabled }) => (
							<label key={label} className="flex items-center gap-2">
								<input
									type="radio"
									name="debug"
									checked={debugEnabled === enabled}
									onChange={async () => {
										setDebugPending(true);
										try {
											const result = await debugState.save(enabled);
											if (result !== "saved")
												setDebugError("无法确认日志设置，请重试");
											else setDebugError("");
										} finally {
											setDebugPending(false);
										}
									}}
								/>
								{label}
							</label>
						))}
					</div>
				</fieldset>
				{debugError && (
					<p role="alert" className="mt-4 text-red-700">
						{debugError}
					</p>
				)}
				<div className="mt-4 flex justify-end gap-3">
					{debugError && (
						<button
							type="button"
							className={button}
							onClick={() => void debugState.refresh()}
						>
							重试
						</button>
					)}
					<button
						type="button"
						className={button}
						onClick={() => settingsDialog.current?.close()}
					>
						关闭
					</button>
				</div>
			</dialog>
		</main>
	);
}
createRoot(document.getElementById("root") as HTMLElement).render(<App />);
