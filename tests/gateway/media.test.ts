// Media helpers: inbound download naming/caps/failure-skip, outbound
// upload-to-URL, and email attachment packaging.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config.js";
import {
  downloadMedia,
  fileToEmailAttachment,
  mediaDir,
  uploadLocalMedia,
} from "../../src/gateway/media.js";
import { gatewayHome } from "../../src/gateway/state.js";
import type { GatewayLogger } from "../../src/gateway/types.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-media-"));
  tmpDirs.push(dir);
  return dir;
}

function makeLogger(): GatewayLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeConfig(gatewayOverrides?: Record<string, unknown>): ResolvedConfig {
  return { gateway: { ...gatewayOverrides } } as unknown as ResolvedConfig;
}

interface StubResponseInit {
  status?: number;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  cancel?: () => Promise<void>;
}

function stubResponse(init: StubResponseInit = {}): Response {
  const status = init.status ?? 200;
  const bytes =
    typeof init.body === "string"
      ? new TextEncoder().encode(init.body)
      : (init.body ?? new Uint8Array());
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
    body: init.cancel ? { cancel: init.cancel } : null,
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as Response;
}

function makeFetch(routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route();
  }) as unknown as typeof fetch;
}

describe("mediaDir", () => {
  it("returns the configured gateway media directory when set", () => {
    expect(mediaDir(makeConfig({ mediaDir: "/srv/inbox-media" }))).toBe("/srv/inbox-media");
  });

  it("falls back to <gateway home>/media when unconfigured", () => {
    expect(mediaDir(makeConfig())).toBe(path.join(gatewayHome(), "media"));
  });
});

describe("downloadMedia", () => {
  it("saves a URL to the dir, deriving the extension from the URL path and stripping the query", async () => {
    const dir = path.join(makeTmpDir(), "media");
    const url = "https://cdn.example.com/photos/cat.PNG?sig=secret-token";
    const fetchImpl = makeFetch({ [url]: () => stubResponse({ body: "png-bytes" }) });

    const saved = await downloadMedia([url], { dir, fetchImpl, logger: makeLogger() });

    expect(saved).toHaveLength(1);
    const name = path.basename(saved[0]);
    expect(path.dirname(saved[0])).toBe(dir);
    expect(name).toMatch(/^cat-[0-9a-f]{8}\.png$/);
    expect(name).not.toContain("sig");
    expect(fs.readFileSync(saved[0], "utf-8")).toBe("png-bytes");
  });

  it("derives the extension from the content-type when the URL path has none", async () => {
    const dir = makeTmpDir();
    const url = "https://cdn.example.com/media/abc123?x=1";
    const fetchImpl = makeFetch({
      [url]: () => stubResponse({ body: "jpeg", headers: { "content-type": "image/jpeg" } }),
    });

    const [saved] = await downloadMedia([url], { dir, fetchImpl, logger: makeLogger() });

    expect(path.basename(saved)).toMatch(/^abc123-[0-9a-f]{8}\.jpg$/);
  });

  it("falls back to .bin when neither the URL nor the content-type gives a type", async () => {
    const dir = makeTmpDir();
    const url = "https://cdn.example.com/blob/";
    const fetchImpl = makeFetch({ [url]: () => stubResponse({ body: "opaque" }) });

    const [saved] = await downloadMedia([url], { dir, fetchImpl, logger: makeLogger() });

    expect(path.basename(saved)).toMatch(/^media-[0-9a-f]{8}\.bin$/);
  });

  it("sanitizes unsafe filename characters", async () => {
    const dir = makeTmpDir();
    const url = "https://cdn.example.com/files/my%20report%20(final)!.pdf";
    const fetchImpl = makeFetch({ [url]: () => stubResponse({ body: "pdf" }) });

    const [saved] = await downloadMedia([url], { dir, fetchImpl, logger: makeLogger() });

    const name = path.basename(saved);
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name).toMatch(/^my-report-final-[0-9a-f]{8}\.pdf$/);
  });

  it("keeps distinct URLs with the same basename apart via the hash suffix", async () => {
    const dir = makeTmpDir();
    const urlA = "https://cdn.example.com/a/img.png";
    const urlB = "https://cdn.example.com/b/img.png";
    const fetchImpl = makeFetch({
      [urlA]: () => stubResponse({ body: "aaa" }),
      [urlB]: () => stubResponse({ body: "bbb" }),
    });

    const saved = await downloadMedia([urlA, urlB], { dir, fetchImpl, logger: makeLogger() });

    expect(saved).toHaveLength(2);
    expect(saved[0]).not.toBe(saved[1]);
    expect(fs.readFileSync(saved[0], "utf-8")).toBe("aaa");
    expect(fs.readFileSync(saved[1], "utf-8")).toBe("bbb");
  });

  it("skips and cancels a download whose content-length exceeds the cap", async () => {
    const dir = makeTmpDir();
    const logger = makeLogger();
    const cancel = vi.fn(async () => {});
    const big = "https://cdn.example.com/huge.mp4";
    const small = "https://cdn.example.com/ok.png";
    const fetchImpl = makeFetch({
      [big]: () => stubResponse({ body: "x", headers: { "content-length": "999" }, cancel }),
      [small]: () => stubResponse({ body: "ok" }),
    });

    const saved = await downloadMedia([big, small], { dir, fetchImpl, maxBytes: 100, logger });

    expect(saved).toHaveLength(1);
    expect(path.basename(saved[0])).toMatch(/^ok-[0-9a-f]{8}\.png$/);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "media download skipped: over size cap",
      expect.objectContaining({ bytes: 999, maxBytes: 100 }),
    );
  });

  it("skips a body that turns out larger than the cap when content-length is absent", async () => {
    const dir = makeTmpDir();
    const logger = makeLogger();
    const url = "https://cdn.example.com/sneaky.gif";
    const fetchImpl = makeFetch({
      [url]: () => stubResponse({ body: new Uint8Array(101) }),
    });

    const saved = await downloadMedia([url], { dir, fetchImpl, maxBytes: 100, logger });

    expect(saved).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("skips failed downloads without throwing and still returns the successes", async () => {
    const dir = makeTmpDir();
    const logger = makeLogger();
    const broken = "https://cdn.example.com/broken.png";
    const missing = "https://cdn.example.com/missing.png";
    const good = "https://cdn.example.com/good.png?token=abc";
    const fetchImpl = makeFetch({
      [broken]: () => Promise.reject(new Error("connection reset")),
      [missing]: () => stubResponse({ status: 404 }),
      [good]: () => stubResponse({ body: "good" }),
    });

    const saved = await downloadMedia([broken, missing, good], {
      dir,
      fetchImpl,
      logger,
    });

    expect(saved).toHaveLength(1);
    expect(path.basename(saved[0])).toMatch(/^good-[0-9a-f]{8}\.png$/);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    // Query strings can carry signed tokens; logs must not include them.
    for (const call of (logger.warn as ReturnType<typeof vi.fn>).mock.calls) {
      expect(JSON.stringify(call)).not.toContain("token=abc");
    }
  });
});

