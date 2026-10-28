import assert from 'node:assert/strict';
import { modelStorageHint } from './model-storage-hint';
import { setLanguage, t } from './locale';
for(const platform of ['Linux x86_64','Linux aarch64'])assert(modelStorageHint(platform).includes('смонтировать'));
for(const platform of ['Win32','MacIntel','unknown'])assert(!modelStorageHint(platform).includes('смонтировать'));
setLanguage('en');assert(t(modelStorageHint('Linux x86_64')).includes('mount it'));assert(t(modelStorageHint('Win32')).includes('Check'));
setLanguage('ru');assert(t(modelStorageHint('Linux x86_64')).includes('автоматически'));
console.log('PASS Linux mount hint and platform-correct RU/EN fallback');
