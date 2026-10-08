import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { AgentContent, type AgentDetail } from "./agent-content.tsx";

export const urlAgent = () => {
	const value = new URL(location.href).searchParams.get("agent");
	return value && /^[1-9]\d*$/.test(value) ? Number(value) : null;
};
type TreeNode = Pick<
	AgentDetail,
	"id" | "question" | "status" | "parentAgentId"
>;
type TaskTree = {
	rootAgentId: number;
	chatId: number;
	projectId: number;
	agents: TreeNode[];
};
// Page lifetime only, independent of root Chat history.
const taskRecords: Record<number, { agent: AgentDetail; revision: number }> =
	{};
const taskPositions: Record<
	number,
	{ top: number; anchor?: { id: string; offset: number } }
> = {};
const expandedNodes = new Set<number>();
const initializedRoots = new Set<number>();
const cancellations = new Map<number, "stopping" | "agentCancelFailed">();
const cancellationListeners = new Set<() => void>();
const subscribeCancellation = (listener: () => void) => {
	cancellationListeners.add(listener);
	return () => {
		cancellationListeners.delete(listener);
	};
};
const notifyCancellation = () => {
	for (const listener of cancellationListeners) listener();
};
const button =
	"rounded-md border border-neutral-300 px-3 py-2 hover:bg-neutral-100 disabled:opacity-50";

