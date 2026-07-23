export interface ProjectSource {
  readonly relativePath: string;
  readonly text: string;
}

export interface SourceLocation {
  readonly relativePath: string;
  readonly line: number;
  readonly character: number;
}

export interface SceneConfigModel {
  readonly name: string;
  readonly sceneType: string;
  readonly ip?: string;
  readonly port?: number;
}

export interface ProcessConfigModel {
  readonly environment: string;
  readonly name: string;
  readonly relativePath: string;
  readonly scenes: readonly SceneConfigModel[];
  readonly knownScenes: readonly SceneConfigModel[];
}

export interface MachineConfigModel {
  readonly environment: string;
  readonly name: string;
  readonly innerIp: string;
  readonly processes: readonly string[];
  readonly relativePath: string;
}

export type DeclarationKind = "entryScene" | "scene" | "actor" | "component";

export interface TypeDeclarationModel {
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly runtimeType?: string;
  readonly mailbox?: string;
  readonly location: SourceLocation;
}

export type HandlerKind = "rpc" | "message" | "actorRpc" | "actorMessage" | "actorMethod";

export interface HandlerModel {
  readonly kind: HandlerKind;
  readonly name: string;
  readonly owner: string;
  readonly target: string;
  readonly descriptor: string;
  readonly location: SourceLocation;
}

export type ProjectDiagnosticSeverity = "error" | "warning";

export interface ProjectDiagnostic {
  readonly code: string;
  readonly severity: ProjectDiagnosticSeverity;
  readonly message: string;
  readonly location: SourceLocation;
}

export interface TiangZProjectSnapshot {
  readonly environments: readonly string[];
  readonly processes: readonly ProcessConfigModel[];
  readonly machines: readonly MachineConfigModel[];
  readonly declarations: readonly TypeDeclarationModel[];
  readonly handlers: readonly HandlerModel[];
  readonly diagnostics: readonly ProjectDiagnostic[];
}
