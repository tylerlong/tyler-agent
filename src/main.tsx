import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { AgentContent, type AgentDetail } from "./agent-content.tsx";
import type { ReaderItem } from "./agent-output.tsx";
import { ApiError, api, appError } from "./api.ts";
import { type Approval, ApprovalInbox } from "./approvals.tsx";
import {
	ChatOptionPicker,
	type ChatOptions,
	normalizeChatOptions,
	validChatOptions,
} from "./chat-options.tsx";
import { ExecutionLimits } from "./execution-limits.tsx";
import i18n from "./i18n.ts";
import { ModelConfiguration } from "./model-configuration.tsx";
import type { ModelSettings } from "./model-settings.ts";
import {
	type EditorResult,
	type EditorTarget,
	type Project,
	ProjectEditor,
} from "./project-editor.tsx";
import { createSettingState } from "./setting-state.ts";
import { TaskView, urlAgent } from "./task-view.tsx";

import "./style.css";

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
				className="action-menu picker-popup"
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
	const [undersized, setUndersized] = useState(
		() => window.innerWidth < 1280 || window.innerHeight < 720,
	);
	const viewportNotice = useRef<HTMLDialogElement>(null);
	const viewportFocus = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const resize = () =>
			setUndersized(window.innerWidth < 1280 || window.innerHeight < 720);
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	const errorText = (error: ApiError | null) =>
		error === null
			? ""
			: `${t(error.code, { defaultValue: t("requestFailed") })}${error.details ? `\n${error.details}` : ""}`;
	const languageDraft = useRef<string | null>(null);
	const languageSave = useRef<Promise<boolean> | null>(null);
	const [languageSaved, setLanguageSaved] = useState(false);
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
				if (languageDraft.current !== null) {
					if (language !== null) {
						void i18n.changeLanguage(language);
						document.documentElement.lang = language;
					}
					return;
				}
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
	const enterDraft = useRef<string | null>(null);
	const enterSave = useRef<Promise<boolean> | null>(null);
	const [enterSaved, setEnterSaved] = useState(false);
	const [enterBehavior, setEnterBehavior] = useState<string | null>(null);
	const [enterPending, setEnterPending] = useState(false);
	const [enterError, setEnterError] = useState("");
	const [enterState] = useState(() =>
		createSettingState<string>(
			async () => {
				const data = await api("/api/enter-behavior");
				if (data.behavior !== "send" && data.behavior !== "newline")
					throw new Error("Invalid Enter behavior");
				return data.behavior;
			},
			async (behavior) => {
				await api("/api/enter-behavior", "PUT", { behavior });
			},
			(behavior) => {
				if (enterDraft.current !== null) return;
				setEnterBehavior(behavior);
				setEnterError(behavior === null ? "enterBehaviorReadFailed" : "");
			},
		),
	);
	async function commitLanguage(): Promise<boolean> {
		if (languageSave.current) return languageSave.current;
		const value = languageDraft.current;
		if (value === null) return !languageError;
		setLanguagePending(true);
		setLanguageSaved(false);
		const operation = (async () => {
			const result = await languageState.save(value);
			const succeeded = result === "saved";
			setLanguageError(succeeded ? "" : "languageSaveFailed");
			if (succeeded) {
				languageDraft.current = null;
				setLanguageSaved(true);
				void i18n.changeLanguage(value);
				document.documentElement.lang = value;
			}
			return succeeded;
		})();
		languageSave.current = operation;
		try {
			return await operation;
		} finally {
			languageSave.current = null;
			setLanguagePending(false);
		}
	}
	async function commitEnter(): Promise<boolean> {
		if (enterSave.current) return enterSave.current;
		const value = enterDraft.current;
		if (value === null) return !enterError;
		setEnterPending(true);
		setEnterSaved(false);
		const operation = (async () => {
			const result = await enterState.save(value);
			const succeeded = result === "saved";
			setEnterError(succeeded ? "" : "enterBehaviorSaveFailed");
			if (succeeded) {
				enterDraft.current = null;
				setEnterSaved(true);
			}
			return succeeded;
		})();
		enterSave.current = operation;
		try {
			return await operation;
		} finally {
			enterSave.current = null;
			setEnterPending(false);
		}
	}
	const mac = navigator.platform.startsWith("Mac");
	const submitName =
		enterBehavior === null
			? t("submit")
			: t("submitShortcut", {
					shortcut:
						enterBehavior === "send" ? "Enter" : mac ? "⌘+Enter" : "Ctrl+Enter",
				});
	const composing = useRef(false);
	const compositionEndedAt = useRef(-Infinity);
	const [modelSettings, setModelSettings] = useState<ModelSettings | null>(
		null,
	);
	const [modelSettingsError, setModelSettingsError] = useState(false);
	const modelSettingsRead = useRef(0);
	const modelSettingsApplied = useRef(0);
	const modelSettingsRefresh = useRef<Promise<void> | null>(null);
	const refreshModelSettings = useCallback(() => {
		const version = ++modelSettingsRead.current;
		const operation = (async () => {
			try {
				const value = await api("/api/model-settings");
				if (version !== modelSettingsRead.current) {
					await modelSettingsRefresh.current;
					return;
				}
				modelSettingsApplied.current = version;
				setModelSettings(value);
				setModelSettingsError(false);
			} catch {
				if (version === modelSettingsRead.current) setModelSettingsError(true);
			}
		})();
		modelSettingsRefresh.current = operation;
		return operation;
	}, []);
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
	const [projectsLoaded, setProjectsLoaded] = useState(false);
	const [projectsError, setProjectsError] = useState<ApiError | null>(null);
	const [selected, setSelected] = useState<number | null>(urlChat);
	const [selectedAgent, setSelectedAgent] = useState<number | null>(urlAgent);
	const taskSelectedRef = useRef(selectedAgent);
	taskSelectedRef.current = selectedAgent;
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	type ChatState = {
		id: number;
		agents: AgentDetail[];
		messages: {
			id: string;
			role: string;
			content: string;
			output?: ReaderItem[];
			revision?: number;
			status?: string;
			errorCode?: string;
			errorDetails?: string;
		}[];
		chatOptions?: ChatOptions;
		busy: boolean;
		hasMore: boolean;
		historyLoaded?: boolean;
	};
	const [chatCache, setChatCache] = useState<Record<number, ChatState>>({});
	const cacheRef = useRef(chatCache);
	const chatState = selected === null ? null : (chatCache[selected] ?? null);
	const chatContent = useRef<HTMLElement>(null);
	const readingPositions = useRef<
		Record<
			number,
			{
				top: number;
				bottom: boolean;
				anchor?: { id: string; offset: number };
			}
		>
	>({});
	const restoreReadingPosition = useCallback(() => {
		const content = chatContent.current;
		const id = selectedRef.current;
		if (!content || id === null || taskSelectedRef.current !== null) return;
		const saved = readingPositions.current[id];
		if (!saved || saved.bottom) {
			content.scrollTop = content.scrollHeight;
		} else {
			const anchor =
				saved.anchor &&
				content.querySelector<HTMLElement>(
					`[data-reading-anchor="${saved.anchor.id}"]`,
				);
			content.scrollTop =
				anchor && saved.anchor
					? content.scrollTop +
						anchor.getBoundingClientRect().top -
						content.getBoundingClientRect().top -
						saved.anchor.offset
					: saved.top;
		}
	}, []);
	useLayoutEffect(restoreReadingPosition);
	useEffect(() => {
		const body = chatContent.current?.firstElementChild;
		if (!body) return;
		const observer = new ResizeObserver(restoreReadingPosition);
		observer.observe(body);
		return () => observer.disconnect();
	});
	const chatRevisions = useRef<Record<number, number>>({});
	const syncedThrough = useRef<Record<number, number>>({});
	const readSequence = useRef(0);
	const agentReads = useRef<Record<number, number>>({});
	const busyReads = useRef<Record<number, number>>({});
	const [historyErrors, setHistoryErrors] = useState<
		Record<number, ApiError | null>
	>({});
	const [loadingEarlier, setLoadingEarlier] = useState<Set<number>>(
		() => new Set(),
	);
	const earlierRequests = useRef(new Set<number>());
	const [earlierErrors, setEarlierErrors] = useState<
		Record<number, ApiError | null>
	>({});
	const updateBusy = useCallback((id: number, busy: boolean, read: number) => {
		if ((busyReads.current[id] ?? 0) > read) return;
		busyReads.current[id] = read;
		setProjects((current) =>
			current.map((project) => ({
				...project,
				chats: project.chats.map((chat) =>
					chat.id === id ? { ...chat, busy } : chat,
				),
			})),
		);
	}, []);
	const mergeChat = useCallback(
		(
			id: number,
			data: ChatState,
			older = false,
			read: number,
			targeted = false,
		) => {
			const previous = cacheRef.current[id];
			const agents = new Map(
				previous?.agents.map((agent) => [agent.id, agent]),
			);
			const messages = new Map(
				previous?.messages.map((message) => [message.id, message]),
			);
			const changed = (agentId: number) =>
				(agentReads.current[agentId] ?? 0) > read;
			for (const agent of data.agents)
				if ((!older || !agents.has(agent.id)) && !changed(agent.id)) {
					agents.set(agent.id, agent);
					agentReads.current[agent.id] = read;
				}
			for (const message of data.messages)
				if (
					(!older || !messages.has(message.id)) &&
					!changed(Number(message.id.split("-")[0]))
				)
					messages.set(message.id, {
						...message,
						revision: (messages.get(message.id)?.revision ?? 0) + 1,
					});
			const next = {
				id,
				agents: [...agents.values()].sort((a, b) => a.id - b.id),
				messages: [...messages.values()].sort(
					(a, b) =>
						Number(a.id.split("-")[0]) - Number(b.id.split("-")[0]) ||
						(a.role === "user" ? -1 : 1),
				),
				busy:
					previous && (older || (busyReads.current[id] ?? 0) > read)
						? previous.busy
						: data.busy,
				hasMore:
					older || !previous?.historyLoaded ? data.hasMore : previous.hasMore,
				historyLoaded: !targeted || previous?.historyLoaded === true,
			};
			if (!older) updateBusy(id, data.busy, read);
			cacheRef.current = { ...cacheRef.current, [id]: next };
			setChatCache(cacheRef.current);
		},
		[updateBusy],
	);
	const [chatOptions, setChatOptions] = useState<Record<number, ChatOptions>>(
		{},
	);
	const optionRequests = useRef(new Set<number>());
	const optionReads = useRef<Record<number, number>>({});
	const [savingOptions, setSavingOptions] = useState<Set<number>>(
		() => new Set(),
	);
	const normalizationAttempt = useRef("");

	const [drafts, setDrafts] = useState<Record<number, string>>({});
	const draftVersions = useRef<Record<number, number>>({});
	const [chatErrors, setChatErrors] = useState<Record<number, ApiError | null>>(
		{},
	);
	const [submitting, setSubmitting] = useState<Set<number>>(() => new Set());
	const submissionRequests = useRef(new Set<number>());
	const cancellationRequests = useRef(new Set<number>());
	const [stopping, setStopping] = useState<Set<number>>(() => new Set());
	const [stopErrors, setStopErrors] = useState<Record<number, ApiError | null>>(
		{},
	);
	const reconciliationReads = useRef(new Map<number, number>());
	const [reconciling, setReconciling] = useState<Set<number>>(() => new Set());
	const confirmBusy = useCallback((id: number, read: number) => {
		const uncertainRead = reconciliationReads.current.get(id);
		if (uncertainRead === undefined || read <= uncertainRead) return;
		reconciliationReads.current.delete(id);
		setReconciling(new Set(reconciliationReads.current.keys()));
	}, []);
	const changeSelectedChat = useCallback((id: number | null) => {
		const previous = selectedRef.current;
		if (
			previous !== null &&
			previous !== id &&
			taskSelectedRef.current === null
		) {
			const saved = readingPositions.current[previous];
			readingPositions.current[previous] = {
				...saved,
				top: chatContent.current?.scrollTop ?? 0,
				bottom: false,
			};
		}
		if (previous !== id) {
			normalizationAttempt.current = "";
		}
		selectedRef.current = id;
		setSelected(id);
	}, []);
	function selectAgent(id: number) {
		const url = new URL(location.href);
		url.searchParams.set("agent", String(id));
		history.pushState(null, "", url);
		setSelectedAgent(id);
	}

	function selectChat(id: number) {
		const url = new URL(location.href);
		url.searchParams.set("chat", String(id));
		url.searchParams.delete("agent");
		setSelectedAgent(null);
		history.pushState(null, "", url);
		changeSelectedChat(id);
	}
	const refreshChat = useCallback(
		async (chatId?: number) => {
			const id = chatId ?? selectedRef.current;
			if (id === null) return;
			const revision = (chatRevisions.current[id] ?? 0) + 1;
			chatRevisions.current[id] = revision;
			const current = () => chatRevisions.current[id] === revision;
			let read = ++readSequence.current;
			try {
				const latest: ChatState = await api(`/api/chats/${id}`);
				if (!current()) return;
				// Validate fresh choices only after a current model/capability read.
				await refreshModelSettings();
				if (!current()) return;
				optionReads.current[id] = revision;
				if (latest.chatOptions && !optionRequests.current.has(id))
					setChatOptions((current) => ({
						...current,
						[id]: latest.chatOptions as ChatOptions,
					}));
				const cached = cacheRef.current[id];
				let cursor = cached?.historyLoaded
					? (syncedThrough.current[id] ?? 0)
					: undefined;
				const pendingId = cached?.historyLoaded
					? cached.agents.find((agent) => agent.status === "pending")?.id
					: undefined;
				if (pendingId !== undefined)
					cursor = Math.min(cursor ?? pendingId - 1, pendingId - 1);
				const target = latest.agents.at(-1)?.id;
				mergeChat(id, latest, false, read);
				confirmBusy(id, read);
				// Refresh cached pending records and fill unseen agents in bounded pages.
				while (
					cursor !== undefined &&
					target !== undefined &&
					cursor < target
				) {
					read = ++readSequence.current;
					const next: ChatState = await api(`/api/chats/${id}?after=${cursor}`);
					if (!current()) return;
					mergeChat(id, next, false, read);
					const last = next.agents.at(-1)?.id;
					if (last === undefined || last <= cursor) break;
					cursor = last;
					syncedThrough.current[id] = last;
				}
				if (!current()) return;
				syncedThrough.current[id] = Math.max(
					syncedThrough.current[id] ?? 0,
					target ?? 0,
				);
				setHistoryErrors((errors) => ({ ...errors, [id]: null }));
			} catch (cause) {
				if (!current()) return;
				const error = appError(cause);
				if (
					error.code === "chatNotFound" &&
					selectedRef.current === id &&
					urlChat() === id
				) {
					const url = new URL(location.href);
					url.searchParams.delete("chat");
					history.replaceState(null, "", url);
					changeSelectedChat(null);
					return;
				}
				setHistoryErrors((errors) => ({ ...errors, [id]: error }));
			}
		},
		[mergeChat, changeSelectedChat, confirmBusy, refreshModelSettings],
	);
	const refreshAgent = useCallback(
		async (chatId: number, agentId: number) => {
			const read = ++readSequence.current;
			try {
				const data: ChatState = await api(`/api/agents/${agentId}`);
				if (data.agents[0]?.parentAgentId != null) return;
				if ((agentReads.current[agentId] ?? 0) > read) return;
				if (cacheRef.current[chatId] || selectedRef.current === chatId)
					mergeChat(chatId, data, false, read, true);
				else updateBusy(chatId, data.busy, read);
				confirmBusy(chatId, read);
				setHistoryErrors((errors) => ({ ...errors, [chatId]: null }));
			} catch (cause) {
				if ((agentReads.current[agentId] ?? 0) <= read)
					setHistoryErrors((errors) => ({
						...errors,
						[chatId]: appError(cause),
					}));
			}
		},
		[mergeChat, updateBusy, confirmBusy],
	);
	async function loadEarlier() {
		const id = selectedRef.current;
		if (id === null || earlierRequests.current.has(id)) return;
		const state = cacheRef.current[id];
		const before = state?.agents[0]?.id;
		if (!state?.hasMore || before === undefined) return;
		earlierRequests.current.add(id);
		setLoadingEarlier(new Set(earlierRequests.current));
		try {
			const read = ++readSequence.current;
			const data: ChatState = await api(`/api/chats/${id}?before=${before}`);
			mergeChat(id, data, true, read);
			setEarlierErrors((errors) => ({ ...errors, [id]: null }));
		} catch (cause) {
			setEarlierErrors((errors) => ({ ...errors, [id]: appError(cause) }));
		} finally {
			earlierRequests.current.delete(id);
			setLoadingEarlier(new Set(earlierRequests.current));
		}
	}
	useEffect(() => {
		selectedRef.current = selected;
		void refreshChat();
	}, [selected, refreshChat]);
	useEffect(() => {
		const pop = () => {
			changeSelectedChat(urlChat());
			setSelectedAgent(urlAgent());
		};
		window.addEventListener("popstate", pop);
		return () => window.removeEventListener("popstate", pop);
	}, [changeSelectedChat]);
	async function stopAgent(chatId: number, agentId: number) {
		if (cancellationRequests.current.has(agentId)) return;
		cancellationRequests.current.add(agentId);
		setStopping(new Set(cancellationRequests.current));
		setStopErrors((current) => ({ ...current, [agentId]: null }));
		try {
			await api(`/api/agents/${agentId}/cancel`, "POST");
		} catch (cause) {
			setStopErrors((current) => ({ ...current, [agentId]: appError(cause) }));
		} finally {
			await refreshAgent(chatId, agentId);
			cancellationRequests.current.delete(agentId);
			setStopping(new Set(cancellationRequests.current));
			void refreshChat(chatId);
		}
	}
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const id = selected;
		if (
			id === null ||
			readOnly ||
			chatState?.id !== id ||
			chatState.busy ||
			submissionRequests.current.has(id) ||
			reconciliationReads.current.has(id) ||
			optionRequests.current.has(id) ||
			!(drafts[id] ?? "").trim() ||
			!modelSettings?.apiKeyConfigured ||
			modelSettingsError ||
			!chatOptions[id] ||
			!validChatOptions(chatOptions[id], modelSettings.models)
		)
			return;
		readingPositions.current[id] = { top: 0, bottom: true };
		restoreReadingPosition();
		const prompt = drafts[id] ?? "";
		const version = draftVersions.current[id] ?? 0;
		submissionRequests.current.add(id);
		setSubmitting(new Set(submissionRequests.current));
		setChatErrors((current) => ({ ...current, [id]: null }));
		try {
			const { agentId } = await api(`/api/chats/${id}`, "POST", {
				prompt,
			});
			const current = cacheRef.current[id];
			const accepted = current?.agents.find((agent) => agent.id === agentId);
			if (current && (!accepted || accepted.status === "pending")) {
				// Establish execution ownership before releasing the submission lock.
				updateBusy(id, true, ++readSequence.current);
				cacheRef.current = {
					...cacheRef.current,
					[id]: { ...current, busy: true },
				};
				setChatCache(cacheRef.current);
			}
			void refreshAgent(id, agentId);
			if ((draftVersions.current[id] ?? 0) === version)
				setDrafts((current) => ({ ...current, [id]: "" }));
		} catch (cause) {
			const error = appError(cause);
			if (error.code === "networkFailed" || error.code === "invalidResponse") {
				// Missing confirmation is ambiguous: keep Send locked until a newer read.
				reconciliationReads.current.set(id, ++readSequence.current);
				setReconciling(new Set(reconciliationReads.current.keys()));
			}
			setChatErrors((current) => ({
				...current,
				[id]: error,
			}));
		} finally {
			submissionRequests.current.delete(id);
			setSubmitting(new Set(submissionRequests.current));
			void refreshChat(id);
		}
	}
	const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
	const [error, setError] = useState<ApiError | null>(null);
	const settingsDialog = useRef<HTMLDialogElement>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const executionCommit = useRef<(() => Promise<boolean>) | null>(null);
	const modelsCommit = useRef<(() => Promise<boolean>) | null>(null);
	const closingSettings = useRef(false);
	const [settingsClosing, setSettingsClosing] = useState(false);
	const [settingsTab, setSettingsTab] = useState("general");
	const openSettings = (required = false) => {
		if (!settingsDialog.current?.open) {
			setSettingsTab(required ? "models" : "general");
			settingsDialog.current?.showModal();
			setSettingsOpen(true);
		}
	};
	const [dialogChange, setDialogChange] = useState(0);
	const [approvals, setApprovals] = useState<Approval[]>([]);
	const [approvalsError, setApprovalsError] = useState("");
	const approvalsRead = useRef(0);
	const refreshApprovals = useCallback(async () => {
		const read = ++approvalsRead.current;
		try {
			const data = await api("/api/approvals");
			if (read !== approvalsRead.current) return;
			setApprovals(data.approvals);
			setApprovalsError("");
		} catch (cause) {
			if (read === approvalsRead.current)
				setApprovalsError(appError(cause).code);
		}
	}, []);
	const refreshRevision = useRef(0);
	const refresh = useCallback(async () => {
		const settingsReads = Promise.all([
			languageState.refresh(),
			enterState.refresh(),
			refreshModelSettings(),
		]);
		const revision = ++refreshRevision.current;
		const read = ++readSequence.current;
		try {
			const data = await api("/api/projects");
			if (revision === refreshRevision.current) {
				setProjectsLoaded(true);
				setProjectsError(null);
				setProjects((current) => {
					const busy = new Map(
						current.flatMap((project) =>
							project.chats.map((chat) => [chat.id, chat.busy] as const),
						),
					);
					return (data.projects as Project[]).map((project) => ({
						...project,
						chats: project.chats.map((chat) => {
							if ((busyReads.current[chat.id] ?? 0) > read)
								return { ...chat, busy: busy.get(chat.id) ?? chat.busy };
							busyReads.current[chat.id] = read;
							return chat;
						}),
					}));
				});
			}
		} catch (cause) {
			if (revision === refreshRevision.current)
				setProjectsError(appError(cause));
		}
		await settingsReads;
	}, [languageState, enterState, refreshModelSettings]);
	useEffect(() => {
		const sync = () => {
			void refresh();
			void refreshApprovals();
			const ids = new Set(Object.keys(cacheRef.current).map(Number));
			if (selectedRef.current !== null) ids.add(selectedRef.current);
			for (const id of ids) void refreshChat(id);
		};
		const visible = () => {
			if (document.visibilityState === "visible") sync();
		};
		sync();
		const events = new EventSource("/api/events");
		events.onopen = sync;
		events.onmessage = sync;
		events.addEventListener("agent", (event) => {
			void refreshApprovals();
			const { chatId, agentId, parentAgentId } = JSON.parse(event.data);
			if (parentAgentId != null) {
				if (
					cacheRef.current[chatId]?.agents.some(
						(agent) => agent.id === parentAgentId,
					)
				)
					void refreshAgent(chatId, parentAgentId);
				return;
			}
			void refreshAgent(chatId, agentId);
		});
		events.onerror = () => {
			for (const id of Object.keys(cacheRef.current).map(Number)) {
				chatRevisions.current[id] = (chatRevisions.current[id] ?? 0) + 1;
				setHistoryErrors((errors) => ({
					...errors,
					[id]: new ApiError("networkFailed"),
				}));
			}
		};
		window.addEventListener("approvals-changed", sync);
		window.addEventListener("focus", sync);
		document.addEventListener("visibilitychange", visible);
		return () => {
			events.close();
			window.removeEventListener("approvals-changed", sync);
			window.removeEventListener("focus", sync);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [refresh, refreshChat, refreshAgent, refreshApprovals]);
	const [editorRequest, setEditorRequest] = useState<EditorTarget | null>(null);
	const [editorOpen, setEditorOpen] = useState(false);
	const [savingTarget, setSavingTarget] = useState<EditorTarget | null>(null);
	function openEditor(target: EditorTarget) {
		setEditorRequest(target);
		setEditorOpen(true);
	}
	const openEdit = (kind: "project" | "chat", id: number) =>
		openEditor({ kind, id });
	const openModal = (projectId: number | null) =>
		openEditor({ kind: "create", projectId });
	async function editorConfirmed(operation: EditorTarget, saved: EditorResult) {
		if (operation.kind !== "create") {
			const edit = operation;
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
		} else if (operation.projectId !== null) {
			const projectId = operation.projectId;
			selectChat(saved.id);
			setCollapsed((current) => {
				const next = new Set(current);
				next.delete(projectId);
				return next;
			});
		}
		await refresh();
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
							savingTarget !== null &&
							(savingTarget.kind !== "create" ||
								savingTarget.projectId !== project.id)
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
							(savingTarget !== null &&
								(savingTarget.kind !== "project" ||
									savingTarget.id !== project.id))
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
			{!archivedArea &&
				!collapsed.has(project.id) &&
				project.chats.length === 0 && (
					<button
						type="button"
						className={`${button} ml-5 mt-2`}
						disabled={
							savingTarget !== null &&
							(savingTarget.kind !== "create" ||
								savingTarget.projectId !== project.id)
						}
						onClick={() => openModal(project.id)}
					>
						{t("newChat")}
					</button>
				)}
			{!collapsed.has(project.id) && (
				<ul className="ml-5 mt-1 space-y-0.5">
					{project.chats.map((chat) => (
						<li key={chat.id} className="flex items-center">
							<button
								type="button"
								aria-current={selected === chat.id ? "page" : undefined}
								className={`min-w-0 flex-1 rounded-lg px-3 py-1.5 text-left break-words ${selected === chat.id ? "bg-neutral-200/60" : "hover:bg-neutral-100"}`}
								onClick={() => selectChat(chat.id)}
							>
								{chat.name}
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
										(savingTarget !== null &&
											(savingTarget.kind !== "chat" ||
												savingTarget.id !== chat.id))
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
							<span className="ml-1 flex w-4 shrink-0 items-center">
								{chat.busy && (
									<span
										role="status"
										aria-label={t("working")}
										className="pointer-events-none h-4 w-4 rounded-full border-2 border-neutral-300 border-t-neutral-600 motion-safe:animate-spin"
									/>
								)}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
	const archivedProjects = projects.filter(
		(project) =>
			project.archived || project.chats.some((chat) => chat.archived),
	);
	const project = projects.find((project) =>
		project.chats.some((chat) => chat.id === selected),
	);
	const chat = project?.chats.find((chat) => chat.id === selected);
	const readOnly = Boolean(project?.archived || chat?.archived);
	const options = selected === null ? undefined : chatOptions[selected];
	const missingSetup = Boolean(
		chat &&
			!readOnly &&
			!modelSettingsError &&
			modelSettings &&
			(!modelSettings.apiKeyConfigured || modelSettings.models.length === 0),
	);
	useEffect(() => {
		void dialogChange;
		const otherOpen = editorOpen;
		if (missingSetup && !otherOpen && !undersized) openSettings(true);
	});
	async function closeSettings() {
		if (closingSettings.current) return;
		closingSettings.current = true;
		setSettingsClosing(true);
		try {
			const [languageOK, enterOK, executionOK, modelsOK] = await Promise.all([
				commitLanguage(),
				commitEnter(),
				executionCommit.current?.() ?? false,
				modelsCommit.current?.() ?? false,
			]);
			if (!languageOK || !enterOK) {
				setSettingsTab("general");
				return;
			}
			if (!modelsOK) {
				setSettingsTab("models");
				return;
			}
			if (!executionOK) {
				setSettingsTab("execution");
				return;
			}
			await refreshModelSettings();
			const saved = await api("/api/model-settings");
			if (
				chat &&
				!readOnly &&
				(!saved.apiKeyConfigured || saved.models.length === 0)
			) {
				setSettingsTab("models");
				return;
			}
			settingsDialog.current?.close();
		} catch {
			setModelSettingsError(true);
			setSettingsTab("models");
		} finally {
			closingSettings.current = false;
			setSettingsClosing(false);
		}
	}
	async function saveChatOptions(id: number, value: ChatOptions) {
		if (optionRequests.current.has(id)) return;
		optionRequests.current.add(id);
		chatRevisions.current[id] = (chatRevisions.current[id] ?? 0) + 1;
		setSavingOptions(new Set(optionRequests.current));
		setChatErrors((current) => ({ ...current, [id]: null }));
		try {
			const saved = await api(`/api/chats/${id}`, "PUT", value);
			setChatOptions((current) => ({ ...current, [id]: saved.chatOptions }));
		} catch (cause) {
			setChatErrors((current) => ({ ...current, [id]: appError(cause) }));
		} finally {
			optionRequests.current.delete(id);
			setSavingOptions(new Set(optionRequests.current));
			void refreshChat(id);
		}
	}
	useEffect(() => {
		if (
			selected === null ||
			!chat ||
			readOnly ||
			!modelSettings ||
			modelSettingsApplied.current !== modelSettingsRead.current ||
			!options ||
			optionReads.current[selected] !== chatRevisions.current[selected] ||
			settingsOpen ||
			optionRequests.current.has(selected)
		)
			return;
		let next = normalizeChatOptions(options, modelSettings.models);
		if (next.modelId === null && modelSettings.defaultModelId)
			next = { modelId: modelSettings.defaultModelId, reasoningEffort: null };
		const attempt = JSON.stringify([selected, options, next]);
		if (JSON.stringify(next) === JSON.stringify(options)) {
			normalizationAttempt.current = "";
			return;
		}
		if (normalizationAttempt.current === attempt) return;
		normalizationAttempt.current = attempt;
		void saveChatOptions(selected, next);
	});
	const changeChatOptions = (value: ChatOptions) => {
		if (selected !== null) void saveChatOptions(selected, value);
	};
	useLayoutEffect(() => {
		const notice = viewportNotice.current;
		if (!notice) return;
		if (undersized && !notice.open) {
			viewportFocus.current = document.activeElement as HTMLElement | null;
			notice.showModal();
		} else if (!undersized && notice.open) {
			notice.close();
			viewportFocus.current?.focus({ preventScroll: true });
		}
	});
	const notice = (
		<dialog
			ref={viewportNotice}
			closedby="none"
			onCancel={(event) => event.preventDefault()}
			aria-labelledby="viewport-title"
			aria-describedby="viewport-description"
			onKeyDown={(event) => {
				if (event.key === "Tab") {
					event.preventDefault();
					event.currentTarget.focus();
				}
			}}
			tabIndex={-1}
			className="m-auto max-w-lg rounded-lg border border-neutral-300 p-6 text-neutral-700 backdrop:bg-white"
		>
			<h2 id="viewport-title" className="text-lg font-semibold">
				{t("enlargeWindow")}
			</h2>
			<p id="viewport-description" className="mt-3">
				{t("minimumViewport")}
			</p>
		</dialog>
	);
	if (!languageReady)
		return (
			<main className="p-6">
				{languageError ? (
					<>
						<p role="alert" className="text-red-700">
							{t(languageError)}
						</p>
						<button
							type="button"
							className={button}
							onClick={() =>
								void (languageDraft.current === null
									? languageState.refresh()
									: commitLanguage())
							}
						>
							{t("retry")}
						</button>
					</>
				) : (
					<p role="status">{t("loading")}</p>
				)}
				{notice}
			</main>
		);
	return (
		<main className="flex h-dvh min-h-[720px] min-w-[1280px] overflow-hidden text-neutral-700">
			<aside
				id="projects-panel"
				aria-label={t("projects")}
				style={{ width: sidebarWidth }}
				className="relative flex h-full shrink-0 flex-col bg-neutral-50 p-3"
			>
				<header className="shrink-0">
					<h1 className="mb-3 px-2 text-lg font-semibold">Tyler Agent</h1>
					<ApprovalInbox
						approvals={approvals}
						error={approvalsError}
						refresh={() => void refreshApprovals()}
					/>
					<button
						type="button"
						className="flex items-center gap-2 rounded-md px-3 py-2 text-left enabled:hover:bg-neutral-100 disabled:opacity-50"
						aria-label={t("newProject")}
						disabled={
							savingTarget !== null &&
							(savingTarget.kind !== "create" ||
								savingTarget.projectId !== null)
						}
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
					{archivedProjects.length > 0 && (
						<details aria-label={t("archived")} className="mt-4">
							<summary className="cursor-pointer">{t("archived")}</summary>
							<div className="mt-4 space-y-4">
								{archivedProjects.map((project) =>
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
					)}
					{error && (
						<p
							role="alert"
							className="mt-4 whitespace-pre-wrap break-words text-red-700"
						>
							{errorText(error)}
						</p>
					)}
				</div>
				<footer className="shrink-0 pt-3">
					<button
						type="button"
						className={`${iconButton} self-start`}
						aria-label={t("settings")}
						title={t("settings")}
						onClick={() => openSettings(missingSetup)}
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
			<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<section
					ref={chatContent}
					aria-label={t("chat")}
					className={`${selectedAgent !== null ? "hidden" : ""} min-h-0 flex-1 overflow-auto overscroll-contain px-6 py-10 [overflow-anchor:none]`}
					onScroll={(event) => {
						if (selected === null || taskSelectedRef.current !== null) return;
						const content = event.currentTarget;
						const top = content.getBoundingClientRect().top;
						const anchors = [
							...content.querySelectorAll<HTMLElement>("[data-reading-anchor]"),
						];
						const anchor =
							anchors
								.filter((element) => {
									const bounds = element.getBoundingClientRect();
									return bounds.top <= top && bounds.bottom > top;
								})
								.at(-1) ??
							anchors.find(
								(element) => element.getBoundingClientRect().bottom > top,
							);
						const saved = readingPositions.current[selected];
						const maxTop = content.scrollHeight - content.clientHeight;
						readingPositions.current[selected] = {
							top: content.scrollTop,
							bottom:
								(saved?.bottom &&
									content.scrollTop >= Math.min(saved.top, maxTop)) ||
								maxTop - content.scrollTop < 24,
							...(anchor?.dataset.readingAnchor
								? {
										anchor: {
											id: anchor.dataset.readingAnchor,
											offset: anchor.getBoundingClientRect().top - top,
										},
									}
								: {}),
						};
					}}
				>
					{projectsError && (
						<div
							role="alert"
							className="mx-auto max-w-2xl whitespace-pre-wrap break-words text-red-700"
						>
							{errorText(projectsError)}{" "}
							<button
								type="button"
								className={button}
								onClick={() => void refresh()}
							>
								{t("retry")}
							</button>
						</div>
					)}
					{!projectsLoaded && !projectsError && (
						<p role="status">{t("loadingProjects")}</p>
					)}
					{selected === null && projectsLoaded && !projectsError && (
						<div className="mx-auto max-w-2xl">
							<h2 className="text-xl font-medium">{t("welcome")}</h2>
							<p className="mt-3">
								{t(
									projects.some((project) => !project.archived)
										? "chooseProjectChat"
										: "createProjectGuidance",
								)}
							</p>
						</div>
					)}
					{selected !== null &&
						!chat &&
						!historyErrors[selected] &&
						projectsLoaded && <p role="status">{t("loadingHistory")}</p>}
					{selected !== null && !chat && historyErrors[selected] && (
						<p
							role="alert"
							className="whitespace-pre-wrap break-words text-red-700"
						>
							{errorText(historyErrors[selected])}{" "}
							<button
								type="button"
								className={button}
								onClick={() => void refreshChat(selected)}
							>
								{t("retry")}
							</button>
						</p>
					)}

					{project && chat && selectedAgent === null && (
						<div className="mx-auto max-w-2xl">
							<p className="text-neutral-600">{project.name}</p>
							<h2 className="mt-2 text-xl font-medium">{chat.name}</h2>
							<h3 className="mt-6 font-medium">{t("targetFolders")}</h3>
							{project.folders.length === 0 && (
								<p className="mt-2 text-sm text-neutral-600">
									{t("emptyTargetFolders")}
								</p>
							)}
							<ul className="mt-2 space-y-1 text-neutral-600">
								{project.folders.map((folder) => (
									<li key={folder} className="break-all">
										{folder}
									</li>
								))}
							</ul>
							{!chatState?.historyLoaded && !historyErrors[chat.id] && (
								<p role="status" className="mt-6">
									{t("loadingHistory")}
								</p>
							)}
							{chatState?.historyLoaded &&
								chatState.messages.length === 0 &&
								!historyErrors[chat.id] &&
								!readOnly && <p className="mt-6">{t("firstQuestion")}</p>}
							{chatState?.hasMore && (
								<button
									type="button"
									className={`${button} mt-6`}
									disabled={loadingEarlier.has(chat.id)}
									onClick={() => void loadEarlier()}
								>
									{t(loadingEarlier.has(chat.id) ? "loading" : "loadEarlier")}
								</button>
							)}
							{earlierErrors[chat.id] && (
								<p role="status" className="mt-4 text-red-700">
									{errorText(earlierErrors[chat.id])}{" "}
									<button
										type="button"
										className={button}
										disabled={loadingEarlier.has(chat.id)}
										onClick={() => void loadEarlier()}
									>
										{t("retry")}
									</button>
								</p>
							)}
							{historyErrors[chat.id] && (
								<p role="status" className="mt-4 text-red-700">
									{errorText(historyErrors[chat.id])}{" "}
									<button
										type="button"
										className={button}
										onClick={() => void refreshChat(chat.id)}
									>
										{t("retry")}
									</button>
								</p>
							)}
							<div
								role="log"
								aria-label={t("chatHistory")}
								className="mt-6 space-y-4"
							>
								{chatState?.id === chat.id &&
									chatState.messages.map((message) => (
										<div
											key={message.id}
											data-message-id={message.id}
											data-reading-anchor={message.id}
											className="whitespace-pre-wrap"
										>
											<strong>
												{message.role === "user"
													? t("you")
													: `${t("agent")} #${Number(message.id.split("-")[0])} · ${t(`taskStatus_${chatState.agents.find((agent) => agent.id === Number(message.id.split("-")[0]))?.status}`)}`}
												{t("labelSeparator")}
											</strong>
											{message.role === "assistant" ? (
												<AgentContent
													onSelectAgent={selectAgent}
													agent={chatState.agents.find(
														(agent) =>
															agent.id === Number(message.id.split("-")[0]),
													)}
													revision={message.revision ?? 0}
													onLayoutChange={restoreReadingPosition}
													stopping={stopping.has(
														Number(message.id.split("-")[0]),
													)}
													stopError={
														stopErrors[Number(message.id.split("-")[0])]
															? errorText(
																	stopErrors[Number(message.id.split("-")[0])],
																)
															: undefined
													}
													onStop={() =>
														void stopAgent(
															chat.id,
															Number(message.id.split("-")[0]),
														)
													}
												/>
											) : (
												<>
													{message.content}
													<div className="mt-2">
														<button
															type="button"
															className={button}
															onClick={() =>
																selectAgent(Number(message.id.split("-")[0]))
															}
														>
															{t("taskTree")}
														</button>
													</div>
												</>
											)}
										</div>
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
						</div>
					)}
				</section>
				{selectedAgent !== null && (
					<TaskView
						agentId={selectedAgent}
						onSelect={setSelectedAgent}
						onChat={(id) => {
							selectChat(id);
						}}
					/>
				)}
				{project && chat && !readOnly && selectedAgent === null && (
					<div className="shrink-0 border-t border-neutral-200 px-6 py-4">
						<form className="mx-auto max-w-2xl" onSubmit={submit}>
							<div className="rounded-2xl border border-neutral-300 bg-white p-3 focus-within:border-neutral-500">
								<textarea
									className="composer-input block w-full resize-none bg-transparent px-1 py-2 text-neutral-950 focus-visible:outline-2 focus-visible:outline-blue-600"
									aria-label={t("prompt")}
									placeholder={t("prompt")}
									rows={2}
									onCompositionStart={() => {
										composing.current = true;
										compositionEndedAt.current = -Infinity;
									}}
									onCompositionEnd={() => {
										// Some IMEs finish composition before the confirmation keydown.
										composing.current = false;
										compositionEndedAt.current = performance.now();
									}}
									onKeyUp={(event) => {
										if (event.key === "Enter")
											compositionEndedAt.current = -Infinity;
									}}
									onKeyDown={(event) => {
										if (event.key !== "Enter") {
											compositionEndedAt.current = -Infinity;
											return;
										}
										if (
											composing.current ||
											event.nativeEvent.isComposing ||
											event.nativeEvent.keyCode === 229 ||
											performance.now() - compositionEndedAt.current < 100
										)
											return;
										const primary = mac ? event.metaKey : event.ctrlKey;
										if (
											event.shiftKey ||
											event.altKey ||
											(!primary && (event.ctrlKey || event.metaKey))
										)
											return;
										if (!primary && enterBehavior !== "send") return;
										event.preventDefault();
										if (!event.repeat)
											event.currentTarget.form?.requestSubmit();
									}}
									readOnly={readOnly}
									disabled={submitting.has(chat.id)}
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
								<div className="flex min-h-11 items-center justify-end gap-2 pt-2">
									{options && (
										<div className="mr-auto flex min-w-0 flex-1 flex-wrap gap-1">
											<ChatOptionPicker
												options={options}
												models={modelSettings?.models ?? []}
												change={changeChatOptions}
												saving={savingOptions.has(chat.id)}
												disabled={readOnly || modelSettingsError}
											/>
										</div>
									)}
									<button
										type="submit"
										aria-label={submitName}
										title={submitName}
										className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-950 text-white enabled:hover:bg-neutral-700 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
										disabled={
											!(drafts[chat.id] ?? "").trim() ||
											readOnly ||
											modelSettingsError ||
											!modelSettings?.apiKeyConfigured ||
											!options ||
											!validChatOptions(options, modelSettings.models) ||
											chatState?.id !== chat.id ||
											chatState.busy ||
											submitting.has(chat.id) ||
											reconciling.has(chat.id) ||
											savingOptions.has(chat.id)
										}
									>
										<svg
											aria-hidden="true"
											className="h-4 w-4"
											viewBox="0 0 16 16"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.75"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<path d="M8 12V4m-3.5 3.5L8 4l3.5 3.5" />
										</svg>
									</button>
								</div>
							</div>
							{modelSettingsError && !readOnly && (
								<div role="alert" className="mt-4 text-red-700">
									{t("configurationReadFailed")}{" "}
									<button
										type="button"
										className={button}
										onClick={() => void refreshModelSettings()}
									>
										{t("retry")}
									</button>
								</div>
							)}
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
			</div>
			<ProjectEditor
				projects={projects}
				request={editorRequest}
				onClose={(open) => {
					setEditorOpen(open);
					if (!open) setEditorRequest(null);
				}}
				onSaving={setSavingTarget}
				onConfirmed={editorConfirmed}
			/>
			<dialog
				onClose={() => {
					setSettingsOpen(false);
					normalizationAttempt.current = "";
					void refreshChat();
					setDialogChange((value) => value + 1);
				}}
				closedby="any"
				onCancel={(event) => {
					event.preventDefault();
					void closeSettings();
				}}
				ref={settingsDialog}
				aria-labelledby="settings-title"
				className="settings-dialog m-auto w-full max-w-lg rounded-lg border border-neutral-300 backdrop:bg-black/40"
			>
				<header className="shrink-0 border-b border-neutral-200 px-6 py-4">
					<h2 id="settings-title" className="text-lg font-semibold">
						{t("settings")}
					</h2>
					{missingSetup && (
						<p role="status" className="mt-2 break-words text-amber-700">
							{t(
								!modelSettings?.apiKeyConfigured
									? modelSettings?.models.length
										? "setupKeyRequired"
										: "setupBothRequired"
									: "setupModelsRequired",
							)}
						</p>
					)}
				</header>
				<div
					role="tablist"
					aria-label={t("settings")}
					className="flex shrink-0 border-b border-neutral-200 px-6"
				>
					{["general", "models", "execution"].map((tab) => (
						<button
							type="button"
							role="tab"
							key={tab}
							id={`settings-tab-${tab}`}
							aria-controls={`settings-panel-${tab}`}
							aria-selected={settingsTab === tab}
							onClick={() => setSettingsTab(tab)}
							className={`flex-1 border-b-2 px-2 py-3 focus-visible:outline-2 focus-visible:outline-blue-600 ${settingsTab === tab ? "border-blue-600 text-blue-700" : "border-transparent hover:bg-neutral-100"}`}
						>
							{t(`settings${tab[0].toUpperCase()}${tab.slice(1)}`)}
						</button>
					))}
				</div>
				<div
					role="tabpanel"
					id="settings-panel-general"
					aria-labelledby="settings-tab-general"
					hidden={settingsTab !== "general"}
					className="settings-content min-h-0 flex-1 overflow-y-auto px-6 py-4"
				>
					<fieldset disabled={settingsClosing} className="min-w-0">
						<h3 className="font-semibold">{t("settingsLanguage")}</h3>
						<label className="block">
							<span className="sr-only">{t("language")}</span>
							<select
								className={control}
								value={language ?? i18n.language}
								disabled={languagePending || language === null}
								onChange={(event) => {
									languageDraft.current = event.target.value;
									setLanguage(event.target.value);
									void commitLanguage();
								}}
							>
								<option value="en">English</option>
								<option value="zh-CN">简体中文</option>
							</select>
						</label>
						<p role="status" className="mt-2 min-h-5 text-sm text-neutral-600">
							{(languagePending || languageSaved) &&
								t(languagePending ? "settingsSaving" : "settingsSaved")}
						</p>
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
									onClick={() =>
										void (languageDraft.current === null
											? languageState.refresh()
											: commitLanguage())
									}
								>
									{t("retry")}
								</button>
							</div>
						)}
						<h3 className="mt-6 font-semibold">{t("enterBehavior")}</h3>
						<label className="block">
							<span className="sr-only">{t("enterBehavior")}</span>
							<select
								className={control}
								value={enterBehavior ?? ""}
								aria-describedby="enter-behavior-help"
								disabled={enterPending || enterBehavior === null}
								onChange={(event) => {
									enterDraft.current = event.target.value;
									setEnterBehavior(event.target.value);
									void commitEnter();
								}}
							>
								{enterBehavior === null && (
									<option value="">{t("loading")}</option>
								)}
								<option value="send">{t("enterSend")}</option>
								<option value="newline">{t("enterNewline")}</option>
							</select>
						</label>
						<p
							id="enter-behavior-help"
							className="mt-2 text-sm text-neutral-600"
						>
							{t("enterHelp", { shortcut: mac ? "⌘+Enter" : "Ctrl+Enter" })}
						</p>
						<p role="status" className="mt-2 min-h-5 text-sm text-neutral-600">
							{(enterPending || enterSaved) &&
								t(enterPending ? "settingsSaving" : "settingsSaved")}
						</p>
						{enterError && (
							<div className="mt-4">
								<p role="alert" className="text-red-700">
									{t(enterError)}
								</p>
								<button
									type="button"
									className={button}
									disabled={enterPending}
									onClick={() =>
										void (enterDraft.current === null
											? enterState.refresh()
											: commitEnter())
									}
								>
									{t("retry")}
								</button>
							</div>
						)}
					</fieldset>
				</div>
				<div
					role="tabpanel"
					id="settings-panel-execution"
					aria-labelledby="settings-tab-execution"
					hidden={settingsTab !== "execution"}
					className="settings-content min-h-0 flex-1 overflow-y-auto px-6 py-4"
				>
					<fieldset disabled={settingsClosing} className="min-w-0">
						<ExecutionLimits open={settingsOpen} commitRef={executionCommit} />
					</fieldset>
				</div>
				<div
					role="tabpanel"
					id="settings-panel-models"
					aria-labelledby="settings-tab-models"
					hidden={settingsTab !== "models"}
					className="settings-content min-h-0 flex-1 overflow-y-auto px-6 py-4"
				>
					<fieldset disabled={settingsClosing} className="min-w-0">
						<ModelConfiguration
							commitRef={modelsCommit}
							active={settingsTab === "models" && !settingsClosing}
							open={settingsOpen}
							settings={modelSettings}
							readFailed={modelSettingsError}
							refresh={refreshModelSettings}
						/>
					</fieldset>
				</div>
				<footer className="flex shrink-0 items-center justify-between gap-3 border-t border-neutral-200 px-6 py-4">
					<p className="text-sm text-neutral-600">{t("settingsAutosave")}</p>
					<button
						type="button"
						className={button}
						disabled={settingsClosing}
						onPointerDown={(event) => event.preventDefault()}
						onClick={() => void closeSettings()}
					>
						{t("close")}
					</button>
				</footer>
			</dialog>
			{notice}
		</main>
	);
}
createRoot(document.getElementById("root") as HTMLElement).render(<App />);
