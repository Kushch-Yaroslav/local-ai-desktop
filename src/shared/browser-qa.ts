export type BrowserVisionMode = 'off' | 'auto' | 'on';
export type VerificationStatus = 'Verified' | 'Partially Verified' | 'Failed' | 'Blocked' | 'Not Verified';
export interface BrowserQaCheck { action: string; expected: string; actual: string; status: VerificationStatus; }
export interface BrowserCapture { dpr?: number; scroll?: {x:number;y:number}; runId?: string; id: string; path: string; sha256: string; width: number; height: number; viewport: { width: number; height: number }; region: { x: number; y: number; width: number; height: number }; selector?: string; url: string; capturedAt: string; captureMs?: number; bytes: number; }
export interface VisualIssue { severity: 'high' | 'medium' | 'low'; description: string; evidence: string; confidence: number; }
export interface BrowserVisualResult { imageInput?:{state:'not-sent'|'response-received'|'failed';recipient:'vision-analysis';requestAttempted:boolean;imageCount:number;mime:'image/png';reasonCode?:string;reused?:boolean}; captureIds?:string[]; analyzed: boolean; status: VerificationStatus; model?: string; imageCount?: number; reason?: string; summary?: string; confidence?: number; issues?: VisualIssue[]; latencyMs?: number; promptTokens?: number; completionTokens?: number; }
export type QaReasonCode = 'QA_NO_PROGRESS' | 'QA_TIMEOUT' | 'QA_TOOL_ERROR' | 'VERIFICATION_INCOMPLETE' | 'EVIDENCE_STALE' | 'AUTH_REQUIRED' | 'PERMISSION_REQUIRED' | 'PRECONDITION_FAILED' | 'UNSUPPORTED_OPERATION' | 'INCONCLUSIVE' | 'FUNCTIONAL_REQUIREMENT_FAILED' | 'VISUAL_REQUIREMENT_FAILED';
export interface BrowserQaReport { scenarios?: QaScenarioResult[]; sourceRevisions?: Record<string,string>; reasonCode?: QaReasonCode; revisionFingerprint?: string; loop?: { distinctOutcomes?:number; key:string; repeats:number; previousEvidence?:string; previousReportId:string; previousStatus:VerificationStatus }; functionalStatus?: VerificationStatus; scope?: 'interaction' | 'capture'; runId?: string; id: string; status: VerificationStatus; url: string; capturedAt: string; checks: BrowserQaCheck[]; errors: string[]; captures: BrowserCapture[]; visual: BrowserVisualResult; elapsedMs: number; evidencePath?: string; sourceFingerprint?: string; reason?: string; }
export interface BrowserQaStatus { visualLayout?: {viewport:QaViewport;frames:number;suspected:number;failures:number}; phase: 'started' | 'capturing' | 'analyzing' | 'interacting' | 'issue' | 'fixing' | 'retesting' | 'complete'; report?: BrowserQaReport; responsive?: { viewport: QaViewport; checked: number; total: number; issues: number; vision: boolean }; }

/** Legacy checkpoint messages remain available in details, never imply a live quota. */
export function qaReasonCode(report: BrowserQaReport): QaReasonCode | undefined {
  if (report.reasonCode) return report.reasonCode;
  if (report.loop) return 'QA_NO_PROGRESS';
  if (report.reason === 'QA budget exhausted without fresh evidence for the final changes') return 'EVIDENCE_STALE';
  return undefined;
}

