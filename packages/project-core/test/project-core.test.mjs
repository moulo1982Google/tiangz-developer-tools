import assert from "node:assert/strict";
import test from "node:test";

import { analyzeTiangZProject } from "../dist/index.js";

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
