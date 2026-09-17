import ts from "typescript";
import type { ProjectDiagnostic } from "./types.js";

const waits = new Set(["sleep", "Sleep", "sleepAsync", "SleepAsync", "sleepHost", "__hostSleep", "delay", "Delay", "delayAsync", "DelayAsync", "WaitForSeconds", "WaitForSecondsAsync"]);
const nativeTimers = new Set(["setTimeout", "setInterval", "setImmediate"]);
const ownedTimers = new Set(["NewOnceTimer", "NewRepeatedTimer"]);

/** 检查业务时间调度；调用者按模块清单选择业务源码，不扫描 Runtime 与工具。
 * Checks business time scheduling; callers select business sources rather than Runtime/tooling.
 */
export function businessTimeDiagnostics(text: string, relativePath: string): ProjectDiagnostic[] {
  if (/\.d\.ts$|(?:^|\/)(?:generated|Generated|tests?|__tests__|bench)\/|\.(?:test|spec)\.ts$/.test(relativePath.replaceAll("\\", "/"))) return [];
  const tree = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  const diagnostics: ProjectDiagnostic[] = [];
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const timersModule = /^(?:node:)?timers(?:\/promises)?$/.test(statement.moduleSpecifier.text);
    const binding = statement.importClause?.namedBindings;
    if (binding && ts.isNamedImports(binding)) for (const element of binding.elements) {
      const original = (element.propertyName ?? element.name).text;
      if ((timersModule && nativeTimers.has(original)) || waits.has(original)) aliases.set(element.name.text, original);
      if (original === "TimerSystem") aliases.set(element.name.text, "TimerSystem");
    }
    if (timersModule) {
      if (binding && ts.isNamespaceImport(binding)) namespaces.add(binding.name.text);
      if (statement.importClause?.name) namespaces.add(statement.importClause.name.text);
    }
  }
  // 传播局部函数别名，避免改名后绕过；跨文件任意封装仍需评审。
  // Propagate local aliases; arbitrary cross-file wrappers still require review.
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => { if (ts.isVariableDeclaration(node)) declarations.push(node); ts.forEachChild(node, collect); };
  collect(tree);
  for (let pass = 0; pass <= declarations.length; pass++) {
    let changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || aliases.has(declaration.name.text)) continue;
      const kind = forbidden(declaration.initializer);
      if (kind) { aliases.set(declaration.name.text, kind); changed = true; }
    }
    if (!changed) break;
  }
  visit(tree);
  return diagnostics;

  function forbidden(expression: ts.Expression): string | undefined {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return forbidden(expression.expression);
    if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? (waits.has(expression.text) || nativeTimers.has(expression.text) ? expression.text : undefined);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : "";
      const owner = expression.expression.getText(tree);
      if (waits.has(name)) return name;
      if (nativeTimers.has(name) && (owner === "globalThis" || owner === "window" || namespaces.has(owner))) return name;
      if (name === "WaitAsync" && /(?:TimerSystem|Timer|TimeHelper|timer|timerSystem)(?:\.Instance)?$/.test(owner)) return name;
      if (name === "WaitAsync" && [...aliases].some(([alias, original]) => original === "TimerSystem" && (owner === alias || owner === `${alias}.Instance`))) return name;
      if (name === "wait" && (owner === "scheduler" || /\.scheduler$/.test(owner))) return name;
    }
    return undefined;
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && forbidden(node.expression)) report(node);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Promise" && node.arguments?.some(containsOwnedTimer)) report(node);
    ts.forEachChild(node, visit);
  }
  function containsOwnedTimer(node: ts.Node): boolean {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ownedTimers.has(node.expression.name.text)) return true;
    return ts.forEachChild(node, containsOwnedTimer) ?? false;
  }
  function report(node: ts.Node): void {
    const position = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    diagnostics.push({ code: "tiangz.timer.time-wait-forbidden", severity: "error",
      message: "业务代码禁止 sleep/delay、原生计时器和时间等待 Promise（包括 TimerSystem.WaitAsync）；请用所属 Scene/Entity/Component 的 NewOnceTimer/NewRepeatedTimer 和方法名回调，不要让 await 等待时间。数据库、RPC 等结果等待不受此规则禁止。",
      location: { relativePath, line: position.line, character: position.character } });
  }
}
