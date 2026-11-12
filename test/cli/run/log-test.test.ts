import { spawnSync } from "bun";
import { describe, expect, it, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";

it("should not log .env when quiet", async () => {
  using dir = tempDir("log-test-silent", {
    ".env": "FOO=bar",
    "bunfig.toml": `logLevel = "error"`,
    "index.ts": "export default console.log('Here');",
  });
  const { stderr } = spawnSync({
    cmd: [bunExe(), "index.ts"],
    cwd: String(dir),
    env: bunEnv,
  });

  expect(stderr!.toString()).toBe("");
});

it("should log .env by default", async () => {
  using dir = tempDir("log-test-silent", {
    ".env": "FOO=bar",
    "bunfig.toml": ``,
    "index.ts": "export default console.log('Here');",
  });

  const { stderr } = spawnSync({
    cmd: [bunExe(), "index.ts"],
    cwd: String(dir),
    env: bunEnv,
  });

  expect(stderr?.toString().includes(".env")).toBe(false);
});

// `bun <file>` loads bunfig.toml while it reads the command line. `bun run <file>` and the other ways to run code below
// load it after that.
describe.concurrent("bunfig.toml logLevel", () => {
  const levels = ["not set", "debug", "warn", "error"] as const;
  type Level = (typeof levels)[number];
  type Form = [name: string, cmd: string[]];
  const logLevel = (level: Level) => (level === "not set" ? "" : `logLevel = "${level}"\n`);
  const each = (forms: Form[]) =>
    forms.flatMap(([name, cmd]) => levels.map((level): [string, Level, string[]] => [name, level, cmd]));
  const script = `console.log("ran");\n`;

  async function run(name: string, cmd: string[], files: Record<string, string>, env: Record<string, string> = {}) {
    using dir = tempDir("bunfig-log-level", { "m.js": script, "no-extension": script, ...files });
    await using proc = Bun.spawn({
      cmd: [bunExe(), ...cmd],
      argv0: name.startsWith("node ") ? "node" : undefined,
      env: {
        ...bunEnv,
        HOME: String(dir),
        XDG_CONFIG_HOME: undefined,
        BUNFIG_LOG_LEVEL_UNSET: undefined,
        BUN_CONFIG_VERBOSE_FETCH: undefined,
        ...env,
      },
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }
  const count = (stderr: string, prefix: string) => stderr.split("\n").filter(line => line.startsWith(prefix)).length;

  const early: Form = ["bun ./m.js", ["./m.js"]];
  const late: Form = ["bun run ./m.js", ["run", "./m.js"]];

  // `[macros]` takes package paths. For this key the bunfig loader adds one warning to the log of the command line.
  const badMacro = `[macros]\n"./not-a-package" = { "a" = "b" }\n`;
  // For a missing `extends` the resolver adds one debug message to the same log.
  const badTsconfig = { "tsconfig.json": `{ "extends": "./missing.json" }` };

  // A run prints this log after the entry point loads.
  describe("the warning and the debug message in the log", () => {
    const forms: Form[] = [
      early,
      late,
      ["bun ./no-extension", ["./no-extension"]],
      ["bun -e CODE arg", ["-e", script, "arg"]],
      ["node ./m.js", ["./m.js"]],
    ];

    for (const [name, level, cmd] of each(forms)) {
      test(`${name}, logLevel ${level}`, async () => {
        const files = { "bunfig.toml": logLevel(level) + badMacro, ...badTsconfig };
        const { stdout, stderr, exitCode } = await run(name, cmd, files);
        expect({ stdout, warn: count(stderr, "warn:"), debug: count(stderr, "debug:"), exitCode }).toEqual({
          stdout: "ran\n",
          warn: level === "error" ? 0 : 1,
          debug: level === "debug" ? 1 : 0,
          exitCode: 0,
        });
      });
    }

    for (const [name, cmd] of [early, late]) {
      test(`${name}, a file that sets a level and then fails to load sets no level`, async () => {
        const config = `logLevel = "error"\n` + badMacro + `[loader]\n".x" = "not-a-loader"\n`;
        const { stderr } = await run(name, cmd, { "bunfig.toml": config });
        expect({ warn: count(stderr, "warn:"), error: count(stderr, "error: Invalid loader") }).toEqual({
          warn: 1,
          error: 1,
        });
      });
    }
  });

  // At "debug" Bun prints how long it took to read each .env file. `bun repl` does not print the log above.
  describe("the line that names the .env file", () => {
    for (const [name, level, cmd] of each([early, late, ["bun repl -e", ["repl", "-e", script]]])) {
      test(`${name}, logLevel ${level}`, async () => {
        const { stdout, stderr, exitCode } = await run(name, cmd, {
          "bunfig.toml": logLevel(level),
          ".env": "FOO=bar\n",
        });
        expect({ stdout, namesEnvFile: stderr.includes(`] ".env"\n`), exitCode }).toEqual({
          stdout: "ran\n",
          namesEnvFile: level === "debug",
          exitCode: 0,
        });
      });
    }
  });

  // `Bun.build()` makes its own log. The entry point has one warning: it assigns to a private method.
  describe("a log that is made after the load", () => {
    const files = {
      "m.js": `const { logs } = await Bun.build({ entrypoints: ["./entry.js"], throw: false });\nconsole.log(logs.length);\n`,
      "entry.js": `class A {\n  #m() {}\n  f() {\n    this.#m = 1;\n  }\n}\n`,
    };

    for (const [name, cmd] of [early, late]) {
      test.each([
        ["not set", "1\n"],
        ["error", "0\n"],
      ] as const)(`${name}, logLevel %s`, async (level, logs) => {
        const { stdout, exitCode } = await run(name, cmd, { "bunfig.toml": logLevel(level), ...files });
        expect({ stdout, exitCode }).toEqual({ stdout: logs, exitCode: 0 });
      });
    }
  });

  // `fetch()` prints its headers for BUN_CONFIG_VERBOSE_FETCH or its `verbose` option, and not for a log level.
  describe("the headers of a fetch()", () => {
    const files = {
      "m.js": `using server = Bun.serve({ port: 0, fetch: () => new Response("ok") });\nconst response = await fetch(server.url, { headers: { "x-probe": "1" } });\nconsole.log(await response.text());\n`,
    };

    for (const [name, cmd] of [early, late]) {
      test.each([
        [{}, 0],
        [{ BUN_CONFIG_VERBOSE_FETCH: "true" }, 1],
      ] as const)(`${name}, logLevel debug, env %j`, async (env, headerLines) => {
        const { stdout, stderr, exitCode } = await run(name, cmd, { "bunfig.toml": logLevel("debug"), ...files }, env);
        expect({
          stdout,
          headerLines: stderr.split("\n").filter(line => line.includes("x-probe: 1")).length,
          exitCode,
        }).toEqual({
          stdout: "ok\n",
          headerLines,
          exitCode: 0,
        });
      });
    }
  });

  // The type checker reads a repeated key of a package.json as TypeScript does: the last value counts.
  describe("the type checker", () => {
    const compilerOptions = {
      strict: true,
      noEmit: true,
      module: "esnext",
      moduleResolution: "bundler",
      lib: ["es5"],
      types: [],
    };
    const files = {
      "tsconfig.json": JSON.stringify({ compilerOptions }),
      "console.d.ts": `declare var console: { log(...args: unknown[]): void };\n`,
      "m.ts": `import { value } from "dep";\nconst n: number = value;\nconsole.log("ran", n);\n`,
      "node_modules/dep/package.json": `{ "name": "dep", "exports": { ".": { "types": "./string.d.ts", "types": "./number.d.ts", "default": "./index.js" } } }`,
      "node_modules/dep/string.d.ts": `export const value: string;\n`,
      "node_modules/dep/number.d.ts": `export const value: number;\n`,
      "node_modules/dep/index.js": `exports.value = 1;\n`,
    };
    const forms: Form[] = [
      ["bun --check ./m.ts", ["--check", "./m.ts"]],
      ["bun run --check ./m.ts", ["run", "--check", "./m.ts"]],
    ];

    for (const [name, cmd] of forms) {
      test.each(["not set", "error"] as const)(`${name}, logLevel %s`, async level => {
        const { stdout, exitCode } = await run(name, cmd, { "bunfig.toml": logLevel(level), ...files });
        expect({ stdout, exitCode }).toEqual({ stdout: "ran 1\n", exitCode: 0 });
      });
    }
  });

  // The package manager takes its level from --silent, --quiet and --verbose.
  describe("bun install", () => {
    const install = (flags: string[], config: string) =>
      run("bun install", ["install", ...flags], { "bunfig.toml": config, "package.json": `{ "name": "a" }` });

    test.each([`logLevel = "error"\n`, `[install]\nlogLevel = "error"\n`])("does not take %j", async config => {
      const { stderr, exitCode } = await install([], config + badMacro);
      expect({ warn: count(stderr, "warn:"), exitCode }).toEqual({ warn: 1, exitCode: 0 });
    });

    // Bun warns about the unset variable before it applies --silent to the log of the command line.
    const unsetToken = `logLevel = "debug"\n[install]\nregistry = { url = "http://localhost/", token = "$BUNFIG_LOG_LEVEL_UNSET" }\n`;

    test("warns about an unset variable in the registry token", async () => {
      const { stderr, exitCode } = await install([], unsetToken);
      expect({ warn: count(stderr, "warn:"), exitCode }).toEqual({ warn: 1, exitCode: 0 });
      expect(stderr).toContain("references unset variable");
    });

    test(`--silent prints nothing with logLevel = "debug"`, async () => {
      expect(await install(["--silent"], unsetToken)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    });
  });

  // Both count the warning for a repeated JSON key to decide how to read a config file, so they need to keep it.
  describe.each(["", `logLevel = "error"\n`])("bunfig.toml %j", config => {
    test("bun lint gives a rule the last value of a repeated key", async () => {
      const { stdout, exitCode } = await run("bun lint", ["lint", "-f", "json", "a.test.js"], {
        "bunfig.toml": config,
        ".oxlintrc.json": `{ "plugins": ["jest"], "categories": { "correctness": "off" }, "rules": { "jest/no-restricted-matchers": ["error", { "toBe": "first", "toBe": "last" }] } }`,
        "a.test.js": `test("t", () => {\n  expect(a).toBe(1);\n});\n`,
      });
      expect({ help: JSON.parse(stdout).diagnostics.map((it: { help: string }) => it.help), exitCode }).toEqual({
        help: ["last"],
        exitCode: 1,
      });
    });

    test("bun fmt warns once about a repeated unknown option", async () => {
      const { stderr, exitCode } = await run("bun fmt", ["fmt", "--check", "a.js"], {
        "bunfig.toml": config,
        ".prettierrc.json": `{ "foo": 1, "foo": 2 }`,
        "a.js": `export const a = 1;\n`,
      });
      expect({ warnings: stderr.split("\n").filter(line => line.startsWith("warn:")), exitCode }).toEqual({
        warnings: ["warn: Ignored unknown option { foo: 2 }."],
        exitCode: 0,
      });
    });
  });
});
