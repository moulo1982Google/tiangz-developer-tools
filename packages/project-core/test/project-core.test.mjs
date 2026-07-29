import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  analyzeTiangZProject,
  createProjectFilePlan,
  createDebugConfig,
  resolveMachineProcessPaths,
} from "../dist/index.js";

test("creates one file discovery plan from the generated manifest", () => {
  const plan = createProjectFilePlan(JSON.stringify({
    version: 1,
    hashAlgorithm: "sha256-normalized-text-v1",
    generators: {
      native: {
        contentInputs: { "native_data/Entity.native": "hash" },
        outputs: { "src/generated/native/entity.rs": "hash" },
        selections: [{ kind: "handler", roots: ["app/demo"], paths: [] }],
        outputRoots: [{ path: "src/generated/native", extensions: [".rs"] }],
      },
    },
  }));
  assert.deepEqual(plan.exactPaths, [
    "codegen.manifest.json",
    "native_data/Entity.native",
    "src/generated/native/entity.rs",
  ]);
  assert.deepEqual(plan.trees, [
    { root: "app", extensions: [".ts"] },
    { root: "app/demo", extensions: [".ts"] },
    { root: "configs", extensions: [".json"] },
    { root: "src/generated/native", extensions: [".rs"] },
  ]);
});

test("indexes generator commands from the project manifest", () => {
  const snapshot = analyzeTiangZProject([{
    relativePath: "codegen.manifest.json",
    text: JSON.stringify(generatedManifest({ command: "npm run codegen:proto" })),
  }]);
  assert.deepEqual(snapshot.generators, [{ id: "test", command: "npm run codegen:proto" }]);
});

const sources = [
  {
    relativePath: "configs/local/map1.json",
    text: JSON.stringify({
      process: { name: "map1", identity: { originServerId: 1, workerId: 1 } },
      scenes: [{ name: "map_1", sceneType: "MapHost", ip: "127.0.0.1", port: 7301 }],
      knownScenes: [{ name: "gate_1", sceneType: "Gate", ip: "127.0.0.1", port: 7201 }],
    }),
  },
  {
    relativePath: "configs/local/StartMachine.json",
    text: JSON.stringify({ machines: [{ name: "local", innerIp: "127.0.0.1", processes: ["map1.json"] }] }),
  },
  {
    relativePath: "app/demo/scenes/MapHostScene.ts",
    text: `
@entryScene()
export class MapHostScene extends EntryScene {}
`,
  },
  {
    relativePath: "app/demo/map/MapScene.ts",
    text: `
@scene({ sceneType: "Map", mailbox: "ordered" })
export class MapScene extends Scene {}

@component()
export class MapComponent extends Component {}
`,
  },
  {
    relativePath: "app/demo/handlers/C2M_MoveHandler.ts",
    text: `
@unitMessageHandler(PlayerUnit, MapMessages.Move)
export class C2M_MoveHandler implements UnitMessageHandler<PlayerUnit, C2M_Move> {}
`,
  },
];

test("builds one project snapshot from configs and TypeScript decorators", () => {
  const snapshot = analyzeTiangZProject(sources);
  assert.deepEqual(snapshot.environments, ["local"]);
  assert.equal(snapshot.processes[0].name, "map1");
  assert.equal(snapshot.processes[0].scenes[0].sceneType, "MapHost");
  assert.equal(snapshot.machines[0].processes[0], "map1.json");
  assert.deepEqual(snapshot.declarations.map(({ kind, name, runtimeType }) => ({ kind, name, runtimeType })), [
    { kind: "scene", name: "MapScene", runtimeType: "Map" },
    { kind: "component", name: "MapComponent", runtimeType: undefined },
    { kind: "entryScene", name: "MapHostScene", runtimeType: "MapHost" },
  ]);
  assert.deepEqual(snapshot.handlers.map(({ kind, target, descriptor }) => ({ kind, target, descriptor })), [
    { kind: "unitMessage", target: "PlayerUnit", descriptor: "MapMessages.Move" },
  ]);
  assert.deepEqual(snapshot.diagnostics, []);
});

