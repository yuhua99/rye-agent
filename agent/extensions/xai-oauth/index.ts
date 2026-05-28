import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  Context,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai";
import { createHash, randomBytes, randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { createServer, type Server } from "http";
import { extname, isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
const XAI_OAUTH_REDIRECT_PORT = 56121;
const XAI_OAUTH_REDIRECT_PATH = "/callback";
const XAI_OAUTH_REFRESH_SKEW_MS = 2 * 60 * 1000;
const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const XAI_IMAGES_GENERATIONS_URL = "https://api.x.ai/v1/images/generations";
const DEFAULT_XAI_MODEL = "grok-4.3";
const DEFAULT_XAI_IMAGE_MODEL = "grok-imagine-image-quality";

type XaiDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
};

type XaiTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
};

type CallbackResult = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  trustedManualCode?: boolean;
};

const MODELS = [
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 Reasoning",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20 Non-Reasoning",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi-Agent",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-build",
    name: "Grok Build",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.0, output: 2.0, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 131_072,
  },
];

const xaiToolRegistrations = new WeakSet<object>();

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function validateXaiEndpoint(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (host !== "x.ai" && !host.endsWith(".x.ai"))
  ) {
    throw new Error(
      `xAI OAuth discovery returned an unexpected endpoint: ${url}`,
    );
  }
  return url;
}

async function xaiDiscovery(): Promise<XaiDiscovery> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `xAI OAuth discovery failed: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as Partial<XaiDiscovery>;
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new Error(
      "xAI OAuth discovery response did not include authorization/token endpoints",
    );
  }

  return {
    authorization_endpoint: validateXaiEndpoint(data.authorization_endpoint),
    token_endpoint: validateXaiEndpoint(data.token_endpoint),
  };
}

function callbackCorsOrigin(origin: string | undefined): string | undefined {
  return origin === "https://accounts.x.ai" || origin === "https://auth.x.ai"
    ? origin
    : undefined;
}

async function refreshXaiCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!credentials.refresh) {
    throw new Error(
      "xAI credentials are expired and do not include a refresh token",
    );
  }

  const tokenEndpoint =
    typeof credentials.tokenEndpoint === "string" && credentials.tokenEndpoint
      ? validateXaiEndpoint(credentials.tokenEndpoint)
      : (await xaiDiscovery()).token_endpoint;
  const data = await exchangeXaiToken(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: XAI_OAUTH_CLIENT_ID,
  });

  return credentialsFromTokenPayload(data, tokenEndpoint, credentials.refresh);
}

async function startCallbackServer(expectedState: string): Promise<{
  redirectUri: string;
  waitForCallback: (signal?: AbortSignal) => Promise<CallbackResult>;
  resolveCallback: (result: CallbackResult) => void;
  close: () => void;
}> {
  let resolveCallback!: (result: CallbackResult) => void;
  const callbackPromise = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const makeServer = () =>
    createServer((req, res) => {
      const origin = callbackCorsOrigin(req.headers.origin);
      const writeCors = () => {
        if (!origin) return;
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Vary", "Origin");
      };

      if (req.method === "OPTIONS") {
        writeCors();
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${XAI_OAUTH_REDIRECT_HOST}`);
      if (url.pathname !== XAI_OAUTH_REDIRECT_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const result: CallbackResult = {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        error_description:
          url.searchParams.get("error_description") || undefined,
      };
      if (result.state !== expectedState) {
        writeCors();
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<html><body><h1>xAI authorization state mismatch.</h1>Please return to pi and try again.</body></html>",
        );
        return;
      }
      resolveCallback(result);

      writeCors();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        result.error
          ? "<html><body><h1>xAI authorization failed.</h1>You can close this tab.</body></html>"
          : "<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>",
      );
    });

  const listen = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = makeServer();
      server.once("error", reject);
      server.listen(port, XAI_OAUTH_REDIRECT_HOST, () => {
        server.removeListener("error", reject);
        resolve(server);
      });
    });

  let server: Server;
  try {
    server = await listen(XAI_OAUTH_REDIRECT_PORT);
  } catch {
    server = await listen(0);
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine xAI OAuth callback port");
  }

  const redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${address.port}${XAI_OAUTH_REDIRECT_PATH}`;

  const close = () => {
    try {
      server.close();
    } catch {
      // ignore
    }
  };

  return {
    redirectUri,
    close,
    resolveCallback,
    waitForCallback: async (signal?: AbortSignal) => {
      let timer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;
      const timeout = new Promise<CallbackResult>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for xAI OAuth callback")),
          180_000,
        );
        abortHandler = () => {
          if (timer) clearTimeout(timer);
          reject(new Error("xAI OAuth login was cancelled"));
        };
        signal?.addEventListener("abort", abortHandler, { once: true });
      });

      try {
        return await Promise.race([callbackPromise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        close();
      }
    },
  };
}

function buildAuthorizeUrl(
  discovery: XaiDiscovery,
  redirectUri: string,
  challenge: string,
  state: string,
  nonce: string,
): string {
  // Match the official Grok CLI authorize URL. Extra query params such as
  // `plan=generic` can change xAI's routing/branding and send users toward
  // the API-console SSO surface instead of the Grok OAuth consent surface.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

function parseCallbackInput(input: string): CallbackResult | undefined {
  const value = input.trim();
  if (!value) return undefined;

  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value.replace(/\s+/g, ""));
      return {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        error_description:
          url.searchParams.get("error_description") || undefined,
      };
    }

    if (value.startsWith("?") || /(?:^|[&?])(code|error)=/.test(value)) {
      const url = new URL(
        `http://${XAI_OAUTH_REDIRECT_HOST}${XAI_OAUTH_REDIRECT_PATH}?${value.replace(/^\?/, "")}`,
      );
      return {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        error_description:
          url.searchParams.get("error_description") || undefined,
      };
    }
  } catch {
    return undefined;
  }

  const code = value.replace(/\s+/g, "");
  return code ? { code, trustedManualCode: true } : undefined;
}

