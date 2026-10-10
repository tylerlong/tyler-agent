export function createSettingState<T>(
	read: () => Promise<T>,
	write: (value: T) => Promise<void>,
	apply: (value: T | null) => void,
) {
	let latestRead = 0;
	let latestRefresh: Promise<boolean> = Promise.resolve(false);
	const refresh = () => {
		const version = ++latestRead;
		const operation = (async () => {
			try {
				const value = await read();
				if (version !== latestRead) return latestRefresh;
				apply(value);
				return true;
			} catch {
				if (version !== latestRead) return latestRefresh;
				apply(null);
				return false;
			}
		})();
		latestRefresh = operation;
		return operation;
	};
	return {
		refresh,
		async save(value: T): Promise<"saved" | "failed" | "unknown"> {
			let written = false;
			try {
				await write(value);
				written = true;
			} catch {
				// The server may have applied the write before the response failed.
			}
			if (!(await refresh())) return "unknown";
			return written ? "saved" : "failed";
		},
	};
}
