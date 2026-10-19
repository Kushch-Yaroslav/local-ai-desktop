export type BrowserVisionMode = 'off' | 'auto' | 'on';
export type VerificationStatus = 'Verified' | 'Partially Verified' | 'Failed' | 'Blocked' | 'Not Verified';
export interface BrowserQaCheck { action: string; expected: string; actual: string; status: VerificationStatus; }
export interface BrowserCapture { runId?: string; id: string; path: string; sha256: string; width: number; height: number; viewport: { width: number; height: number }; region: { x: number; y: number; width: number; height: number }; selector?: string; url: string; capturedAt: string; captureMs?: number; bytes: number; }
export interface VisualIssue { severity: 'high' | 'medium' | 'low'; description: string; evidence: string; confidence: number; }
export interface BrowserVisualResult { analyzed: boolean; status: VerificationStatus; model?: string; imageCount?: number; reason?: string; summary?: string; confidence?: number; issues?: VisualIssue[]; latencyMs?: number; promptTokens?: number; completionTokens?: number; }
export type QaReasonCode = 'QA_NO_PROGRESS' | 'QA_TIMEOUT' | 'QA_TOOL_ERROR' | 'VERIFICATION_INCOMPLETE' | 'EVIDENCE_STALE' | 'AUTH_REQUIRED' | 'PERMISSION_REQUIRED';
export interface BrowserQaReport { reasonCode?: QaReasonCode; revisionFingerprint?: string; loop?: { distinctOutcomes?:number; key:string; repeats:number; previousEvidence?:string; previousReportId:string; previousStatus:VerificationStatus }; functionalStatus?: VerificationStatus; scope?: 'interaction' | 'capture'; runId?: string; id: string; status: VerificationStatus; url: string; capturedAt: string; checks: BrowserQaCheck[]; errors: string[]; captures: BrowserCapture[]; visual: BrowserVisualResult; elapsedMs: number; evidencePath?: string; sourceFingerprint?: string; reason?: string; }
export interface BrowserQaStatus { phase: 'started' | 'capturing' | 'analyzing' | 'interacting' | 'issue' | 'fixing' | 'retesting' | 'complete'; report?: BrowserQaReport; }

/** Legacy checkpoint messages remain available in details, never imply a live quota. */
export function qaReasonCode(report: BrowserQaReport): QaReasonCode | undefined {
  if (report.reasonCode) return report.reasonCode;
  if (report.loop) return 'QA_NO_PROGRESS';
  if (report.reason === 'QA budget exhausted without fresh evidence for the final changes') return 'EVIDENCE_STALE';
  return undefined;
}
