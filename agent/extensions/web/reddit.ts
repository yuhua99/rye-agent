import { fetch } from "undici";
import {
  MAX_ERROR_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  readBodyCapped,
} from "./shared.js";

const REDDIT_BASE = "https://www.reddit.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_COMMENT_DEPTH = 4;
const MAX_BODY_LENGTH = 1_000;

type RedditFetchResult = {
  text: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  title?: string;
};

type RecordValue = Record<string, unknown>;

export function isRedditUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "redd.it" || host === "reddit.com" || host.endsWith(".reddit.com");
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shorten(value: string, limit = MAX_BODY_LENGTH): string {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function permalink(data: RecordValue): string | undefined {
  const value = string(data.permalink);
  if (!value) return undefined;
  return value.startsWith("http")
    ? value
    : `${REDDIT_BASE}${value.startsWith("/") ? value : `/${value}`}`;
}

function normalizeRedditUrl(url: URL): URL {
  if (!isRedditUrl(url)) throw new Error("Reddit fetch requires a Reddit URL.");
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Reddit fetch requires an http or https URL.");

  const request = new URL(REDDIT_BASE);
  if (url.hostname.toLowerCase() === "redd.it") {
    const id = url.pathname.split("/").find(Boolean);
    if (!id || !/^[a-z0-9]+$/i.test(id))
      throw new Error("Reddit short URLs must include a post ID.");
    request.pathname = `/comments/${id}.json`;
  } else {
    const path = url.pathname.replace(/\/+$/, "");
    request.pathname = path.endsWith(".json") ? path || "/.json" : `${path || "/"}.json`;
  }
  request.search = url.search;
  request.searchParams.set("raw_json", "1");
  return request;
}

function loadCookieHeader(): string {
  const session = process.env.REDDIT_SESSION?.trim();
  if (!session) {
    throw new Error(
      "Reddit authentication is required. Set REDDIT_SESSION to your reddit_session cookie value.",
    );
  }
  return `reddit_session=${session}`;
}

function listingChildren(value: unknown): Array<RecordValue> {
  if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.children))
    return [];
  return value.data.children.filter(isRecord);
}

function formatComments(value: unknown, depth = 0): string[] {
  if (depth >= MAX_COMMENT_DEPTH) return [];
  const lines: string[] = [];
  for (const child of listingChildren(value)) {
    const kind = string(child.kind);
    if (kind === "more") {
      lines.push(`${"  ".repeat(depth)}- [more comments omitted]`);
      continue;
    }
    if (kind !== "t1" || !isRecord(child.data)) continue;
    const data = child.data;
    const author = string(data.author) ?? "[deleted]";
    const score = number(data.score);
    const body = shorten(string(data.body) ?? "[deleted]").replace(/\s*\n\s*/g, " ");
    lines.push(
      `${"  ".repeat(depth)}- u/${author}${score === undefined ? "" : ` (${score} points)`}: ${body}`,
    );
    lines.push(...formatComments(data.replies, depth + 1));
  }
  return lines;
}

function formatPost(data: RecordValue): { text: string; title?: string } {
  const title = string(data.title) ?? "Reddit post";
  const subreddit = string(data.subreddit);
  const author = string(data.author) ?? "[deleted]";
  const score = number(data.score);
  const body = string(data.selftext);
  const url = string(data.url);
  const link = permalink(data);
  const lines = [
    `# ${title}`,
    "",
    [subreddit && `r/${subreddit}`, `u/${author}`, score === undefined ? undefined : `${score} points`]
      .filter(Boolean)
      .join(" · "),
  ];
  if (body) lines.push("", shorten(body));
  if (url && url !== link) lines.push("", `URL: ${url}`);
  if (link) lines.push("", `Permalink: ${link}`);
  return { text: lines.join("\n"), title };
}

