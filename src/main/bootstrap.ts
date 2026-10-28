import { criticalMainProcessError } from './critical-main-process-error';
import { installCriticalProcessHandlers, loadMainEntry } from './main-process-startup';

installCriticalProcessHandlers((event, handler) => process.on(event, handler), criticalMainProcessError);
void loadMainEntry(() => import('./index'), criticalMainProcessError);
