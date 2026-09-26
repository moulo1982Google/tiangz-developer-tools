import path from "node:path";
import ts from "typescript";

export const coreSource = `
export interface TimerCancelledContext { readonly reason: "cancelled"; readonly timerId: bigint; }
export interface IDeserialize { Deserialize(): void; }
export interface ITransfer<T> { CaptureTransfer(): T; RestoreTransfer(state: T): void; }
export declare class Component {
  protected Awake(): void;
  protected OnDestroy(): void;
  NewOnceTimer<T = undefined>(delay: number, method: string, args?: T, options?: { onCancelled?: string }): number;
  NewRepeatedTimer<T = undefined>(delay: number, method: string, args?: T, options?: { onCancelled?: string }): number;
}
export declare class TimerSystem {
  NewOnceTimer(delay: number, callback: () => void): number;
}
`;

export const contractSource = `import { Component as Base, type TimerCancelledContext } from "../core/public";
export class Worker extends Base {
  protected override async Awake() {}
  Tick(arg: { value: number }, unused?: string) {}
  Cancel(arg: { value: number }, context: TimerCancelledContext) {}
}
declare const worker: Worker;
worker.NewOnceTimer(1, "Missing", { value: 1 });
worker.NewOnceTimer(1, "Tick", "wrong");
worker.NewOnceTimer(1, "Tick", { value: 1 }, { onCancelled: "Cancel" });
`;

export const projectFiles = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["app/**/*.ts"] }),
  "app/core/public.ts": coreSource,
  "app/model/Worker.ts": contractSource,
};

export function createFixtureProgram(source, extra = {}, api = ts, compilerOptions = {}) {
  const root = path.resolve("runtime-contract-fixture");
  const files = new Map(Object.entries({ "app/core/public.ts": coreSource, "app/model/Test.ts": source, ...extra })
    .map(([name, text]) => [path.resolve(root, name), text]));
  const host = api.createCompilerHost({});
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists.bind(host);
  host.readFile = file => files.get(path.resolve(file)) ?? readFile(file);
  host.fileExists = file => files.has(path.resolve(file)) || fileExists(file);
  host.directoryExists = directory => [...files.keys()].some(file => file.startsWith(`${path.resolve(directory)}${path.sep}`)) || directoryExists(directory);
  host.getSourceFile = (file, languageVersion) => {
    const text = host.readFile(file);
    return text === undefined ? undefined : api.createSourceFile(file, text, languageVersion, true);
  };
  const program = api.createProgram([...files.keys()], { target: api.ScriptTarget.ES2022, module: api.ModuleKind.ESNext, moduleResolution: api.ModuleResolutionKind.Bundler, strict: true, noEmit: true, ...compilerOptions }, host);
  return { program, options: { typescript: api, projectRoot: root, coreRoot: path.join(root, "app/core") } };
}