test("indexes Process Inspector configuration", () => {
  const snapshot = analyzeTiangZProject([{
    relativePath: "configs/local/debug.json",
    text: JSON.stringify({
      process: {
        name: "debug",
        debug: {
          inspectorIp: "127.0.0.1",
          inspectorPort: 9231,
          breakOnStart: true,
          allowRemote: false,
        },
      },
      scenes: [],
    }),
  }]);
  assert.deepEqual(snapshot.processes[0].debug, {
    inspectorIp: "127.0.0.1",
    inspectorPort: 9231,
    breakOnStart: true,
    allowRemote: false,
  });
});

test("creates an isolated debug config without changing business fields", () => {
  const generated = createDebugConfig(JSON.stringify({
    process: { name: "map1", game: { fixedUpdateMs: 50 } },
    scenes: [{ name: "map_1", sceneType: "MapHost" }],
  }), {
    inspectorIp: "127.0.0.1",
    inspectorPort: 9235,
    breakOnStart: true,
    allowRemote: false,
  });
  const value = JSON.parse(generated.text);
  assert.equal(value.process.name, "map1");
  assert.equal(value.process.game.fixedUpdateMs, 50);
  assert.deepEqual(value.process.debug, generated.debug);
  assert.equal(value.scenes[0].sceneType, "MapHost");
});

test("resolves StartMachine process files relative to its environment", () => {
  assert.deepEqual(resolveMachineProcessPaths({
    environment: "local",
    name: "local",
    innerIp: "127.0.0.1",
    processes: ["login1.json", "groups/map1.json"],
    relativePath: "configs/local/StartMachine.json",
  }), ["configs/local/login1.json", "configs/local/groups/map1.json"]);
});

test("validates process identity only for configs referenced by each StartMachine", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "configs/local/map1.json",
      text: JSON.stringify({ process: { name: "map1", identity: { originServerId: 9, workerId: 1 } }, scenes: [] }),
    },
    {
      relativePath: "configs/local/map2.json",
      text: JSON.stringify({ process: { name: "map2", identity: { originServerId: 9, workerId: 2 } }, scenes: [] }),
    },
    {
      relativePath: "configs/local/map1.debug.json",
      text: JSON.stringify({ process: { name: "map1-debug", identity: { originServerId: 9, workerId: 1 } }, scenes: [] }),
    },
    {
      relativePath: "configs/local/StartMachine.json",
      text: JSON.stringify({ machines: [{ name: "local", processes: ["map1.json", "map2.json"] }] }),
    },
  ]);
  assert.deepEqual(snapshot.processes[0].identity, { originServerId: 9, workerId: 1 });
  assert.deepEqual(snapshot.diagnostics, []);
});

test("reports missing, invalid, and duplicate process identity slots", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "configs/local/missing.json",
      text: JSON.stringify({ process: { name: "missing" }, scenes: [] }),
    },
    {
      relativePath: "configs/local/invalid.json",
      text: JSON.stringify({ process: { name: "invalid", identity: { originServerId: 0, workerId: 128 } }, scenes: [] }),
    },
    {
      relativePath: "configs/local/first.json",
      text: JSON.stringify({ process: { name: "first", identity: { originServerId: 2, workerId: 3 } }, scenes: [] }),
    },
    {
      relativePath: "configs/local/duplicate.json",
      text: JSON.stringify({ process: { name: "duplicate", identity: { originServerId: 2, workerId: 3 } }, scenes: [] }),
    },
    {
      relativePath: "configs/local/StartMachine.json",
      text: JSON.stringify({ machines: [{ name: "local", processes: ["missing.json", "invalid.json", "first.json", "duplicate.json"] }] }),
    },
  ]);
  assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code), [
    "tiangz.config.missing-process-identity",
    "tiangz.config.invalid-process-identity",
    "tiangz.config.duplicate-process-identity",
  ]);
});

test("reports config references that cannot be resolved", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "configs/dev/broken.json",
      text: JSON.stringify({ process: { name: "broken" }, scenes: [{ name: "x", sceneType: "Missing" }] }),
    },
    {
      relativePath: "configs/dev/StartMachine.json",
      text: JSON.stringify({ machines: [{ name: "dev", innerIp: "10.0.0.1", processes: ["missing.json"] }] }),
    },
  ]);
  assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code), [
    "tiangz.config.unknown-entry-scene",
    "tiangz.machine.missing-process-config",
  ]);
});

