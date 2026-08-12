import { fetch } from "undici";
import {
  MAX_ERROR_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  readBodyCapped,
} from "./shared.js";

const X_BASE = "https://x.com";
const TWEET_DETAIL_QUERY_ID = "xd_EMdYvB9hfZsZ6Idri0w";
const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_REPLY_LENGTH = 750;

const FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  vibe_api_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  interactive_text_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
};

const FIELD_TOGGLES = {
  withArticleRichContentState: true,
  withArticlePlainText: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
};

type TwitterFetchResult = {
  text: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  title?: string;
};

type RecordValue = Record<string, unknown>;

type Tweet = {
  id: string;
  text: string;
  screenName?: string;
  name?: string;
  createdAt?: string;
  replies?: number;
  reposts?: number;
  likes?: number;
  views?: string;
  inReplyToId?: string;
};

export function isTwitterUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com");
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

function nested(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

function shorten(value: string, limit: number): string {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function tweetIdFromUrl(url: URL): string {
  if (!isTwitterUrl(url)) throw new Error("Twitter fetch requires a Twitter/X URL.");
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Twitter fetch requires an http or https URL.");

  const parts = url.pathname.split("/").filter(Boolean);
  const id =
    parts[0]?.toLowerCase() === "i" && parts[1]?.toLowerCase() === "web" && parts[2]?.toLowerCase() === "status"
      ? parts[3]
      : parts[1]?.toLowerCase() === "status"
        ? parts[2]
        : undefined;
  if (!id || !/^\d+$/.test(id)) {
    throw new Error(
      "Twitter MVP supports status/tweet URLs only, such as https://x.com/user/status/1234567890.",
    );
  }
  return id;
}

function loadAuth(): { authToken: string; ct0: string } {
  const authToken = process.env.TWITTER_AUTH_TOKEN?.trim();
  const ct0 = process.env.TWITTER_CT0?.trim();
  if (!authToken || !ct0) {
    throw new Error(
      "Twitter authentication is required. Set both TWITTER_AUTH_TOKEN and TWITTER_CT0 environment variables.",
    );
  }
  return { authToken, ct0 };
}

function requestUrl(id: string): URL {
  const request = new URL(`/i/api/graphql/${TWEET_DETAIL_QUERY_ID}/TweetDetail`, X_BASE);
  request.searchParams.set(
    "variables",
    JSON.stringify({
      focalTweetId: id,
      referrer: "tweet",
      with_rux_injections: false,
      includePromotedContent: true,
      rankingMode: "Relevance",
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: true,
      withVoice: true,
    }),
  );
  request.searchParams.set("features", JSON.stringify(FEATURES));
  request.searchParams.set("fieldToggles", JSON.stringify(FIELD_TOGGLES));
  return request;
}

function unwrapTweet(value: RecordValue): RecordValue | undefined {
  let result = value;
  while (isRecord(result.tweet)) result = result.tweet;
  return string(result.__typename) === "TweetTombstone" ? undefined : result;
}

function parseTweet(value: RecordValue): Tweet | undefined {
  const result = unwrapTweet(value);
  if (!result) return undefined;
  const legacy = nested(result, "legacy");
  if (!isRecord(legacy)) return undefined;
  const id = string(result.rest_id) ?? string(legacy.id_str);
  if (!id || !/^\d+$/.test(id)) return undefined;
  const noteText = string(nested(result, "note_tweet", "note_tweet_results", "result", "text"));
  const text = noteText ?? string(legacy.full_text) ?? "";
  const user = nested(result, "core", "user_results", "result");
  const userLegacy = nested(user, "legacy");
  const views = nested(result, "views", "count");
  const inReplyToId = string(legacy.in_reply_to_status_id_str);
  return {
    id,
    text,
    screenName: string(nested(userLegacy, "screen_name")),
    name: string(nested(userLegacy, "name")),
    createdAt: string(legacy.created_at),
    replies: number(legacy.reply_count),
    reposts: number(legacy.retweet_count),
    likes: number(legacy.favorite_count),
    views: string(views) ?? (typeof views === "number" ? String(views) : undefined),
    inReplyToId: inReplyToId && /^\d+$/.test(inReplyToId) ? inReplyToId : undefined,
  };
}

function collectTweets(value: unknown, tweets: Tweet[], seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTweets(item, tweets, seen);
    return;
  }
  if (!isRecord(value)) return;
  if (isRecord(value.tweet_results) && isRecord(value.tweet_results.result)) {
    const tweet = parseTweet(value.tweet_results.result);
    if (tweet && !seen.has(tweet.id)) {
      seen.add(tweet.id);
      tweets.push(tweet);
    }
  }
  for (const child of Object.values(value)) collectTweets(child, tweets, seen);
}

function tweetTitle(tweet: Tweet): string {
  const author = tweet.screenName ? `@${tweet.screenName}` : tweet.name ?? "Tweet";
  const firstLine = tweet.text.split("\n").find((line) => line.trim())?.trim();
  return firstLine ? `${author}: ${shorten(firstLine, 160)}` : author;
}

function formatTweet(tweet: Tweet, heading: string, limit?: number): string {
  const author = tweet.screenName ? `@${tweet.screenName}` : tweet.name ?? "Unknown user";
  const details = [
    tweet.name && tweet.screenName ? tweet.name : undefined,
    tweet.createdAt,
    tweet.replies === undefined ? undefined : `${tweet.replies} replies`,
    tweet.reposts === undefined ? undefined : `${tweet.reposts} reposts`,
    tweet.likes === undefined ? undefined : `${tweet.likes} likes`,
    tweet.views === undefined ? undefined : `${tweet.views} views`,
  ].filter(Boolean);
  const lines = [`${heading} ${author}`];
  if (details.length) lines.push("", details.join(" · "));
  if (tweet.text) lines.push("", limit ? shorten(tweet.text, limit) : tweet.text.trim());
  return lines.join("\n");
}

function formatResponse(payload: unknown, id: string): { text: string; title?: string } {
  const tweets: Tweet[] = [];
  collectTweets(payload, tweets, new Set());
  const focal = tweets.find((tweet) => tweet.id === id);
  if (!focal) throw new Error("Twitter response did not contain the requested tweet.");
  const tweetsById = new Map(tweets.map((tweet) => [tweet.id, tweet]));
  const ancestors: Tweet[] = [];
  const ancestorIds = new Set<string>();
  for (let parentId = focal.inReplyToId; parentId && !ancestorIds.has(parentId); ) {
    const parent = tweetsById.get(parentId);
    if (!parent || parent.id === focal.id) break;
    ancestors.push(parent);
    ancestorIds.add(parent.id);
    parentId = parent.inReplyToId;
  }
  ancestors.reverse();

  const replies = tweets
    .filter((tweet) => {
      if (tweet.id === focal.id || ancestorIds.has(tweet.id)) return false;
      const seen = new Set<string>();
      for (let current: Tweet | undefined = tweet; current?.inReplyToId && !seen.has(current.id); ) {
        seen.add(current.id);
        if (current.inReplyToId === focal.id) return true;
        current = tweetsById.get(current.inReplyToId);
      }
      return false;
    })
    .slice(0, 20);
  const text = [
    formatTweet(focal, "#"),
    ...(ancestors.length
      ? ["", "## Context", ...ancestors.flatMap((tweet) => ["", formatTweet(tweet, "-", MAX_REPLY_LENGTH)])]
      : []),
    ...(replies.length
      ? ["", "## Replies", ...replies.flatMap((tweet) => ["", formatTweet(tweet, "-", MAX_REPLY_LENGTH)])]
      : []),
  ].join("\n");
  return { text, title: tweetTitle(focal) };
}

function isHtml(body: string, contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("text/html") === true || /<(!doctype|html)\b/i.test(body);
}

export async function fetchTwitter(url: URL, signal: AbortSignal): Promise<TwitterFetchResult> {
  const id = tweetIdFromUrl(url);
  const { authToken, ct0 } = loadAuth();
  const request = requestUrl(id);
  const response = await fetch(request, {
    signal,
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      Cookie: `auth_token=${authToken}; ct0=${ct0}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Client-Language": "en",
      "User-Agent": USER_AGENT,
      Origin: X_BASE,
      Referer: `${X_BASE}/`,
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
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
        `Twitter rejected the session (HTTP ${response.status}). Refresh TWITTER_AUTH_TOKEN and TWITTER_CT0.${html ? " Twitter returned HTML, so authentication or bot blocking is likely." : ""}`,
      );
    }
    if (response.status === 429)
      throw new Error("Twitter rate-limited this request (HTTP 429). Wait and try again.");
    throw new Error(
      `Twitter request failed (HTTP ${response.status}).${html ? " Twitter returned HTML, so authentication or bot blocking is likely." : ""}`,
    );
  }
  if (html) {
    throw new Error(
      "Twitter returned HTML instead of JSON; authentication or bot blocking is likely. Refresh TWITTER_AUTH_TOKEN and TWITTER_CT0.",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Twitter returned invalid JSON; authentication or bot blocking may be likely.");
  }
  const formatted = formatResponse(payload, id);
  return {
    text: formatted.text,
    finalUrl: `${X_BASE}/i/web/status/${id}`,
    status: response.status,
    contentType: contentType?.split(";", 1)[0]?.trim() || undefined,
    title: formatted.title,
  };
}
