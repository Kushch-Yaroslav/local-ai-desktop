import MemoryMonitor from './MemoryMonitor';
import { useLocation } from 'react-router';
// Modified for Local AI Desktop: reusable external GGUF profile.
import AdvancedLocalInference from '../../onboarding/AdvancedLocalInference';
import { LocalInferenceSettings } from './LocalInferenceSettings';

export default function LocalInferenceSection() {
  const { state } = useLocation();
  const profileId = (state as { ggufProfileId?: string } | null)?.ggufProfileId;
  return (
    <section id="local-inference" className="space-y-4 pr-4 pb-8">
      <MemoryMonitor />
      <AdvancedLocalInference initialProfileId={profileId} />
      <LocalInferenceSettings />
    </section>
  );
}
