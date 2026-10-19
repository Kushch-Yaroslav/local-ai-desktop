export type BrowserVisionMode = 'off' | 'auto' | 'on';
export type VerificationStatus = 'Verified' | 'Partially Verified' | 'Failed' | 'Blocked' | 'Not Verified';
export interface BrowserQaCheck { action: string; expected: string; actual: string; status: VerificationStatus; }
export interface BrowserCapture { runId?: string; id: string; path: string; sha256: string; width: number; height: number; viewport: { width: number; height: number }; region: { x: number; y: number; width: number; height: number }; selector?: string; url: string; capturedAt: string; captureMs?: number; bytes: number; }
export interface VisualIssue { severity: 'high' | 'medium' | 'low'; description: string; evidence: string; confidence: number; }
export interface BrowserVisualResult { analyzed: boolean; status: VerificationStatus; model?: string; imageCount?: number; reason?: string; summary?: string; confidence?: number; issues?: VisualIssue[]; latencyMs?: number; promptTokens?: number; completionTokens?: number; }
export type QaReasonCode = 'QA_NO_PROGRESS' | 'QA_TIMEOUT' | 'QA_TOOL_ERROR' | 'VERIFICATION_INCOMPLETE' | 'EVIDENCE_STALE' | 'AUTH_REQUIRED' | 'PERMISSION_REQUIRED' | 'PRECONDITION_FAILED' | 'UNSUPPORTED_OPERATION' | 'INCONCLUSIVE' | 'FUNCTIONAL_REQUIREMENT_FAILED' | 'VISUAL_REQUIREMENT_FAILED';
export interface BrowserQaReport { scenarios?: QaScenarioResult[]; sourceRevisions?: Record<string,string>; reasonCode?: QaReasonCode; revisionFingerprint?: string; loop?: { distinctOutcomes?:number; key:string; repeats:number; previousEvidence?:string; previousReportId:string; previousStatus:VerificationStatus }; functionalStatus?: VerificationStatus; scope?: 'interaction' | 'capture'; runId?: string; id: string; status: VerificationStatus; url: string; capturedAt: string; checks: BrowserQaCheck[]; errors: string[]; captures: BrowserCapture[]; visual: BrowserVisualResult; elapsedMs: number; evidencePath?: string; sourceFingerprint?: string; reason?: string; }
export interface BrowserQaStatus { phase: 'started' | 'capturing' | 'analyzing' | 'interacting' | 'issue' | 'fixing' | 'retesting' | 'complete'; report?: BrowserQaReport; }

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
  source: 'text' | 'value' | 'visible' | 'url' | 'diagnostic' | 'pixels' | 'runtime_errors' | 'raf' | 'draws' | 'viewport';
  selector?: string;
  path?: string;
  operator: 'equals' | 'changed' | 'increased' | 'decreased';
  expected?: string | number | boolean;
  tolerance?: number;
  sample_ms?: number[];
}
export interface QaScenario {
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
  sourceRevisions?: Record<string,string>;
  id: string; goal: string; target: string; deliverableId?: string; criterionId?: string;
  status: VerificationStatus; evidenceKind: QaEvidenceKind; assertion: QaAssertion;
  preconditions: BrowserQaCheck[]; observations: QaObservation[]; checks: BrowserQaCheck[];
  reasonCode?: QaReasonCode; reason?: string; elapsedMs: number; visual?: BrowserVisualResult;
}

export interface QaStep {
  action: 'click' | 'fill' | 'key' | 'keydown' | 'keyup' | 'hold' | 'scroll' | 'focus' | 'mousemove' | 'drag' | 'wait' | 'pointer-lock';
  selector?: string; value?: string; key?: string; duration_ms?: number; repeat?: number;
  x?: number; y?: number; to_x?: number; to_y?: number; delta_y?: number;
  expect?: { selector: string; text?: string; value?: string; changed?: boolean };
}
