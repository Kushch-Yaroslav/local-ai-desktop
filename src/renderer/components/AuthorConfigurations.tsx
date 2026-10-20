import { useState } from 'react';
import { useLocale } from '../use-locale';
import { authorConfigurations, authorConfigurationPatch, compatibleAuthorConfiguration } from '../../shared/author-configurations';
import type { ModelInspection } from '../../shared/model-profiles';
import type { RuntimeModelConfiguration } from '../../shared/types';

export function AuthorConfigurations({ profile, inspection, onChange }: {
  profile: RuntimeModelConfiguration;
  inspection?: ModelInspection;
  onChange(patch: Partial<RuntimeModelConfiguration>): void;
}) {
  const ru = useLocale() === 'ru';
  const [notice, setNotice] = useState('');
  const unavailable = !inspection || inspection.status === 'unknown'
    ? ru ? 'Ожидается проверка метаданных GGUF.' : 'Waiting for GGUF metadata inspection.'
    : inspection.status === 'error'
      ? ru ? 'Не удалось прочитать метаданные GGUF.' : 'GGUF metadata could not be read.'
      : ru
        ? 'Метаданные GGUF не соответствуют архитектуре, размеру или квантованию этой записи.'
        : 'GGUF metadata does not match this observation’s architecture, size, or quantization.';

  return <details className="profile-section author-configurations">
    <summary>{ru ? 'Наблюдения автора' : 'Author-tested configurations'}</summary>
    <p>RTX 3090 24 GB · Ryzen 7 5700X3D · 64 GB DDR4 · Linux · llama.cpp CUDA</p>
    <p>{ru
      ? 'Это оборудование автора, не минимальные требования. Исторические наблюдения не являются стандартизированным benchmark и не проверены на каждой текущей сборке.'
      : 'Author hardware, not minimum requirements. Historical observations are not standardized benchmarks and have not been retested on every current build.'}</p>
    <div className="author-table-scroll"><table>
      <thead><tr>{[ru ? 'Модель' : 'Model', 'GPU layers', ru ? 'Контекст / KV' : 'Context / KV', ru ? 'Веса' : 'Weights', ru ? 'Наблюдение' : 'Observation'].map(x => <th key={x}>{x}</th>)}</tr></thead>
      <tbody>{authorConfigurations.map(row => {
        const compatible = compatibleAuthorConfiguration(row, inspection, profile.id);
        return <tr key={row.id}>
          <td>{row.name}</td><td>{row.gpuLayers ?? (ru ? 'Неизвестно' : 'Unknown')}</td>
          <td>{row.context}<br />{row.kv}</td><td>{row.weights}</td>
          <td>
            <strong>{row.status === 'author-tested' ? (ru ? 'Проверено автором' : 'Author tested') : row.status === 'experimental' ? (ru ? 'Экспериментально' : 'Experimental') : (ru ? 'Неизвестно' : 'Unknown')}</strong>
            <small>{row.id === 'coder80' ? (ru ? 'Smoke test; не benchmark' : 'Smoke test; not a benchmark') : ru ? 'Не проверено на текущей сборке' : 'Not retested on this build'}</small>
            <p>{ru ? row.noteRu : row.noteEn}</p>
            <button type="button" disabled={!compatible} title={!compatible ? unavailable : undefined} onClick={() => {
              const patch = authorConfigurationPatch(row, profile, inspection);
              if (!patch) {
                setNotice(ru ? 'Наблюдение не применено: метаданные текущей GGUF ему не соответствуют.' : 'Not applied: the selected GGUF metadata does not match this observation.');
                return;
              }
              onChange(patch);
              setNotice(ru ? 'Параметры добавлены в черновик. Проверьте их и сохраните профиль вручную.' : 'Values applied to the draft. Review them and save the profile manually.');
            }}>{ru ? 'Использовать как отправную точку' : 'Use as a starting point'}</button>
            {!compatible && <small className="author-config-unavailable">{unavailable}</small>}
          </td>
        </tr>;
      })}</tbody>
    </table></div>
    {notice && <p role="status">{notice}</p>}
    <small>{ru
      ? 'Параметры попадают только в черновик. Они не запускают и не перезагружают модель. Неизвестные поля остаются без изменений; значения, которых нет в форме профиля, не применяются.'
      : 'Values update only the draft. No model is loaded or restarted. Unknown fields remain unchanged; values not represented in the profile form are not applied.'}</small>
  </details>;
}