test("indexes method decorators used by entry scenes and actors", () => {
  const snapshot = analyzeTiangZProject([{
    relativePath: "app/demo/LoginScene.ts",
    text: `
@entryScene()
class LoginScene extends EntryScene {
  @rpc(LoginProtocol.Login)
  private login(): void {}
}
@actor()
class LoginActor extends Actor {
  @handler(LoginProtocol.Login.name)
  private handleLogin(): void {}
}
`,
  }]);
  assert.deepEqual(snapshot.handlers.map(({ kind, name, descriptor }) => ({ kind, name, descriptor })), [
    { kind: "rpc", name: "LoginScene.login", descriptor: "LoginProtocol.Login" },
    { kind: "actorMethod", name: "LoginActor.handleLogin", descriptor: "LoginProtocol.Login.name" },
  ]);
});

test("indexes generated RPC and message descriptors with resolved msgcodes", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/generated/model/server/demo/protocol/messages.ts",
      text: `export interface C2S_Login {}\nexport interface S2C_Login {}`,
    },
    {
      relativePath: "app/generated/model/server/demo/protocol/msgcodes.ts",
      text: `export const OuterMessage = { C2S_Login: 10001, S2C_Login: 10002, C2G_Ping: 10003 } as const;`,
    },
    {
      relativePath: "app/generated/model/server/demo/protocol/rpcs.ts",
      text: `
export const LoginProtocol = {
  Login: defineRpc<C2S_Login, S2C_Login>({
    name: "Login.Login",
    requestCode: MsgCode.C2S_Login,
    responseCode: MsgCode.S2C_Login,
    requestCodec: C2S_LoginCodec,
    responseCodec: S2C_LoginCodec,
  }),
};`,
    },
    {
      relativePath: "app/generated/model/server/demo/protocol/messageDescriptors.ts",
      text: `
export const GateMessages = {
  Ping: defineMessage<C2G_Ping>({ name: "Gate.Ping", msgcode: MsgCode.C2G_Ping, codec: C2G_PingCodec }),
};`,
    },
    {
      relativePath: "app/demo/LoginHandler.ts",
      text: `
@rpcHandler(LoginScene, LoginProtocol.Login)
class LoginHandler implements SceneRpcHandler<LoginScene, C2S_Login, S2C_Login> {}`,
    },
    {
      relativePath: "app/demo/PingHandler.ts",
      text: `
@messageHandler(GateScene, GateMessages.Ping)
class PingHandler implements SceneMessageHandler<GateScene, C2G_Ping> {}`,
    },
  ]);
  assert.deepEqual(snapshot.msgcodes.map(({ name, value }) => ({ name, value })), [
    { name: "C2S_Login", value: 10001 },
    { name: "S2C_Login", value: 10002 },
    { name: "C2G_Ping", value: 10003 },
  ]);
  assert.deepEqual(snapshot.protocols.map((protocol) => ({
    kind: protocol.kind,
    symbol: protocol.symbol,
    requestType: protocol.requestType,
    responseType: protocol.responseType,
    messageType: protocol.messageType,
    requestCode: protocol.requestCode,
    responseCode: protocol.responseCode,
    msgcode: protocol.msgcode,
  })), [
    {
      kind: "message",
      symbol: "GateMessages.Ping",
      requestType: undefined,
      responseType: undefined,
      messageType: "C2G_Ping",
      requestCode: undefined,
      responseCode: undefined,
      msgcode: 10003,
    },
    {
      kind: "rpc",
      symbol: "LoginProtocol.Login",
      requestType: "C2S_Login",
      responseType: "S2C_Login",
      messageType: undefined,
      requestCode: 10001,
      responseCode: 10002,
      msgcode: undefined,
    },
  ]);
  assert.deepEqual(snapshot.diagnostics, []);
});

