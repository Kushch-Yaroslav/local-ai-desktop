import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { liveMultimodal } from './browser-vision';
const server = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ models: [{ capabilities: ['completion', 'multimodal'] }], data: [{ id: 'model', meta: {} }] })); });
void (async () => {
  try { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address=server.address(); assert(address&&typeof address!=='string'); assert(await liveMultimodal(`http://127.0.0.1:${address.port}/v1/chat/completions`)); assert(await liveMultimodal(`http://127.0.0.1:${address.port}/v1/chat/completions`,undefined,'model'));assert(!await liveMultimodal(`http://127.0.0.1:${address.port}/v1/chat/completions`,undefined,'different-model'));console.log('Pinned llama-server models capability response accepted independently of OpenAI data.'); }
  finally { server.closeAllConnections(); server.close(); }
})();
