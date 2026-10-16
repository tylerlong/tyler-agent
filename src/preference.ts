import { useRef, useState } from "react";
import { createSettingState } from "./setting-state.ts";

export function usePreference(options: {
	read: () => Promise<string>;
	write: (value: string) => Promise<void>;
	readError: string;
	saveError: string;
	onRefresh?: (value: string | null, retainedDraft: boolean) => void;
	onSaved?: (value: string) => void;
}) {
	const draft = useRef<string | null>(null);
	const save = useRef<Promise<boolean> | null>(null);
	const [value, setValue] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState("");
	const [state] = useState(() =>
		createSettingState(options.read, options.write, (value) => {
			const retainedDraft = draft.current !== null;
			if (!retainedDraft) {
				setValue(value);
				setError(value === null ? options.readError : "");
			}
			options.onRefresh?.(value, retainedDraft);
		}),
	);
	async function commit(): Promise<boolean> {
		if (save.current) return save.current;
		const submitted = draft.current;
		if (submitted === null) return !error;
		setPending(true);
		setSaved(false);
		const operation = (async () => {
			const succeeded = (await state.save(submitted)) === "saved";
			setError(succeeded ? "" : options.saveError);
			if (succeeded) {
				draft.current = null;
				setSaved(true);
				options.onSaved?.(submitted);
			}
			return succeeded;
		})();
		save.current = operation;
		try {
			return await operation;
		} finally {
			save.current = null;
			setPending(false);
		}
	}
	return {
		value,
		pending,
		saved,
		error,
		state,
		commit,
		select(value: string) {
			draft.current = value;
			setValue(value);
			return commit();
		},
		retry: () => (draft.current === null ? state.refresh() : commit()),
	};
}
