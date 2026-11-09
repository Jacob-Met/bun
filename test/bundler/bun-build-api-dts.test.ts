import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { tempDir } from "harness";
import { join } from "path";

const project = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "esnext", types: [] },
  }),
  "src/index.ts": `import { join } from "./join";
export interface Options {
  name: string;
  times: number;
}
export function greet(options: Options): string {
  return join("hello", options.name).repeat(options.times);
}
export { join };
`,
  "src/join.ts": `export function join(first: string, second: string): string {
  return first + " " + second;
}
`,
};

const WRITTEN = ["index.aot.ts", "index.d.ts", "index.js", "join.d.ts"];
const filesIn = (folder: string) => readdirSync(folder, { recursive: true }).map(String).sort();
const described = (root: string, outputs: Bun.BuildArtifact[]) =>
  outputs
    .map(({ path, kind, loader }) => [path.replace(root, "").replaceAll("\\", "/").replace(/^\.\//, ""), kind, loader])
    .sort();
// The typed file of `src/index.ts`, from a build that has nothing to say.
async function typed(files: Record<string, string>, options: Partial<Bun.BuildConfig> = {}) {
  using dir = tempDir("build-api-dts-typed", { "tsconfig.json": project["tsconfig.json"], ...files });
  const root = String(dir);
  const built = await Bun.build({
    entrypoints: [join(root, "src/index.ts")],
    outdir: join(root, "out"),
    tsconfig: join(root, "tsconfig.json"),
    dts: true,
    ...options,
  });
  expect(built.logs).toEqual([]);
  return readFileSync(join(root, "out/index.aot.ts"), "utf8");
}

describe("Bun.build({ dts: true })", () => {
  test("writes the bundle, its declaration files and the bundle with its types kept to outdir", async () => {
    using dir = tempDir("build-api-dts", project);
    const root = String(dir);
    const built = await Bun.build({
      entrypoints: [join(root, "src/index.ts")],
      outdir: join(root, "out"),
      tsconfig: join(root, "tsconfig.json"),
      dts: true,
    });
    expect(built.logs).toEqual([]);
    expect(filesIn(join(root, "out"))).toEqual(WRITTEN);
    expect(described(root, built.outputs)).toEqual([
      ["/out/index.aot.ts", "asset", "ts"],
      ["/out/index.d.ts", "asset", "ts"],
      ["/out/index.js", "entry-point", "ts"],
      ["/out/join.d.ts", "asset", "ts"],
    ]);
    for (const output of built.outputs) expect(await output.text()).toBe(readFileSync(output.path, "utf8"));
    const read = (name: string) => readFileSync(join(root, "out", name), "utf8");
    expect(read("index.d.ts")).toBe(`import { join } from "./join.js";
export interface Options {
    name: string;
    times: number;
}
export declare function greet(options: Options): string;
export { join };
`);
    expect(read("index.aot.ts")).toContain("function greet(options: Options): string {");
    expect(read("index.aot.ts")).toContain("function join(first: string, second: string): string {");
    expect(read("index.js")).toContain("function greet(options) {");
    expect(read("index.js")).not.toContain("debugId");
    const plain = await Bun.build({ entrypoints: [join(root, "src/index.ts")], tsconfig: join(root, "tsconfig.json") });
    expect(read("index.js")).toBe(await plain.outputs[0].text());
  });

  test("without outdir, the files are in outputs and nothing is written", async () => {
    using dir = tempDir("build-api-dts-memory", project);
    const root = String(dir);
    const before = filesIn(root);
    const built = await Bun.build({
      entrypoints: [join(root, "src/index.ts")],
      tsconfig: join(root, "tsconfig.json"),
      dts: true,
    });
    expect(built.logs).toEqual([]);
    expect(described(root, built.outputs)).toEqual([
      ["index.aot.ts", "asset", "ts"],
      ["index.d.ts", "asset", "ts"],
      ["index.js", "entry-point", "ts"],
      ["join.d.ts", "asset", "ts"],
    ]);
    const typed = built.outputs.find(output => output.path.endsWith("index.aot.ts"))!;
    expect(await typed.text()).toContain("function greet(options: Options): string {");
    expect(filesIn(root)).toEqual(before);
  });

  test("a source map that was asked for is kept", async () => {
    using dir = tempDir("build-api-dts-sourcemap", project);
    const root = String(dir);
    const built = await Bun.build({
      entrypoints: [join(root, "src/index.ts")],
      outdir: join(root, "out"),
      tsconfig: join(root, "tsconfig.json"),
      sourcemap: "external",
      dts: true,
    });
    expect(built.logs).toEqual([]);
    expect(filesIn(join(root, "out"))).toEqual([...WRITTEN, "index.js.map"].sort());
  });

  test("a type error fails the build", async () => {
    using dir = tempDir("build-api-dts-error", {
      ...project,
      "src/join.ts": project["src/join.ts"].replace("): string", "): number"),
    });
    const root = String(dir);
    const built = await Bun.build({
      entrypoints: [join(root, "src/index.ts")],
      outdir: join(root, "out"),
      tsconfig: join(root, "tsconfig.json"),
      dts: true,
      throw: false,
    });
    expect(built.success).toBe(false);
    expect(built.logs.map(log => log.message).join("\n")).toContain("TS2322");
    expect(filesIn(root)).not.toContain("out");
  });

  test("minify: the declaration files, and a warning about the rest", async () => {
    using dir = tempDir("build-api-dts-minify", project);
    const root = String(dir);
    const built = await Bun.build({
      entrypoints: [join(root, "src/index.ts")],
      outdir: join(root, "out"),
      tsconfig: join(root, "tsconfig.json"),
      minify: true,
      dts: true,
    });
    expect(built.logs.map(log => [log.level, log.message])).toEqual([
      [
        "warn",
        "the .aot.ts files that --aot compiles a package from are left out: they do not support minify.identifiers yet",
      ],
    ]);
    expect(filesIn(join(root, "out"))).toEqual(["index.d.ts", "index.js", "join.d.ts"]);
  });

  test("minify.syntax and minify.whitespace: every file", async () => {
    using dir = tempDir("build-api-dts-minify-syntax", project);
    const root = String(dir);
    const built = await Bun.build({
      entrypoints: [join(root, "src/index.ts")],
      outdir: join(root, "out"),
      tsconfig: join(root, "tsconfig.json"),
      minify: { syntax: true, whitespace: true },
      dts: true,
    });
    expect(built.logs).toEqual([]);
    expect(filesIn(join(root, "out"))).toContain("index.aot.ts");
  });

  // The bundle has `0` for `Unit.Px`, and the typed file has `0 as Unit.Px`. That does not widen to `Unit` as `Unit.Px`
  // does, so a place without an annotation takes `: Unit`. Under an `as`, the place has the type of the `as`.
  describe.each([
    ["", {}],
    [", with minify.syntax", { minify: { syntax: true } }],
  ])("an enum member under a cast%s", (_, options) => {
    const enums = `export enum Unit {
  Px,
  Em,
}
export enum Color {
  Red = "red",
}
`;
    const variableAndValues = `let current = Color.Red as string;
export function paint(color: string): string {
  current = color;
  return current;
}
export function inObject() {
  return { unit: Unit.Px as const };
}
export function returned() {
  return Unit.Em as const;
}
const px: Unit.Px = inObject().unit;
const em: Unit.Em = returned();
console.log(paint("blue"), px, em);
`;
    const parametersAndProperty = `export function useIt(first = 1, unit = Unit.Px as Unit | null) {
  unit = null;
  return [first, unit];
}
export function only(unit = Unit.Px as Unit | null) {
  return unit;
}
export class Box {
  unit = Unit.Px as Unit | undefined;
  clear(): void {
    this.unit = undefined;
  }
}
export function constant(unit = Unit.Em as const): Unit.Em {
  return unit;
}
export function widened(unit = Unit.Px, other = Unit.Px satisfies Unit, third = Unit.Px!) {
  unit = Unit.Em;
  other = Unit.Em;
  third = Unit.Em;
  return [unit, other, third];
}
console.log(useIt(), useIt(1, null), useIt(1, Unit.Em), only(null), new Box().unit, constant(), widened());
`;
    const fromAnotherFile = `import { Color, Unit } from "./enums";\n`;
    // The name of an enum can have a number behind it, and each value has the name of its member in a comment.
    const typedFile = async (files: Record<string, string>) =>
      (await typed(files, { target: "bun", ...options }))
        .replace(/\b(Unit|Color)\d+/g, "$1")
        .replace(/ \/\* \w+ \*\//g, "");
    const expectVariableAndValues = (text: string) => {
      expect(text).toContain(`current = "red" as Color.Red as string;`);
      // `0 as Unit.Px` is what `Unit.Px as const` is.
      expect(text).toContain("return { unit: 0 as Unit.Px };");
      expect(text).toContain("return 1 as Unit.Em;");
    };
    const expectParametersAndProperty = (text: string) => {
      expect(text).toContain("function useIt(first = 1, unit = 0 as Unit.Px as Unit | null) {");
      expect(text).toContain("function only(unit = 0 as Unit.Px as Unit | null) {");
      expect(text).toContain("  unit = 0 as Unit.Px as Unit | undefined;");
      expect(text).toContain("function constant(unit: Unit.Em = 1 as Unit.Em): Unit.Em {");
      expect(text).toContain(
        "function widened(unit: Unit = 0 as Unit.Px, other: Unit = 0 as Unit.Px satisfies Unit, third: Unit = (0 as Unit.Px)!) {",
      );
    };

    test("in each place, with the enum in the same file", async () => {
      const text = await typedFile({ "src/index.ts": enums + variableAndValues + parametersAndProperty });
      expectVariableAndValues(text);
      expectParametersAndProperty(text);
    });

    test("in a variable, an object and a return, with the enum in another file", async () => {
      expectVariableAndValues(
        await typedFile({ "src/enums.ts": enums, "src/index.ts": fromAnotherFile + variableAndValues }),
      );
    });

    // Observed: `function useIt(first = 1, unit = 0) {`, and TS2322 for `unit = null`. The bundle has the value of a
    // member of another file with no source mapping, so the default of a parameter or a property has no place for a cast.
    test.todo("in a parameter and a class property, with the enum in another file", async () => {
      expectParametersAndProperty(
        await typedFile({ "src/enums.ts": enums, "src/index.ts": fromAnotherFile + parametersAndProperty }),
      );
    });
  });

  // A constant that only a type names is not in the bundle. The typed file declares it with what the type checker says.
  test("a constant that only a type names is declared with a type that names nothing", async () => {
    const text = await typed({
      "src/flag.ts": `type Flag = true | false;
declare const stored: Flag;
export const on = stored;
`,
      "src/index.ts": `import { on } from "./flag";
type Flag = "yes" | "no";
const big = 1e999;
const small = -1e999;
const word = "a";
export type On = typeof on;
export type Sizes = [typeof big, typeof small, typeof word];
export function pick(flag: Flag): On {
  return flag === "yes";
}
export function sizes(): Sizes {
  return [1e999, -1e999, "a"];
}
`,
    });
    // `Flag` of the other file is `boolean`, and no type is `Infinity`.
    expect(text.match(/^declare const .*$/gm)?.sort()).toEqual([
      "declare const big: number;",
      "declare const on: boolean;",
      "declare const small: number;",
      `declare const word: "a";`,
    ]);
  });

  test("two builds at once keep their files apart", async () => {
    using dir = tempDir("build-api-dts-twice", {
      ...Object.fromEntries(Object.entries(project).map(([path, text]) => ["a/" + path, text])),
      "b/tsconfig.json": project["tsconfig.json"],
      "b/src/index.ts": `export const other: number = 1;\n`,
    });
    const root = String(dir);
    const build = (name: string) =>
      Bun.build({
        entrypoints: [join(root, name, "src/index.ts")],
        outdir: join(root, name, "out"),
        tsconfig: join(root, name, "tsconfig.json"),
        dts: true,
      });
    const [a, b] = await Promise.all([build("a"), build("b")]);
    expect([a.logs, b.logs]).toEqual([[], []]);
    expect(filesIn(join(root, "a/out"))).toEqual(WRITTEN);
    expect(filesIn(join(root, "b/out"))).toEqual(WRITTEN.filter(path => path !== "join.d.ts"));
    expect(readFileSync(join(root, "b/out/index.d.ts"), "utf8")).toBe("export declare const other: number;\n");
  });

  test("cannot be used with compile", () => {
    expect(() => Bun.build({ entrypoints: ["./index.ts"], compile: true, dts: true })).toThrow(
      "dts cannot be used with compile",
    );
  });
});

// The React Compiler prints `function useStep(step = 1) {` as `function useStep(t0) { let step = t0 === undefined ? 1 : t0;`.
describe("Bun.build({ dts: true, reactCompiler: true }): a parameter whose default value is in the function body", () => {
  const state = `export function useState<T>(initial: T): [T, (next: T) => void] {
  return [initial, () => {}];
}
export function useEffect(effect: () => void, dependencies: unknown[]): void {}
`;
  const hooks = `import { useState } from "./state";
export enum Unit {
  Px,
  Em,
}
export enum Color {
  Red = "red",
}
export function useBoth(first: number = 1, second: number = 2): number {
  const [value] = useState(first);
  return value + second;
}
export function useStep(step = 2): number {
  const [value] = useState(step);
  return value;
}
export function useRange(first: number = 1, start: number = 0, end: number): number {
  const [value] = useState(first);
  return value + start + end;
}
export function useFormat(first: number = 1, format: (value: number) => string = String, value: number): string {
  const [text] = useState(format(value + first));
  return text;
}
export function useName(first: number = 1, { name }: { name: string } = { name: "x" }, suffix: string = "!"): string {
  const [value] = useState(name);
  return value + suffix + first;
}
export function usePoint(first: number = 1, point: [number, number] = [0, 0]): [number, number] {
  const [value] = useState(point);
  return [value[0] + first, value[1]];
}
export function useUnit(first: number = 1, unit = Unit.Px): string {
  const [value] = useState(first);
  return value + Unit[unit];
}
export function usePadded(first: number = 1, unit = Unit.Em, pad = 2, text: string): string {
  const [value] = useState(text);
  return value.padStart(pad + first) + Unit[unit];
}
interface Options {
  label: string;
}
export function useCast(
  first = 1,
  unit = Unit.Px as Unit | null,
  color = Color.Red as string,
  last = Unit.Em!,
  exact = Unit.Px as const,
  known = (Unit.Em as Unit | null)!,
  options = { label: "x" } as Options,
): string {
  const [value] = useState(first);
  return value + String(unit) + color + Unit[last] + Unit[exact] + Unit[known] + options.label;
}
export function useParse(first = 1, parse = Number as (text: string) => number, text: string): number {
  const [value] = useState(first);
  return value + parse(text);
}
export function useTyped(first = 1, second = 2 as typeof first): string {
  const [value] = useState(first);
  return value + second.toFixed(1);
}
function same<T>(value: T): T {
  return value;
}
export function useQueried(first = 1, maybe: string | undefined = undefined, pick: typeof same = same): string {
  const [value] = useState(maybe);
  const kept: typeof maybe = value;
  const picked: typeof pick<number> = pick;
  return String(kept) + picked(first);
}
export function useSpelled(t0 = 1, t1: number = 2): number {
  const [value] = useState(t0);
  const list: Array<typeof t1> = [value];
  return list[0] + t1;
}
type Theme = "light" | "dark";
const config: { theme: string } = { theme: "light" };
function paint(theme: Theme): string {
  return theme;
}
export function useTheme(first = 1, theme = config.theme as Theme): string {
  const [value] = useState(first);
  return value + paint(theme);
}
type Flag = true | false;
function stored(): Flag {
  return true;
}
export function useNoted(first = 1, flag = stored()): number {
  const [value] = useState(first);
  return flag ? value : 0;
}
export function useCell(first = 1, unit = Unit.Px as Unit | null): string {
  const [value] = useState(first);
  if (unit === null) return value + "none";
  switch (unit) {
    case Unit.Px:
      return value + "px";
    case Unit.Em:
      return value + "em";
  }
}
export function useNested(base: number): number {
  const [value] = useState(base);
  const add = (first: number = 0, right: number = 1): number => first + right;
  return add(value);
}
function pad(value: string): string;
function pad(value: number): number;
function pad(value: any): any {
  return value;
}
type Step = (base: number, scale?: number, by?: number, unit?: Unit | null) => number;
export function useStepper(n: number): Step {
  const [value] = useState(n);
  const step: Step = (base, scale = 1, by = value, unit = Unit.Px as Unit) => {
    const next: number = pad(by);
    return base * scale + next + (unit ?? 0);
  };
  return step;
}
export function useLabel(label: string, size?: number): string {
  const [value] = useState(label);
  return value + (size ?? 0);
}
export function plain(first: number = 1, second: number = 2): number {
  return first + second;
}
`;
  // What the sources accept. With these in the bundle, a typed file that asks for more is left out with a warning.
  const calls = `console.log(useBoth(), useBoth(5), useStep(), useRange(undefined, undefined, 5), useFormat(undefined, undefined, 1));
console.log(useName(), usePoint(), useUnit(), usePadded(undefined, undefined, undefined, "a"), useNested(1));
console.log(useStepper(2)(1), useStepper(2)(1, 2, 3), useLabel("a"), plain(), useCast(), useCast(1, null, "blue"));
console.log(useCell(), useCell(1, null), useCell(1, Unit.Em), useParse(undefined, undefined, "1"), useTyped());
console.log(useQueried(), useQueried(1, "a", same), useSpelled(), useTheme(), useTheme(1, "dark"));
console.log(useNoted(), useNoted(1, false));
`;
  // The parameters of each function. The check of the typed files writes `: any` behind a parameter that has no type.
  const parametersIn = (typed: string) =>
    Object.fromEntries(
      Array.from(typed.matchAll(/^function (\w+)(?:<[^>]*>)?\((.*)\)(?:: [^{\n]+)? \{$/gm), ([, name, list]) => [
        name,
        list.replaceAll("?: any", "?"),
      ]),
    );
  const build = (root: string, options: Partial<Bun.BuildConfig> = {}) =>
    Bun.build({
      entrypoints: [join(root, "src/index.tsx")],
      outdir: join(root, "out"),
      tsconfig: join(root, "tsconfig.json"),
      target: "bun",
      reactCompiler: true,
      dts: true,
      ...options,
    });
  const typedHooks = async (index: string, options: Partial<Bun.BuildConfig> = {}) => {
    using dir = tempDir("build-api-dts-moved-default", {
      "tsconfig.json": project["tsconfig.json"],
      "src/state.ts": state,
      "src/index.tsx": index,
    });
    const built = await build(String(dir), options);
    expect(built.logs).toEqual([]);
    return readFileSync(join(String(dir), "out/index.aot.ts"), "utf8");
  };

  const parameters = {
    useState: "initial: T",
    _temp: "t0?: number, t1?: number",
    useBoth: "t0?: number, t1?: number",
    // The type checker says what `step = 2` is.
    useStep: "t0?: number",
    // A `?` before a parameter that has to be passed is an error.
    useRange: "t0: number | undefined, t1: number | undefined, end: number",
    useFormat: "t0: number | undefined, t1: ((value: number) => string) | undefined, value: number",
    // The annotation of a pattern is where the pattern is.
    useName: "t0?: number, t1?, t2?: string",
    usePoint: "t0?: number, t1?: [number, number]",
    // `Unit.Px` is `0` in the bundle, and the parameter has the type of the enum.
    useUnit: expect.stringMatching(/^t0\?: number, t1\?: Unit\d*$/),
    usePadded: expect.stringMatching(
      /^t0: number \| undefined, t1: Unit\d* \| undefined, t2: number \| undefined, text: string$/,
    ),
    // An `as` on the default value is the type of the parameter. Under `!` it has the enum, under `as const` the member.
    // `(T) & {}` is `T` without `null` and `undefined`, as `(x as T)!` is.
    useCast: expect.stringMatching(
      /^t0\?: number, t1\?: Unit\d* \| null, t2\?: string, t3\?: Unit\d*, t4\?: Unit\d*\.Px, t5\?: \(Unit\d* \| null\) & \{\}, t6\?: Options$/,
    ),
    useParse: "t0: number | undefined, t1: ((text: string) => number) | undefined, text: string",
    // `typeof first` names a variable of the function body, which a parameter list does not have. The type checker
    // says what `second` is.
    useTyped: "t0?: number, t1?: number",
    useQueried: "t0?: number, t1?: string | undefined, t2?: typeof same",
    useSpelled: "t0?: number, t1?: number",
    // The bundle has `config.theme` with no cast, so the parameter takes no type from the cast.
    useTheme: "t0?: number, t1?",
    paint: "theme: Theme",
    // The type checker says `Flag` for it, which is a name that another type of the bundle can have too.
    useNoted: "t0?: number, t1?: boolean",
    stored: "",
    same: "value: T",
    // Its `switch` has a `case` for each value only if `unit` has its type.
    useCell: expect.stringMatching(/^t0\?: number, t1\?: Unit\d* \| null$/),
    useNested: "base: number",
    pad: "value: any",
    useStepper: "n: number",
    useLabel: "label: string, size?: number",
    // What the compiler leaves as it is written keeps its default values.
    plain: "first: number = 1, second: number = 2",
  };

  test.each([
    ["a call in the bundle that leaves it out", calls],
    ["no call in the bundle", ""],
  ])("can be left out, and keeps its type: %s", async (_, calls) => {
    const typed = await typedHooks(hooks + calls);
    expect(parametersIn(typed)).toEqual(parameters);
    // The default value has its type from the annotation.
    expect(typed).toContain("let point: [number, number] = t1 === undefined ? [");
    // Without an annotation, a callback takes the type of its parameter from where it is passed to. An `as` on the
    // default value does not change that.
    expect(typed).toMatch(/let step: Step = \(base, t0\?, t1\?, t2\?\) => \{/);
    // In the function body, the variable that holds the default value is what `typeof` names.
    expect(typed).toContain("2 as typeof first");
    expect(typed).toContain("kept: typeof maybe = value");
    expect(typed).toContain("picked: typeof pick<number> = pick");
    // The compiler gives a parameter that the source names `t1` another name in the function body.
    expect(typed).toContain("list: Array<typeof t1$0> = [");
  });

  // The variable that holds the default value takes the annotation of the parameter, but not in these two cases.
  // `label` is a `string` where a function reads it later, and its annotation says more. The bundle has `config.theme`
  // without its cast, which is a `string` and no `Theme`.
  const unlike = `import { useState } from "./state";
type Theme = "light" | "dark";
const config: { theme: string } = { theme: "light" };
export function useLabelled(first = 1, label: string | undefined = "x"): () => number {
  const [value] = useState(first);
  const size = () => label.length + value;
  label = "y";
  return size;
}
export function useDressed(first = 1, theme: Theme = config.theme as Theme): string {
  const [value] = useState(first);
  return value + String(theme);
}
console.log(useLabelled()(), useDressed());
`;
  test("is stored to a variable without an annotation that is not the type of the variable", async () => {
    const typed = await typedHooks(unlike);
    expect(parametersIn(typed)).toEqual({
      useState: "initial: T",
      useLabelled: "t0?: number, t1?: string | undefined",
      useDressed: "t0?: number, t1?: Theme",
    });
    expect(typed).toContain(`let label = t1 === undefined ? "x" : t1;`);
    expect(typed).toContain("let theme = t1 === undefined ? config.theme : t1;");
  });

  // Observed: `TS18048: 'label' is possibly 'undefined'.` There the source map has a place for the variable, and it
  // takes the annotation of the parameter, as on main.
  test.todo("is stored to such a variable with minify.syntax", async () => {
    await typedHooks(unlike, { minify: { syntax: true } });
  });

  // `typeof a` is the type of the parameter `a` as the source has it: with its default value, and without `undefined`.
  // The typed file has no name of that type in a parameter list, and no variable for a parameter that only a type names.
  const queried = `import { useState } from "./state";
function same<T>(value: T): T {
  return value;
}
export function useSigned(
  first: number = 1,
  second: typeof first = 2,
  pick: typeof same = same,
  run: typeof pick<number> = pick,
): number {
  const [value] = useState(first);
  return value + second + run(1);
}
export function useReturned(first = 1, value: number | undefined = void 0): typeof value {
  const [seen] = useState(first);
  return seen > 1 ? value : undefined;
}
export function useUnknown(first: unknown = 1): typeof first {
  const [value] = useState(first);
  return value;
}
export function useMeasured(first = 1, unit = 2): number {
  const [value] = useState(first);
  return (value + 1) as typeof unit;
}
console.log(useSigned(1, 2, same, same), useReturned(1, 2), useUnknown(1), useMeasured(1, 2));
`;
  test("stays as the output has it in a function with a `typeof` that only the parameter list can answer", async () => {
    const typed = await typedHooks(queried);
    expect(parametersIn(typed)).toEqual({
      useState: "initial: T",
      same: "value: T",
      useSigned: "t0: number, t1: typeof t0, t2: typeof same, t3: typeof t2<number>",
      useReturned: "t0: any, t1: number | undefined",
      useUnknown: "t0: unknown",
      useMeasured: "t0: any, t1: any",
    });
    expect(typed).toContain("t1: number | undefined): typeof t1 {");
    expect(typed).toContain("value + 1 as typeof t1");
  });

  // Observed: `TS2554: Expected 4 arguments, but got 0.` for the call. The parameter list is what main writes.
  test.todo("can be left out of a function with a `typeof` of it in the signature", async () => {
    await typedHooks(queried + "console.log(useSigned());\n");
  });

  // The compiler output has `useState(null)` for `useState<number | null>(null)`, so `setCount` takes `null` alone.
  // The typed files are then what they are without this rule, but for the `?`: `any`, and the enum of a default value.
  test("has no type of its default value where the typed files do not check with it", async () => {
    const typed = await typedHooks(`import { useEffect, useState } from "./state";
export enum Unit {
  Px,
  Em,
}
export function useCounter(initial = 0): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    setCount(initial);
  }, [initial]);
  return count;
}
export function useBoth(first: number = 1, second = 2): number {
  const [value] = useState(first);
  return value + second;
}
export function useCell(first = 1, unit = Unit.Px as Unit | null): string {
  const [value] = useState(first);
  if (unit === null) return value + "none";
  switch (unit) {
    case Unit.Px:
      return value + "px";
    case Unit.Em:
      return value + "em";
  }
}
console.log(useCounter(), useBoth(), useCell());
`);
    expect(parametersIn(typed)).toEqual({
      useState: "initial: T",
      useCounter: "t0?",
      useBoth: "t0?: number, t1?",
      useCell: expect.stringMatching(/^t0\?, t1\?: Unit\d*$/),
    });
    expect(typed).toContain("let second = t1 === undefined ? 2 : t1;");
  });

  test("in a module that is not checked", async () => {
    using dir = tempDir("build-api-dts-moved-default-unchecked", {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { ...JSON.parse(project["tsconfig.json"]).compilerOptions, allowJs: true, jsx: "react-jsx" },
      }),
      "package.json": JSON.stringify({ name: "hooks", compilerOptions: { strict: true, jsx: "react-jsx" } }),
      "src/state.ts": state,
      "src/index.tsx": `export { useLoose } from "./loose";\nexport { plainJs, useJs } from "./hooks.js";\n`,
      "src/loose.tsx": `// @ts-nocheck
import { useState } from "./state";
export function useLoose(first: number = 1, second: number = 2, third = 3) {
  const [value] = useState(first);
  return value + second + third;
}
`,
      "src/hooks.js": `import { useState } from "./state";
export function useJs(first = 1, { second } = { second: 2 }, third = 3) {
  const [value] = useState(first);
  return value + second + third;
}
export function plainJs(first, second) {
  return first + second;
}
`,
    });
    const root = String(dir);
    const built = await build(root);
    expect(built.logs).toEqual([]);
    expect(parametersIn(readFileSync(join(root, "out/index.aot.ts"), "utf8"))).toEqual({
      useState: "initial: T",
      useLoose: "t0?, t1?, t2?",
      useJs: "t0?, t1?, t2?",
      plainJs: "first, second",
    });
  });

  // The stand-in declares `c`. The `react/compiler-runtime` of `@types/react` declares nothing, and a typed file of a
  // browser build is left out against it (TS2305).
  test("in the output for a browser, which keeps what a function computes from one call to the next", async () => {
    using dir = tempDir("build-api-dts-moved-default-client", {
      "tsconfig.json": project["tsconfig.json"],
      "src/index.tsx": `import { useState } from "react";
export function usePoint(first: number = 1, point: [number, number] = [0, 0], scale = 2): number {
  const [value] = useState(point);
  return (value[0] + value[1]) * scale + first;
}
console.log(usePoint(), usePoint(1, [1, 2]), usePoint(1, [1, 2], 3));
`,
      "node_modules/react/package.json": JSON.stringify({
        name: "react",
        version: "19.0.0",
        exports: {
          ".": { types: "./index.d.ts", default: "./index.js" },
          "./compiler-runtime": { types: "./compiler-runtime.d.ts", default: "./compiler-runtime.js" },
        },
      }),
      "node_modules/react/index.js": `export const useState = initial => [initial];\n`,
      "node_modules/react/index.d.ts": `export declare function useState<T>(initial: T): [T];\n`,
      "node_modules/react/compiler-runtime.js": `export const c = size => new Array(size);\n`,
      "node_modules/react/compiler-runtime.d.ts": `export declare function c(size: number): any[];\n`,
    });
    const root = String(dir);
    const built = await build(root, { target: "browser", external: ["react", "react/*"] });
    expect(built.logs).toEqual([]);
    const typed = readFileSync(join(root, "out/index.aot.ts"), "utf8");
    expect(typed).toContain(`import { c as _c } from "react/compiler-runtime";`);
    expect(parametersIn(typed)).toEqual({ usePoint: "t0?: number, t1?: [number, number], t2?: number" });
  });

  test("with minify.syntax, which puts the variables of a function into one statement", async () => {
    const typed = await typedHooks(hooks + calls, { minify: { syntax: true } });
    expect(parametersIn(typed)).toEqual(parameters);
    expect(typed).toContain(", second: number = t1 === void 0 ? 2 : t1,");
  });
});
