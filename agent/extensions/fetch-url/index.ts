import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	convertHtmlToMarkdown,
	extractMetadataFromHtml,
	extractReadableContent,
	formatMetadataBlock,
	isHtmlContentType,
} from "./utils";

const fetchUrlSchema = Type.Object(
	{
		url: Type.String({ description: "URL to fetch." }),
		raw: Type.Optional(
			Type.Boolean({
				description: "Return the raw response body without extraction (default: false).",
			}),
		),
		format: Type.Optional(
			Type.Union([Type.Literal("markdown"), Type.Literal("html")], {
				description: "Output format for extracted main content (default: markdown).",
			}),
		),
	},
	{ additionalProperties: false },
);

type FetchUrlParams = Static<typeof fetchUrlSchema>;

type TruncationSummary = {
	outputLines: number;
	totalLines: number;
	outputBytes: number;
	totalBytes: number;
};

type FetchUrlDetails = {
	url: string;
	status: number;
	contentType?: string;
	format: "markdown" | "html" | "raw";
	metadata?: ReturnType<typeof extractMetadataFromHtml>;
	usedFallback?: boolean;
	displayText?: string;
	truncation?: ReturnType<typeof truncateHead>;
	fullOutputPath?: string;
};

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_BYTES = 16 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

const FETCH_HEADERS = {
	Accept: "text/markdown,text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
	"User-Agent": "pi-fetch-url/1.0 (+https://pi)",
};

function isPrivateIPv4(ip: string): boolean {
	const [a, b] = ip.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19))
	);
}

function parseIPv6(ip: string): number[] | null {
	let s = ip.split("%")[0]!.toLowerCase();
	const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (v4) {
		const o = v4[1]!.split(".").map(Number);
		if (o.some((n) => n > 255)) return null;
		s =
			s.slice(0, -v4[1]!.length) +
			(o[0]! * 256 + o[1]!).toString(16) +
			":" +
			(o[2]! * 256 + o[3]!).toString(16);
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	if (groups.length !== 8) return null;
	const parts = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
	return parts.some(Number.isNaN) ? null : parts;
}

function isBlockedIp(ip: string): boolean {
	if (isIP(ip) === 4) return isPrivateIPv4(ip);
	const parts = parseIPv6(ip);
	if (!parts) return true;
	if (parts.slice(0, 5).every((p) => p === 0)) {
		if (parts[5] === 0) return true;
		if (parts[5] === 0xffff) {
			return isPrivateIPv4(
				`${parts[6]! >> 8}.${parts[6]! & 255}.${parts[7]! >> 8}.${parts[7]! & 255}`,
			);
		}
	}
	const g = parts[0]!;
	return (g & 0xffc0) === 0xfe80 || (g & 0xfe00) === 0xfc00 || (g & 0xff00) === 0xff00;
}

function assertHostAllowed(url: URL): void {
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost")) {
		throw new Error(`fetch_url blocked non-public host: ${url.hostname}`);
	}
	if (isIP(host) && isBlockedIp(host)) {
		throw new Error(`fetch_url blocked non-public address: ${url.hostname}`);
	}
}

// Validating addresses in the socket-level lookup hook (instead of a separate
// pre-fetch DNS query) ensures the checked address is the one actually
// connected to, closing the DNS-rebinding TOCTOU window.
const safeAgent = new Agent({
	connect: {
		lookup(hostname, options, callback) {
			dnsLookup(hostname, options, (err, address, family) => {
				if (err) return callback(err, address as any, family);
				const list = Array.isArray(address)
					? address
					: [{ address: address as string, family }];
				const blocked = list.find((a) => isBlockedIp(a.address));
				if (blocked) {
					return callback(
						new Error(
							`fetch_url blocked non-public address ${blocked.address} for host ${hostname}`,
						),
						address as any,
						family,
					);
				}
				callback(null, address as any, family);
			});
		},
	},
});

type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

async function fetchWithPolicy(url: URL, signal: AbortSignal): Promise<FetchResponse> {
	let current = url;
	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		if (!(["http:", "https:"].includes(current.protocol))) {
			throw new Error(
				i === 0
					? "fetch_url requires an http or https URL"
					: `fetch_url blocked redirect to non-http(s) URL: ${current}`,
			);
		}
		assertHostAllowed(current);
		const response = await undiciFetch(current.toString(), {
			signal,
			redirect: "manual",
			headers: FETCH_HEADERS,
			dispatcher: safeAgent,
		});
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel();
			current = new URL(location, current);
			continue;
		}
		return response;
	}
	throw new Error(`fetch_url exceeded ${MAX_REDIRECTS} redirects`);
}

async function readBodyCapped(response: FetchResponse, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.byteLength >= maxBytes) {
			chunks.push(value.subarray(0, maxBytes - total));
			await reader.cancel();
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	return Buffer.concat(chunks).toString("utf8");
}

function formatTruncationNotice(t: TruncationSummary, path: string): string {
	return `[Output truncated: ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Full output saved to: ${path}]`;
}