export function TaskView({
	agentId,
	onSelect,
	onChat,
}: {
	agentId: number;
	onSelect: (id: number) => void;
	onChat: (id: number) => void;
}) {
	const { t } = useTranslation();
	const mounted = useRef(true);
	const selected = useRef(agentId);
	selected.current = agentId;
	const [tree, setTree] = useState<TaskTree | null>(null);
	const treeRef = useRef(tree);
	treeRef.current = tree;
	const [cache, setCache] = useState<
		Record<number, { agent: AgentDetail; revision: number }>
	>({ ...taskRecords });
	const [error, setError] = useState<string | null>(null);
	const reads = useRef(
		new Map(
			Object.entries(taskRecords).map(([id, value]) => [
				Number(id),
				value.revision,
			]),
		),
	);
	const treeRead = useRef(0);
	const revealedAgent = useRef<number | null>(null);
	const cancellation = useSyncExternalStore(subscribeCancellation, () =>
		cancellations.get(agentId),
	);
	const [expanded, setExpanded] = useState(new Set(expandedNodes));
	const content = useRef<HTMLElement>(null);
	const positions = useRef(taskPositions);
	const restore = useCallback(() => {
		const element = content.current;
		if (!element) return;
		const saved = positions.current[selected.current];
		const anchor =
			saved?.anchor &&
			element.querySelector<HTMLElement>(
				`[data-reading-anchor="${saved.anchor.id}"]`,
			);
		element.scrollTop =
			anchor && saved?.anchor
				? element.scrollTop +
					anchor.getBoundingClientRect().top -
					element.getBoundingClientRect().top -
					saved.anchor.offset
				: (saved?.top ?? 0);
	}, []);
	useLayoutEffect(restore);
	const refresh = useCallback(async (id: number) => {
		if (!mounted.current) return;
		const read = (reads.current.get(id) ?? 0) + 1;
		reads.current.set(id, read);
		try {
			const response = await fetch(`/api/agents/${id}`);
			if (!response.ok) throw new Error("taskReadFailed");
			const data = await response.json();
			if (!mounted.current || reads.current.get(id) !== read) return;
			taskRecords[id] = { agent: data.agents[0], revision: read };
			setCache((current) => ({
				...current,
				[id]: { agent: data.agents[0], revision: read },
			}));
			if (selected.current === id) setError(null);
		} catch {
			if (reads.current.get(id) === read && selected.current === id)
				setError("taskReadFailed");
		}
	}, []);
	const refreshTree = useCallback(async (id: number) => {
		const read = ++treeRead.current;
		try {
			const response = await fetch(`/api/agents/${id}/tree`);
			if (!response.ok) throw new Error("taskReadFailed");
			const data: TaskTree = await response.json();
			if (read !== treeRead.current) return;
			if (!initializedRoots.has(data.rootAgentId)) {
				initializedRoots.add(data.rootAgentId);
				expandedNodes.add(data.rootAgentId);
				setExpanded(new Set(expandedNodes));
			}
			if (revealedAgent.current !== selected.current) {
				const byId = new Map(data.agents.map((node) => [node.id, node]));
				let parentId = byId.get(selected.current)?.parentAgentId;
				while (parentId != null) {
					expandedNodes.add(parentId);
					parentId = byId.get(parentId)?.parentAgentId;
				}
				revealedAgent.current = selected.current;
				setExpanded(new Set(expandedNodes));
			}
			setTree(data);
		} catch {
			if (read === treeRead.current) setError("taskReadFailed");
		}
	}, []);
	useEffect(() => {
		if (cancellation === "stopping") return;
		void refresh(agentId);
		void refreshTree(agentId);
	}, [agentId, cancellation, refresh, refreshTree]);
	useEffect(() => {
		const sync = () => {
			void refresh(selected.current);
			void refreshTree(selected.current);
		};
		const events = new EventSource("/api/events");
		events.onopen = sync;
		events.onmessage = sync;
		events.addEventListener("agent", (event) => {
			const {
				agentId: changedId,
				chatId,
				parentAgentId,
			} = JSON.parse(event.data);
			if (changedId !== selected.current && chatId !== treeRef.current?.chatId)
				return;
			void refreshTree(selected.current);
			if (changedId === selected.current || parentAgentId === selected.current)
				void refresh(selected.current);
		});
		events.onerror = () => setError("networkFailed");
		const visible = () => {
			if (document.visibilityState === "visible") sync();
		};
		window.addEventListener("focus", sync);
		document.addEventListener("visibilitychange", visible);
		return () => {
			mounted.current = false;
			events.close();
			window.removeEventListener("focus", sync);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [refresh, refreshTree]);
	function select(id: number) {
		const url = new URL(location.href);
		url.searchParams.set("agent", String(id));
		if (tree) url.searchParams.set("chat", String(tree.chatId));
		history.pushState(null, "", url);
		setError(null);
		onSelect(id);
	}
	async function stop() {
		const id = agentId;
		if (cancellations.get(id) === "stopping") return;
		cancellations.set(id, "stopping");
		notifyCancellation();
		let failed = false;
		try {
			const response = await fetch(`/api/agents/${id}/cancel`, {
				method: "POST",
			});
			if (!response.ok) throw new Error();
		} catch {
			failed = true;
		} finally {
			if (failed) cancellations.set(id, "agentCancelFailed");
			else cancellations.delete(id);
			notifyCancellation();
		}
	}
	const summary = (node: TreeNode) => node.question.trim().split(/\r?\n/)[0];
	const nodeButton = (node: TreeNode) => (
		<button
			type="button"
			className={`inline-flex max-w-[calc(100%-1.25rem)] items-baseline gap-1 text-left underline-offset-2 hover:underline ${node.id === agentId ? "font-semibold text-blue-800" : ""}`}
			aria-current={node.id === agentId ? "page" : undefined}
			onClick={() => select(node.id)}
		>
			<span className="shrink-0">#{node.id}</span>{" "}
			<span className="min-w-0 truncate" title={summary(node)}>
				{summary(node)}
			</span>
			<span className="shrink-0 text-sm text-neutral-600">
				({t(`taskStatus_${node.status}`)})
			</span>
		</button>
	);
	// ponytail: flat scans suit small task trees; index children if large trees become slow.
	function nodeView(node: TreeNode) {
		const children =
			tree?.agents.filter((child) => child.parentAgentId === node.id) ?? [];
		return (
			<li key={node.id} className="mt-2 min-w-0">
				{children.length ? (
					<details
						open={expanded.has(node.id)}
						onToggle={(event) => {
							const open = event.currentTarget.open;
							setExpanded((current) => {
								const next = new Set(current);
								if (open) {
									next.add(node.id);
									expandedNodes.add(node.id);
								} else {
									next.delete(node.id);
									expandedNodes.delete(node.id);
								}
								return next;
							});
						}}
					>
						<summary className="cursor-pointer">{nodeButton(node)}</summary>
						<ul className="ml-4 border-l border-neutral-200 pl-3">
							{children.map(nodeView)}
						</ul>
					</details>
				) : (
					nodeButton(node)
				)}
			</li>
		);
	}
	const value = cache[agentId];
	const path: TreeNode[] = [];
	let node = tree?.agents.find((node) => node.id === agentId);
	while (node) {
		path.unshift(node);
		node = tree?.agents.find((parent) => parent.id === node?.parentAgentId);
	}
	const siblings =
		tree?.agents.filter(
			(node) =>
				node.parentAgentId === value?.agent.parentAgentId &&
				node.id !== agentId,
		) ?? [];
	return (
		<section
			ref={content}
			aria-label={t("agentDetails")}
			className="min-h-0 flex-1 overflow-auto overscroll-contain px-6 py-8 [overflow-anchor:none]"
			onScroll={(event) => {
				const element = event.currentTarget;
				const top = element.getBoundingClientRect().top;
				const anchors = [
					...element.querySelectorAll<HTMLElement>("[data-reading-anchor]"),
				];
				const anchor =
					anchors
						.filter((anchor) => {
							const bounds = anchor.getBoundingClientRect();
							return bounds.top <= top && bounds.bottom > top;
						})
						.at(-1) ??
					anchors.find((anchor) => anchor.getBoundingClientRect().bottom > top);
				positions.current[agentId] = {
					top: element.scrollTop,
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
			<div className="mx-auto max-w-2xl">
				{tree && (
					<>
						<button
							type="button"
							className={button}
							onClick={() => onChat(tree.chatId)}
						>
							{t("backToChat")}
						</button>
						<nav
							aria-label={t("taskPath")}
							className="mt-4 flex flex-wrap gap-2"
						>
							{path.map((node, index) => (
								<span key={node.id}>
									{index > 0 && " / "}
									<button
										type="button"
										className="hover:underline"
										aria-current={node.id === agentId ? "page" : undefined}
										onClick={() => select(node.id)}
									>
										{t("agent")} #{node.id}
									</button>
								</span>
							))}
						</nav>
						<details
							className="mt-4 rounded-md border border-neutral-200 p-3"
							open
						>
							<summary className="cursor-pointer font-medium">
								{t("taskTree")}
							</summary>
							<section aria-label={t("taskTree")}>
								<ul>
									{tree.agents
										.filter((node) => node.parentAgentId === null)
										.map(nodeView)}
								</ul>
							</section>
						</details>
					</>
				)}
				{error && (
					<p role="alert" className="mt-4 text-red-700">
						{t(error)}{" "}
						<button
							type="button"
							className={button}
							onClick={() => {
								void refresh(agentId);
								void refreshTree(agentId);
							}}
						>
							{t("retry")}
						</button>
					</p>
				)}
				{!value && !error && <p role="status">{t("loading")}</p>}
				{value && (
					<div
						key={agentId}
						className="mt-6 whitespace-pre-wrap break-words"
						data-reading-anchor={`task-${agentId}`}
					>
						<h2 className="text-xl font-medium">
							{t("agent")} #{agentId} · {t(`taskStatus_${value.agent.status}`)}
						</h2>
						{siblings.length > 0 && (
							<nav
								aria-label={t("siblingAgents")}
								className="mt-3 flex flex-wrap gap-3"
							>
								{siblings.map((node) => (
									<span key={node.id} className="max-w-full">
										{nodeButton(node)}
									</span>
								))}
							</nav>
						)}
						<h3 className="mt-4 font-medium">{t("prompt")}</h3>
						<p>{value.agent.question}</p>
						{value.agent.createdByToolCallId !== null && (
							<>
								<h3 className="mt-4 font-medium">{t("taskContext")}</h3>
								<p>{value.agent.context || t("emptyContext")}</p>
								<details className="mt-4 rounded-md bg-neutral-50 px-3 py-2 text-sm">
									<summary className="cursor-pointer">
										{t("creationParameters")} ·{" "}
										{t("toolCallTitle", { name: "create_sub_agent" })} #
										{value.agent.createdByToolCallId}
									</summary>
									<pre className="mt-2 whitespace-pre-wrap break-words">
										{JSON.stringify(value.agent.creationArguments, null, 2)}
									</pre>
								</details>
							</>
						)}
						<div className="mt-4">
							<AgentContent
								onSelectAgent={select}
								agent={value.agent}
								revision={value.revision}
								stopping={cancellation === "stopping"}
								stopError={
									cancellation === "agentCancelFailed"
										? t(cancellation)
										: undefined
								}
								onStop={() => void stop()}
								onLayoutChange={restore}
							/>
						</div>
					</div>
				)}
			</div>
		</section>
	);
}
