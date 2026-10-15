import { normalizeAutonomyMode, type AgentPermissions, type AutonomyMode } from '../../shared/autonomy';
/** Memory only: autonomy mode never survive a restart. */
export class AutonomySessions {
  private readonly sessions = new Map<string, AgentPermissions>();
  get(id: string): AgentPermissions { return structuredClone(this.sessions.get(id) ?? { mode: 'strict', trusted_roots: [] }); }
  async set(id: string, mode: AutonomyMode, roots: string[], establishTrust: boolean, confirmAbsolute: () => Promise<boolean>): Promise<AgentPermissions> {
    if (!['strict', 'trusted', 'autonomous', 'absolute_autopilot'].includes(mode)) throw new Error('Unknown autonomy mode');
    // Legacy trust inputs are accepted for IPC compatibility but cannot expand scope.
    void roots; void establishTrust; void confirmAbsolute;
    const permissions: AgentPermissions = { mode: normalizeAutonomyMode(mode), trusted_roots: [] };
    this.sessions.set(id, permissions); return this.get(id);
  }
}
