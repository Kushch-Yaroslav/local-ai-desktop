import assert from 'node:assert/strict';
import { isComputerVisionAvailable } from './computer-vision';

assert.equal(isComputerVisionAvailable({ featureImplemented: false, visionSupported: true, effectiveVisionEnabled: true }), false);
assert.equal(isComputerVisionAvailable({ featureImplemented: true, visionSupported: false, effectiveVisionEnabled: true }), false);
assert.equal(isComputerVisionAvailable({ featureImplemented: true, visionSupported: true, effectiveVisionEnabled: false }), false);
assert.equal(isComputerVisionAvailable({ featureImplemented: true, visionSupported: true, effectiveVisionEnabled: true }), true);
console.log('PASS Computer Vision availability requires implementation, model Vision support and effective Vision.');
