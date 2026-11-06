// Browser layout fixture: no model weights, user profiles, ACP requests or external network.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import SessionSettingsPopover from '../../src/components/SessionSettingsPopover';
import ModelsBottomBar from '../../src/components/settings/models/bottom_bar/ModelsBottomBar';
import ru from '../../src/i18n/compiled/ru.json';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.classList.toggle('dark', theme === 'dark');
applyThemeTokens(theme);
document.body.style.color = 'var(--color-text-primary)';
const profiles = Array.from({ length: 24 }, (_, i) => ({ profile: { id: String(i), name: `GGUF ${String(i).padStart(2,'0')}`, providerId: `managed-${i}`, backend: 'external', context: 8192, gpuLayers: 8 }, available: true }));
let runtime = { phase: 'ready', profileId: '1', args: ['--ctx-size','8192'] };
const listeners = new Set<(state: unknown) => void>();
Object.assign(window, { electron: {
  ggufCapabilities: async () => ({thinking:true,vision:true}),
  ggufList: async () => profiles, ggufState: async () => runtime,
  ggufOnState: (fn: (state: unknown) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  ggufOnDiscoveryProgress: () => () => {}, on() {}, off() {},
  ggufDiscoveryCatalog: async () => ({ options: [{ modelId:'fixture-model',contextWindow:102400,kvCacheType:'f16',kvOffload:true,restored:true,validation:'revalidation' },{modelId:'fixture-model',contextWindow:176128,kvCacheType:'q8_0',kvOffload:true,restored:true,validation:'revalidation'}], previous: [], hardLimit: 262144, selectedContext: 8192, selectedKv: 'f16', supportedKv: ['f16','q8_0'] }),
  ggufStart: async (id: string) => { runtime = { ...runtime, phase: 'ready', profileId: id }; for (const fn of listeners) fn(runtime); },
  ggufStop: async () => { runtime = { ...runtime, phase: 'idle' }; for (const fn of listeners) fn(runtime); },
} });
function Fixture() {
 const [draft, setDraft] = useState({});
 return <IntlProvider locale="ru" messages={ru}>
  <div style={{ position:'fixed', inset:0, zIndex:10, background:'var(--color-background-primary)' }} />
  <button data-testid="outside" style={{position:'fixed',top:8,left:8,zIndex:20}}>Outside</button>
  <div data-testid="clipping-ancestor" style={{position:'fixed',bottom:8,right:8,width:'min(420px,calc(100vw - 16px))',height:90,overflow:'hidden',transform:'translateZ(0)',zIndex:20}}>
   <div style={{position:'absolute',bottom:8,right:12,display:'flex',alignItems:'center',gap:12}}>
    <ModelsBottomBar sessionId={null} dropdownRef={{current:null} as never} setView={()=>{}} onModelChanged={()=>{}} />
    <span>$0.00</span><SessionSettingsPopover sessionId={null} provider="managed-0" model="local-gguf" draft={draft} onDraftChange={setDraft} />
   </div>
  </div>
 </IntlProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