test("indexes Scene, Session and Unit handlers with their generic signatures", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/generated/model/server/demo/protocol/rpcs.ts",
      text: `export const DemoProtocol = {
        Login: defineRpc<C2S_Login, S2C_Login>({ name: "Demo.Login" }),
        Probe: defineRpc<C2M_Probe, M2C_Probe>({ name: "Demo.Probe" }),
      };`,
    },
    {
      relativePath: "app/generated/model/server/demo/protocol/messageDescriptors.ts",
      text: `export const DemoMessages = {
        Ping: defineMessage<C2G_Ping>({ name: "Demo.Ping" }),
        Move: defineMessage<C2M_Move>({ name: "Demo.Move" }),
      };`,
    },
    {
      relativePath: "app/demo/handlers/LoginHandler.ts",
      text: `@sessionRpcHandler(LoginScene, DemoProtocol.Login)
        class LoginHandler implements SessionRpcHandler<LoginScene, LoginSession, C2S_Login, S2C_Login> {}`,
    },
    {
      relativePath: "app/demo/handlers/PingHandler.ts",
      text: `@sessionMessageHandler(GateScene, DemoMessages.Ping)
        class PingHandler implements SessionMessageHandler<GateScene, GateSession, C2G_Ping> {}`,
    },
    {
      relativePath: "app/demo/handlers/ProbeHandler.ts",
      text: `@unitRpcHandler(PlayerUnit, DemoProtocol.Probe)
        class ProbeHandler implements UnitRpcHandler<PlayerUnit, C2M_Probe, M2C_Probe> {}`,
    },
    {
      relativePath: "app/demo/handlers/MoveHandler.ts",
      text: `@unitMessageHandler(PlayerUnit, DemoMessages.Move)
        class MoveHandler implements UnitMessageHandler<PlayerUnit, C2M_Move> {}`,
    },
  ]);

  assert.deepEqual(snapshot.handlers.map((handler) => ({
    kind: handler.kind,
    target: handler.target,
    descriptor: handler.descriptor,
    requestType: handler.requestType,
    responseType: handler.responseType,
    messageType: handler.messageType,
  })), [
    {
      kind: "sessionRpc",
      target: "LoginScene",
      descriptor: "DemoProtocol.Login",
      requestType: "C2S_Login",
      responseType: "S2C_Login",
      messageType: undefined,
    },
    {
      kind: "unitMessage",
      target: "PlayerUnit",
      descriptor: "DemoMessages.Move",
      requestType: undefined,
      responseType: undefined,
      messageType: "C2M_Move",
    },
    {
      kind: "sessionMessage",
      target: "GateScene",
      descriptor: "DemoMessages.Ping",
      requestType: undefined,
      responseType: undefined,
      messageType: "C2G_Ping",
    },
    {
      kind: "unitRpc",
      target: "PlayerUnit",
      descriptor: "DemoProtocol.Probe",
      requestType: "C2M_Probe",
      responseType: "M2C_Probe",
      messageType: undefined,
    },
  ]);
  assert.deepEqual(snapshot.diagnostics, []);
});

test("reports missing, duplicate and mismatched handlers", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/generated/model/server/demo/protocol/rpcs.ts",
      text: `
export const LoginProtocol = {
  Login: defineRpc<C2S_Login, S2C_Login>({ name: "Login.Login", requestCode: MsgCode.C2S_Login, responseCode: MsgCode.S2C_Login }),
  Missing: defineRpc<C2S_Missing, S2C_Missing>({ name: "Login.Missing", requestCode: MsgCode.C2S_Missing, responseCode: MsgCode.S2C_Missing }),
};`,
    },
    {
      relativePath: "app/demo/LoginHandlers.ts",
      text: `
@rpcHandler(LoginScene, LoginProtocol.Login)
class LoginHandler implements SceneRpcHandler<LoginScene, WrongRequest, S2C_Login> {}
@rpcHandler(LoginScene, LoginProtocol.Login)
class DuplicateLoginHandler implements SceneRpcHandler<LoginScene, C2S_Login, S2C_Login> {}`,
    },
  ]);
  assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code).sort(), [
    "tiangz.handler.duplicate",
    "tiangz.handler.missing",
    "tiangz.handler.rpc-type-mismatch",
  ]);
});

test("does not require a server Handler for ClientMessages push descriptors", () => {
  const snapshot = analyzeTiangZProject([{
    relativePath: "app/generated/model/server/demo/protocol/messageDescriptors.ts",
    text: `export const ClientMessages = {
      Ready: defineMessage<G2C_Ready>({ name: "Client.Ready", msgcode: MsgCode.G2C_Ready }),
    };`,
  }]);
  assert.equal(snapshot.protocols[0].expectsHandler, false);
  assert.deepEqual(snapshot.diagnostics, []);
});

