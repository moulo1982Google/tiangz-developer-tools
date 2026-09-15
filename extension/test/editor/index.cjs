const assert = require("node:assert/strict");
const vscode = require("vscode");

/** Optional real Extension Host test. Run with an isolated user-data directory and disposable teaching workspace. */
exports.run = async function run() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "A disposable teaching workspace is required");
  assert.equal(vscode.workspace.isTrusted, true, "Test workspace is not trusted; do not bypass the trust prompt");
  const extension = vscode.extensions.getExtension("moulo.tiangz-developer-tools");
  assert.ok(extension, "Development extension was not loaded");
  await bounded(extension.activate(), "extension activation");
  await vscode.commands.executeCommand("tiangzDeveloperTools.refreshProject");
  const uri = vscode.Uri.joinPath(folder.uri, "modules", "starter", "src", "model", "counter", "CounterComponent.ts");
  await vscode.workspace.fs.stat(uri);
  await vscode.workspace.openTextDocument(uri);
  const written = new vscode.EventEmitter();
  const closed = new vscode.EventEmitter();
  let opened;
  const terminalOpened = new Promise(resolve => { opened = resolve; });
  const task = new vscode.Task({ type: "tiangz-editor-test" }, folder, "TiangZ isolated diagnostic test", "TiangZ Test",
    new vscode.CustomExecution(async () => ({ onDidWrite: written.event, onDidClose: closed.event, open: () => opened(), close() {} })),
    ["$tiangz-module-watch"]);
  task.isBackground = true;
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Never, focus: false, panel: vscode.TaskPanelKind.Dedicated };
  let execution;
  const code = "tiangz.editor.contract-test";
  const ours = () => vscode.languages.getDiagnostics(uri).filter(item => (typeof item.code === "object" ? item.code.value : item.code) === code);
  try {
    execution = await vscode.tasks.executeTask(task);
    await bounded(terminalOpened, "custom terminal open");
    for (let cycle = 0; cycle < 2; cycle += 1) {
      written.fire(`[tiangz-dev-check] begin\r\n${uri.fsPath}:2:3 [${code}] Deliberate test diagnostic ${cycle}\r\n[tiangz-dev-check] end\r\n`);
      await until(() => ours().length === 1, "problem matcher publishes the host diagnostic");
      assert.equal(ours()[0].range.start.line, 1);
      assert.equal(ours()[0].range.start.character, 2);
      written.fire("[tiangz-dev-check] begin\r\n[tiangz-dev-check] end\r\n");
      await until(() => ours().length === 0, "successful next cycle clears the old diagnostic");
    }
    closed.fire(0);
    console.log(`[editor-tests] passed VS Code ${vscode.version}: activation, host diagnostic positions, two failure/recovery cycles`);
  } finally {
    execution?.terminate();
    written.dispose();
    closed.dispose();
  }
};

async function until(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function bounded(action, label) {
  let timer;
  try { return await Promise.race([action, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 30_000); })]); }
  finally { clearTimeout(timer); }
}
