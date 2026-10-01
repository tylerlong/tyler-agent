import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import i18n from "./i18n.ts";
import { createSettingState } from "./setting-state.ts";
import "./style.css";

type Chat = {
	id: number;
	name: string;
	createdAt: number;
	lastQuestionAt: number | null;
	busy: boolean;
	archived: boolean;
};
type Project = {
	id: number;
	name: string;
	archived: boolean;
	folders: string[];
	chats: Chat[];
};
class ApiError extends Error {
	constructor(
		public code: string,
		public details?: string,
	) {
		super(code);
	}
}
function appError(cause: unknown) {
	return cause instanceof ApiError
		? cause
		: new ApiError("requestFailed", String(cause));
}
async function api(path: string, method = "GET", input?: unknown) {
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			...(input === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(input),
					}),
		});
	} catch (cause) {
		throw new ApiError("networkFailed", String(cause));
	}
	let data: Awaited<ReturnType<Response["json"]>>;
	try {
		data = await response.json();
	} catch (cause) {
		throw new ApiError("invalidResponse", String(cause));
	}
	if (!response.ok)
		throw new ApiError(
			data.code ?? "requestFailed",
			data.details ?? (data.code ? undefined : data.error),
		);
	return data;
}
const control =
	"mt-2 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-neutral-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";
const button =
	"rounded-md border border-neutral-300 px-3 py-2 hover:bg-neutral-100 disabled:opacity-50";
const iconButton =
	"flex h-8 w-8 shrink-0 items-center justify-center rounded-md enabled:hover:bg-neutral-200 disabled:opacity-50";
function ActionMenu({
	id,
	label,
	children,
}: {
	id: string;
	label: string;
	children: ReactNode;
}) {
	const popover = useRef<HTMLDivElement>(null);
	return (
		<div className="relative">
			<button
				type="button"
				className={iconButton}
				aria-label={label}
				popoverTarget={id}
				style={{ anchorName: `--${id}` }}
			>
				⋯
			</button>
			<div
				ref={popover}
				id={id}
				popover="auto"
				className="action-menu"
				style={{ positionAnchor: `--${id}` }}
				onClickCapture={() => popover.current?.hidePopover()}
			>
				{children}
			</div>
		</div>
	);
}
const urlChat = () => {
	const value = new URL(location.href).searchParams.get("chat");
	return value && /^\d+$/.test(value) ? Number(value) : null;
};

function saveSidebarWidth(width: number) {
	void api("/api/sidebar-width", "PUT", { width }).catch(() => {});
}