test("indexes registerActorRpc as an explicit routed Handler", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/generated/model/server/demo/protocol/rpcs.ts",
      text: `export const LoginProtocol = {
        Login: defineRpc<C2S_Login, S2C_Login>({ name: "Login.Login" }),
      };`,
    },
    {
      relativePath: "app/demo/LoginScene.ts",
      text: `class LoginScene {
        registerHandlers() {
          this.registerActorRpc(LoginProtocol.Login, (request) => this.resolve(request.account));
        }
      }`,
    },
  ]);
  assert.equal(snapshot.handlers[0].kind, "actorRpc");
  assert.equal(snapshot.handlers[0].descriptor, "LoginProtocol.Login");
  assert.deepEqual(snapshot.diagnostics, []);
});

test("enforces framework, generated and business dependency directions", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/core/Runtime.ts",
      text: `import { LoginScene } from "../demo/LoginScene";`,
    },
    {
      relativePath: "app/generated/model/server/messages.ts",
      text: `export { LoginScene } from "../../../demo/LoginScene";`,
    },
    {
      relativePath: "app/model/Player.ts",
      text: `const handler = import("../hotfix/PlayerHandler");`,
    },
    {
      relativePath: "app/demo/LoginScene.ts",
      text: `import { BenchScene } from "../bench/BenchScene";`,
    },
  ]);
  assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code), [
    "tiangz.architecture.invalid-dependency",
    "tiangz.architecture.invalid-dependency",
    "tiangz.architecture.invalid-dependency",
    "tiangz.architecture.invalid-dependency",
  ]);
  assert.ok(snapshot.diagnostics.every((diagnostic) => diagnostic.severity === "error"));
});

test("allows model, hotfix, business and generated composition dependencies", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/model/Player.ts",
      text: `import { Entity } from "../core/runtime";
import { NativeUnitRef } from "../generated/model/native/NativeUnitRef";`,
    },
    {
      relativePath: "app/hotfix/PlayerHandler.ts",
      text: `import { Player, GameErrCode } from "#tiangz/model";
import { helper } from "./helper";`,
    },
    {
      relativePath: "app/demo/LoginScene.ts",
      text: `import { Entity } from "../core/runtime";
import { LoginProtocol } from "../generated/model/server/demo/protocol/rpcs";
import { GameErrCode } from "../game/protocol/GameErrCode";`,
    },
    {
      relativePath: "app/generated/hotfix/handlers.ts",
      text: `import "../../hotfix/PlayerHandler";`,
    },
    {
      relativePath: "app/generated/bootstrap/scenes.ts",
      text: `import "../../model/LoginScene";
import { registerKnownRpcs } from "../../core/protocol/rpc";`,
    },
    {
      relativePath: "app/model/main.ts",
      text: `import "../generated/bootstrap/scenes";`,
    },
    {
      relativePath: "app/hotfix/main.ts",
      text: `import "../generated/hotfix/handlers";`,
    },
    {
      relativePath: "app/main.ts",
      text: `import "./model/main";
import "./hotfix/main";`,
    },
  ]);
  assert.deepEqual(snapshot.diagnostics, []);
});

test("requires Hotfix to enter stable code through the model package", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/hotfix/demo/LoginHandler.ts",
      text: `import { Entity } from "../../core/runtime";
import { LoginScene } from "../../model/demo/LoginScene";
import { something } from "some-package";`,
    },
  ]);
  assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code), [
    "tiangz.architecture.invalid-dependency",
    "tiangz.architecture.invalid-dependency",
    "tiangz.architecture.invalid-dependency",
  ]);
});

test("allows benchmark Hotfix to exercise the stable Model API", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/hotfix/bench/handlers/StateSyncBenchHandler.ts",
      text: `import { PlayerUnit, StateSyncBenchProtocol } from "#tiangz/model";`,
    },
    {
      relativePath: "app/main.bench.ts",
      text: `import "./bench/bootstrap";
import "./main";`,
    },
  ]);
  assert.deepEqual(snapshot.diagnostics, []);
});

