import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, appError } from "./api.ts";

export type ComposerSkill = {
	name: string;
	description: string;
	source: string;
	implicit: boolean;
};

export function SkillComposer({
	chatId,
	value,
	change,
	selected,
	select,
	disabled,
	enterBehavior,
}: {
	chatId: number;
	value: string;
	change: (value: string) => void;
	selected: ComposerSkill[];
	select: (skills: ComposerSkill[]) => void;
	disabled: boolean;
	enterBehavior: string | null;
}) {
	const { t } = useTranslation();
	const input = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const compositionEndedAt = useRef(-Infinity);
	const [query, setQuery] = useState<{
		start: number;
		end: number;
		text: string;
	} | null>(null);
	const [skills, setSkills] = useState<ComposerSkill[]>([]);
	const [diagnostics, setDiagnostics] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [active, setActive] = useState(0);
	const listId = useId();
	const open = query !== null;
	// Clear the previous catalog before a reopened picker can show selectable stale options.
	useLayoutEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		setSkills([]);
		setDiagnostics([]);
		void api(`/api/chats/${chatId}/skills`)
			.then((data) => {
				if (cancelled) return;
				setSkills(data.skills);
				setDiagnostics(data.diagnostics);
			})
			.catch((cause) => {
				if (!cancelled) {
					const error = appError(cause);
					setDiagnostics([
						`${t(error.code, { defaultValue: t("requestFailed") })}${error.details ? `: ${error.details}` : ""}`,
					]);
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [chatId, open, t]);
	const matches = skills.filter(
		(skill) =>
			!selected.some((item) => item.source === skill.source) &&
			`${skill.name}\n${skill.description}\n${skill.source}`
				.toLowerCase()
				.includes(query?.text.toLowerCase() ?? ""),
	);
	const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
	const activeSource = matches[activeIndex]?.source;
	useEffect(() => {
		if (open && activeSource)
			document
				.getElementById(`${listId}-${activeIndex}`)
				?.scrollIntoView({ block: "nearest" });
	}, [open, activeIndex, activeSource, listId]);
	function updateQuery(element: HTMLTextAreaElement) {
		const end = element.selectionStart;
		const match = /(?:^|\s)\/([^\n]*)$/.exec(element.value.slice(0, end));
		const next =
			match && element.selectionEnd === end
				? { start: end - match[1].length - 1, end, text: match[1] }
				: null;
		if (
			query?.start === next?.start &&
			query?.end === next?.end &&
			query?.text === next?.text
		)
			return;
		setQuery(next);
		setActive(0);
	}
	function choose(skill: ComposerSkill) {
		if (!query || disabled) return;
		select([...selected, skill]);
		change(value.slice(0, query.start) + value.slice(query.end));
		setQuery(null);
		input.current?.focus();
		const position = query.start;
		requestAnimationFrame(() =>
			input.current?.setSelectionRange(position, position),
		);
	}
	return (
		<div className="relative">
			{selected.length > 0 && (
				<fieldset
					className="flex flex-wrap gap-1"
					aria-label={t("selectedSkills")}
				>
					{selected.map((skill) => (
						<button
							key={skill.source}
							type="button"
							disabled={disabled}
							title={skill.source}
							className="max-w-full rounded border border-neutral-300 px-2 py-1 text-left text-sm break-all hover:bg-neutral-100 disabled:opacity-50"
							aria-label={t("removeSkill", {
								name: skill.name,
								source: skill.source,
							})}
							onClick={() =>
								select(selected.filter((item) => item.source !== skill.source))
							}
						>
							{skill.name} · {skill.source} ×
						</button>
					))}
				</fieldset>
			)}
			<textarea
				ref={input}
				className="composer-input block w-full resize-none bg-transparent px-1 py-2 text-neutral-950 focus-visible:outline-2 focus-visible:outline-blue-600"
				aria-label={t("prompt")}
				placeholder={t("prompt")}
				rows={2}
				disabled={disabled}
				value={value}
				required
				aria-autocomplete="list"
				aria-controls={open ? listId : undefined}
				aria-activedescendant={
					open && matches.length ? `${listId}-${activeIndex}` : undefined
				}
				onChange={(event) => {
					change(event.target.value);
					updateQuery(event.target);
				}}
				onSelect={(event) => updateQuery(event.currentTarget)}
				onBlur={() => setQuery(null)}
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
					if (event.key === "Enter") compositionEndedAt.current = -Infinity;
				}}
				onKeyDown={(event) => {
					if (
						composing.current ||
						event.nativeEvent.isComposing ||
						event.nativeEvent.keyCode === 229 ||
						performance.now() - compositionEndedAt.current < 100
					)
						return;
					if (
						open &&
						!event.shiftKey &&
						!event.altKey &&
						!event.ctrlKey &&
						!event.metaKey &&
						["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)
					) {
						event.preventDefault();
						if (event.key === "Escape") setQuery(null);
						else if (event.key === "Enter") {
							if (!event.repeat && matches[activeIndex])
								choose(matches[activeIndex]);
						} else if (matches.length)
							setActive(
								(activeIndex +
									(event.key === "ArrowDown" ? 1 : -1) +
									matches.length) %
									matches.length,
							);
						return;
					}
					if (event.key !== "Enter") {
						compositionEndedAt.current = -Infinity;
						return;
					}
					const primary = navigator.platform.startsWith("Mac")
						? event.metaKey
						: event.ctrlKey;
					if (
						event.shiftKey ||
						event.altKey ||
						(!primary && (event.ctrlKey || event.metaKey))
					)
						return;
					if (!primary && enterBehavior !== "send") return;
					event.preventDefault();
					if (!event.repeat) event.currentTarget.form?.requestSubmit();
				}}
			/>
			{open && (
				<div className="absolute bottom-full left-0 z-20 mb-2 max-h-72 w-full overflow-auto rounded-lg border border-neutral-300 bg-white p-2 shadow-lg">
					<div id={listId} role="listbox" aria-label={t("skills")}>
						{matches.map((skill, index) => (
							<button
								key={skill.source}
								id={`${listId}-${index}`}
								type="button"
								role="option"
								aria-selected={index === activeIndex}
								className={`block w-full rounded px-2 py-1 text-left break-words ${index === activeIndex ? "bg-neutral-100" : "hover:bg-neutral-100"}`}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => choose(skill)}
							>
								<strong>{skill.name}</strong>
								<span className="block text-sm">{skill.description}</span>
								<span className="block break-all text-xs text-neutral-600">
									{skill.source}
								</span>
							</button>
						))}
					</div>
					{(loading || !matches.length) && (
						<p role="status" className="px-2 py-1 text-sm text-neutral-600">
							{t(loading ? "loading" : "noSkills")}
						</p>
					)}
					{diagnostics.length > 0 && (
						<p
							role="alert"
							className="whitespace-pre-wrap px-2 py-1 text-sm text-red-700"
						>
							{diagnostics.join("\n")}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
