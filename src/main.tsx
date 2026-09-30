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
function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [selected, setSelected] = useState<number | null>(null);
	const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
	const [error, setError] = useState("");
	const [debugEnabled, setDebugEnabled] = useState<boolean | null>(null);
	const [debugPending, setDebugPending] = useState(false);
	const [debugState] = useState(() =>
		createDebugState(
			async () => (await api("/api/debug")).enabled,
			async (enabled) => {
				await api("/api/debug", "PUT", { enabled });
			},
			setDebugEnabled,
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
		if (!(await debugState.refresh()))
			setError("读取日志设置失败，请刷新页面重试");
	}, [debugState]);
	useEffect(() => {
		void refresh();
		const events = new EventSource("/api/events");
		events.onopen = () => void refresh();
		events.onmessage = () => void refresh();
		return () => events.close();
	}, [refresh]);
	const dialog = useRef<HTMLDialogElement>(null);
	const [creatingProject, setCreatingProject] = useState<number | null>(null);
	const [name, setName] = useState("");
	const [folders, setFolders] = useState("");
	const [modalError, setModalError] = useState("");
	const [saving, setSaving] = useState(false);
	function openModal(projectId: number | null) {
		setCreatingProject(projectId);
		setName("");
		setFolders("");
		setModalError("");
		dialog.current?.showModal();
	}
	async function create(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSaving(true);
		setModalError("");
		try {
			if (creatingProject === null) {
				await api("/api/projects", "POST", {
					name,
					folders: folders.split("\n"),
				});
			} else {
				const chat = await api(
					`/api/projects/${creatingProject}/chats`,
					"POST",
					{ name },
				);
				setSelected(chat.id);
				setCollapsed((current) => {
					const next = new Set(current);
					next.delete(creatingProject);
					return next;
				});
			}
			await refresh();
			dialog.current?.close();
		} catch (cause) {
			setModalError(cause instanceof Error ? cause.message : "创建失败");
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
				aria-label="Projects"
				className="flex w-80 shrink-0 flex-col border-r border-slate-300 bg-slate-50 p-4"
			>
				<h1 className="mb-4 text-xl font-semibold">Tyler Agent</h1>
				<button
					type="button"
					className={button}
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
									onClick={() => openModal(project.id)}
								>
									新建 chat
								</button>
							</div>
							{!collapsed.has(project.id) && (
								<ul className="ml-5 mt-2 space-y-1">
									{project.chats.map((chat) => (
										<li key={chat.id}>
											<button
												type="button"
												aria-current={selected === chat.id ? "page" : undefined}
												className={`w-full rounded px-3 py-2 text-left break-words ${selected === chat.id ? "bg-blue-100" : "hover:bg-slate-200"}`}
												onClick={() => setSelected(chat.id)}
											>
												{chat.name}
											</button>
										</li>
									))}
								</ul>
							)}
						</section>
					))}
				</nav>
				<fieldset
					className="mt-6 border-t border-slate-300 pt-4 disabled:opacity-60"
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
												setError("无法确认日志设置，请重试");
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
				{error && (
					<p role="alert" className="mt-4 text-red-700">
						{error}
					</p>
				)}
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
						<p className="mt-6 text-slate-600">提问功能将在下一步提供。</p>
					</div>
				)}
			</section>
			<dialog
				ref={dialog}
				onCancel={(event) => {
					if (saving) event.preventDefault();
				}}
				aria-labelledby="create-title"
				className="m-auto w-full max-w-lg rounded-lg border border-slate-300 p-6 backdrop:bg-black/40"
			>
				<h2 id="create-title" className="text-xl font-semibold">
					{creatingProject === null ? "新建 project" : "新建 chat"}
				</h2>
				<form className="mt-4 space-y-4" onSubmit={create}>
					<label className="block">
						名称
						<input
							className={control}
							name="name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							required
						/>
					</label>
					{creatingProject === null && (
						<label className="block">
							文件夹路径（每行一个）
							<textarea
								className={control}
								rows={4}
								value={folders}
								onChange={(event) => setFolders(event.target.value)}
								required
							/>
						</label>
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
							disabled={saving}
							onClick={() => dialog.current?.close()}
						>
							取消
						</button>
						<button className={button} type="submit" disabled={saving}>
							创建
						</button>
					</div>
				</form>
			</dialog>
		</main>
	);
}
createRoot(document.getElementById("root") as HTMLElement).render(<App />);
