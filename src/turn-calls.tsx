import {
	Fragment,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";

type Call = {
	id: number;
	url: string;
	method: string;
	requestedAt: string;
	status: string;
	requestBody?: string | null;
	responseBody?: string | null;
	httpStatus: number | null;
	durationMs: number | null;
	error: string | null;
	errorCode?: string;
};
type SearchMatch = {
	start: number;
	end: number;
	anchor: string;
	partId: string;
	ordinal: number;
	before: string;
	after: string;
};
type RecordState = {
	open: boolean;
	scrollTop: number;
	searchOpen: boolean;
	query: string;
	match?: SearchMatch;
	calls?: Call[];
	status?: string;
	sourceRevision?: number;
	error: boolean;
	loading: boolean;
	revision: number;
};
// Page lifetime only: switching chats must not discard downloaded records.
const records = new Map<string, RecordState>();
function pretty(body: string) {
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}
function responseEvents(body: string) {
	if (!/^(?:event|data|id|retry):|^:/m.test(body)) return [pretty(body)];
	return body
		.split(/\r?\n\r?\n|\r\r/)
		.filter(Boolean)
		.map((event) => {
			const lines = event.split(/\r\n|\n|\r/);
			const data = lines
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""))
				.join("\n");
			try {
				const formatted = JSON.stringify(JSON.parse(data), null, 2);
				let inserted = false;
				return lines
					.flatMap((line) => {
						if (!line.startsWith("data:")) return [line];
						if (inserted) return [];
						inserted = true;
						return [`data: ${formatted}`];
					})
					.join("\n");
			} catch {
				return event;
			}
		});
}
function foldCase(text: string) {
	return Array.from(text, (character) =>
		character.toLowerCase().replaceAll("ς", "σ"),
	).join("");
}
function commonPrefix(left: string, right: string) {
	let length = 0;
	while (
		length < left.length &&
		length < right.length &&
		left[length] === right[length]
	)
		length++;
	return length;
}
export function TurnCalls({
	turnId,
	callId,
	ordinal,
	status,
	kind,
	revision = 0,
	onLayoutChange,
}: {
	turnId: number;
	callId: number;
	ordinal: number;
	status: string;
	kind: "request" | "response";
	revision?: number;
	onLayoutChange: () => void;
}) {
	const { t } = useTranslation();
	useLayoutEffect(onLayoutChange);
	const key = `${turnId}-${callId}-${kind}`;
	let state = records.get(key);
	if (!state) {
		state = {
			open: false,
			scrollTop: 0,
			searchOpen: false,
			query: "",
			error: false,
			loading: false,
			revision: 0,
		};
		records.set(key, state);
	}
	const record = state;
	const [, render] = useState(0);
	const [copyError, setCopyError] = useState(false);
	const [copied, setCopied] = useState(false);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const searchRef = useRef<HTMLInputElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => () => clearTimeout(copyTimer.current), []);
	useLayoutEffect(() => {
		if (record.open && bodyRef.current)
			bodyRef.current.scrollTop = record.scrollTop;
	});
	const parts = record.calls?.flatMap((call) => {
		const body = kind === "request" ? call.requestBody : call.responseBody;
		const metadata =
			kind === "request"
				? `${call.requestedAt} · ${call.method} ${call.url}`
				: [
						call.httpStatus === null ? "" : `HTTP ${call.httpStatus}`,
						call.durationMs === null ? "" : `${call.durationMs}ms`,
					]
						.filter(Boolean)
						.join(" · ");
		return [
			...(metadata
				? [{ text: metadata, body: false, id: `${call.id}-metadata` }]
				: []),
			...(kind === "response" && body == null
				? [
						{
							id: `${call.id}-no-body`,
							text: t(
								call.status === "pending"
									? "responseNotYetReceived"
									: "noResponse",
							),
							body: false,
						},
					]
				: []),
			...(kind === "response" && call.error
				? [
						{
							id: `${call.id}-error`,
							text: call.errorCode ? t(call.errorCode) : call.error,
							body: false,
						},
					]
				: []),
			...(typeof body === "string"
				? (kind === "response" ? responseEvents(body) : [pretty(body)]).map(
						(text, index) => ({
							text,
							body: true,
							id: `${call.id}-body-${index}`,
						}),
					)
				: []),
		];
	});
	const displayParts =
		record.calls?.length === 0
			? [{ text: t("noCalls"), body: false, id: "no-calls" }]
			: parts;
	const communicationText =
		displayParts?.map((part) => part.text).join("\n\n") ?? "";
	const matches: SearchMatch[] = [];
	const query = foldCase(record.query);
	if (record.searchOpen && query) {
		// Lowercasing can expand a character (İ); keep original text offsets.
		const offsets: number[] = [];
		const ends: number[] = [];
		const text = foldCase(communicationText);
		let offset = 0;
		for (const character of communicationText) {
			const folded = foldCase(character);
			for (let index = 0; index < folded.length; index++) {
				offsets.push(offset);
				ends.push(offset + character.length);
			}
			offset += character.length;
		}
		const occurrences = new Map<string, number>();
		let start = text.indexOf(query);
		while (start !== -1) {
			const originalStart = offsets[start];
			const end = ends[start + query.length - 1];
			start = text.indexOf(query, start + query.length);
			// Expanded characters can map disjoint folded matches to overlapping text.
			if (originalStart < (matches.at(-1)?.end ?? 0)) continue;
			let partStart = 0;
			const part = displayParts?.find((part) => {
				if (originalStart < partStart + part.text.length) return true;
				partStart += part.text.length + 2;
				return false;
			});
			const partId = part?.id ?? "";
			const ordinal = occurrences.get(partId) ?? 0;
			occurrences.set(partId, ordinal + 1);
			const before =
				part?.text.slice(0, originalStart - partStart).replace(/\s/g, "") ?? "";
			const boundary = `${partId}:${before.length}`;
			const occurrence = occurrences.get(boundary) ?? 0;
			occurrences.set(boundary, occurrence + 1);
			matches.push({
				start: originalStart,
				end,
				anchor: `${boundary}:${occurrence}`,
				partId,
				ordinal,
				// Nearby surviving text identifies a match through JSON reformatting.
				before: before.slice(-32).split("").reverse().join(""),
				after:
					part?.text
						.slice(end - partStart)
						.replace(/\s/g, "")
						.slice(0, 32) ?? "",
			});
		}
	}
	const previous = record.match;
	const retained =
		previous &&
		matches
			.map((match, index) => ({
				match,
				index,
				score:
					commonPrefix(match.before, previous.before) +
					commonPrefix(match.after, previous.after),
			}))
			.filter(({ match }) => match.partId === previous.partId)
			.sort(
				(left, right) =>
					right.score - left.score ||
					Number(right.match.anchor === previous.anchor) -
						Number(left.match.anchor === previous.anchor) ||
					Math.abs(left.match.ordinal - previous.ordinal) -
						Math.abs(right.match.ordinal - previous.ordinal),
			)[0];
	const currentMatch = retained?.index ?? 0;
	if (matches.length) record.match = matches[currentMatch];
	function navigate(direction: number) {
		const body = bodyRef.current;
		if (!body || !matches.length) return;
		const next = (currentMatch + direction + matches.length) % matches.length;
		record.match = matches[next];
		const target = body.querySelector<HTMLElement>(
			`[data-search-match="${next}"]`,
		);
		if (target) {
			const bounds = body.getBoundingClientRect();
			const outerBounds = body.closest("section")?.getBoundingClientRect();
			const top = Math.max(bounds.top, outerBounds?.top ?? bounds.top);
			const bottom = Math.min(
				bounds.bottom,
				outerBounds?.bottom ?? bounds.bottom,
			);
			const matchBounds = target.getBoundingClientRect();
			if (matchBounds.top < top) body.scrollTop += matchBounds.top - top;
			else if (matchBounds.bottom > bottom)
				body.scrollTop += matchBounds.bottom - bottom;
			record.scrollTop = body.scrollTop;
		}
		render((value) => value + 1);
	}
	function closeSearch() {
		record.searchOpen = false;
		render((value) => value + 1);
	}
	function highlighted(text: string, offset: number) {
		const fragments = [];
		let cursor = 0;
		for (const [index, match] of matches.entries()) {
			const from = Math.max(0, match.start - offset);
			const to = Math.min(text.length, match.end - offset);
			if (to <= from) continue;
			fragments.push(text.slice(cursor, from));
			fragments.push(
				<mark
					key={index}
					data-search-match={index}
					className={index === currentMatch ? "bg-orange-300" : "bg-yellow-200"}
				>
					{text.slice(from, to)}
				</mark>,
			);
			cursor = to;
		}
		fragments.push(text.slice(cursor));
		return fragments;
	}
	let partOffset = 0;
	const load = useCallback(async () => {
		const readRevision = ++record.revision;
		record.loading = true;
		record.error = false;
		render((value) => value + 1);
		try {
			const response = await fetch(
				`/api/turns/${turnId}/calls?kind=${kind}&callId=${callId}`,
			);
			if (!response.ok) throw new Error("Unable to read communication");
			const data = await response.json();
			if (readRevision !== record.revision) return;
			record.calls = data.calls;
			record.status = status;
			record.sourceRevision = revision;
		} catch {
			if (readRevision === record.revision) record.error = true;
		} finally {
			if (readRevision === record.revision) {
				record.loading = false;
				render((value) => value + 1);
			}
		}
	}, [record, status, kind, turnId, callId, revision]);
	useEffect(() => {
		if (
			(record.open || record.calls) &&
			(record.status !== status ||
				(record.status === "pending" && record.sourceRevision !== revision))
		)
			void load();
	}, [status, revision, record, load]);
	return (
		<details
			data-reading-anchor={key}
			open={record.open}
			className="mt-2 rounded-md bg-neutral-50 px-3 py-2 text-sm"
			onToggle={(event) => {
				record.open = event.currentTarget.open;
				render((value) => value + 1);
				if (record.open && !record.calls && !record.loading) void load();
			}}
		>
			<summary className="cursor-pointer text-neutral-600 hover:text-neutral-950">
				<span className="inline-flex w-[calc(100%-1.25rem)] items-center gap-2">
					<span>
						{t(kind)} {ordinal}
						{kind === "response" &&
							status === "failed" &&
							` · ${t("callFailed")}`}
					</span>
					{kind === "response" && status === "pending" && (
						<span
							role="status"
							aria-label={t("turnPending")}
							className="h-4 w-4 rounded-full border-2 border-neutral-300 border-t-neutral-600 motion-safe:animate-spin"
						/>
					)}
					{record.open && record.calls && (
						<button
							type="button"
							aria-label={t("searchCommunication")}
							title={t("searchCommunication")}
							className="ml-auto rounded p-1 hover:bg-neutral-200"
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								record.searchOpen = true;
								render((value) => value + 1);
								requestAnimationFrame(() => searchRef.current?.focus());
							}}
						>
							<svg
								aria-hidden="true"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
							>
								<circle cx="10" cy="10" r="6" />
								<path d="m15 15 5 5" />
							</svg>
						</button>
					)}
					{status !== "pending" && record.calls && (
						<button
							type="button"
							aria-label={t("copy")}
							title={t("copy")}
							className={`${record.open && record.calls ? "" : "ml-auto"} rounded p-1 hover:bg-neutral-200`}
							onClick={async (event) => {
								event.preventDefault();
								event.stopPropagation();
								try {
									await navigator.clipboard.writeText(communicationText);
									setCopyError(false);
									setCopied(true);
									clearTimeout(copyTimer.current);
									copyTimer.current = setTimeout(() => setCopied(false), 1500);
								} catch {
									setCopied(false);
									setCopyError(true);
								}
							}}
						>
							{copied ? (
								<span aria-hidden="true">✓</span>
							) : (
								<svg
									aria-hidden="true"
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
								>
									<rect x="8" y="8" width="12" height="12" rx="2" />
									<path d="M16 8V4H4v12h4" />
								</svg>
							)}
						</button>
					)}
				</span>
				{copyError && (
					<span role="alert" className="block whitespace-pre-wrap">
						{t("copyFailed")}
					</span>
				)}
			</summary>
			{record.searchOpen && record.calls && (
				<search
					aria-label={t("searchCommunication")}
					className="mt-2 flex flex-wrap items-center gap-2"
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							closeSearch();
						}
					}}
				>
					<input
						ref={searchRef}
						type="search"
						aria-label={t("searchCommunication")}
						className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-1"
						value={record.query}
						onChange={(event) => {
							record.query = event.currentTarget.value;
							record.match = undefined;
							render((value) => value + 1);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								navigate(event.shiftKey ? -1 : 1);
							}
						}}
					/>
					<span
						role="status"
						aria-live="polite"
						aria-label={t("searchMatches")}
					>
						{matches.length ? currentMatch + 1 : 0} / {matches.length}
					</span>
					<button
						type="button"
						aria-label={t("previousMatch")}
						title={t("previousMatch")}
						disabled={!matches.length}
						onClick={() => navigate(-1)}
						className="rounded p-1 hover:bg-neutral-200 disabled:opacity-40"
					>
						↑
					</button>
					<button
						type="button"
						aria-label={t("nextMatch")}
						title={t("nextMatch")}
						disabled={!matches.length}
						onClick={() => navigate(1)}
						className="rounded p-1 hover:bg-neutral-200 disabled:opacity-40"
					>
						↓
					</button>
					<button
						type="button"
						aria-label={t("closeSearch")}
						title={t("closeSearch")}
						onClick={closeSearch}
						className="rounded p-1 hover:bg-neutral-200"
					>
						×
					</button>
				</search>
			)}
			{record.loading && <p role="status">{t("loading")}</p>}
			{record.error && (
				<div role="alert">
					{t("callsReadFailed")}{" "}
					<button
						type="button"
						className="underline"
						onClick={() => void load()}
					>
						{t("retry")}
					</button>
				</div>
			)}
			<div
				ref={bodyRef}
				className="communication-body"
				onScroll={(event) => {
					if (record.open) record.scrollTop = event.currentTarget.scrollTop;
				}}
			>
				<div className="communication-text mt-3 font-mono text-xs whitespace-pre-wrap">
					{displayParts?.map((part, index) => {
						const separator =
							index > 0 ? highlighted("\n\n", partOffset - 2) : "";
						const text = highlighted(part.text, partOffset);
						partOffset += part.text.length + 2;
						return (
							// Content parts append in display order.
							// biome-ignore lint/suspicious/noArrayIndexKey: parts retain their display order.
							<Fragment key={index}>
								{separator}
								{part.body ? (
									<pre className="border-l-2 border-neutral-200 pl-2 whitespace-pre-wrap">
										{text}
									</pre>
								) : (
									<p>{text}</p>
								)}
							</Fragment>
						);
					})}
				</div>
			</div>
		</details>
	);
}
