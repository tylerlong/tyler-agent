import {
	type FormEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { type ApiError, api, appError } from "./api.ts";
import type { ExecutionPermissions } from "./execution-permissions.ts";
import i18n from "./i18n.ts";
import { ProjectGrants } from "./project-grants.tsx";

type Chat = {
	id: number;
	name: string;
	createdAt: number;
	lastQuestionAt: number | null;
	busy: boolean;
	archived: boolean;
};
export type Project = {
	id: number;
	name: string;
	archived: boolean;
	folders: string[];
	grants: ExecutionPermissions;
	chats: Chat[];
};
export type EditorTarget =
	| { kind: "create"; projectId: number | null }
	| { kind: "project" | "chat"; id: number };
export type EditorResult = { id: number; name: string; folders: string[] };

const control =
	"mt-2 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-neutral-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";
const button =
	"rounded-md border border-neutral-300 px-3 py-2 hover:bg-neutral-100 disabled:opacity-50";
// Mounted for the page lifetime: hiding either dialog retains its editing session.
export function ProjectEditor({
	projects,
	request,
	onClose,
	onSaving,
	onConfirmed,
}: {
	projects: Project[];
	request: EditorTarget | null;
	onClose: (open: boolean) => void;
	onSaving: (target: EditorTarget | null) => void;
	onConfirmed: (target: EditorTarget, saved: EditorResult) => Promise<void>;
}) {
	const { t } = useTranslation();
	const errorText = (error: ApiError | null) =>
		error === null
			? ""
			: `${t(error.code, { defaultValue: t("requestFailed") })}${error.details ? `\n${error.details}` : ""}`;
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
	const [directoryTarget, setDirectoryTarget] = useState<string>();
	const directoryList = useRef<HTMLUListElement>(null);
	useEffect(() => {
		if (directory && directoryList.current) directoryList.current.scrollTop = 0;
	}, [directory]);
	const directoryRevision = useRef(0);
	const directoryInitialized = useRef(false);
	async function browse(path?: string) {
		const revision = ++directoryRevision.current;
		setLoadingDirectory(true);
		setDirectoryTarget(path);
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
		setDirectoryTarget(undefined);
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
		onSaving(edit ?? { kind: "create", projectId: target });
		setModalError(null);
		try {
			const operation: EditorTarget = edit ?? {
				kind: "create",
				projectId: target,
			};
			const saved = await api(
				edit
					? `/api/${edit.kind === "project" ? "projects" : "chats"}/${edit.id}`
					: target === null
						? "/api/projects"
						: `/api/projects/${target}/chats`,
				edit ? "PUT" : "POST",
				!edit && target !== null ? { name: input.name } : input,
			);
			await onConfirmed(operation, saved);
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
			onSaving(null);
		}
	}
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
	const handledRequest = useRef<EditorTarget | null>(null);
	useLayoutEffect(() => {
		if (handledRequest.current === request) return;
		handledRequest.current = request;
		if (request === null) {
			folderDialog.current?.close();
			dialog.current?.close();
		} else if (request.kind === "create") openModal(request.projectId);
		else openEdit(request.kind, request.id);
	});
	const closed = () =>
		onClose(Boolean(dialog.current?.open || folderDialog.current?.open));
	return (
		<>
			<dialog
				onClose={closed}
				closedby="any"
				ref={dialog}
				aria-labelledby="create-title"
				className="m-auto max-h-[90dvh] overflow-auto w-full max-w-lg rounded-lg border border-neutral-300 p-6 backdrop:bg-black/40"
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
				{creatingProject !== null && !editing && (
					<p className="mt-2 break-words">
						{t("chatOwner", { name: modalProject?.name })}
					</p>
				)}
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
							<p className="mt-2 text-sm text-neutral-600">
								{t("targetFoldersHelp")}
							</p>
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
					{editing?.kind === "project" && modalProject && (
						<ProjectGrants
							key={modalProject.id}
							projectId={modalProject.id}
							grants={modalProject.grants}
							readOnly={saving || modalReadOnly}
						/>
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
				onClose={closed}
				closedby="any"
				ref={folderDialog}
				aria-labelledby="folder-title"
				className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-lg border border-neutral-300 p-6 backdrop:bg-black/40 open:flex open:flex-col"
			>
				<header className="shrink-0">
					<h2 id="folder-title" className="text-lg font-semibold">
						{t("selectFolder")}
					</h2>
					<p className="mt-4 text-sm text-neutral-600">
						{t("currentDirectory")}
					</p>
					<section
						aria-label={t("currentDirectory")}
						title={directory?.path}
						className="break-all font-mono"
					>
						{directory?.path}
					</section>
					<button
						type="button"
						className={`${button} mt-3`}
						disabled={!directory?.parent}
						onClick={() => {
							if (directory?.parent) void browse(directory.parent);
						}}
					>
						{t("parentDirectory")}
					</button>
					{loadingDirectory && (
						<p role="status" className="mt-3 break-all">
							{t("directoryLoading", {
								path: directoryTarget ?? t("homeDirectory"),
							})}
						</p>
					)}
					{directoryError && (
						<div className="mt-3">
							<p
								role="alert"
								className="whitespace-pre-wrap break-all text-red-700"
							>
								{errorText(directoryError)}{" "}
								{t("directoryFailedTarget", {
									path: directoryTarget ?? t("homeDirectory"),
								})}
								{directory && (
									<> {t("directoryRetained", { path: directory.path })}</>
								)}
							</p>
							<button
								type="button"
								className={`${button} mt-2`}
								disabled={loadingDirectory}
								onClick={() => void browse(directoryTarget)}
							>
								{t("retry")}
							</button>
						</div>
					)}
				</header>
				<ul
					ref={directoryList}
					aria-label={t("subdirectories")}
					className="my-4 min-h-12 overflow-y-auto font-mono"
				>
					{directory?.directories.map((child) => (
						<li key={child.path}>
							<button
								type="button"
								aria-label={child.name}
								className="flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
								onClick={() => void browse(child.path)}
							>
								<span aria-hidden="true">📁</span>
								<span className="min-w-0 flex-1 break-all">{child.name}</span>
								<span aria-hidden="true">→</span>
							</button>
						</li>
					))}
					{directory &&
						!loadingDirectory &&
						directory.directories.length === 0 && (
							<li className="py-3 text-neutral-600">{t("noSubfolders")}</li>
						)}
				</ul>
				<footer className="flex shrink-0 justify-end gap-3">
					<button
						type="button"
						className={button}
						onClick={() => folderDialog.current?.close()}
					>
						{t("cancel")}
					</button>
					<button
						type="button"
						className={button}
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
				</footer>
			</dialog>
		</>
	);
}
