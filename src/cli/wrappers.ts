import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "jsonc-parser";

export function hostMajor(bin = "opencode"): 1 | 2 | undefined {
  try {
    const match = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 }).match(
      /(?:^|\s)v?([12])\./,
    );
    return match ? (Number(match[1]) as 1 | 2) : undefined;
  } catch {
    return undefined;
  }
}

export function wrapperSource(major: 1 | 2): string {
  if (major === 1)
    return 'import InkboxPlugin from "@inkbox/opencode-plugin";\n\nexport default async (input: any) => InkboxPlugin(input, {\n  tools: { enable: ["inkbox_place_call"] },\n});\n';
  return 'import InkboxPlugin from "@inkbox/opencode-plugin/v2";\n\nexport default {\n  ...InkboxPlugin,\n  setup: (ctx: Parameters<typeof InkboxPlugin.setup>[0]) => InkboxPlugin.setup({\n    ...ctx,\n    options: { ...ctx.options, tools: { enable: ["inkbox_place_call"] } },\n  }),\n};\n';
}

function normalized(source: string): string {
  const header = [
    "// Inkbox plugin wrapper — written by install.sh; edit freely (never overwritten).",
    "// Credentials resolve from env vars or ~/.inkbox/config; options: see README.",
    "// inkbox_place_call is enabled so the agent can dial out (calls stay gated",
    "// by outbound approval like every other send).",
    "",
  ].join("\n");
  const text = source.replace(/\r\n/g, "\n").trim();
  return text.startsWith(header) ? text.slice(header.length).trim() : text;
}

export function installWrapper(
  file: string,
  major: 1 | 2,
): "created" | "updated" | "unchanged" | "custom" {
  const source = wrapperSource(major);
  if (!existsSync(file)) {
    writeFileSync(file, source);
    return "created";
  }
  const existing = readFileSync(file, "utf8");
  if (normalized(existing) === normalized(source)) return "unchanged";
  if (
    ![1, 2].some((version) => normalized(existing) === normalized(wrapperSource(version as 1 | 2)))
  )
    return "custom";
  writeFileSync(`${file}.backup-${randomUUID()}`, existing, { flag: "wx", mode: 0o600 });
  writeFileSync(file, source);
  return "updated";
}

export function incompatibleWrappers(roots: string[], major: 1 | 2): string[] {
  const dirs = new Set<string>([
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode"),
  ]);
  for (const root of roots) {
    let dir = resolve(root);
    for (;;) {
      dirs.add(join(dir, ".opencode"));
      if (dirname(dir) === dir) break;
      dir = dirname(dir);
    }
  }
  const found = new Set<string>();
  for (const dir of dirs)
    for (const sub of ["plugin", "plugins"]) {
      const parent = join(dir, sub);
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.[jt]s$/.test(entry.name)) continue;
        const file = join(parent, entry.name);
        const text = readFileSync(file, "utf8");
        if (!text.includes("@inkbox/opencode-plugin")) continue;
        if (
          (major === 2 && !text.includes("@inkbox/opencode-plugin/v2")) ||
          (major === 1 && text.includes("@inkbox/opencode-plugin/v2"))
        )
          found.add(file);
      }
    }
  return [...found];
}

export function configuredPackages(directory: string): string[] {
  const files = ["opencode.json", "opencode.jsonc"].map((name) => join(directory, name));
  return files.filter((file) => {
    if (!existsSync(file)) return false;
    const config = parse(readFileSync(file, "utf8"));
    return [config?.plugin, config?.plugins].some(
      (entries) =>
        Array.isArray(entries) &&
        entries.some((entry) => {
          const target =
            typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : entry?.package;
          return typeof target === "string" && /^@inkbox\/opencode-plugin(?:$|[@/])/.test(target);
        }),
    );
  });
}
