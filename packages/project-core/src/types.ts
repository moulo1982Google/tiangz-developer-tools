export interface ProjectSource {
  readonly relativePath: string;
  readonly text: string;
}

export interface SourceLocation {
  readonly relativePath: string;
  readonly line: number;
  readonly character: number;
}

export interface MessageTypeModel {
  readonly name: string;
  readonly location: SourceLocation;
}

export interface MsgCodeModel {
  readonly name: string;
  readonly value: number;
  readonly location: SourceLocation;
}

export type ProtocolDescriptorKind = "rpc" | "message";

export interface ProtocolDescriptorModel {
  readonly kind: ProtocolDescriptorKind;
  readonly symbol: string;
  readonly group: string;
  readonly member: string;
  readonly name: string;
  readonly requestType?: string;
  readonly responseType?: string;
  readonly messageType?: string;
  readonly requestCodeName?: string;
  readonly responseCodeName?: string;
  readonly msgcodeName?: string;
  readonly requestCode?: number;
  readonly responseCode?: number;
  readonly msgcode?: number;
  readonly routing?: string;
  readonly expectsHandler: boolean;
  readonly location: SourceLocation;
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
  readonly debug?: ProcessDebugConfigModel;
  readonly scenes: readonly SceneConfigModel[];
  readonly knownScenes: readonly SceneConfigModel[];
}

export interface ProcessDebugConfigModel {
  readonly inspectorIp: string;
  readonly inspectorPort: number;
  readonly breakOnStart: boolean;
  readonly allowRemote: boolean;
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
  readonly requestType?: string;
  readonly responseType?: string;
  readonly messageType?: string;
  readonly location: SourceLocation;
}

export type ProjectDiagnosticSeverity = "error" | "warning";

export interface ProjectDiagnostic {
  readonly code: string;
  readonly severity: ProjectDiagnosticSeverity;
  readonly message: string;
  readonly location: SourceLocation;
}

export interface CodegenGeneratorModel {
  readonly id: string;
  readonly command: string;
}

export interface TiangZProjectSnapshot {
  readonly environments: readonly string[];
  readonly processes: readonly ProcessConfigModel[];
  readonly machines: readonly MachineConfigModel[];
  readonly declarations: readonly TypeDeclarationModel[];
  readonly messageTypes: readonly MessageTypeModel[];
  readonly msgcodes: readonly MsgCodeModel[];
  readonly protocols: readonly ProtocolDescriptorModel[];
  readonly handlers: readonly HandlerModel[];
  readonly generators: readonly CodegenGeneratorModel[];
  readonly diagnostics: readonly ProjectDiagnostic[];
}