async function exchangeXaiToken(
  tokenEndpoint: string,
  body: Record<string, string>,
): Promise<XaiTokenPayload> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `xAI token request failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as XaiTokenPayload;
}

function credentialsFromTokenPayload(
  data: XaiTokenPayload,
  tokenEndpoint: string,
  fallbackRefresh = "",
): OAuthCredentials {
  if (!data.access_token) {
    throw new Error("xAI token response did not include an access token");
  }

  const refresh = data.refresh_token || fallbackRefresh;
  if (!refresh) {
    throw new Error("xAI token response did not include a refresh token");
  }

  return {
    refresh,
    access: data.access_token,
    expires:
      Date.now() + (data.expires_in || 3600) * 1000 - XAI_OAUTH_REFRESH_SKEW_MS,
    tokenEndpoint,
    idToken: data.id_token || "",
    tokenType: data.token_type || "Bearer",
  };
}

function stripShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unescapeShellPath(value: string): string {
  // Users often paste paths copied from a shell prompt, e.g. /tmp/My\\ File.png.
  return stripShellQuotes(value).replace(/\\([\\\s'"()&;@])/g, "$1");
}

function imageMimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      throw new Error(
        "xAI image understanding supports local .jpg, .jpeg, and .png files only",
      );
  }
}

function resolveLocalImagePath(value: string): string | undefined {
  const cleaned = unescapeShellPath(value);
  if (!cleaned) return undefined;

  if (cleaned.startsWith("file://")) {
    try {
      return fileURLToPath(cleaned);
    } catch {
      return undefined;
    }
  }

  const candidates = [cleaned];
  if (!isAbsolute(cleaned)) candidates.push(resolve(process.cwd(), cleaned));

  return candidates.find((candidate) => existsSync(candidate));
}

function normalizeXaiImageInput(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const cleaned = stripShellQuotes(value);

  if (/^https?:\/\//i.test(cleaned) || /^data:image\//i.test(cleaned)) {
    return cleaned;
  }

  const localPath = resolveLocalImagePath(cleaned);
  if (!localPath) {
    throw new Error(
      `Image file does not exist or is not a valid URL: ${cleaned}`,
    );
  }

  const mimeType = imageMimeTypeForPath(localPath);
  const data = readFileSync(localPath).toString("base64");
  return `data:${mimeType};base64,${data}`;
}

function extractResponsesText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text)
    return data.output_text;
  const chunks: string[] = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (
        typeof part?.text === "string" &&
        (part.type === "output_text" || part.text)
      )
        chunks.push(part.text);
    }
  }
  return chunks.join("") || JSON.stringify(data);
}

function xaiModelForRequest(modelId?: string): Model<Api> {
  const id = modelId || DEFAULT_XAI_MODEL;
  const model = MODELS.find((candidate) => candidate.id === id) || MODELS[0];
  return {
    ...model,
    id,
    provider: "xai-auth",
    api: "xai-responses",
    baseUrl: "https://api.x.ai/v1",
  } as any;
}

function grokSupportsReasoningEffort(modelId: string): boolean {
  const normalized = (modelId || "").toLowerCase().split("/").pop() || "";
  return (
    normalized.startsWith("grok-3-mini") ||
    normalized.startsWith("grok-4.20-multi-agent") ||
    normalized.startsWith("grok-4.3")
  );
}

function textFromResponsesContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: unknown; text?: unknown };
      const type = typeof item.type === "string" ? item.type : "";
      return ["text", "input_text", "output_text"].includes(type) &&
        typeof item.text === "string"
        ? item.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeResponsesImageParts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeResponsesImageParts);
  if (!value || typeof value !== "object") return value;

  const obj: Record<string, any> = { ...(value as Record<string, any>) };
  if (
    obj.type === "image" &&
    typeof obj.data === "string" &&
    typeof obj.mimeType === "string"
  ) {
    return {
      type: "input_image",
      image_url: `data:${obj.mimeType};base64,${obj.data}`,
      detail:
        typeof obj.detail === "string" && obj.detail ? obj.detail : "auto",
    };
  }
  if (obj.type === "image_url") {
    const imageUrl =
      typeof obj.image_url === "object" && obj.image_url
        ? obj.image_url.url
        : obj.image_url;
    const detail =
      typeof obj.image_url === "object" && obj.image_url
        ? obj.image_url.detail
        : obj.detail;
    obj.type = "input_image";
    obj.image_url = imageUrl;
    if (typeof detail === "string" && detail) obj.detail = detail;
  }
  if (obj.type === "input_image") {
    const imageUrl =
      typeof obj.image_url === "object" && obj.image_url
        ? obj.image_url.url
        : obj.image_url;
    const detail =
      typeof obj.image_url === "object" && obj.image_url
        ? obj.image_url.detail
        : obj.detail;
    const normalized = normalizeXaiImageInput(imageUrl);
    if (normalized) obj.image_url = normalized;
    if (typeof detail === "string" && detail) obj.detail = detail;
    if (typeof obj.detail !== "string" || !obj.detail) obj.detail = "auto";
  }
  if (Array.isArray(obj.content))
    obj.content = normalizeResponsesImageParts(obj.content);
  if (Array.isArray(obj.output))
    obj.output = normalizeResponsesImageParts(obj.output);
  return obj;
}

function isResponsesInputImagePart(
  value: unknown,
): value is Record<string, any> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, any>).type === "input_image"
  );
}

function textForFunctionCallOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output))
    return output === undefined || output === null
      ? ""
      : JSON.stringify(output);

  const chunks: string[] = [];
  let imageCount = 0;
  for (const part of output) {
    if (isResponsesInputImagePart(part)) {
      imageCount++;
      continue;
    }
    const text = textFromResponsesContent([part]).trim();
    if (text) chunks.push(text);
  }
  if (imageCount > 0)
    chunks.push(
      `[${imageCount} image${imageCount === 1 ? "" : "s"} attached in the following user message]`,
    );
  return (
    chunks.join("\n") ||
    (imageCount > 0
      ? `[${imageCount} image${imageCount === 1 ? "" : "s"} attached]`
      : "")
  );
}

function normalizeXaiResponsesInput(
  input: unknown[],
  model: Model<Api>,
): unknown[] {
  const normalizedInput = input.map(normalizeResponsesImageParts) as Record<
    string,
    any
  >[];
  const rewritten: unknown[] = [];
  const modelInputs = Array.isArray((model as any).input)
    ? ((model as any).input as unknown[])
    : [];
  const supportsImages = modelInputs.includes("image");

  for (const item of normalizedInput) {
    if (
      !item ||
      typeof item !== "object" ||
      item.type !== "function_call_output" ||
      !Array.isArray(item.output)
    ) {
      rewritten.push(item);
      continue;
    }

    // xAI rejects OpenAI Responses' image-bearing tool replay shape:
    //   { type: "function_call_output", output: [{ type: "input_text" }, { type: "input_image" }] }
    // with a 422 ModelInput deserialization error. Keep the required tool
    // output as text and replay images as a normal following user message.
    const outputParts = item.output;
    const imageParts = outputParts.filter(isResponsesInputImagePart);
    const outputText = textForFunctionCallOutput(outputParts);
    rewritten.push({
      ...item,
      output: outputText || "(tool returned no text output)",
    });

    if (supportsImages && imageParts.length > 0) {
      const label = `The previous tool result${item.call_id ? ` (${item.call_id})` : ""} included ${imageParts.length} image${imageParts.length === 1 ? "" : "s"}. Use the attached image${imageParts.length === 1 ? "" : "s"} as the visual output from that tool.`;
      rewritten.push({
        role: "user",
        content: [{ type: "input_text", text: label }, ...imageParts],
      });
    }
  }

  return rewritten;
}

function rewriteXaiResponsesPayload(
  payload: unknown,
  model: Model<Api>,
  options?: SimpleStreamOptions,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body: Record<string, any> = { ...(payload as Record<string, any>) };

  // xAI's Responses API matches the OpenAI surface but has a few stricter
  // edges than pi's generic OpenAI Responses serializer. Hermes solves the
  // same Grok OAuth path with top-level instructions; xAI also rejects
  // image arrays in function_call_output.output, so normalize those here.
  if (Array.isArray(body.input)) {
    const input = normalizeXaiResponsesInput([...body.input], model) as Record<
      string,
      any
    >[];
    const instructionParts: string[] = [];
    while (input.length > 0) {
      const first = input[0];
      if (
        !first ||
        typeof first !== "object" ||
        (first.role !== "developer" && first.role !== "system")
      )
        break;
      const text = textFromResponsesContent(first.content).trim();
      if (text) instructionParts.push(text);
      input.shift();
    }
    if (instructionParts.length > 0) {
      body.instructions = [body.instructions, ...instructionParts]
        .filter((part) => typeof part === "string" && part)
        .join("\n\n");
    }
    body.input = input;
  } else if (typeof body.input === "string") {
    // String input is valid and should stay string-shaped.
  }

  if (body.response_format && !body.text) {
    body.text = { format: body.response_format };
    delete body.response_format;
  }

  if (body.reasoning && typeof body.reasoning === "object") {
    const effort = body.reasoning.effort;
    if (
      typeof effort === "string" &&
      effort !== "none" &&
      grokSupportsReasoningEffort(String(body.model || model.id))
    ) {
      body.reasoning = { effort: effort === "minimal" ? "low" : effort };
    } else {
      delete body.reasoning;
    }
  }

  // xAI doesn't implement OpenAI's prompt_cache_retention knob. Keep the
  // cache key (xAI documents it as a body field), but remove retention.
  delete body.prompt_cache_retention;
  if (options?.sessionId && !body.prompt_cache_key)
    body.prompt_cache_key = options.sessionId;

  return body;
}

function xaiTextInput(text: string): Array<{ role: "user"; content: string }> {
  return [{ role: "user", content: text }];
}

function xaiToolError(message: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text: message }], details };
}

async function resolveXaiAuthToken(ctx: any): Promise<string | null> {
  const registryModel = ctx?.modelRegistry?.find?.(
    "xai-auth",
    DEFAULT_XAI_MODEL,
  );
  if (
    registryModel &&
    typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function"
  ) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(registryModel);
    if (auth?.ok && auth.apiKey) return auth.apiKey;
    const authorization =
      auth?.ok && typeof auth.headers?.Authorization === "string"
        ? auth.headers.Authorization
        : "";
    if (authorization.toLowerCase().startsWith("bearer "))
      return authorization.slice("bearer ".length);
  }
  if (ctx?.apiKey) return ctx.apiKey;
  return null;
}

async function postXaiJson(
  apiKey: string,
  url: string,
  body: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    const error = new Error(errorText);
    (error as any).status = response.status;
    throw error;
  }

  return response.json();
}

async function createXaiResponse(
  apiKey: string,
  body: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  const model = xaiModelForRequest(
    typeof body.model === "string" ? body.model : undefined,
  );
  const payload = rewriteXaiResponsesPayload(body, model) as Record<
    string,
    any
  >;
  return postXaiJson(apiKey, XAI_RESPONSES_URL, payload, signal);
}

function statusFromError(error: unknown): number | undefined {
  return typeof (error as any)?.status === "number"
    ? (error as any).status
    : undefined;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function streamSimpleXaiResponses(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const headers = { ...(options?.headers || {}) };
  if (options?.sessionId && !headers["x-grok-conv-id"])
    headers["x-grok-conv-id"] = options.sessionId;

  return streamSimpleOpenAIResponses(
    model as Model<"openai-responses">,
    context,
    {
      ...options,
      headers,
      async onPayload(payload, payloadModel) {
        const rewritten = rewriteXaiResponsesPayload(
          payload,
          payloadModel,
          options,
        );
        const userRewritten = await options?.onPayload?.(
          rewritten,
          payloadModel,
        );
        return userRewritten === undefined ? rewritten : userRewritten;
      },
    },
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("xai-auth", {
    name: "xAI (OAuth)",
    baseUrl: "https://api.x.ai/v1",
    api: "xai-responses",
    models: MODELS as any,
    authHeader: true,
    streamSimple: streamSimpleXaiResponses as any,

    oauth: {
      usesCallbackServer: true,
      name: "xAI (Grok)",

      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        callbacks.onProgress?.("Starting xAI SuperGrok OAuth login...");
        const discovery = await xaiDiscovery();
        const { verifier, challenge } = pkcePair();
        const state = randomUUID().replace(/-/g, "");
        const nonce = randomUUID().replace(/-/g, "");
        const callbackServer = await startCallbackServer(state);
        const authorizeUrl = buildAuthorizeUrl(
          discovery,
          callbackServer.redirectUri,
          challenge,
          state,
          nonce,
        );

        // Trigger automatic browser open via pi's onAuth handler.
        // pi's login dialog runs `open <url>` on macOS / `xdg-open` on Linux,
        // AND when usesCallbackServer:true it also shows a built-in manual input
        // field that resolves via onManualCodeInput. We race both paths below.
        callbacks.onAuth?.({
          url: authorizeUrl,
          instructions:
            "If the automatic open uses the wrong browser/profile, copy the URL and paste it into the field below (or open it manually in your preferred browser).",
        });

        callbacks.onProgress?.(
          `Waiting for xAI OAuth callback on ${callbackServer.redirectUri}...`,
        );

        // Race the local callback server against pi's built-in manual input
        // (shown automatically when usesCallbackServer: true). If the HTTP
        // callback fires first (browser reaches localhost), the manual input
        // is simply a no-op since resolveCallback already ran.
        const manualCodePromise = callbacks.onManualCodeInput?.();
        if (manualCodePromise) {
          manualCodePromise
            .then((input: string) => {
              if (input) {
                const manual = parseCallbackInput(input);
                if (
                  manual?.trustedManualCode ||
                  manual?.state === state ||
                  manual?.error
                ) {
                  callbackServer.resolveCallback(manual);
                } else if (manual) {
                  callbacks.onProgress?.(
                    "Ignored pasted xAI callback because the OAuth state did not match. Try the login again if needed.",
                  );
                } else {
                  callbacks.onProgress?.(
                    "Could not parse pasted xAI authorization input. Paste the full redirect URL or authorization code.",
                  );
                }
              }
            })
            .catch(() => {
              // Cancellation is handled by callbacks.signal / the login dialog.
            });
        }

        let callback: CallbackResult;
        try {
          callback = await callbackServer.waitForCallback(callbacks.signal);
        } catch (error) {
          callbacks.onProgress?.(
            `${messageFromError(error)}. Falling back to manual paste...`,
          );
          const input = await callbacks.onPrompt({
            message: "Paste the xAI authorization code or full redirect URL:",
          });
          const manual = parseCallbackInput(input);
          if (!manual) {
            throw new Error(
              "xAI authorization failed: could not parse pasted code or redirect URL",
            );
          }
          callback = manual;
        }

        if (callback.error) {
          throw new Error(
            `xAI authorization failed: ${callback.error_description || callback.error}`,
          );
        }
        if (!callback.trustedManualCode && callback.state !== state) {
          throw new Error("xAI authorization failed: state mismatch");
        }
        if (!callback.code) {
          throw new Error(
            "xAI authorization failed: no authorization code returned",
          );
        }

        callbacks.onProgress?.("Exchanging xAI authorization code...");
        const data = await exchangeXaiToken(discovery.token_endpoint, {
          grant_type: "authorization_code",
          code: callback.code,
          redirect_uri: callbackServer.redirectUri,
          client_id: XAI_OAUTH_CLIENT_ID,
          code_verifier: verifier,
        });

        return credentialsFromTokenPayload(data, discovery.token_endpoint);
      },

      async refreshToken(
        credentials: OAuthCredentials,
      ): Promise<OAuthCredentials> {
        if (
          !credentials.refresh &&
          credentials.expires &&
          credentials.expires <= Date.now()
        ) {
          throw new Error(
            "xAI OAuth token is expired and cannot be refreshed. Please run /login xai-auth again.",
          );
        }
        if (!credentials.refresh) return credentials;
        return refreshXaiCredentials(credentials);
      },

      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    } as any,
  });

  // ====================== CUSTOM TOOLS ======================
  // These tools use the xai_ prefix to reduce collision risk.
  // IMPORTANT: Install this package via ONE method only (npm OR git) to avoid
  // "Tool conflicts with ..." errors between the npm global path and
  // ~/.pi/agent/git/... clone.

  function registerXaiTools() {
    if (xaiToolRegistrations.has(pi as object)) return;
    xaiToolRegistrations.add(pi as object);

    pi.registerTool({
      name: "x_search",
      label: "X Search",
      description:
        "Real-time X.com/Twitter search. Prefer for x.com URLs, posts, threads.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "X search query" },
          count: {
            type: "number",
            description: "Max number of posts to return (1-10)",
            default: 5,
          },
          since: {
            type: "string",
            description: "Only posts after this date (YYYY-MM-DD)",
          },
          until: {
            type: "string",
            description: "Only posts before this date (YYYY-MM-DD)",
          },
        },
        required: ["query"],
      },
      execute: async (
        _toolCallId: string,
        params: {
          query?: string;
          count?: number;
          since?: string;
          until?: string;
        },
        _signal: any,
        _onUpdate: any,
        ctx: any,
      ) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError(
            "Error: No xAI OAuth credentials found. Please run the OAuth login first.",
            { query: params?.query },
          );
        }

        let prompt = `Search X for: ${params.query}.`;
        if (params.count) prompt += ` Return up to ${params.count} posts.`;
        if (params.since)
          prompt += ` Only include posts since ${params.since}.`;
        if (params.until)
          prompt += ` Only include posts until ${params.until}.`;
        prompt +=
          " Summarize most relevant posts with timestamps, authors, and key points.";

        const xSearchTool: Record<string, any> = {
          type: "x_search",
          enable_image_understanding: true,
        };
        if (params.since) xSearchTool.from_date = params.since;
        if (params.until) xSearchTool.to_date = params.until;

        let data: any;
        try {
          data = await createXaiResponse(
            apiKey,
            {
              model: DEFAULT_XAI_MODEL,
              input: xaiTextInput(prompt),
              reasoning: { effort: "medium" },
              tools: [xSearchTool],
            },
            _signal,
          );
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(
            `xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
            { error: true, status, query: params.query },
          );
        }

        const text =
          extractResponsesText(data) || `No X results for: ${params.query}`;
        return {
          content: [{ type: "text", text }],
          details: { query: params.query },
        };
      },
    } as any);

    pi.registerTool({
      name: "xai_generate_image",
      label: "xAI Image Generation",
      description:
        "Generate images using xAI's current image generation model.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Detailed description of image to generate",
          },
          model: {
            type: "string",
            description: "Image model to use",
            default: DEFAULT_XAI_IMAGE_MODEL,
          },
          aspect_ratio: {
            type: "string",
            description:
              "Image aspect ratio. Supported: 1:1, 3:4, 4:3, 9:16, 16:9, 2:3, 3:2, 9:19.5, 19.5:9, 9:20, 20:9, 1:2, 2:1, auto",
            default: "auto",
          },
          resolution: {
            type: "string",
            description: "Image resolution. Supported: 1k, 2k",
            default: "1k",
          },
          n: {
            type: "number",
            description: "Number of images to generate (1-4)",
            default: 1,
          },
        },
        required: ["prompt"],
      },
      execute: async (
        _toolCallId: string,
        params: {
          prompt?: string;
          model?: string;
          aspect_ratio?: string;
          resolution?: string;
          n?: number;
        },
        _signal: any,
        _onUpdate: any,
        ctx: any,
      ) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError(
            "Error: No xAI OAuth credentials found. Please run the OAuth login first.",
            { prompt: params?.prompt },
          );
        }

        const body: Record<string, any> = {
          model: params.model || DEFAULT_XAI_IMAGE_MODEL,
          prompt: params.prompt,
          n: params.n || 1,
        };
        if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;
        if (params.resolution) body.resolution = params.resolution;

        let data: any;
        try {
          data = await postXaiJson(
            apiKey,
            XAI_IMAGES_GENERATIONS_URL,
            body,
            _signal,
          );
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(
            `xAI Image API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
            { error: true, status, prompt: params.prompt },
          );
        }

        const images = data.data || [];
        const urls = images.map((img: any) => img.url).filter(Boolean);
        const text =
          urls.length > 0
            ? `Generated ${urls.length} image(s):\n${urls.map((u: string) => `- ${u}`).join("\n")}`
            : "Image generation completed but no URLs returned.";
        return {
          content: [{ type: "text", text }],
          details: { prompt: params.prompt, urls, count: urls.length },
        };
      },
    } as any);
  }

  registerXaiTools();
}
