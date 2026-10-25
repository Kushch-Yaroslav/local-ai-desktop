import assert from 'node:assert/strict';import{createRequire}from'node:module';
const {literalViteOutputs}=createRequire(import.meta.url)('../dist/shared/vite-build-output.js');
assert.deepEqual(literalViteOutputs("export default defineConfig({build:{outDir:'artifacts/web',rollupOptions:{}}})"),{present:true,directories:['artifacts/web']});
assert.deepEqual(literalViteOutputs("// build: {outDir:'src'}\n/*build:{outDir:'app'}*/ const x=\"build:{outDir:'public'}\"; export default {}"),{present:false,directories:[]});
assert.deepEqual(literalViteOutputs("export default {build:{rollupOptions:{outDir:'src'},outDir:process.env.OUTPUT}}"),{present:true,directories:[]});
assert.deepEqual(literalViteOutputs("export default {build:{'outDir':'../outside'}}"),{present:true,directories:[]});
console.log('PASS literal Vite output inspection: comments/strings/nested fields ignored; dynamic and escaping paths never guessed.');
