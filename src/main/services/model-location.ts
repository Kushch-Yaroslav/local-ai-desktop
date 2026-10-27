import {stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {mediaStorageRoot} from './gguf-artifacts';

/** Opens an existing directory only. Mounting is left to the user's file manager. */
export async function modelLocationDirectory(modelPath:string):Promise<string>{
  const storage=mediaStorageRoot(modelPath);
  if(storage&&!await stat(storage).then(s=>s.isDirectory(),()=>false)){for(const directory of [dirname(storage),dirname(dirname(storage))])if(await stat(directory).then(s=>s.isDirectory(),()=>false))return directory;}
  const directory=dirname(modelPath);
  if(!await stat(directory).then(s=>s.isDirectory(),()=>false))throw Error('Расположение модели недоступно. Подключите диск в файловом менеджере и обновите доступность моделей.');
  return directory;
}
