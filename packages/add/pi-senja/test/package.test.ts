import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import manifest from "../package.json";
import theme from "../themes/senja.json";
import captured from "./palette.json";

const root = fileURLToPath(new URL("../", import.meta.url));
const themePath = join(root, "themes/senja.json");
const expectedRoles = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
  "thinkingText", "selectedBg", "scrollbarTrack", "scrollbarThumb", "searchMatchBg", "searchMatchText",
  "userMessageBg", "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel",
  "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl",
  "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
  "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction",
  "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
];

function findHost(): string | undefined {
  if (process.env.SENJA_PI_HOST) return process.env.SENJA_PI_HOST;
  const executable = Bun.which("pi");
  if (!executable) return undefined;
  let directory = dirname(realpathSync(executable));
  while (directory !== dirname(directory)) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      const candidate = JSON.parse(readFileSync(path, "utf8"));
      if (candidate.name === "@earendil-works/pi-coding-agent") return directory;
    }
    directory = dirname(directory);
  }
  return undefined;
}

const host = findHost();
const hostVersion = host ? JSON.parse(readFileSync(join(host, "package.json"), "utf8")).version as string : undefined;
const currentHost = host && Number(hostVersion?.split(".")[0]) >= 1 ? host : undefined;

function resolveVariable(variable: string): string {
  return theme.vars[variable as keyof typeof theme.vars];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const light = luminance(foreground);
  const dark = luminance(background);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

describe("package contract", () => {
  test("public package uses explicit source/theme resources and scoped repository", () => {
    expect(manifest.name).toBe("@arhen/pi-senja");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.type).toBe("module");
    expect(manifest.license).toBe("MIT");
    expect(manifest.pi).toEqual({ extensions: ["./src/index.ts"], themes: ["./themes/senja.json"] });
    expect(manifest.files).toEqual(["src", "themes", "README.md", "LICENSE"]);
    expect(manifest.repository.directory).toBe("packages/add/pi-senja");
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.scripts.typecheck).toBe("tsc -p tsconfig.json --noEmit");
    expect(manifest.scripts.test).toBe("bun test test");
    for (const path of [...manifest.pi.extensions, ...manifest.pi.themes, "README.md", "LICENSE"]) {
      expect(existsSync(join(root, path))).toBe(true);
    }
  });

  test("host packages are optional wildcard peers, never bundled runtime dependencies", () => {
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual([
      "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui",
    ]);
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      expect(range).toBe("*");
      expect(manifest.peerDependenciesMeta[name as keyof typeof manifest.peerDependenciesMeta].optional).toBe(true);
    }
    expect(manifest).not.toHaveProperty("dependencies");
    expect(manifest).not.toHaveProperty("bundledDependencies");
  });

  test("credits fork and palette authors; retains both complete MIT notices", () => {
    const license = readFileSync(join(root, "LICENSE"), "utf8");
    expect(license).toStartWith("MIT License\n\nCopyright (c) 2026 nocte\n");
    expect(license).toContain("Copyright (c) 2020 sainnhe");
    for (const clause of [
      "Permission is hereby granted, free of charge",
      "The above copyright notice and this permission notice shall be included",
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
      "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    ]) expect(license.split(clause)).toHaveLength(3);
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("https://github.com/nnocte/pi-haiku");
    expect(readme).toContain("**0.2.0**");
    expect(readme).toContain("**nocte**");
    expect(readme).toContain("https://github.com/sainnhe/gruvbox-material");
    expect(readme).toContain("**sainnhe**");
    expect(readme).toContain("/senja");
    expect(readme).not.toContain("screenshots/");
  });
});

