import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createMergedSignal(
	parentSignal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const handleAbort = () => controller.abort();
	if (parentSignal?.aborted) {
		controller.abort();
	} else {
		parentSignal?.addEventListener("abort", handleAbort, { once: true });
	}
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeoutId);
			parentSignal?.removeEventListener("abort", handleAbort);
		},
	};
}

export async function truncateOutput(
	content: string,
	options: { maxLines: number; maxBytes: number; tempPrefix: string; extension: string },
) {
	const truncation = truncateHead(content, {
		maxLines: options.maxLines,
		maxBytes: options.maxBytes,
	});
	const fullOutputPath = truncation.truncated
		? await writeTempOutput(content, options.tempPrefix, options.extension)
		: undefined;
	return { truncation, fullOutputPath };
}

export function formatTruncationNotice(
	truncation: {
		outputLines: number;
		totalLines: number;
		outputBytes: number;
		totalBytes: number;
	},
	path: string,
): string {
	return `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${path}]`;
}

async function writeTempOutput(content: string, prefix: string, extension: string): Promise<string> {
	const path = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.${extension}`);
	await writeFile(path, content, "utf8");
	return path;
}