function formatPostAndComments(value: unknown[]): { text: string; title?: string } {
  const post = listingChildren(value[0])[0];
  if (!post || !isRecord(post.data)) return formatListing(value[0]);
  const formatted = formatPost(post.data);
  const comments = formatComments(value[1]);
  return {
    title: formatted.title,
    text: comments.length
      ? `${formatted.text}\n\n## Comments\n\n${comments.join("\n")}`
      : formatted.text,
  };
}

function formatListing(value: unknown): { text: string; title?: string } {
  const posts = listingChildren(value)
    .filter((child) => string(child.kind) === "t3" && isRecord(child.data))
    .map((child) => child.data as RecordValue);
  if (!posts.length) return formatThing(value);
  const lines = posts.map((post, index) => {
    const title = string(post.title) ?? "Untitled post";
    const subreddit = string(post.subreddit);
    const author = string(post.author) ?? "[deleted]";
    const score = number(post.score);
    const comments = number(post.num_comments);
    const link = permalink(post);
    return [
      `${index + 1}. **${title}**`,
      `   ${[subreddit && `r/${subreddit}`, `u/${author}`, score === undefined ? undefined : `${score} points`, comments === undefined ? undefined : `${comments} comments`].filter(Boolean).join(" · ")}`,
      link && `   ${link}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return { text: lines.join("\n\n") };
}

function formatThing(value: unknown): { text: string; title?: string } {
  const root = isRecord(value) ? value : {};
  const data = isRecord(root.data) ? root.data : root;
  const subreddit = isRecord(data.subreddit) ? data.subreddit : undefined;
  const title =
    string(data.display_name) ??
    string(data.title) ??
    string(data.name) ??
    (subreddit && string(subreddit.display_name)) ??
    "Reddit response";
  const description =
    string(data.public_description) ??
    string(data.description) ??
    (subreddit && (string(subreddit.public_description) ?? string(subreddit.description)));
  const kind = string(root.kind);
  const lines = [`# ${title}`];
  if (description) lines.push("", shorten(description));
  if (kind) lines.push("", `Type: ${kind}`);
  return { text: lines.join("\n"), title };
}

function formatResponse(payload: unknown): { text: string; title?: string } {
  if (Array.isArray(payload)) return formatPostAndComments(payload);
  if (isRecord(payload) && string(payload.kind) === "Listing") return formatListing(payload);
  return formatThing(payload);
}

function isHtml(body: string, contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("text/html") === true || /<(!doctype|html)\b/i.test(body);
}

export async function fetchReddit(url: URL, signal: AbortSignal): Promise<RedditFetchResult> {
  const request = normalizeRedditUrl(url);
  const response = await fetch(request, {
    signal,
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: loadCookieHeader(),
    },
  });
  const contentType = response.headers.get("content-type");
  const body = (
    await readBodyCapped(
      response,
      response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES,
    )
  ).toString("utf8");
  const html = isHtml(body, contentType);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Reddit rejected the session (HTTP ${response.status}). Set REDDIT_SESSION to a current reddit_session cookie.${html ? " Reddit returned HTML, so authentication or bot blocking is likely." : ""}`,
      );
    }
    if (response.status === 429)
      throw new Error("Reddit rate-limited this request (HTTP 429). Wait and try again.");
    throw new Error(
      `Reddit request failed (HTTP ${response.status}).${html ? " Reddit returned HTML, so authentication or bot blocking is likely." : ""}`,
    );
  }
  if (html)
    throw new Error(
      "Reddit returned HTML instead of JSON; authentication or bot blocking is likely. Set REDDIT_SESSION to a current reddit_session cookie.",
    );

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Reddit returned invalid JSON; authentication or bot blocking may be likely.");
  }
  const formatted = formatResponse(payload);
  return {
    text: formatted.text,
    finalUrl: request.toString(),
    status: response.status,
    contentType: contentType?.split(";", 1)[0]?.trim() || undefined,
    title: formatted.title,
  };
}
