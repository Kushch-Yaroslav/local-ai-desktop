export type BrowserVisionMode = 'off' | 'auto' | 'on';
export type VerificationStatus = 'Verified' | 'Partially Verified' | 'Failed' | 'Blocked' | 'Not Verified';
export interface BrowserQaCheck { action: string; expected: string; actual: string; status: VerificationStatus; }
export interface BrowserCapture { runId?: string; id: string; path: string; sha256: string; width: number; height: number; viewport: { width: number; height: number }; region: { x: number; y: number; width: number; height: number }; selector?: string; url: string; capturedAt: string; captureMs?: number; bytes: number; }
export interface VisualIssue { severity: 'high' | 'medium' | 'low'; description: string; evidence: string; confidence: number; }
export interface BrowserVisualResult { analyzed: boolean; status: VerificationStatus; model?: string; reason?: string; summary?: string; confidence?: number; issues?: VisualIssue[]; latencyMs?: number; promptTokens?: number; completionTokens?: number; }
export interface BrowserQaReport { runId?: string; id: string; status: VerificationStatus; url: string; capturedAt: string; checks: BrowserQaCheck[]; errors: string[]; captures: BrowserCapture[]; visual: BrowserVisualResult; elapsedMs: number; evidencePath?: string; sourceFingerprint?: string; reason?: string; }
export interface BrowserQaStatus { phase: 'started' | 'capturing' | 'analyzing' | 'interacting' | 'issue' | 'retesting' | 'complete'; report?: BrowserQaReport; }
