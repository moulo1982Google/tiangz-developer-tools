import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeTiangZProject,
  createDebugConfig,
  resolveMachineProcessPaths,
} from "../dist/index.js";

const sources = [
  {
    relativePath: "configs/local/map1.json",
    text: JSON.stringify({
      process: { name: "map1" },
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
@actorMessageHandler(PlayerUnit, MapMessages.Move)
export class C2M_MoveHandler implements ActorMessageHandler<PlayerUnit, C2M_Move> {}
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
    { kind: "actorMessage", target: "PlayerUnit", descriptor: "MapMessages.Move" },
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
