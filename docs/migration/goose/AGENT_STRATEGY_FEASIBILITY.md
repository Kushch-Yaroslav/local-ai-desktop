# Donor Agent Strategy: Goose integration feasibility

Research only. No strategy UI, prompt change, or runtime behavior was added.

## What the donor does

The legacy application exposes two persisted conversation values, `fast` and
`deep`, independently from thinking enablement and provider reasoning effort.
They are stored by `src/shared/conversation-settings.ts` and resolved alongside
separate reasoning controls in `src/shared/reasoning-controls.ts`. The runtime
passes a `reasoningMode` value through its own Rust agent runtime and web-chat
loop. The mode changes guidance/planning expectations for that separate agent;
it does not change the permission mode, provide an enforceable tool policy, or
guarantee a reasoning-token budget. `src/main/models/model-capabilities.ts`
explicitly avoids inventing provider effort values from the strategy.

The old strategy's assumptions therefore cannot be carried over as an
equivalent runtime setting in Goose. Goose owns the model loop, permission
checks, compaction, tool calls, recipes and Skills.

## Recommended mapping

Use a **Recipe plus an optional Skill** for reusable procedural strategies.
Recipes are the right entry when a user wants an explicit, repeatable task
workflow and parameterized steps. A Skill is appropriate for reusable domain
guidance that Goose can load when relevant. A small editable prompt preset may
be offered later as a convenience, but it must be labeled as guidance only.

Do not map a Fast/Deep label to thinking effort: Goose exposes provider/model
capabilities through ACP `thinking_effort`, while the donor keeps effort
independent. Do not map it to `GooseMode`; `auto`, `approve`, `smart_approve`,
and `chat` govern permissions and tool availability. Prompt text cannot enforce
approval, tool restrictions, verification or state transitions.

If a future strategy needs mandatory planning/verification, implement it as a
reviewed Goose state-machine/recipe capability with explicit state, failure,
cancellation and permission semantics. A prompt-only feature must not claim
those guarantees.

## Relevant source

- Donor persistence and semantics: `src/shared/conversation-settings.ts`,
  `src/shared/reasoning-controls.ts`, `src/shared/types.ts`.
- Donor prompt/runtime call sites: `src/main/services/web-chat.ts`,
  `src/main/services/rust-agent-runtime.ts`,
  `src/main/models/model-capabilities.ts`.
- Goose prompts and agent behavior: `crates/goose/src/prompts/system.md`,
  `crates/goose/src/agents/`, `crates/goose/src/context_mgmt/`.
- Goose permissions and session mode: `crates/goose/src/acp/server.rs`,
  `crates/goose/src/acp/response_builder.rs`,
  `crates/goose/src/security/`.
- Goose procedural content: `ui/desktop/src/components/recipes/`,
  `ui/desktop/src/components/settings/skills/`, and the Rust recipe/skill
  loading code under `crates/goose/src/`.

## Cost, risks and updates

Prompt guidance is low complexity but cannot guarantee execution. Recipes and
Skills reuse Goose's existing content model but require careful interaction
with user permissions and context-window limits. Enforced strategy behavior
would be medium-to-high complexity and would need state-machine changes and
tests for cancellation, compaction, tool failure and permission requests.

Keep any eventual feature in Local AI Desktop-owned UI/content integrations;
avoid forking Goose's agent loop. That reduces conflicts with reviewed Goose
snapshot updates while still requiring periodic checks that ACP, recipe, Skill
and prompt APIs have not changed. No donor agent runtime, prompt text or
permission logic is recommended for direct transplantation.
