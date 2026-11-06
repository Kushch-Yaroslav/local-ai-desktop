import { rememberModelCategory } from './modelCategories';
// Local AI Desktop: interact with the real Radix menu, not a static menu mock.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ModelsBottomBar from './ModelsBottomBar';
import { IntlTestWrapper } from '../../../../i18n/test-utils';
const m = vi.hoisted(() => ({ change: vi.fn(), state: { phase: 'idle', profileId: undefined } as { phase: string; profileId?: string; args?: string[] }, activity: vi.fn(), select: vi.fn(), navigate: vi.fn() }));
vi.mock('../../../ModelAndProviderContext', () => ({ useModelAndProvider: () => ({ currentModel: 'local-gguf', currentProvider: 'managed-a', changeModel: m.change }) }));
vi.mock('../../../../hooks/useManagedGgufState', () => ({ useManagedGgufState: () => m.state }));
vi.mock('../../../../acp/chatSessionStore', () => ({ acpChatSessionStore: { getActivitySnapshots: m.activity } }));
vi.mock('../../../../acp/providers', () => ({ acpListProviderDetails: async () => [{ name: 'cloud', is_configured: true }] }));
vi.mock('../modelInterface', () => ({ fetchModelsForProviders: async () => [{ models: [{ provider: 'cloud', name: 'Remote' }, { provider: 'local', name: 'Native Model' }, { provider: 'managed-a', name: 'local-gguf' }] }], fetchModelReasoning: async () => false }));
vi.mock('../../../../utils/analytics', () => ({ trackModelChanged: vi.fn() }));
vi.mock('../../localInference/ModelSettingsPanel', () => ({ ModelSettingsPanel: () => null }));
const profiles = ['a','b'].map((id) => ({ profile: { id, name: `Model ${id}`, providerId: `managed-${id}`, backend: 'external', context: 8192, gpuLayers: 8 }, available: true }));
const show = () => render(<ModelsBottomBar sessionId={null} dropdownRef={{ current: null } as never} setView={m.navigate} onModelChanged={m.select} />, { wrapper: IntlTestWrapper });
async function open() { const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Select Model' })); await screen.findByRole('menu'); return user; }
beforeEach(() => {
 rememberModelCategory(undefined); vi.clearAllMocks(); m.state={phase:'idle'}; m.activity.mockReturnValue([]); m.change.mockResolvedValue(true);
 Object.assign(window.electron, { ggufCapabilities: vi.fn().mockResolvedValue({embeddedMtp:false}), ggufList: vi.fn().mockResolvedValue(profiles), on: vi.fn(), off: vi.fn(), ggufStart: vi.fn().mockResolvedValue({}), ggufStop: vi.fn().mockResolvedValue(undefined) });
});
describe('unified model selector', () => {
 it('lists each profile once alongside cloud models without Recent or Current sections', async () => {
  show();await open();expect(screen.getAllByRole('group',{name:'Model a'})).toHaveLength(1);
  await userEvent.setup().click(screen.getByRole('button',{name:'All'}));expect(await screen.findByText('Remote')).toBeInTheDocument();expect(screen.queryByText('Recent')).not.toBeInTheDocument();expect(screen.queryByText('Current model')).not.toBeInTheDocument();
  expect(within(screen.getByRole('group',{name:'Model a'})).getByLabelText('Selected for this chat')).toBeInTheDocument();
 });
 it('loads without selecting or closing the menu and opens settings for the exact profile', async () => {
  show();const user=await open();await user.click(screen.getByRole('menuitem',{name:'Load model: Model b'}));
  expect(window.electron.ggufStart).toHaveBeenCalledWith('b');expect(m.change).not.toHaveBeenCalled();expect(screen.getByRole('menu')).toBeInTheDocument();
  await user.click(screen.getByRole('menuitem',{name:'Model settings: Model b'}));
  await waitFor(()=>expect(m.navigate).toHaveBeenCalledWith('settings',{section:'local-inference',ggufProfileId:'b'}));
 });
 it('represents selected and loaded independently and unloads only through the owned supervisor', async () => {
  m.state={phase:'ready',profileId:'b'};show();const user=await open();
  expect(within(screen.getByRole('group',{name:'Model b'})).getByRole('status')).toHaveAttribute('aria-label','Running');
  expect(screen.getByRole('menuitem',{name:'Load model: Model a'})).toBeInTheDocument();
  await user.click(screen.getByRole('menuitem',{name:'Unload model: Model b'}));expect(window.electron.ggufStop).toHaveBeenCalledOnce();expect(m.select).not.toHaveBeenCalled();
 });
 it('blocks switching/unloading during a dependent agent cycle', async () => {
  m.state={phase:'ready',profileId:'b'};m.activity.mockReturnValue([{session:{provider_name:'managed-a'},chatState:'streaming',activeRunId:'run',activePromptAttemptId:null,pendingCancelPromptAttemptId:null}]);
  show();const user=await open();await user.click(screen.getByRole('menuitem',{name:'Unload model: Model b'}));
  expect(window.electron.ggufStop).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toBeInTheDocument();
 });
 it('filters and selects cloud models without exposing managed actions on them', async () => {
  show();const user=await open();await user.click(screen.getByRole('button',{name:'API / Cloud'}));await user.type(screen.getByRole('textbox',{name:'Search models'}),'Remote');
  expect(screen.queryByRole('group',{name:'Model a'})).not.toBeInTheDocument();await user.click(await screen.findByText('Remote'));
  await waitFor(()=>expect(m.select).toHaveBeenCalledWith({model:'Remote',provider:'cloud'}));expect(window.electron.ggufStart).not.toHaveBeenCalled();
 });
 it('allows cancelling a pending load and never changes the selected chat model', async () => {
  m.state={phase:'starting',profileId:'b'};show();const user=await open();await user.click(screen.getByRole('menuitem',{name:'Cancel loading: Model b'}));expect(window.electron.ggufStop).toHaveBeenCalledOnce();expect(m.change).not.toHaveBeenCalled();
 });
 it('shows loaded and selected indicators together and moves keyboard focus from search into rows', async () => {
  m.state={phase:'ready',profileId:'a'};show();const user=await open();const row=screen.getByRole('group',{name:'Model a'});
  expect(within(row).getByRole('status')).toHaveAttribute('aria-label','Running');expect(within(row).getByLabelText('Selected for this chat')).toBeInTheDocument();
  await user.click(screen.getByRole('textbox',{name:'Search models'}));await user.keyboard('{ArrowDown}');expect(within(row).getAllByRole('menuitem')[0]).toHaveFocus();
 });
 it('selects a managed profile lazily without loading it', async () => {
  show();const user=await open();await user.click(within(screen.getByRole('group',{name:'Model b'})).getByText('Model b'));
  await waitFor(()=>expect(m.select).toHaveBeenCalledWith({model:'local-gguf',provider:'managed-b'}));expect(window.electron.ggufStart).not.toHaveBeenCalled();
 });
 it('retains settings for missing files and keeps load errors visible inside the menu', async () => {
  window.electron.ggufList=vi.fn().mockResolvedValue([{...profiles[0],available:false},profiles[1]]);
  window.electron.ggufStart=vi.fn().mockRejectedValue(Error('GGUF:timeout:'));
  show();const user=await open();expect(screen.getByRole('menuitem',{name:'Load model: Model a'})).toHaveAttribute('data-disabled');
  expect(screen.getByRole('menuitem',{name:'Model settings: Model a'})).not.toHaveAttribute('data-disabled');
  await user.click(screen.getByRole('menuitem',{name:'Load model: Model b'}));await screen.findByRole('alert');expect(screen.getByRole('menu')).toBeInTheDocument();
 });

 it('retains native Goose models with native settings and no managed load controls', async () => {
  show();await open();const row=await screen.findByRole('group',{name:'Native Model'});
  expect(within(row).getByRole('menuitem',{name:'Model settings: Native Model'})).toBeInTheDocument();
  expect(within(row).queryByRole('menuitem',{name:/Load model|Unload model/})).not.toBeInTheDocument();
 });

 it('defaults to Local for managed selection, filters API models and persists an explicit filter on remount', async()=>{
  const view=show();const user=await open();expect(screen.getByRole('button',{name:'Local'})).toHaveAttribute('aria-pressed','true');
  expect(screen.queryByText('Remote')).not.toBeInTheDocument();await user.click(screen.getByRole('button',{name:'API / Cloud'}));
  expect(await screen.findByText('Remote')).toBeInTheDocument();expect(screen.queryByRole('group',{name:'Model a'})).not.toBeInTheDocument();
  view.unmount();show();await open();expect(screen.getByRole('button',{name:'API / Cloud'})).toHaveAttribute('aria-pressed','true');
  await user.click(screen.getByRole('button',{name:'All'}));expect(await screen.findByRole('group',{name:'Model a'})).toBeInTheDocument();expect(screen.getByText('Remote')).toBeInTheDocument();
 });

 it('offers validated MTP quick save without selecting, closing or loading weights', async()=>{
  window.electron.ggufCapabilities=vi.fn().mockResolvedValue({embeddedMtp:true});
  window.electron.ggufSetMtp=vi.fn().mockResolvedValue({});
  show();const user=await open();const row=screen.getByRole('group',{name:'Model a'});
  await user.click(await within(row).findByRole('menuitem',{name:'MTP: disabled'}));
  expect(window.electron.ggufSetMtp).toHaveBeenCalledWith('a',true);
  expect(m.change).not.toHaveBeenCalled();expect(window.electron.ggufStart).not.toHaveBeenCalled();expect(screen.getByRole('menu')).toBeInTheDocument();
 });
 it('shows actual MTP versus pending saved-Off, confirms reload and releases lease',async()=>{
  window.electron.ggufCapabilities=vi.fn().mockResolvedValue({embeddedMtp:true});
  window.electron.ggufDiscoveryAcquire=vi.fn().mockResolvedValue('mtp-lease');
  window.electron.ggufDiscoveryRelease=vi.fn().mockResolvedValue(undefined);
  window.electron.ggufReloadProfile=vi.fn().mockResolvedValue({});
  const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
  m.state={phase:'ready',profileId:'a',args:['--spec-type','draft-mtp']};show();const user=await open();
  const row=screen.getByRole('group',{name:'Model a'});
  expect(await within(row).findByRole('menuitem',{name:'MTP: reload required'})).toBeInTheDocument();
  await user.click(within(row).getByRole('menuitem',{name:'Apply MTP / reload model'}));
  await waitFor(()=>expect(window.electron.ggufReloadProfile).toHaveBeenCalledWith('a','mtp-lease'));
  expect(window.electron.ggufDiscoveryRelease).toHaveBeenCalledWith('mtp-lease');expect(m.change).not.toHaveBeenCalled();confirm.mockRestore();
 });
 it('omits quick MTP for incompatible targets',async()=>{
  show();await open();expect(screen.queryByRole('menuitem',{name:/MTP:/})).not.toBeInTheDocument();
 });

});
