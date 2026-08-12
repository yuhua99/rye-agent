import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import iconv from "iconv-lite";
import { Agent, fetch as undiciFetch } from "undici";
import {
  createHopSignal,
  createMergedSignal,
  formatTruncationNotice,
  truncateOutput,
} from "./shared.js";
import type { ExtractedMetadata as HtmlMetadata } from "./utils.js";

const webfetchSchema = Type.Object(
  {
    url: Type.String({ description: "URL to fetch." }),
    raw: Type.Optional(
      Type.Boolean({
        description:
          "Return the raw response body without extraction (default: false).",
      }),
    ),
    format: Type.Optional(
      Type.Union([Type.Literal("markdown"), Type.Literal("html")], {
        description:
          "Output format for extracted main content (default: markdown).",
      }),
    ),
  },
  { additionalProperties: false },
);

const websearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query." }),
    numResults: Type.Optional(
      Type.Integer({ description: "Number of results to return." }),
    ),
  },
  { additionalProperties: false },
);

type WebfetchParams = Static<typeof webfetchSchema>;
type WebsearchParams = Static<typeof websearchSchema>;

type WebfetchDetails = {
  url: string;
  status: number;
  contentType?: string;
  format: "markdown" | "html" | "raw";
  metadata?: HtmlMetadata;
  usedFallback?: boolean;
  displayText?: string;
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

type WebsearchDetails = {
  endpoint?: string;
  truncated?: boolean;
  truncation?: Omit<
    TruncationResult,
    "content" | "truncated" | "lastLinePartial" | "firstLineExceedsLimit"
  >;
  tempFile?: string;
  cancelled?: boolean;
};

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const WEBFETCH_MAX_LINES = 500;
const WEBFETCH_MAX_BYTES = 16 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const HOP_TIMEOUT_MS = 10_000;
const MIN_HOP_TIMEOUT_MS = 1_000;
const WEBSEARCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_EXA_ENDPOINT = "https://mcp.exa.ai/mcp";

class PolicyError extends Error {}
class TimeoutBudgetError extends Error {}

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
  let value = ip.split("%")[0]!.toLowerCase();
  const v4 = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const octets = v4[1]!.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    value =
      value.slice(0, -v4[1]!.length) +
      (octets[0]! * 256 + octets[1]!).toString(16) +
      ":" +
      (octets[2]! * 256 + octets[3]!).toString(16);
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [
    ...head,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...tail,
  ];
  if (groups.length !== 8) return null;
  const parts = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
  );
  return parts.some(Number.isNaN) ? null : parts;
}

function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  const parts = parseIPv6(ip);
  if (!parts) return true;
  if (parts.slice(0, 5).every((part) => part === 0)) {
    if (parts[5] === 0) return true;
    if (parts[5] === 0xffff) {
      return isPrivateIPv4(
        `${parts[6]! >> 8}.${parts[6]! & 255}.${parts[7]! >> 8}.${parts[7]! & 255}`,
      );
    }
  }
  const group = parts[0]!;
  return (
    (group & 0xffc0) === 0xfe80 ||
    (group & 0xfe00) === 0xfc00 ||
    (group & 0xff00) === 0xff00
  );
}

function assertHostAllowed(url: URL): void {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new PolicyError(`webfetch blocked non-public host: ${url.hostname}`);
  }
  if (isIP(host) && isBlockedIp(host)) {
    throw new PolicyError(
      `webfetch blocked non-public address: ${url.hostname}`,
    );
  }
}

const safeAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, options, (error, address, family) => {
        if (error) return callback(error, address as any, family);
        const addresses = Array.isArray(address)
          ? address
          : [{ address: address as string, family }];
        const blocked = addresses.find((item) => isBlockedIp(item.address));
        if (blocked) {
          return callback(
            new PolicyError(
              `webfetch blocked non-public address ${blocked.address} for host ${hostname}`,
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
type FetchResult = { response: FetchResponse; url: URL };

function acceptForFormat(format: WebfetchParams["format"]): string {
  if (format === "markdown")
    return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5";
  if (format === "html") return "text/html,*/*;q=0.5";
  return "text/plain,text/html;q=0.9,*/*;q=0.5";
}

function hopTimeoutMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < MIN_HOP_TIMEOUT_MS)
    throw new TimeoutBudgetError("Webfetch timed out before starting another request");
  return Math.min(HOP_TIMEOUT_MS, remaining);
}

type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
};

type CookieJar = {
  absorb: (url: URL, response: FetchResponse) => void;
  header: (url: URL) => string | undefined;
};

function createCookieJar(): CookieJar {
  const cookies: StoredCookie[] = [];

  function absorb(url: URL, response: FetchResponse) {
    const raws =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    const host = url.hostname.toLowerCase();
    for (const raw of raws) {
      const eq = raw.indexOf("=");
      if (eq <= 0) continue;
      const name = raw.slice(0, eq).trim();
      if (!name) continue;
      const value = (raw.slice(eq + 1).split(";", 1)[0] ?? "").trim();
      let domain = host;
      let hostOnly = true;
      let path = "/";
      let secure = false;
      let rejected = false;
      for (const part of raw.split(";").slice(1)) {
        const attrEq = part.indexOf("=");
        const key = (attrEq === -1 ? part : part.slice(0, attrEq))
          .trim()
          .toLowerCase();
        const attrVal = attrEq === -1 ? "" : part.slice(attrEq + 1).trim();
        if (key === "domain" && attrVal) {
          const candidate = attrVal.replace(/^\./, "").toLowerCase();
          if (host !== candidate && !host.endsWith(`.${candidate}`)) {
            rejected = true;
            break;
          }
          domain = candidate;
          hostOnly = false;
        } else if (key === "path" && attrVal.startsWith("/")) {
          path = attrVal;
        } else if (key === "secure") {
          secure = true;
        }
      }
      if (rejected) continue;
      if (name.startsWith("__Secure-") || name.startsWith("__Host-")) {
        if (url.protocol !== "https:") continue;
        secure = true;
      }
      if (name.startsWith("__Host-")) {
        domain = host;
        hostOnly = true;
        path = "/";
      }
      const index = cookies.findIndex(
        (cookie) =>
          cookie.name === name &&
          cookie.domain === domain &&
          cookie.path === path,
      );
      const next = { name, value, domain, hostOnly, path, secure };
      if (index >= 0) cookies[index] = next;
      else cookies.push(next);
    }
  }

  function header(url: URL): string | undefined {
    const host = url.hostname.toLowerCase();
    const path = url.pathname || "/";
    const parts: string[] = [];
    for (const cookie of cookies) {
      if (cookie.secure && url.protocol !== "https:") continue;
      if (cookie.hostOnly) {
        if (host !== cookie.domain) continue;
      } else if (host !== cookie.domain && !host.endsWith(`.${cookie.domain}`)) {
        continue;
      }
      if (!pathMatches(cookie.path, path)) continue;
      parts.push(`${cookie.name}=${cookie.value}`);
    }
    return parts.length > 0 ? parts.join("; ") : undefined;
  }

  return { absorb, header };
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === "/") return true;
  if (requestPath === cookiePath) return true;
  const prefix = cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`;
  return requestPath.startsWith(prefix);
}

async function fetchWithPolicy(
  url: URL,
  signal: AbortSignal,
  format: WebfetchParams["format"],
  deadline: number,
  jar: CookieJar,
): Promise<FetchResult> {
  let current = url;
  let previousOrigin = url.origin;
  for (let index = 0; index <= MAX_REDIRECTS; index++) {
    if (!["http:", "https:"].includes(current.protocol)) {
      throw new PolicyError(
        index === 0
          ? "webfetch requires an http or https URL"
          : `webfetch blocked redirect to non-http(s) URL: ${current}`,
      );
    }
    assertHostAllowed(current);
    const { signal: hopSignal, cleanup } = createHopSignal(
      signal,
      hopTimeoutMs(deadline),
    );
    const headers: Record<string, string> = {
      Accept: acceptForFormat(format),
      "User-Agent": DEFAULT_USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site":
        index === 0
          ? "none"
          : current.origin === previousOrigin
            ? "same-origin"
            : "cross-site",
      "Sec-Fetch-User": "?1",
    };
    const cookie = jar.header(current);
    if (cookie) headers.Cookie = cookie;
    let response: FetchResponse;
    try {
      response = await undiciFetch(current.toString(), {
        signal: hopSignal,
        redirect: "manual",
        headers,
        dispatcher: safeAgent,
      });
    } catch (error) {
      cleanup();
      throw error;
    }
    cleanup();
    jar.absorb(current, response);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      previousOrigin = current.origin;
      current = new URL(location, current);
      continue;
    }
    return { response, url: current };
  }
  throw new PolicyError(`webfetch exceeded ${MAX_REDIRECTS} redirects`);
}

async function waitForRetry(signal: AbortSignal, delay: number): Promise<void> {
  if (signal.aborted) throw new Error("Operation aborted");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, delay);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      reject(new Error("Operation aborted"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function isPolicyError(error: unknown): boolean {
  while (error instanceof Error) {
    if (error instanceof PolicyError) return true;
    error = error.cause;
  }
  return false;
}

async function fetchWithRetry(
  url: URL,
  signal: AbortSignal,
  format: WebfetchParams["format"],
  deadline: number,
): Promise<FetchResult> {
  const jar = createCookieJar();
  let retries = 0;
  while (true) {
    try {
      const result = await fetchWithPolicy(url, signal, format, deadline, jar);
      if (result.response.status >= 500 && retries < 2) {
        await result.response.body?.cancel();
        await waitForRetry(
          signal,
          (retries === 0 ? 500 : 1000) + Math.floor(Math.random() * 100),
        );
        retries += 1;
        continue;
      }
      return result;
    } catch (error) {
      if (
        signal.aborted ||
        isPolicyError(error) ||
        error instanceof TimeoutBudgetError ||
        retries >= 2
      )
        throw error;
      await waitForRetry(
        signal,
        (retries === 0 ? 500 : 1000) + Math.floor(Math.random() * 100),
      );
      retries += 1;
    }
  }
}

async function readBodyCapped(
  response: FetchResponse,
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

function charsetFromContentType(contentType: string | null): string | undefined {
  const match = contentType?.match(/charset\s*=\s*("?)([^";\s]+)\1/i);
  return match?.[2]?.toLowerCase();
}

function charsetFromHtmlMeta(buf: Buffer): string | undefined {
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString("latin1");
  const match =
    head.match(/<meta\b[^>]*\bcharset\s*=\s*["']?\s*([^"'\s/>]+)/i) ||
    head.match(
      /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*([^"'\s/>]+)/i,
    );
  return match?.[1]?.toLowerCase();
}

function normalizeCharset(charset: string): string {
  if (charset === "gb2312" || charset === "gbk") return "gb18030";
  if (charset === "shift-jis" || charset === "sjis") return "shift_jis";
  if (charset === "utf8") return "utf-8";
  return charset;
}

function decodeBody(buf: Buffer, contentType: string | null): string {
  const raw =
    charsetFromContentType(contentType) ||
    charsetFromHtmlMeta(buf) ||
    "utf-8";
  const charset = normalizeCharset(raw);
  if (charset === "utf-8" || charset === "us-ascii") return buf.toString("utf8");
  if (!iconv.encodingExists(charset)) return buf.toString("utf8");
  return iconv.decode(buf, charset);
}

function classifyBlock(
  response: FetchResponse,
  body: string,
):
  | "cloudflare_challenge"
  | "anubis_bot_check"
  | "waf_blocked"
  | "rate_limited"
  | "access_denied"
  | undefined {
  const content = body.toLowerCase();
  const server = response.headers.get("server")?.toLowerCase() ?? "";
  if (response.status === 429) return "rate_limited";
  if (response.headers.get("cf-mitigated") === "challenge")
    return "cloudflare_challenge";
  if (response.status === 403 || response.status === 503) {
    if (
      ["just a moment", "cf-browser-verification", "cf-chl", "challenge-platform"].some(
        (marker) => content.includes(marker),
      )
    )
      return "cloudflare_challenge";
    if (
      content.includes("making sure you're not a bot") ||
      /\banubis\b/.test(content)
    )
      return "anubis_bot_check";
  }
  if (
    content.includes("blocked by network security") ||
    content.includes("incapsula incident id") ||
    ((server.includes("akamai") || server.includes("imperva")) &&
      content.includes("access denied"))
  )
    return "waf_blocked";
  if (response.status === 401 || response.status === 403) return "access_denied";
}

function requestError(response: FetchResponse, url: URL, body: string): Error {
  const kind = classifyBlock(response, body);
  const status = `${response.status} ${response.statusText}`.trim();
  const excerpt = body ? `\nBody: ${body.slice(0, 300)}` : "";
  if (!kind) return new Error(`Request failed (status ${status}) at ${url}${excerpt}`);
  const hints = {
    cloudflare_challenge:
      "This looks like a bot/JS challenge page; webfetch cannot solve it. Try websearch for a summary or a different source URL.",
    anubis_bot_check:
      "This site requires a bot check that webfetch cannot solve. Try websearch or a different source URL.",
    waf_blocked:
      "This site appears to block automated requests. Try websearch or a different source URL.",
    rate_limited:
      "The site rate-limited this request. Wait and try again, or use websearch or a different source URL.",
    access_denied:
      "This URL requires access that webfetch does not have. Try a public source or websearch.",
  };
  return new Error(
    `Blocked by ${kind} (HTTP ${response.status}) at ${url}\nHints: ${hints[kind]}${excerpt}`,
  );
}

function extractText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (
    result.content
      ?.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("\n")
      .trim() ?? ""
  );
}

function symbolFor(status: string | undefined, theme: any): string {
  if (status === "ok") return theme.fg("success", "✓ ");
  if (status === "error") return theme.fg("error", "✗ ");
  return theme.fg("dim", "· ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value) && value.jsonrpc === "2.0";
}

function toJsonString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function resolveEndpoint(): { endpoint: string; apiKey?: string } {
  const apiKey = process.env.EXA_API_KEY?.trim() || undefined;
  const url = new URL(DEFAULT_EXA_ENDPOINT);
  if (apiKey && !url.searchParams.has("exaApiKey"))
    url.searchParams.set("exaApiKey", apiKey);
  url.searchParams.set("tools", "web_search_exa");
  return { endpoint: url.toString(), apiKey };
}

function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.searchParams.has("exaApiKey"))
      url.searchParams.set("exaApiKey", "REDACTED");
    return url.toString();
  } catch {
    return endpoint;
  }
}

function redact(message: string, apiKey: string | undefined): string {
  if (!apiKey) return message;
  return message
    .replaceAll(apiKey, "REDACTED")
    .replaceAll(encodeURIComponent(apiKey), "REDACTED");
}

function extractJsonRpcResponse(
  response: unknown,
  requestId: string,
): JsonRpcResponse {
  if (Array.isArray(response)) {
    const match = response.find(
      (item) => isJsonRpcResponse(item) && item.id === requestId,
    );
    if (match) return match;
    throw new Error("Invalid Exa search response.");
  }
  if (isJsonRpcResponse(response)) return response;
  throw new Error("Invalid Exa search response.");
}

async function parseSseResponse(
  response: Response,
  requestId: string,
): Promise<unknown> {
  if (!response.body)
    throw new Error("Exa search response stream missing body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trimEnd();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed: unknown = JSON.parse(data);
        if (isRecord(parsed) && parsed.id === requestId) {
          await reader.cancel();
          return parsed;
        }
      } catch {}
    }
  }
  throw new Error("Exa search response ended without a result.");
}

async function callExaWebSearch(
  endpoint: string,
  params: WebsearchParams,
  signal: AbortSignal,
): Promise<unknown> {
  const id = "websearch";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "web_search_exa", arguments: params },
    }),
    signal,
  });
  if (!response.ok)
    throw new Error(`Exa search request failed (HTTP ${response.status}).`);
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : contentType.includes("text/event-stream")
      ? await parseSseResponse(response, id)
      : (() => {
          throw new Error("Unexpected Exa search response.");
        })();
  const json = extractJsonRpcResponse(payload, id);
  if (json.error)
    throw new Error(`Exa search failed: ${json.error.message.slice(0, 300)}`);
  return json.result;
}

function localDate(): string {
  const date = new Date();
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function renderWebsearchResult(
  result: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  },
  options: { isPartial?: boolean },
  _theme: any,
  context?: { state?: any; invalidate?: () => void },
) {
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  const status = options.isPartial
    ? "running"
    : result.isError
      ? "error"
      : "ok";
  const error =
    status === "error"
      ? `error: ${text.split("\n", 1)[0] ?? ""}`.slice(0, 80)
      : undefined;
  if (
    context?.state &&
    (context.state.status !== status || context.state.err !== error)
  ) {
    context.state.status = status;
    context.state.err = error;
    context.invalidate?.();
  }
  return new Container();
}

export default function (pi: ExtensionAPI) {
  const websearchDescription = `Real-time web search. Today's date: ${localDate()}. Returns current web results.`;

  pi.registerTool({
    name: "webfetch",
    label: "webfetch",
    description:
      "Fetch a URL and return extracted markdown, HTML, or raw content.",
    parameters: webfetchSchema,
    renderCall: (args, theme, context) => {
      const url = args.url ?? "(missing url)";
      const status = context.state.status as string | undefined;
      let text = `${symbolFor(status, theme)}${theme.fg("toolTitle", theme.bold("webfetch"))} ${theme.fg("accent", url)}`;
      if (status === "error" && context.state.err)
        text += `  ${theme.fg("error", context.state.err as string)}`;
      return new Text(text, 0, 0);
    },
    renderResult: (result, { isPartial }, _theme, context) => {
      const details = result.details as WebfetchDetails | undefined;
      const text =
        (details?.displayText ?? extractText(result)) || "(no output)";
      const status = isPartial
        ? "running"
        : (result as { isError?: boolean }).isError
          ? "error"
          : "ok";
      const error =
        status === "error"
          ? `error: ${text.split("\n", 1)[0] ?? ""}`.slice(0, 80)
          : undefined;
      if (context.state.status !== status || context.state.err !== error) {
        context.state.status = status;
        context.state.err = error;
        context.invalidate();
      }
      return new Container();
    },
    async execute(_toolCallId, params: WebfetchParams, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const utils = await import("./utils.js");
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(params.url);
      } catch {
        throw new Error("webfetch requires a valid URL");
      }
      const deadline = Date.now() + FETCH_TIMEOUT_MS;
      const { signal: fetchSignal, cleanup } = createMergedSignal(
        signal,
        FETCH_TIMEOUT_MS,
      );
      try {
        const { response, url } = await fetchWithRetry(
          parsedUrl,
          fetchSignal,
          params.format,
          deadline,
        );
        const contentTypeHeader = response.headers.get("content-type");
        if (!response.ok) {
          const errorBody = decodeBody(
            await readBodyCapped(response, MAX_ERROR_BODY_BYTES),
            contentTypeHeader,
          )
            .replace(/[\u0000-\u001f\u007f]+/g, " ")
            .trim();
          throw requestError(response, url, errorBody);
        }
        const contentType = contentTypeHeader?.split(";")[0]?.trim();
        const body = decodeBody(
          await readBodyCapped(response, MAX_RESPONSE_BYTES),
          contentTypeHeader,
        );
        const wantsRaw = params.raw ?? false;
        const isHtml = utils.isHtmlContentType(contentType);
        const format = params.format ?? "markdown";
        let outputContent = body;
        let metadata: HtmlMetadata = {};
        let usedFallback: boolean | undefined;
        let effectiveFormat: WebfetchDetails["format"] = "raw";
        if (!wantsRaw && isHtml) {
          const extracted = utils.extractReadableContent(body, url.toString());
          metadata = extracted.metadata;
          usedFallback = extracted.usedFallback;
          const htmlContent = extracted.html || body;
          if (format === "html") {
            outputContent = htmlContent;
            effectiveFormat = "html";
          } else {
            outputContent = utils.convertHtmlToMarkdown(htmlContent);
            effectiveFormat = "markdown";
          }
        } else if (isHtml) {
          metadata = utils.extractMetadataFromHtml(body, url.toString());
        }
        const fullOutput = outputContent
          ? `${utils.formatMetadataBlock(metadata, { url: url.toString(), contentType })}\n\n${outputContent}`
          : utils.formatMetadataBlock(metadata, { url: url.toString(), contentType });
        const { truncation, fullOutputPath } = await truncateOutput(
          fullOutput,
          {
            maxLines: WEBFETCH_MAX_LINES,
            maxBytes: WEBFETCH_MAX_BYTES,
            tempPrefix: "pi-webfetch",
            extension: "log",
          },
        );
        const displayText = truncation.content || "(no output)";
        const details: WebfetchDetails = {
          url: url.toString(),
          status: response.status,
          contentType,
          format: effectiveFormat,
          metadata,
          usedFallback,
          displayText,
        };
        let text = displayText;
        if (fullOutputPath) {
          details.truncation = truncation;
          details.fullOutputPath = fullOutputPath;
          text += `\n\n${formatTruncationNotice(truncation, fullOutputPath)}`;
        }
        return { content: [{ type: "text", text }], details };
      } finally {
        cleanup();
      }
    },
  });

  pi.registerTool<typeof websearchSchema, WebsearchDetails>({
    name: "websearch",
    label: "websearch",
    description: websearchDescription,
    parameters: websearchSchema,
    renderCall: (args, theme, context) => {
      const status = context.state.status as string | undefined;
      let text = `${symbolFor(status, theme)}${theme.fg("toolTitle", theme.bold("websearch"))} ${theme.fg("accent", args.query ?? "")}`;
      if (args.numResults !== undefined)
        text += theme.fg("muted", ` [numResults=${args.numResults}]`);
      if (status === "error" && context.state.err)
        text += `  ${theme.fg("error", context.state.err as string)}`;
      return new Text(text, 0, 0);
    },
    renderResult: renderWebsearchResult,
    async execute(_toolCallId, params: WebsearchParams, signal) {
      if (signal?.aborted) {
        const details: WebsearchDetails = { cancelled: true };
        return { content: [{ type: "text", text: "Cancelled." }], details };
      }
      let resolved: { endpoint: string; apiKey?: string } | undefined;
      try {
        resolved = resolveEndpoint();
        const { signal: requestSignal, cleanup } = createMergedSignal(
          signal,
          WEBSEARCH_TIMEOUT_MS,
        );
        try {
          const result = await callExaWebSearch(
            resolved.endpoint,
            params,
            requestSignal,
          );
          const rawText =
            isRecord(result) && Array.isArray(result.content)
              ? result.content
                  .map((block) =>
                    isRecord(block) &&
                    block.type === "text" &&
                    typeof block.text === "string"
                      ? block.text
                      : toJsonString(block),
                  )
                  .join("\n")
              : toJsonString(result);
          const { truncation, fullOutputPath } = await truncateOutput(rawText, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
            tempPrefix: "pi-websearch",
            extension: "txt",
          });
          let text = truncation.content;
          if (fullOutputPath)
            text += `\n\n${formatTruncationNotice(truncation, fullOutputPath)}`;
          if (truncation.firstLineExceedsLimit && rawText.length > 0) {
            text = `[First line exceeded ${formatSize(truncation.maxBytes)} limit. Full output saved to: ${fullOutputPath ?? "N/A"}]\n${text}`;
          }
          const {
            content: _content,
            truncated: _truncated,
            lastLinePartial: _lastLinePartial,
            firstLineExceedsLimit: _firstLineExceedsLimit,
            ...truncationDetails
          } = truncation;
          const details: WebsearchDetails = {
            endpoint: redactEndpoint(resolved.endpoint),
            truncated: truncation.truncated,
            truncation: truncationDetails,
            tempFile: fullOutputPath,
          };
          return {
            content: [{ type: "text", text }],
            details,
            isError: isRecord(result) && result.isError === true,
          };
        } finally {
          cleanup();
        }
      } catch (error) {
        if (signal?.aborted) {
          const details: WebsearchDetails = { cancelled: true };
          return { content: [{ type: "text", text: "Cancelled." }], details };
        }
        const message = redact(
          error instanceof Error ? error.message : String(error),
          resolved?.apiKey,
        );
        throw new Error(message.slice(0, 400));
      }
    },
  });
}