test("rejects unstable long-lived Model fields", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/model/game/PlayerUnit.ts",
      text: `@component()
export class PlayerUnit extends Unit {
  unsafe: any = 0;
  mixed: number | string = 0;
  maybeCount: number | undefined = 0;
  optionalCount?: number;
  target: Unit | null = null;
  mode: "idle" | "moving" = "idle";

  mutate(): void {
    delete this.mixed;
    (this as any).lateField = 1;
  }
}`,
    },
    {
      relativePath: "app/hotfix/bench/IntentionalBench.ts",
      text: `export class IntentionalBench extends Unit { value: any = 1; }`,
    },
  ]);
  const warnings = snapshot.diagnostics.filter(
    (diagnostic) => diagnostic.code === "tiangz.performance.unstable-shape",
  );
  assert.equal(warnings.length, 6);
  assert.ok(warnings.every((diagnostic) => diagnostic.severity === "error"));
  assert.deepEqual(warnings.map((diagnostic) => diagnostic.location.line), [2, 3, 4, 5, 10, 11]);
});

test("does not warn for nullable fields, discriminated unions, dictionaries or ordinary DTOs", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/model/game/PlayerUnit.ts",
      text: `@component()
export class PlayerUnit extends Unit {
  target: Unit | null = null;
  state: IdleState | MovingState = { kind: "idle" };
  protected values = new Map<number, number>();
}`,
    },
    {
      relativePath: "app/model/game/Messages.ts",
      text: `export interface FlexibleDto { value: number | string; payload: any; }`,
    },
  ]);
  assert.deepEqual(snapshot.diagnostics, []);
});

test("validates declared Model lifecycle and transfer methods against Hotfix Systems", () => {
  const incomplete = analyzeTiangZProject([
    {
      relativePath: "app/model/game/BuffComponent.ts",
      text: `@component()
@transferable()
@lifecycle({ awake: true, destroy: true, deserialize: true })
export class BuffComponent extends Component {}`,
    },
    {
      relativePath: "app/hotfix/game/BuffComponentSystem.ts",
      text: `@systemFor(BuffComponent)
export class BuffComponentSystem extends BuffComponent {
  protected override Awake(): void {}
  async Deserialize(): Promise<void> {}
}`,
    },
  ]);
  assert.deepEqual(
    incomplete.diagnostics
      .filter((diagnostic) => diagnostic.code.startsWith("tiangz.lifecycle."))
      .map((diagnostic) => diagnostic.code),
    [
      "tiangz.lifecycle.missing-method",
      "tiangz.lifecycle.async-method",
      "tiangz.lifecycle.missing-method",
      "tiangz.lifecycle.missing-method",
    ],
  );

  const complete = analyzeTiangZProject([
    {
      relativePath: "app/model/game/BuffComponent.ts",
      text: `@component()
@transferable()
@lifecycle({ awake: true, destroy: true, deserialize: true })
export class BuffComponent extends Component {}`,
    },
    {
      relativePath: "app/hotfix/game/BuffComponentSystem.ts",
      text: `@systemFor(BuffComponent)
export class BuffComponentSystem extends BuffComponent {
  protected override Awake(): void {}
  protected override OnDestroy(): void {}
  Deserialize(): void {}
  CaptureTransfer(): number { return 1; }
  RestoreTransfer(_state: number): void {}
}`,
    },
  ]);
  assert.deepEqual(
    complete.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("tiangz.lifecycle.")),
    [],
  );
});

test("warns when a Component exposes a mutable collection or a Handler imports Native Ref", () => {
  const snapshot = analyzeTiangZProject([
    {
      relativePath: "app/model/game/item/ItemComponent.ts",
      text: `@component()
export class ItemComponent extends Component {
  readonly items = new Map<number, ItemView>();
  protected readonly index = new Map<number, number>();
}`,
    },
    {
      relativePath: "app/hotfix/game/handlers/C2M_UseItemHandler.ts",
      text: `import { ItemComponent, NativeItemRef, type ItemView } from "#tiangz/model";
export class C2M_UseItemHandler {}`,
    },
    {
      relativePath: "app/hotfix/game/item/ItemComponentSystem.ts",
      text: `import { NativeItemRef } from "#tiangz/model";
@systemFor(ItemComponent)
export class ItemComponentSystem extends ItemComponent {}`,
    },
  ]);
  const ownershipWarnings = snapshot.diagnostics.filter(
    (diagnostic) => diagnostic.code.startsWith("tiangz.architecture.component-public")
      || diagnostic.code === "tiangz.architecture.native-ref-in-handler",
  );
  assert.deepEqual(ownershipWarnings.map((diagnostic) => diagnostic.code).sort(), [
    "tiangz.architecture.component-public-collection",
    "tiangz.architecture.native-ref-in-handler",
  ].sort());
  assert.ok(ownershipWarnings.every((diagnostic) => diagnostic.severity === "warning"));
});

