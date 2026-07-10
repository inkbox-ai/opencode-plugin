import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedConfig } from "../config.js";
import { gatewayHome } from "./state.js";
import type { GatewayLogger } from "./types.js";

// Media helpers for the gateway. Inbound: download webhook attachments
// (MMS/iMessage media, email files) to local paths the agent can Read.
// Outbound: package local files into the shape each channel's send API
// wants — a hosted URL for SMS/iMessage, base64 for email attachments.

const MIB = 1024 * 1024;
export const DEFAULT_DOWNLOAD_MAX_BYTES = 25 * MIB;
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * MIB;
export const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * MIB;

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

// Small built-in type map covering the media the channels actually carry;
// anything else falls back to application/octet-stream.
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".heic": "image/heic",
};

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {};
for (const [ext, type] of Object.entries(CONTENT_TYPE_BY_EXTENSION)) {
  EXTENSION_BY_CONTENT_TYPE[type] ??= ext;
}

/** Directory inbound media is downloaded to. */
export function mediaDir(config: ResolvedConfig): string {
  return config.gateway.mediaDir ?? path.join(gatewayHome(), "media");
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function contentTypeFor(filename: string): string {
  return CONTENT_TYPE_BY_EXTENSION[path.extname(filename).toLowerCase()] ?? FALLBACK_CONTENT_TYPE;
}

function sanitizeName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return safe.slice(0, 80) || "media";
}

function pickExtension(segment: string, contentType: string | null): string {
  const dot = segment.lastIndexOf(".");
  if (dot > 0) {
    const ext = segment.slice(dot + 1);
    if (/^[A-Za-z0-9]{1,5}$/.test(ext)) return `.${ext.toLowerCase()}`;
  }
  if (contentType) {
    const known = EXTENSION_BY_CONTENT_TYPE[contentType.split(";", 1)[0].trim().toLowerCase()];
    if (known) return known;
  }
  return ".bin";
}

// Local filename for a downloaded URL: sanitized stem + short URL hash +
// extension. The hash (over the full URL, query included) keeps distinct
// URLs that share a basename from colliding, while re-downloads of the
// same URL reuse one file.
function downloadFilename(url: string, contentType: string | null): string {
  const pathname = url.split(/[?#]/, 1)[0];
  let segment = pathname.slice(pathname.lastIndexOf("/") + 1);
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // Keep the raw segment when percent-decoding fails.
  }
  const ext = pickExtension(segment, contentType);
  const stem = segment.toLowerCase().endsWith(ext)
    ? segment.slice(0, segment.length - ext.length)
    : segment;
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 8);
  return `${sanitizeName(stem)}-${hash}${ext}`;
}

// Query strings can carry signed access tokens, so logs only ever see the
// query-stripped URL.
function loggableUrl(url: string): string {
  return url.split(/[?#]/, 1)[0].slice(0, 120);
}

export interface DownloadMediaOptions {
  dir: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  logger: GatewayLogger;
}

/**
 * Download inbound media URLs to local files, best-effort. Failures and
 * oversized files are logged and skipped — a bad attachment never drops
 * the message it arrived with. Returns the local paths that saved.
 */
export async function downloadMedia(urls: string[], opts: DownloadMediaOptions): Promise<string[]> {
  const { dir, logger } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  const saved: string[] = [];
  if (urls.length === 0) return saved;
  await fsp.mkdir(dir, { recursive: true });
  for (const url of urls) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        logger.warn("media download failed", { url: loggableUrl(url), status: res.status });
        continue;
      }
      const declared = Number(res.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        logger.warn("media download skipped: over size cap", {
          url: loggableUrl(url),
          bytes: declared,
          maxBytes,
        });
        continue;
      }
      // Servers may omit or understate content-length; re-check real bytes.
      const content = Buffer.from(await res.arrayBuffer());
      if (content.byteLength > maxBytes) {
        logger.warn("media download skipped: over size cap", {
          url: loggableUrl(url),
          bytes: content.byteLength,
          maxBytes,
        });
        continue;
      }
      const target = path.join(dir, downloadFilename(url, res.headers.get("content-type")));
      await fsp.writeFile(target, content);
      saved.push(target);
    } catch (err) {
      logger.warn("media download failed", {
        url: loggableUrl(url),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return saved;
}

async function readFileWithCap(filePath: string, maxBytes: number, use: string): Promise<Buffer> {
  const { size } = await fsp.stat(filePath);
  if (size > maxBytes) {
    throw new Error(
      `Cannot ${use} ${filePath}: ${size} bytes exceeds the ${maxBytes}-byte limit. ` +
        "Compress or resize the file, or send a link instead.",
    );
  }
  return fsp.readFile(filePath);
}

// The slice of AgentIdentity outbound media needs; keeps this module
// testable with a plain stub.
export interface IMessageMediaUploader {
  uploadIMessageMedia(options: {
    content: Uint8Array;
    filename: string;
    contentType?: string;
  }): Promise<{ mediaUrl: string }>;
}

/**
 * Upload local files for an outbound SMS/iMessage send and return their
 * hosted media URLs, in input order. Oversized files throw with the
 * offending path so the agent can fix that file specifically.
 */
export async function uploadLocalMedia(
  identity: IMessageMediaUploader,
  paths: string[],
  opts: { maxBytes?: number } = {},
): Promise<string[]> {
  const maxBytes = opts.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  const urls: string[] = [];
  for (const p of paths) {
    const resolved = expandHome(p);
    const content = await readFileWithCap(resolved, maxBytes, "upload");
    const filename = path.basename(resolved);
    const { mediaUrl } = await identity.uploadIMessageMedia({
      content,
      filename,
      contentType: contentTypeFor(filename),
    });
    urls.push(mediaUrl);
  }
  return urls;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

/** Read a local file into the inline-base64 shape email sends expect. */
export async function fileToEmailAttachment(
  filePath: string,
  opts: { maxBytes?: number } = {},
): Promise<EmailAttachment> {
  const maxBytes = opts.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
  const resolved = expandHome(filePath);
  const content = await readFileWithCap(resolved, maxBytes, "attach");
  const filename = path.basename(resolved);
  return {
    filename,
    contentType: contentTypeFor(filename),
    contentBase64: content.toString("base64"),
  };
}