describe("captured Gruvbox Material theme", () => {
  test("exact dark/medium/material palette variables, no synthetic colors", () => {
    const expected = Object.fromEntries(Object.entries(captured).filter(([key]) => key !== "none").map(([key, values]) => [key, values[0]!]));
    expect(theme.name).toBe("senja");
    expect(theme.appearance).toBe("dark");
    expect(Object.entries(theme.vars).sort()).toEqual(Object.entries(expected).sort());
    expect(theme.vars.bg0).toBe("#282828");
    expect(theme.vars.fg0).toBe("#d4be98");
    expect(theme.vars.orange).toBe("#e78a4e");
  });

  test("all 56 roles including all five optionals use palette references", () => {
    expect(expectedRoles).toHaveLength(56);
    expect(Object.keys(theme.colors).sort()).toEqual(expectedRoles.sort());
    for (const variable of [...Object.values(theme.colors), ...Object.values(theme.export)]) {
      expect(theme.vars).toHaveProperty(variable);
      expect(resolveVariable(variable)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(theme.colors.accent).toBe("orange");
    expect(theme.colors.text).toBe("fg0");
    expect(theme.colors.thinkingMax).toBe("purple");
    expect(theme.export).toEqual({ pageBg: "bg0", cardBg: "bg1", infoBg: "bg_dim" });
  });

  test("quiet tool panels and editor syntax stay within the Gruvbox palette", () => {
    expect(theme.colors.toolPendingBg).toBe("bg1");
    expect(theme.colors.toolSuccessBg).toBe("bg0");
    expect(theme.colors.toolErrorBg).toBe("bg_visual_red");
    expect(theme.colors.success).toBe("green");
    expect(luminance(resolveVariable(theme.colors.toolSuccessBg))).toBeLessThan(luminance(theme.vars.bg_visual_green));
    const roles = {
      toolTitle: "fg0", toolOutput: "fg0", syntaxComment: "grey2", syntaxKeyword: "purple",
      syntaxFunction: "blue", syntaxVariable: "fg0", syntaxString: "green", syntaxNumber: "purple",
      syntaxType: "yellow", syntaxOperator: "orange", syntaxPunctuation: "fg0",
    } as const;
    for (const [role, variable] of Object.entries(roles)) {
      expect(theme.colors[role as keyof typeof roles]).toBe(variable);
      for (const background of [theme.colors.toolPendingBg, theme.colors.toolSuccessBg]) {
        expect(contrast(resolveVariable(variable), resolveVariable(background))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("matches Ghostty Senja foreground, selection, search, and ANSI hues", () => {
    expect(resolveVariable(theme.colors.text)).toBe("#d4be98");
    expect(resolveVariable(theme.colors.selectedBg)).toBe("#45403d");
    expect(resolveVariable(theme.colors.searchMatchBg)).toBe("#a9b665");
    expect(resolveVariable(theme.colors.searchMatchText)).toBe("#282828");
    expect([theme.vars.bg5, theme.vars.red, theme.vars.green, theme.vars.yellow, theme.vars.blue, theme.vars.purple, theme.vars.aqua, theme.vars.fg0]).toEqual([
      "#5a524c", "#ea6962", "#a9b665", "#d8a657", "#7daea3", "#d3869b", "#89b482", "#d4be98",
    ]);
  });

  test.skipIf(!currentHost)(`real Pi ${hostVersion ?? "1.0+"} schema, validator, loader, and HTML export resolution`, async () => {
    const directory = join(currentHost!, "dist/modes/interactive/theme");
    const schema = JSON.parse(readFileSync(join(directory, "theme-schema.json"), "utf8"));
    expect(Object.keys(schema.properties.colors.properties).sort()).toEqual(Object.keys(theme.colors).sort());
    const api = await import(pathToFileURL(join(directory, "theme.js")).href);
    const validation = await import(pathToFileURL(join(directory, "theme-json.js")).href);
    api.setThemeJsonValidator(validation.validateThemeJson);
    expect(() => validation.validateThemeJson("senja", theme)).not.toThrow();
    const loaded = api.loadThemeFromPath(themePath, "truecolor");
    expect(loaded.name).toBe("senja");
    expect(loaded.appearance).toBe("dark");
    expect(loaded.fg("accent", "test")).toContain("\x1b[38;2;231;138;78m");
    expect(loaded.fg("thinkingMax", "max")).toContain("\x1b[38;2;211;134;155m");
    api.setRegisteredThemes([loaded]);
    expect(api.getThemeExportColors("senja")).toEqual({ pageBg: "#282828", cardBg: "#32302f", infoBg: "#1b1b1b" });
    const resolved = api.getResolvedThemeColors("senja");
    for (const [role, variable] of Object.entries(theme.colors)) expect(resolved[role]).toBe(resolveVariable(variable));
    api.setRegisteredThemes([]);
  });

  test.skipIf(!currentHost)("actual Pi highlighting in streaming write calls and expanded read results", async () => {
    const api = await import(pathToFileURL(join(currentHost!, "dist/modes/interactive/theme/theme.js")).href);
    const read = await import(pathToFileURL(join(currentHost!, "dist/core/tools/renderers/read.js")).href);
    const write = await import(pathToFileURL(join(currentHost!, "dist/core/tools/renderers/write.js")).href);
    const loaded = api.loadThemeFromPath(themePath, "truecolor");
    const previous = api.theme;
    api.setThemeInstance(loaded);
    try {
      const code = 'import clsx from "clsx";\n// Gruvbox tool preview\nfunction mapRows(rows: string[]) {\n  return "ready";\n}';
      const args = { path: "/project/preview.tsx", content: code };
      const context = { args, cwd: "/project", expanded: true, isPartial: true, argsComplete: false, isError: false, showImages: false };
      const components = [
        write.writeRenderers.renderCall(args, loaded, context),
        read.readRenderers.renderResult({ content: [{ type: "text", text: code }], details: {} }, { expanded: true, isPartial: false }, loaded, context),
      ];
      for (const component of components) {
        const rendered = component.render(120).join("\n");
        expect(rendered).toContain(loaded.fg("syntaxKeyword", "import"));
        expect(rendered).toContain(loaded.fg("syntaxString", '"clsx"'));
        expect(rendered).toContain(loaded.fg("syntaxFunction", "mapRows"));
        expect(rendered).toContain(loaded.fg("syntaxComment", "// Gruvbox tool preview"));
      }
    } finally {
      api.setThemeInstance(previous);
    }
  });
});
