// Local AI Desktop: one supervisor state shared across chat windows.
import { useEffect, useState } from 'react';
import type { RuntimeState } from '../ggufTypes';
export function useManagedGgufState() {
  const [state, setState] = useState<RuntimeState>({ phase: 'idle' });
  useEffect(() => {
    void window.electron.ggufState().then(setState);
    return window.electron.ggufOnState(setState);
  }, []);
  return state;
}
