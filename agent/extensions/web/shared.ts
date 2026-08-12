import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_ERROR_BODY_BYTES = 4 * 1024;

export async function readBodyCapped(
	response: { body: ReadableStream<Uint8Array> | null },
	maxBytes: number,
): Promise<Buffer> {
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.byteLength >= maxBytes) {
			const chunk = value.subarray(0, maxBytes - total);
			chunks.push(chunk);
			total += chunk.byteLength;
			await reader.cancel();
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	return Buffer.concat(chunks);
}

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

export function createHopSignal(
	parentSignal: AbortSignal,
	timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
	const hopController = new AbortController();
	const timeoutId = setTimeout(() => hopController.abort(), timeoutMs);
	return {
		signal: AbortSignal.any([parentSignal, hopController.signal]),
		cleanup: () => clearTimeout(timeoutId),
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
