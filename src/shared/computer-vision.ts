/** UI availability only; this future feature has no persisted preference or backend API. */
export function isComputerVisionAvailable(input: {
  featureImplemented: boolean;
  visionSupported: boolean;
  effectiveVisionEnabled: boolean;
}): boolean {
  return input.featureImplemented && input.visionSupported && input.effectiveVisionEnabled;
}