function App() {
	const { t } = useTranslation();
	const errorText = (error: ApiError | null) =>
		error === null
			? ""
			: `${t(error.code, { defaultValue: t("requestFailed") })}${error.details ? `\n${error.details}` : ""}`;
	const [language, setLanguage] = useState<string | null>(null);
	const [languageReady, setLanguageReady] = useState(false);
	const [languagePending, setLanguagePending] = useState(false);
	const [languageError, setLanguageError] = useState("");
	const [languageState] = useState(() =>
		createSettingState<string>(
			async () => {
				const data = await api("/api/language");
				if (data.language !== "en" && data.language !== "zh-CN")
					throw new Error("Invalid server language");
				return data.language;
			},
			async (language) => {
				await api("/api/language", "PUT", { language });
			},
			(language) => {
				setLanguage(language);
				setLanguageError(language === null ? "languageReadFailed" : "");
				if (language !== null) {
					void i18n.changeLanguage(language);
					document.documentElement.lang = language;
					setLanguageReady(true);
				}
			},
		),
	);
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
	const [chatErrors, setChatErrors] = useState<Record<number, ApiError | null>>(
		{},
	);
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
					[id]: appError(cause),
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
			readOnly ||
			chatState?.id !== id ||
			chatState.busy ||
			submitting.has(id)
		)
			return;
		const prompt = drafts[id] ?? "";
		const version = draftVersions.current[id] ?? 0;
		setSubmitting((current) => new Set(current).add(id));
		setChatErrors((current) => ({ ...current, [id]: null }));
		try {
			await api(`/api/chats/${id}`, "POST", { prompt });
			if ((draftVersions.current[id] ?? 0) === version)
				setDrafts((current) => ({ ...current, [id]: "" }));
		} catch (cause) {
			setChatErrors((current) => ({
				...current,
				[id]: appError(cause),
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
	const [error, setError] = useState<ApiError | null>(null);
	const [debugEnabled, setDebugEnabled] = useState<boolean | null>(null);
	const [debugPending, setDebugPending] = useState(false);
	const [debugError, setDebugError] = useState("");
	const settingsDialog = useRef<HTMLDialogElement>(null);
	const [debugState] = useState(() =>
		createSettingState(
			async () => (await api("/api/debug")).enabled,
			async (enabled) => {
				await api("/api/debug", "PUT", { enabled });
			},
			(enabled) => {
				setDebugEnabled(enabled);
				setDebugError(enabled === null ? "debugReadFailed" : "");
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
			if (revision === refreshRevision.current) setError(appError(cause));
		}
		await Promise.all([debugState.refresh(), languageState.refresh()]);
	}, [debugState, languageState]);
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
	const [name, setName] = useState("");
	const creationInitialized = useRef(false);
	const [folders, setFolders] = useState<string[]>([]);
	const folderDialog = useRef<HTMLDialogElement>(null);
	const [directory, setDirectory] = useState<{
		path: string;
		parent: string | null;
		directories: { name: string; path: string }[];
	} | null>(null);
	const [directoryError, setDirectoryError] = useState<ApiError | null>(null);
	const [loadingDirectory, setLoadingDirectory] = useState(false);
	const directoryRevision = useRef(0);
	const directoryInitialized = useRef(false);
	async function browse(path?: string) {
		const revision = ++directoryRevision.current;
		setLoadingDirectory(true);
		setDirectoryError(null);
		try {
			const data = await api(
				`/api/directories${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`,
			);
			if (revision === directoryRevision.current) setDirectory(data);
		} catch (cause) {
			if (revision === directoryRevision.current)
				setDirectoryError(appError(cause));
		} finally {
			if (revision === directoryRevision.current) setLoadingDirectory(false);
		}
	}
	function resetDirectory() {
		directoryInitialized.current = false;
		++directoryRevision.current;
		setDirectory(null);
		setDirectoryError(null);
		setLoadingDirectory(false);
	}
	const [modalError, setModalError] = useState<ApiError | null>(null);
	const [saving, setSaving] = useState(false);
	const [editing, setEditing] = useState<{
		kind: "project" | "chat";
		id: number;
	} | null>(null);
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
			setModalError(null);
			resetDirectory();
			editSaved.current = false;
		}
		dialog.current?.showModal();
	}
	function openModal(projectId: number | null) {
		if (saving && (editing || projectId !== creatingProject)) return;
		if (
			!creationInitialized.current ||
			editing ||
			projectId !== creatingProject
		) {
			creationInitialized.current = true;
			++modalRevision.current;
			setEditing(null);
			setCreatingProject(projectId);
			setName(t(projectId === null ? "defaultProjectName" : "defaultChatName"));
			setFolders([]);
			resetDirectory();
			setModalError(null);
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
		setModalError(null);
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
			else
				setName(
					i18n.t(target === null ? "defaultProjectName" : "defaultChatName"),
				);
			if (!edit) {
				setFolders([]);
				resetDirectory();
			}
			dialog.current?.close();
		} catch (cause) {
			if (revision === modalRevision.current) setModalError(appError(cause));
		} finally {
			setSaving(false);
		}
	}
	async function archive(
		kind: "project" | "chat",
		id: number,
		archived: boolean,
	) {
		setError(null);
		try {
			const saved = await api(
				`/api/${kind === "project" ? "projects" : "chats"}/${id}/archive`,
				"PUT",
				{ archived },
			);
			++refreshRevision.current;
			setProjects((current) =>
				current.map((project) =>
					kind === "project"
						? project.id === id
							? { ...project, archived: saved.archived }
							: project
						: {
								...project,
								chats: project.chats.map((chat) =>
									chat.id === id ? { ...chat, archived: saved.archived } : chat,
								),
							},
				),
			);
			await refresh();
		} catch (cause) {
			setError(appError(cause));
		}
	}
	const renderProject = (project: Project, archivedArea = false) => (
		<section
			key={project.id}
			aria-label={t("projectRegion", { name: project.name })}
		>
			<div className="relative flex items-center gap-2 rounded-md px-2 py-1 hover:bg-neutral-100">
				<button
					type="button"
					className="absolute inset-0 rounded-md"
					aria-expanded={!collapsed.has(project.id)}
					aria-label={t(collapsed.has(project.id) ? "expand" : "collapse", {
						name: project.name,
					})}
					onClick={() =>
						setCollapsed((current) => {
							const next = new Set(current);
							if (next.has(project.id)) next.delete(project.id);
							else next.add(project.id);
							return next;
						})
					}
				/>
				<svg
					aria-hidden="true"
					className="pointer-events-none shrink-0"
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					{collapsed.has(project.id) ? (
						<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h18" />
					) : (
						<>
							<path d="M3 17V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2" />
							<path d="m3 17 3-7h16l-3 9H5a2 2 0 0 1-2-2Z" />
						</>
					)}
				</svg>
				<h2 className="pointer-events-none min-w-0 flex-1 break-words font-normal">
					{project.name}
					{project.archived && (
						<span className="text-sm font-normal">
							{t("projectArchivedLabel")}
						</span>
					)}
				</h2>
				{!archivedArea && (
					<button
						type="button"
						className={`${iconButton} relative`}
						aria-label={t("newChat")}
						title={t("newChat")}
						disabled={
							saving && (editing !== null || creatingProject !== project.id)
						}
						onClick={() => openModal(project.id)}
					>
						<span aria-hidden="true" className="text-xl">
							+
						</span>
					</button>
				)}
				<ActionMenu
					id={`${archivedArea ? "archived" : "normal"}-project-${project.id}`}
					label={t("projectActions")}
				>
					<button
						type="button"
						disabled={
							project.archived ||
							(saving &&
								(editing?.kind !== "project" || editing.id !== project.id))
						}
						onClick={() => openEdit("project", project.id)}
					>
						{t("editProject")}
					</button>
					<button
						type="button"
						className="block"
						onClick={() =>
							void archive("project", project.id, !project.archived)
						}
					>
						{t(project.archived ? "restoreProject" : "archiveProject")}
					</button>
				</ActionMenu>
			</div>
			{!collapsed.has(project.id) && (
				<ul className="ml-5 mt-1 space-y-0.5">
					{project.chats.map((chat) => (
						<li key={chat.id} className="flex items-center">
							<button
								type="button"
								aria-current={selected === chat.id ? "page" : undefined}
								className={`w-full rounded-lg px-3 py-1.5 text-left break-words ${selected === chat.id ? "bg-neutral-200/60" : "hover:bg-neutral-100"}`}
								onClick={() => selectChat(chat.id)}
							>
								{chat.name}
								{chat.busy && <span>{t("busyLabel")}</span>}
							</button>
							<ActionMenu
								id={`${archivedArea ? "archived" : "normal"}-chat-${chat.id}`}
								label={t("chatActions", { name: chat.name })}
							>
								<button
									type="button"
									disabled={
										project.archived ||
										chat.archived ||
										(saving &&
											(editing?.kind !== "chat" || editing.id !== chat.id))
									}
									onClick={() => openEdit("chat", chat.id)}
								>
									{t("editChat")}
								</button>
								<button
									type="button"
									className="block"
									disabled={project.archived && !chat.archived}
									onClick={() => void archive("chat", chat.id, !chat.archived)}
								>
									{t(chat.archived ? "restoreChat" : "archiveChat")}
								</button>
							</ActionMenu>
						</li>
					))}
				</ul>
			)}
		</section>
	);
	const project = projects.find((project) =>
		project.chats.some((chat) => chat.id === selected),
	);
	const chat = project?.chats.find((chat) => chat.id === selected);
	const readOnly = Boolean(project?.archived || chat?.archived);
	const modalProject = projects.find((project) =>
		editing?.kind === "project"
			? project.id === editing.id
			: editing?.kind === "chat"
				? project.chats.some((chat) => chat.id === editing.id)
				: project.id === creatingProject,
	);
	const modalReadOnly = Boolean(
		modalProject?.archived ||
			(editing?.kind === "chat" &&
				modalProject?.chats.find((chat) => chat.id === editing.id)?.archived),
	);
	if (!languageReady)
		return (
			<main className="p-6">
				{languageError ? (
					<>
						<p role="alert">{t(languageError)}</p>
						<button
							type="button"
							className={button}
							onClick={() => void languageState.refresh()}
						>
							{t("retry")}
						</button>
					</>
				) : (
					<p role="status">{t("loading")}</p>
				)}
			</main>
		);
	return (
		<main className="flex h-dvh overflow-hidden text-neutral-700">
			<aside
				id="projects-panel"
				aria-label={t("projects")}
				style={{ width: sidebarWidth }}
				className="relative flex h-full shrink-0 flex-col bg-neutral-50 p-3"
			>
				<header className="shrink-0">
					<h1 className="mb-3 px-2 text-lg font-semibold">Tyler Agent</h1>
					<button
						type="button"
						className="flex items-center gap-2 rounded-md px-3 py-2 text-left enabled:hover:bg-neutral-100 disabled:opacity-50"
						aria-label={t("newProject")}
						disabled={saving && (editing !== null || creatingProject !== null)}
						onClick={() => openModal(null)}
					>
						<svg
							aria-hidden="true"
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						>
							<path d="M20 11V7a2 2 0 0 0-2-2h-7L9 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7M18 14v8m-4-4h8" />
						</svg>
						{t("newProject")}
					</button>
				</header>
				<div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain">
					<nav aria-label={t("projectsAndChats")} className="space-y-3">
						{projects
							.filter((project) => !project.archived)
							.map((project) =>
								renderProject({
									...project,
									chats: project.chats.filter((chat) => !chat.archived),
								}),
							)}
					</nav>
					<details aria-label={t("archived")} className="mt-4">
						<summary className="cursor-pointer">{t("archived")}</summary>
						<div className="mt-4 space-y-4">
							{projects
								.filter(
									(project) =>
										project.archived ||
										project.chats.some((chat) => chat.archived),
								)
								.map((project) =>
									renderProject(
										{
											...project,
											chats: project.chats.filter(
												(chat) => project.archived || chat.archived,
											),
										},
										true,
									),
								)}
						</div>
					</details>
					{error && (
						<p
							role="alert"
							className="mt-4 whitespace-pre-wrap break-words text-red-700"
						>
							{errorText(error)}
						</p>
					)}
					{selected !== null && !chat && chatErrors[selected] && (
						<p
							role="alert"
							className="mt-4 whitespace-pre-wrap break-words text-red-700"
						>
							{errorText(chatErrors[selected])}
						</p>
					)}
				</div>
				<footer className="shrink-0 pt-3">
					<button
						type="button"
						className={`${iconButton} self-start`}
						aria-label={t("settings")}
						title={t("settings")}
						onClick={() => settingsDialog.current?.showModal()}
					>
						<svg
							aria-hidden="true"
							width="20"
							height="20"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						>
							<path d="m9 3-1 3-3 1-2 3 2 2-2 2 2 3 3 1 1 3h6l1-3 3-1 2-3-2-2 2-2-2-3-3-1-1-3Z" />
							<circle cx="12" cy="12" r="3" />
						</svg>
					</button>
				</footer>
				<hr
					aria-label={t("resizeSidebar")}
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
			<section
				aria-label={t("chat")}
				className="min-w-0 flex-1 overflow-auto overscroll-contain px-6 py-10"
			>
				{project && chat && (
					<div className="mx-auto max-w-2xl">
						<p className="text-neutral-600">{project.name}</p>
						<h2 className="mt-2 text-xl font-medium">{chat.name}</h2>
						<h3 className="mt-6 font-medium">{t("targetFolders")}</h3>
						<ul className="mt-2 space-y-1 text-neutral-600">
							{project.folders.map((folder) => (
								<li key={folder} className="break-all">
									{folder}
								</li>
							))}
						</ul>
						<div
							role="log"
							aria-label={t("chatHistory")}
							className="mt-6 space-y-4"
						>
							{chatState?.id === chat.id &&
								chatState.messages.map((message) => (
									<p key={message.id} className="whitespace-pre-wrap">
										<strong>
											{t(message.role === "user" ? "you" : "agent")}:{" "}
										</strong>
										{message.content}
									</p>
								))}
						</div>
						{readOnly && (
							<p role="status" className="mt-6 text-neutral-600">
								{project.archived
									? chat.archived
										? t("bothArchivedReadOnly")
										: t("projectArchivedReadOnly")
									: t("chatArchivedReadOnly")}
							</p>
						)}
						<form className="mt-6" onSubmit={submit}>
							<label className="block">
								{t("prompt")}
								<textarea
									className={control}
									rows={4}
									readOnly={readOnly}
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
									readOnly ||
									chatState?.id !== chat.id ||
									chatState.busy ||
									submitting.has(chat.id)
								}
							>
								{t("submit")}
							</button>
							{chatErrors[chat.id] && (
								<p
									role="alert"
									className="mt-4 whitespace-pre-wrap break-words text-red-700"
								>
									{errorText(chatErrors[chat.id])}
								</p>
							)}
						</form>
					</div>
				)}
			</section>
			<dialog
				closedby="any"
				ref={dialog}
				aria-labelledby="create-title"
				className="m-auto w-full max-w-lg rounded-lg border border-neutral-300 p-6 backdrop:bg-black/40"
			>
				<h2 id="create-title" className="text-lg font-semibold">
					{t(
						editing
							? editing.kind === "project"
								? "editProject"
								: "editChat"
							: creatingProject === null
								? "newProject"
								: "newChat",
					)}
				</h2>
				<form className="mt-4 space-y-4" onSubmit={saveModal}>
					<label className="block">
						{t("name")}
						<input
							className={control}
							name="name"
							disabled={saving || modalReadOnly}
							value={name}
							onChange={(event) => setName(event.target.value)}
							required
						/>
					</label>
					{(editing
						? editing.kind === "project"
						: creatingProject === null) && (
						<section aria-label={t("selectedFolders")}>
							<h3>{t("targetFolders")}</h3>
							<ul>
								{folders.map((folder) => (
									<li key={folder} className="mt-2 flex items-center gap-2">
										<span className="min-w-0 flex-1 break-all">{folder}</span>
										<button
											type="button"
											className={button}
											disabled={saving || modalReadOnly}
											aria-label={t("removeFolder", { path: folder })}
											onClick={() =>
												setFolders((current) =>
													current.filter((path) => path !== folder),
												)
											}
										>
											{t("remove")}
										</button>
									</li>
								))}
							</ul>
							<button
								type="button"
								className={`${button} mt-2`}
								disabled={saving || modalReadOnly}
								onClick={() => {
									folderDialog.current?.showModal();
									if (!directoryInitialized.current) {
										directoryInitialized.current = true;
										void browse();
									}
								}}
							>
								{t("addFolder")}
							</button>
						</section>
					)}
					{modalReadOnly && <p role="status">{t("archivedEditReadOnly")}</p>}
					{modalError && (
						<p
							role="alert"
							className="whitespace-pre-wrap break-words text-red-700"
						>
							{errorText(modalError)}
						</p>
					)}
					<div className="flex justify-end gap-3">
						<button
							className={button}
							type="button"
							onClick={() => dialog.current?.close()}
						>
							{t("cancel")}
						</button>
						<button
							className={button}
							type="submit"
							disabled={saving || modalReadOnly}
						>
							{t(editing ? "save" : "create")}
						</button>
					</div>
				</form>
			</dialog>
			<dialog
				closedby="any"
				ref={folderDialog}
				aria-labelledby="folder-title"
				className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-lg border border-neutral-300 p-6 backdrop:bg-black/40 open:flex open:flex-col"
			>
				<header className="shrink-0">
					<h2 id="folder-title" className="text-lg font-semibold">
						{t("selectFolder")}
					</h2>
					<div className="mt-4 flex items-start gap-3">
						<section
							aria-label={t("currentDirectory")}
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
								modalReadOnly ||
								folders.includes(directory.path)
							}
							onClick={() => {
								if (directory)
									setFolders((current) => [...current, directory.path]);
								folderDialog.current?.close();
							}}
						>
							{directory && folders.includes(directory.path)
								? t("alreadyAdded")
								: t("selectDirectory")}
						</button>
					</div>
					{loadingDirectory && <p role="status">{t("loading")}</p>}

					{directoryError && (
						<div className="mt-4">
							<p
								role="alert"
								className="whitespace-pre-wrap break-words text-red-700"
							>
								{errorText(directoryError)}
							</p>
							<button
								type="button"
								className={button}
								disabled={loadingDirectory}
								onClick={() => void browse(directory?.path)}
							>
								{t("retry")}
							</button>
						</div>
					)}
				</header>
				<ul
					aria-label={t("subdirectories")}
					className="my-4 min-h-12 overflow-y-auto font-mono"
				>
					<li>
						<button
							type="button"
							aria-label={t("parentDirectory")}
							className="text-left hover:underline disabled:text-neutral-400 disabled:no-underline"
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
						{t("cancel")}
					</button>
				</footer>
			</dialog>
			<dialog
				closedby="any"
				ref={settingsDialog}
				aria-labelledby="settings-title"
				className="m-auto w-full max-w-lg rounded-lg border border-neutral-300 p-6 backdrop:bg-black/40"
			>
				<h2 id="settings-title" className="text-lg font-semibold">
					{t("settings")}
				</h2>
				<label className="mt-4 block">
					{t("language")}
					<select
						className={control}
						value={language ?? i18n.language}
						disabled={languagePending || language === null}
						onChange={async (event) => {
							setLanguagePending(true);
							try {
								const result = await languageState.save(event.target.value);
								setLanguageError(
									result === "saved" ? "" : "languageSaveFailed",
								);
							} finally {
								setLanguagePending(false);
							}
						}}
					>
						<option value="en">English</option>
						<option value="zh-CN">简体中文</option>
					</select>
				</label>
				{languageError && (
					<div className="mt-4">
						<p
							role="alert"
							className="whitespace-pre-wrap break-words text-red-700"
						>
							{t(languageError)}
						</p>
						<button
							type="button"
							className={button}
							disabled={languagePending}
							onClick={() => void languageState.refresh()}
						>
							{t("retry")}
						</button>
					</div>
				)}
				<fieldset
					className="mt-4 disabled:opacity-60"
					disabled={debugEnabled === null || debugPending}
				>
					<legend className="text-sm font-medium">{t("debug")}</legend>
					<div className="mt-2 flex gap-6">
						{[
							{ label: t("off"), enabled: false },
							{ label: t("on"), enabled: true },
						].map(({ label, enabled }) => (
							<label key={String(enabled)} className="flex items-center gap-2">
								<input
									type="radio"
									name="debug"
									checked={debugEnabled === enabled}
									onChange={async () => {
										setDebugPending(true);
										try {
											const result = await debugState.save(enabled);
											if (result !== "saved") setDebugError("debugSaveFailed");
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
					<p
						role="alert"
						className="mt-4 whitespace-pre-wrap break-words text-red-700"
					>
						{t(debugError)}
					</p>
				)}
				<div className="mt-4 flex justify-end gap-3">
					{debugError && (
						<button
							type="button"
							className={button}
							onClick={() => void debugState.refresh()}
						>
							{t("retry")}
						</button>
					)}
					<button
						type="button"
						className={button}
						onClick={() => settingsDialog.current?.close()}
					>
						{t("close")}
					</button>
				</div>
			</dialog>
		</main>
	);
}
createRoot(document.getElementById("root") as HTMLElement).render(<App />);
