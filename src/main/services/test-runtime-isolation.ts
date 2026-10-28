/** Test entry points must never initialize the user's app-data by default. */
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
if(!process.env.LOCAL_AI_RUNTIME_ROOT)process.env.LOCAL_AI_RUNTIME_ROOT=mkdtempSync(join(tmpdir(),'lad-node-regression-'));