test("accepts valid owned timers and Scene Event handlers", () => {
  const snapshot = analyzeTiangZProject([{
    relativePath: "app/hotfix/game/RuntimeFoundationSystem.ts",
    text: `
class RuntimeFoundationSystem {
  Start(): void {
    this.scene.Time.NewRepeatedTimer(100, "Tick", { value: 1 }, { onCancelled: "Cancelled" });
    this.scene.Events.Publish(GameEvents.Changed, { value: 1 });
  }
  async Publish(): Promise<void> {
    await this.scene.Events.PublishAsync(GameEvents.Saved, { value: 1 });
    const pending = this.scene.Events.PublishAsync(GameEvents.Saved, { value: 2 });
    await pending;
  }
  Tick(_args: unknown): void {}
  Cancelled(_args: unknown, _context: TimerCancellationContext): void {}
}
@syncEventHandler(GameScene, GameEvents.Changed)
class ChangedHandler implements SyncSceneEventHandler<GameScene, ChangedEvent> {
  Handle(_scene: GameScene, _event: ChangedEvent): void {}
}
@asyncEventHandler(GameScene, GameEvents.Saved)
class SavedHandler implements AsyncSceneEventHandler<GameScene, SavedEvent> {
  async Handle(_scene: GameScene, _event: SavedEvent): Promise<void> {}
}`,
  }]);
  assert.deepEqual(snapshot.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("tiangz.timer.")
    || diagnostic.code.startsWith("tiangz.event.")
    || diagnostic.code === "tiangz.persistence.runtime-id"), []);
  assert.deepEqual(snapshot.handlers.map(({ kind, messageType }) => ({ kind, messageType })), [
    { kind: "syncEvent", messageType: "ChangedEvent" },
    { kind: "asyncEvent", messageType: "SavedEvent" },
  ]);
});

test("reports unsafe timer, Scene Event, and persisted runtime-ID usage", () => {
  const snapshot = analyzeTiangZProject([{
    relativePath: "app/hotfix/game/BrokenRuntimeFoundation.ts",
    text: `
class BrokenRuntimeFoundation {
  Start(): void {
    this.scene.Time.NewOnceTimer(100, "MissingTick", undefined, { onCancelled: "MissingCancelled" });
    this.scene.Time.NewRepeatedTimer(100, "Tick", undefined, { onCancelled: "BadCancelled" });
    this.scene.Time.RemoveTimer(1n);
    this.scene.Events.PublishAsync(GameEvents.Saved, {});
  }
  Tick(): void {}
  BadCancelled(_args: unknown): void {}
}
@syncEventHandler(GameScene, GameEvents.Changed)
class BadSyncHandler {
  async Handle(): Promise<void> {}
}
@asyncEventHandler(GameScene, GameEvents.Saved)
class BadAsyncHandler {
  Handle(): void {}
}
@syncEventHandler(GameScene, GameEvents.Missing)
class MissingHandleHandler {}
interface PlayerPersistenceSnapshot {
  owner: InstanceId;
  retryTimer: TimerId;
  playerId: GlobalId;
}`,
  }]);
  assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code), [
    "tiangz.timer.missing-method",
    "tiangz.timer.missing-cancel-method",
    "tiangz.timer.invalid-cancel-method",
    "tiangz.timer.legacy-remove",
    "tiangz.event.unawaited-async",
    "tiangz.event.sync-handler-async",
    "tiangz.event.async-handler-sync",
    "tiangz.event.missing-handle",
    "tiangz.persistence.runtime-id",
    "tiangz.persistence.runtime-id",
  ]);
});

