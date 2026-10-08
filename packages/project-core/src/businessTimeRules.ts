import ts from "typescript";
import type { ProjectDiagnostic } from "./types.js";

const waits = new Set(["sleep", "Sleep", "sleepAsync", "SleepAsync", "sleepHost", "__hostSleep", "delay", "Delay", "delayAsync", "DelayAsync", "WaitForSeconds", "WaitForSecondsAsync"]);
const nativeTimers = new Set(["setTimeout", "setInterval", "setImmediate"]);
const ownedTimers = new Set(["NewOnceTimer", "NewRepeatedTimer"]);

interface Binding { readonly kind?: string; readonly initializer?: ts.Expression }
interface Scope { readonly parent?: Scope; readonly functionScope: boolean; readonly bindings: Map<string, Binding> }

/** 检查业务时间调度；调用者按模块清单选择业务源码，不扫描 Runtime 与工具。
 * Checks business time scheduling; callers select business sources rather than Runtime/tooling.
 */
export function businessTimeDiagnostics(text: string, relativePath: string): ProjectDiagnostic[] {
  if (/\.d\.ts$|(?:^|\/)(?:generated|Generated|tests?|__tests__|bench)\/|\.(?:test|spec)\.ts$/.test(relativePath.replaceAll("\\", "/"))) return [];
  const tree = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scopes = new WeakMap<ts.Node, Scope>();
  const rootScope: Scope = { functionScope: true, bindings: new Map() };
  const diagnostics: ProjectDiagnostic[] = [];
  collect(tree, rootScope);
  visit(tree);
  return diagnostics;

  // 先建立词法绑定，再解析别名；同名参数/局部声明必须遮蔽外层导入。
  // Build lexical bindings first; same-named parameters and locals shadow outer imports.
  function collect(node: ts.Node, parent: Scope): void {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      parent.bindings.set(node.name.text, {});
    }
    const isFunction = ts.isFunctionLike(node);
    const startsScope = isFunction || ts.isBlock(node) || ts.isCatchClause(node) || ts.isForStatement(node)
      || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isCaseBlock(node) || ts.isClassLike(node);
    const scope: Scope = startsScope ? { parent, functionScope: isFunction, bindings: new Map() } : parent;
    scopes.set(node, scope);
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) scope.bindings.set(node.name.text, {});
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      let target = scope;
      if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped)) {
        while (!target.functionScope && target.parent) target = target.parent;
      }
      const binding = ts.isVariableDeclaration(node) && node.initializer ? { initializer: node.initializer } : {};
      bindName(node.name, binding, target);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const timersModule = /^(?:node:)?timers(?:\/promises)?$/.test(node.moduleSpecifier.text);
      const clause = node.importClause;
      if (clause?.name) scope.bindings.set(clause.name.text, timersModule ? { kind: "@namespace" } : {});
      const binding = clause?.namedBindings;
      if (binding && ts.isNamespaceImport(binding)) scope.bindings.set(binding.name.text, timersModule ? { kind: "@namespace" } : {});
      if (binding && ts.isNamedImports(binding)) for (const element of binding.elements) {
        if (element.isTypeOnly) continue;
        const original = (element.propertyName ?? element.name).text;
        const kind = original === "TimerSystem" ? "@timer" : timersModule && original === "scheduler" ? "@scheduler"
          : (timersModule && nativeTimers.has(original)) || waits.has(original) ? original : undefined;
        scope.bindings.set(element.name.text, kind ? { kind } : {});
      }
    }
    ts.forEachChild(node, child => collect(child, scope));
  }
  function bindName(name: ts.BindingName, binding: Binding, scope: Scope): void {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, binding);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bindName(element.name, {}, scope);
  }
  function resolveBinding(identifier: ts.Identifier): Binding | undefined {
    let scope = scopes.get(identifier);
    while (scope) {
      const binding = scope.bindings.get(identifier.text);
      if (binding) return binding;
      scope = scope.parent;
    }
    return undefined;
  }
  function forbidden(expression: ts.Expression): string | undefined {
    const kind = classify(expression, new Set());
    return kind?.startsWith("@") ? undefined : kind;
  }
  function classify(expression: ts.Expression, seen: Set<Binding>): string | undefined {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return classify(expression.expression, seen);
    if (ts.isIdentifier(expression)) {
      const binding = resolveBinding(expression);
      if (binding) {
        if (seen.has(binding)) return undefined;
        seen.add(binding);
        return binding.kind ?? (binding.initializer ? classify(binding.initializer, seen) : undefined);
      }
      if (expression.text === "globalThis" || expression.text === "window") return "@namespace";
      if (expression.text === "scheduler") return "@scheduler";
      if (/^(?:TimerSystem|Timer|TimeHelper|timer|timerSystem)$/.test(expression.text)) return "@timer";
      return waits.has(expression.text) || nativeTimers.has(expression.text) ? expression.text : undefined;
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : "";
      const owner = classify(expression.expression, seen);
      if (waits.has(name)) return name;
      if (name === "Instance" && owner === "@timer") return "@timer";
      if (name === "scheduler" && owner === "@namespace") return "@scheduler";
      if (nativeTimers.has(name) && owner === "@namespace") return name;
      if (name === "WaitAsync" && owner === "@timer") return name;
      if (name === "wait" && owner === "@scheduler") return name;
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
