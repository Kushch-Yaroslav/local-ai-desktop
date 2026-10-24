import assert from 'node:assert/strict';
import { sameBrowserUrl } from './browser-url';
assert(sameBrowserUrl('http://localhost:5173/?#/it/products-page','http://localhost:5173/#/it/products-page'));
for(const other of ['http://localhost:5174/#/it/products-page','http://localhost:5173/?sort=price#/it/products-page','http://localhost:5173/#/it/products-page?sort=price','http://localhost:5173/#/it/product/1','http://localhost:5173/?q=?#/it/products-page'])assert(!sameBrowserUrl('http://localhost:5173/#/it/products-page',other));
console.log('Browser route equivalence preserves origins, real query and hash state');