/** Declarative observations only: never evaluates model-supplied JavaScript. */
export type QaEvidenceKind = 'load' | 'runtime' | 'interaction' | 'temporal' | 'visual' | 'implementation';
export interface QaAssertion {
  source: 'style' | 'text' | 'value' | 'visible' | 'url' | 'diagnostic' | 'pixels' | 'runtime_errors' | 'raf' | 'draws' | 'viewport' | 'layout' | 'visual_layout' | 'text_fit';
  selector?: string;
  path?: string;
  operator: 'equals' | 'changed' | 'increased' | 'decreased';
  expected?: string | number | boolean;
  tolerance?: number;
  sample_ms?: number[];
}
export interface QaScenario {
  viewport?: QaViewport;
  visual_layout?: VisualLayoutOptions;
  id: string;
  goal: string;
  target: string;
  deliverable_id?: string;
  criterion_id?: string;
  preconditions: QaAssertion[];
  required_state: QaAssertion[];
  steps: QaStep[];
  assertion: QaAssertion;
  timeout_ms: number;
}
export interface QaObservation { atMs: number; value: string | number | boolean | null; captureId?: string; }
export interface QaScenarioResult {
  viewport?: QaViewport;
  responsive?: ResponsiveInspection;
  visualLayout?: VisualLayoutInspection;
  sourceRevisions?: Record<string,string>;
  id: string; goal: string; target: string; deliverableId?: string; criterionId?: string;
  status: VerificationStatus; evidenceKind: QaEvidenceKind; assertion: QaAssertion;
  preconditions: BrowserQaCheck[]; observations: QaObservation[]; checks: BrowserQaCheck[];
  reasonCode?: QaReasonCode; reason?: string; elapsedMs: number; visual?: BrowserVisualResult;
}

export type QaViewport = { width: number; height: number; profile?: string };
export interface ResponsiveFinding { kind: 'horizontal-overflow' | 'viewport-fit' | 'overlap' | 'text-clipping' | 'image-fit'; confidence: 'confirmed' | 'candidate'; selector: string; detail: string; rect?: { x: number; y: number; width: number; height: number }; }
export interface ResponsiveInspection { viewport: QaViewport; url: string; documentWidth: number; findings: ResponsiveFinding[]; intentionalScrollContainers: number; hasCanvas: boolean; truncated: boolean; }

export interface QaStep {
  action: 'click' | 'fill' | 'key' | 'keydown' | 'keyup' | 'hold' | 'scroll' | 'focus' | 'mousemove' | 'drag' | 'wait' | 'pointer-lock';
  selector?: string; value?: string; key?: string; duration_ms?: number; repeat?: number;
  x?: number; y?: number; to_x?: number; to_y?: number; delta_y?: number;
  expect?: { selector: string; text?: string; value?: string; changed?: boolean };
}

/** Scoped image diagnostics, carried by the existing scenario/evidence ledger. */
export interface VisualLayoutOptions {
  dpr?: 1 | 2;
  resize?: QaViewport[];
  baseline?: { report_id:string; scenario_id:string };
  state_key?: string;
  vision?: 'auto' | 'on' | 'off';
}
export interface VisualLayoutFinding {
  kind:'coverage'|'backing-store'|'horizontal-seam'|'vertical-seam'|'resize-instability';
  source:'dom'|'pixels'; status:'Suspected'|'Failed'; confidence:number;
  detail:string; region:{x:number;y:number;width:number;height:number};
  contrast?:number; extent?:number; domBoundary?:boolean;
}
export interface VisualLayoutFrame {
  captureId:string; viewport:QaViewport; dpr:number; scroll:{x:number;y:number};
  screenshot:{width:number;height:number};
  responsive?:ResponsiveInspection;
  bounds:{x:number;y:number;width:number;height:number};
  backing?:{width:number;height:number;expectedWidth:number;expectedHeight:number};
  stateHash:string; background:string; findings:VisualLayoutFinding[];
  signature:number[];
}
export interface VisualLayoutInspection {
  status:'Verified'|'Suspected'|'Failed'|'Blocked'; property:string; selector?:string;
  conditions:string; frames:VisualLayoutFrame[]; captures:BrowserCapture[];
  comparison?:{baselineReportId:string;baselineScenarioId:string;matched:boolean;backgroundShift?:number;resolved:number;persisting:number;newCandidates:number;summary:string};
  limitation:string;
}
