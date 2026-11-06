// Test doubles for service boundaries only; actual Radix/Goose controls are rendered.
export const acpChatSessionActions = { setSessionMetadata() {} };
export const acpChatSessionStore = { getActivitySnapshots: () => [] };
export const useAcpChatSessionSnapshot = () => undefined;
export const getAcpClient = async () => { throw Error('No ACP execution in layout fixture'); };
export const acpListProviderModels = async () => [{ id: 'local-gguf', reasoning: true }];
export const acpListProviderDetails = async () => [{ name: 'cloud', is_configured: true }];
export const fetchModelsForProviders = async () => [{ models: [{ name: 'Cloud Model', provider: 'cloud' }] }];
export const fetchModelReasoning = async () => false;
export const useModelAndProvider = () => ({ currentModel: 'local-gguf', currentProvider: 'managed-0', changeModel: async () => true });
export const registerLocalProfile = async (profile: unknown) => profile;
export const ModelSettingsPanel = () => null;
export const trackModelChanged = () => {};
