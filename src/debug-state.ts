export function createDebugState(
	read: () => Promise<boolean>,
	write: (enabled: boolean) => Promise<void>,
	apply: (enabled: boolean | null) => void,
) {
	let latestRead = 0;
	const refresh = async () => {
		const version = ++latestRead;
		try {
			const enabled = await read();
			if (version !== latestRead) return true;
			apply(enabled);
			return true;
		} catch {
			if (version !== latestRead) return true;
			apply(null);
			return false;
		}
	};
	return {
		refresh,
		async save(enabled: boolean): Promise<"saved" | "failed" | "unknown"> {
			let written = false;
			try {
				await write(enabled);
				written = true;
			} catch {
				// The server may have applied the write before the response failed.
			}
			if (!(await refresh())) return "unknown";
			return written ? "saved" : "failed";
		},
	};
}