describe("uploadLocalMedia", () => {
  function makeIdentity() {
    let n = 0;
    return {
      uploadIMessageMedia: vi.fn(
        async (_options: { content: Uint8Array; filename: string; contentType?: string }) => ({
          mediaUrl: `https://media.example/u${++n}`,
        }),
      ),
    };
  }

  it("uploads each file with its inferred content type and returns hosted URLs in order", async () => {
    const dir = makeTmpDir();
    const png = path.join(dir, "photo.PNG");
    const blob = path.join(dir, "data.xyz");
    fs.writeFileSync(png, "png-data");
    fs.writeFileSync(blob, "raw-data");
    const identity = makeIdentity();

    const urls = await uploadLocalMedia(identity, [png, blob]);

    expect(urls).toEqual(["https://media.example/u1", "https://media.example/u2"]);
    expect(identity.uploadIMessageMedia).toHaveBeenNthCalledWith(1, {
      content: expect.any(Uint8Array),
      filename: "photo.PNG",
      contentType: "image/png",
    });
    expect(identity.uploadIMessageMedia).toHaveBeenNthCalledWith(2, {
      content: expect.any(Uint8Array),
      filename: "data.xyz",
      contentType: "application/octet-stream",
    });
    const [[firstArgs]] = identity.uploadIMessageMedia.mock.calls;
    expect(Buffer.from(firstArgs.content).toString("utf-8")).toBe("png-data");
  });

  it("throws an error naming the file when it exceeds the upload cap", async () => {
    const dir = makeTmpDir();
    const big = path.join(dir, "big.mp4");
    fs.writeFileSync(big, "12345");
    const identity = makeIdentity();

    await expect(uploadLocalMedia(identity, [big], { maxBytes: 4 })).rejects.toThrow(big);
    await expect(uploadLocalMedia(identity, [big], { maxBytes: 4 })).rejects.toThrow(
      /5 bytes exceeds the 4-byte limit/,
    );
    expect(identity.uploadIMessageMedia).not.toHaveBeenCalled();
  });

  it("returns an empty list for no paths without touching the uploader", async () => {
    const identity = makeIdentity();
    await expect(uploadLocalMedia(identity, [])).resolves.toEqual([]);
    expect(identity.uploadIMessageMedia).not.toHaveBeenCalled();
  });
});

describe("fileToEmailAttachment", () => {
  it("round-trips file bytes through base64 with the inferred content type", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "report.pdf");
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    fs.writeFileSync(file, bytes);

    const attachment = await fileToEmailAttachment(file);

    expect(attachment.filename).toBe("report.pdf");
    expect(attachment.contentType).toBe("application/pdf");
    expect(Buffer.from(attachment.contentBase64, "base64")).toEqual(bytes);
  });

  it("defaults unknown extensions to application/octet-stream", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "archive.tar");
    fs.writeFileSync(file, "tar");

    const attachment = await fileToEmailAttachment(file);

    expect(attachment.contentType).toBe("application/octet-stream");
  });

  it("throws an error naming the file when it exceeds the attachment cap", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "huge.txt");
    fs.writeFileSync(file, "123456");

    await expect(fileToEmailAttachment(file, { maxBytes: 5 })).rejects.toThrow(file);
  });
});
