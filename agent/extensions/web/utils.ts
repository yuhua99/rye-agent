import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";

const silentConsole = new VirtualConsole();

export const DEFAULT_MAIN_CONTENT_SELECTORS = [
	"article",
	"main",
	"[role=main]",
	".post",
	".article-body",
	".content",
	".post-content",
	".entry-content",
	"#content",
];

export const MIN_CONTENT_LENGTH = 200;

export type ExtractedMetadata = {
	title?: string;
	byline?: string;
	siteName?: string;
	publishedTime?: string;
	lang?: string;
};

export type ExtractedContent = {
	html: string;
	text: string;
	metadata: ExtractedMetadata;
	usedFallback: boolean;
};

const turndownService = new TurndownService({
	codeBlockStyle: "fenced",
	headingStyle: "atx",
});
turndownService.remove(["style", "script", "noscript"]);

function normalizeText(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeTextContent(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
	for (const value of values) {
		const normalized = normalizeText(value);
		if (normalized) return normalized;
	}
	return undefined;
}

function getMetaContent(
	document: Document,
	attribute: "name" | "property" | "itemprop",
	key: string,
): string | undefined {
	const content = document.querySelector(`meta[${attribute}="${key}"]`)?.getAttribute("content");
	return normalizeText(content);
}

export function extractPublishedTime(document: Document): string | undefined {
	const metaKeys: Array<{ attribute: "name" | "property" | "itemprop"; key: string }> = [
		{ attribute: "property", key: "article:published_time" },
		{ attribute: "property", key: "og:published_time" },
		{ attribute: "name", key: "pubdate" },
		{ attribute: "name", key: "publishdate" },
		{ attribute: "name", key: "timestamp" },
		{ attribute: "name", key: "date" },
		{ attribute: "name", key: "datePublished" },
		{ attribute: "name", key: "dc.date" },
		{ attribute: "name", key: "dcterms.created" },
		{ attribute: "itemprop", key: "datePublished" },
	];
	for (const { attribute, key } of metaKeys) {
		const value = getMetaContent(document, attribute, key);
		if (value) return value;
	}
	const timeElement = document.querySelector("time[datetime]");
	return firstNonEmpty(timeElement?.getAttribute("datetime"), timeElement?.textContent);
}

export function extractMetadataFromDocument(document: Document): ExtractedMetadata {
	const title = firstNonEmpty(
		getMetaContent(document, "property", "og:title"),
		getMetaContent(document, "name", "twitter:title"),
		getMetaContent(document, "name", "title"),
		normalizeText(document.title),
	);
	const byline = firstNonEmpty(
		getMetaContent(document, "name", "author"),
		getMetaContent(document, "property", "article:author"),
		getMetaContent(document, "name", "parsely-author"),
		getMetaContent(document, "name", "sailthru.author"),
	);
	const siteName = firstNonEmpty(
		getMetaContent(document, "property", "og:site_name"),
		getMetaContent(document, "name", "application-name"),
	);
	const lang = firstNonEmpty(
		normalizeText(document.documentElement?.getAttribute("lang")),
		getMetaContent(document, "property", "og:locale"),
	);
	return { title, byline, siteName, publishedTime: extractPublishedTime(document), lang };
}

export function extractMetadataFromHtml(html: string, url: string): ExtractedMetadata {
	const dom = new JSDOM(html, { url, virtualConsole: silentConsole });
	return extractMetadataFromDocument(dom.window.document);
}

export function pickBestContentNode(
	document: Document,
	selectors: string[] = DEFAULT_MAIN_CONTENT_SELECTORS,
): { html: string; text: string; selector: string } | null {
	for (const el of document.querySelectorAll("style, script, noscript, svg, template")) el.remove();
	let best: { html: string; text: string; length: number; selector: string } | null = null;
	for (const selector of selectors) {
		for (const element of Array.from(document.querySelectorAll(selector))) {
			const text = normalizeTextContent(element.textContent);
			if (!text) continue;
			if (!best || text.length > best.length) {
				best = { html: element.innerHTML.trim(), text, length: text.length, selector };
			}
		}
	}
	if (best) return { html: best.html, text: best.text, selector: best.selector };
	const body = document.body;
	if (!body) return null;
	const text = normalizeTextContent(body.textContent);
	if (!text) return null;
	return { html: body.innerHTML.trim(), text, selector: "body" };
}

export function extractReadableContent(html: string, url: string): ExtractedContent {
	const dom = new JSDOM(html, { url, virtualConsole: silentConsole });
	const document = dom.window.document;
	const baseMetadata = extractMetadataFromDocument(document);
	let article: ReturnType<Readability["parse"]> | null = null;
	try {
		article = new Readability(document).parse();
	} catch {
		article = null;
	}
	const metadata: ExtractedMetadata = {
		title: normalizeText(article?.title) ?? baseMetadata.title,
		byline: normalizeText(article?.byline) ?? baseMetadata.byline,
		siteName: normalizeText(article?.siteName) ?? baseMetadata.siteName,
		publishedTime: baseMetadata.publishedTime,
		lang: normalizeText(article?.lang) ?? baseMetadata.lang,
	};
	const htmlContent = article?.content?.trim() ?? "";
	const text = normalizeTextContent(article?.textContent);
	if (htmlContent && text.length >= MIN_CONTENT_LENGTH) {
		return { html: htmlContent, text, metadata, usedFallback: false };
	}
	const fallback = pickBestContentNode(
		new JSDOM(html, { url, virtualConsole: silentConsole }).window.document,
	);
	if (fallback) return { html: fallback.html, text: fallback.text, metadata, usedFallback: true };
	return { html: "", text: "", metadata, usedFallback: true };
}

export function convertHtmlToMarkdown(html: string): string {
	return turndownService.turndown(html).trim();
}

export function formatMetadataBlock(
	metadata: ExtractedMetadata,
	options: { url: string; contentType?: string },
): string {
	return [
		["URL", options.url],
		["Content-Type", options.contentType],
		["Title", metadata.title],
		["Byline", metadata.byline],
		["Site", metadata.siteName],
		["Published", metadata.publishedTime],
		["Language", metadata.lang],
	]
		.filter(([, value]) => value)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
}

export function isHtmlContentType(contentType: string | null | undefined): boolean {
	if (!contentType) return true;
	const lowered = contentType.toLowerCase();
	return lowered.includes("text/html") || lowered.includes("application/xhtml+xml");
}