async function writeTempOutput(content: string): Promise<string> {
	const id = randomBytes(8).toString("hex");
	const path = join(tmpdir(), `pi-fetch-url-${id}.log`);
	await writeFile(path, content, "utf8");
	return path;
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
	if (!result.content) return "";
	return result.content
		.map((block) => (block.type === "text" ? block.text ?? "" : ""))
		.join("\n")
		.trim();
}

function symbolFor(status: string | undefined, theme: any): string {
	if (status === "ok") return theme.fg("success", "✓ ");
	if (status === "error") return theme.fg("error", "✗ ");
	return theme.fg("dim", "· ");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch_url",
		label: "fetch_url",
		description:
			"Fetch a URL and return the main content. Defaults to extracted markdown with metadata, with options to return HTML or raw content.",
		promptSnippet: "Fetch a URL and return extracted markdown, HTML, or raw content.",
		parameters: fetchUrlSchema,
		renderCall: (args, theme, context) => {
			const url = args.url ?? "(missing url)";
			const status = context.state.status as string | undefined;
			const symbol = symbolFor(status, theme);
			const toolTitle = theme.fg("toolTitle", theme.bold("fetch_url"));
			let callLine = `${symbol}${toolTitle} ${theme.fg("accent", url)}`;
			if (status === "error" && context.state.err) {
				callLine += `  ${theme.fg("error", context.state.err as string)}`;
			}
			return new Text(callLine, 0, 0);
		},
		renderResult: (result, { isPartial }, _theme, context) => {
			const details = result.details as FetchUrlDetails | undefined;
			const text = (details?.displayText ?? extractText(result)) || "(no output)";

			let status: "running" | "ok" | "error";
			let err: string | undefined;
			if (isPartial) {
				status = "running";
			} else {
				if ((result as { isError?: boolean }).isError === true) {
					status = "error";
					const firstLine = text.split("\n", 1)[0] ?? "";
					err = `error: ${firstLine}`.slice(0, 80);
				} else {
					status = "ok";
				}
			}

			if (context.state.status !== status || context.state.err !== err) {
				context.state.status = status;
				context.state.err = err;
				context.invalidate();
			}

			return new Container();
		},
		async execute(_toolCallId, params: FetchUrlParams, signal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(params.url);
			} catch {
				throw new Error("fetch_url requires a valid URL");
			}

			const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
			const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

			const response = await fetchWithPolicy(parsedUrl, fetchSignal);

			if (!response.ok) {
				const errorBody = (await readBodyCapped(response, MAX_ERROR_BODY_BYTES))
					.replace(/[\u0000-\u001f\u007f]+/g, " ")
					.trim();
				const suffix = errorBody ? `: ${errorBody.slice(0, 300)}` : "";
				throw new Error(`Request failed (${response.status} ${response.statusText})${suffix}`);
			}

			const contentTypeHeader = response.headers.get("content-type");
			const contentType = contentTypeHeader?.split(";")[0]?.trim();
			const body = await readBodyCapped(response, MAX_RESPONSE_BYTES);

			const wantsRaw = params.raw ?? false;
			const isHtml = isHtmlContentType(contentType);
			const format = params.format ?? "markdown";

			let outputContent = body;
			let metadata: ReturnType<typeof extractMetadataFromHtml> = {};
			let usedFallback: boolean | undefined;
			let effectiveFormat: FetchUrlDetails["format"] = "raw";

			if (!wantsRaw && isHtml) {
				const extracted = extractReadableContent(body, parsedUrl.toString());
				metadata = extracted.metadata;
				usedFallback = extracted.usedFallback;
				const htmlContent = extracted.html || body;
				if (format === "html") {
					outputContent = htmlContent;
					effectiveFormat = "html";
				} else {
					outputContent = convertHtmlToMarkdown(htmlContent);
					effectiveFormat = "markdown";
				}
			} else if (isHtml) {
				metadata = extractMetadataFromHtml(body, parsedUrl.toString());
			}

			const metadataBlock = formatMetadataBlock(metadata, {
				url: parsedUrl.toString(),
				contentType,
			});

			const fullOutput = outputContent
				? `${metadataBlock}\n\n${outputContent}`
				: metadataBlock;
			const truncation = truncateHead(fullOutput, {
				maxLines: MAX_OUTPUT_LINES,
				maxBytes: MAX_OUTPUT_BYTES,
			});

			const displayText = truncation.content || "(no output)";
			const details: FetchUrlDetails = {
				url: parsedUrl.toString(),
				status: response.status,
				contentType: contentType ?? undefined,
				format: effectiveFormat,
				metadata,
				usedFallback,
				displayText,
			};

			let contextText = displayText;
			if (truncation.truncated) {
				const fullOutputPath = await writeTempOutput(fullOutput);
				details.truncation = truncation;
				details.fullOutputPath = fullOutputPath;
				contextText += `\n\n${formatTruncationNotice(truncation, fullOutputPath)}`;
			}

			return {
				content: [{ type: "text", text: contextText }],
				details,
			};
		},
	});
}