test("accepts generated files that match the codegen manifest", () => {
  const input = "message Login {}\n";
  const output = "// generated\nexport interface Login {}\n";
  const manifest = generatedManifest({
    contentInputs: { "proto/Login.proto": textHash(input) },
    outputs: { "app/generated/model/server/Login.ts": textHash(output) },
    outputRoots: [{ path: "app/generated/model/server", extensions: [".ts"] }],
  });
  const snapshot = analyzeTiangZProject([
    { relativePath: "codegen.manifest.json", text: JSON.stringify(manifest) },
    { relativePath: "proto/Login.proto", text: input },
    { relativePath: "app/generated/model/server/Login.ts", text: output },
  ]);
  assert.deepEqual(snapshot.diagnostics, []);
});

test("reports stale, modified, missing and orphan generated state", () => {
  const manifest = generatedManifest({
    contentInputs: { "proto/Login.proto": textHash("old input") },
    outputs: {
      "app/generated/model/server/Login.ts": textHash("old output"),
      "app/generated/model/server/Missing.ts": textHash("missing"),
    },
    outputRoots: [{ path: "app/generated/model/server", extensions: [".ts"] }],
  });
  const snapshot = analyzeTiangZProject([
    { relativePath: "codegen.manifest.json", text: JSON.stringify(manifest) },
    { relativePath: "proto/Login.proto", text: "new input" },
    { relativePath: "app/generated/model/server/Login.ts", text: "// changed output" },
    { relativePath: "app/generated/model/server/Orphan.ts", text: "// orphan" },
  ]);
  assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code).sort(), [
    "tiangz.generated.missing",
    "tiangz.generated.modified",
    "tiangz.generated.orphan",
    "tiangz.generated.stale",
  ]);
});

test("marks scene imports stale only when the selected file set changes", () => {
  const scene = { relativePath: "app/demo/scenes/LoginScene.ts", text: "export const body = 2;" };
  const unchanged = generatedManifest({
    selections: [{ kind: "scene", roots: ["app"], paths: [scene.relativePath] }],
  });
  assert.deepEqual(analyzeTiangZProject([
    { relativePath: "codegen.manifest.json", text: JSON.stringify(unchanged) },
    scene,
  ]).diagnostics, []);

  const stale = generatedManifest({
    selections: [{ kind: "scene", roots: ["app"], paths: [] }],
  });
  assert.deepEqual(analyzeTiangZProject([
    { relativePath: "codegen.manifest.json", text: JSON.stringify(stale) },
    scene,
  ]).diagnostics.map((diagnostic) => diagnostic.code), ["tiangz.generated.stale"]);
});

test("tracks Hotfix patches, Systems, and benchmark handlers as generated selections", () => {
  const files = [
    { relativePath: "app/hotfix/demo/LoginHotfix.ts", text: "export class LoginHotfix {}" },
    { relativePath: "app/hotfix/demo/PlayerUnitSystem.ts", text: "export class PlayerUnitSystem {}" },
    { relativePath: "app/hotfix/bench/handlers/PingHandler.ts", text: "export class PingHandler {}" },
    { relativePath: "app/model/demo/PlayerUnit.ts", text: "export class PlayerUnit {}" },
  ];
  const manifest = generatedManifest({
    selections: [
      { kind: "hotfix-patch", roots: ["app/hotfix/demo"], paths: [files[0].relativePath] },
      { kind: "hotfix-system", roots: ["app/hotfix/demo"], paths: [files[1].relativePath] },
      { kind: "bench-handler", roots: ["app/hotfix/bench"], paths: [files[2].relativePath] },
      { kind: "system-model", roots: ["app/model"], paths: [files[3].relativePath] },
    ],
  });
  const snapshot = analyzeTiangZProject([
    { relativePath: "codegen.manifest.json", text: JSON.stringify(manifest) },
    ...files,
  ]);
  assert.deepEqual(snapshot.diagnostics, []);
});

function generatedManifest(overrides) {
  return {
    version: 1,
    hashAlgorithm: "sha256-normalized-text-v1",
    generators: {
      test: {
        command: "npm run codegen:test",
        contentInputs: {},
        selections: [],
        outputs: {},
        outputRoots: [],
        ...overrides,
      },
    },
  };
}

function textHash(text) {
  return createHash("sha256").update(text.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}
