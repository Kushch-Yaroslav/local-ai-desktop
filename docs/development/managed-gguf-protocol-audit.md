# Managed GGUF protocol audit — Qwen3.8-27B

## Result

System instructions and native Goose tool calling were preserved. No identity
rewrite, prompt injection, tool shim or agent-runtime change was made. A model
introducing itself as Qwen is not evidence that its system instructions/tools
were lost.

The OpenAI provider, OpenAI message/stream formatter, agent prompt manager,
standard system template and tiny-model system template are byte-identical to
those files in the read-only Goose reference checkout. No Rust files changed.

## Path and field handling

| Stage/field | Finding |
| --- | --- |
| Goose → OpenAI-compatible provider | Existing Goose message construction and tool schema serialization retained; streaming enabled, toolshim disabled |
| system/developer | Goose creates system or developer according to model capability. The real local alias used system; the outgoing request contained the known Goose agent-instruction marker. Synthetic tests cover both roles unchanged |
| tools/tool_choice | Real agent request contained 17 tools. Goose omitted tool_choice, leaving standard model-directed choice; it was not stripped by the gateway. Explicit named function choice is preserved in byte-exact regression coverage |
| Gateway → llama-server | Original request bytes forwarded, without parsing/rebuilding messages, rewriting prompts or modifying generation settings |
| Chat template | Actual server /props reported a template referencing system and tools. No profile template override; Jinja backend default enabled. No template change was required |
| reasoning_content | Real SSE contained reasoning. The subsequent Goose request retained non-empty assistant reasoning together with the prior tool-call history; this follows existing OpenAI-compatible preservation defaults |
| tool_calls | Real response emitted structured calls; Goose executed the Developer/MCP shell tool, then submitted one tool result with assistant call history |
| finish_reason | Tool-call stream finished with tool_calls and DONE; final response finished with stop and DONE |
| SSE/usage | UTF-8 fragments, tool-call argument fragments, finish reasons, usage and DONE are forwarded byte-for-byte in regression tests |

The real test used the existing Qwen3.8-27B Q4_K_M file, standard CUDA llama-server,
GPU layers 999 and context 8192 in a separate temporary application/backend root.
The harmless tool action was a single printf of a synthetic marker. The tool UI
confirmed execution; the model then reported its result. Agent instructions were
not changed to obtain this result. A parallel service request without tools was
also observed; it must not be mistaken for the agent request. It was still active
when the audit snapshot was taken and was cancelled by normal test-app shutdown.

## Protocol defect corrected

An upstream read failure after SSE headers/data had been sent previously caused
the gateway to append an ordinary JSON error object to an already-started SSE
stream. This is a transport/protocol error, unrelated to the observed Qwen identity.

Now the gateway terminates the transport on an interrupted stream. It neither
appends invalid JSON nor fabricates finish_reason/DONE. Errors before response
headers use a generic JSON failure without echoing upstream/request text.
Regression coverage simulates the upstream disconnect and requires a failed read
instead of an apparently successful corrupted stream.

## Privacy and evidence

The opt-in audit is disabled by default, memory-only, capped at 32 structural
summaries and explicitly cleared when disabled. It retains role counts, tool
counts, field-presence booleans and allow-listed finish enums. It never retains
prompt/response text, instructions, schemas, tool arguments/results, call IDs,
headers or API credentials. The Goose-instruction marker is recorded only as a
boolean. Raw packet capture, verbose llama prompt logging and private-chat export
were not enabled. Existing user conversations and their process were not inspected
or restarted.

Real testing used only synthetic messages and an isolated working directory.
Goose's existing request logger is unchanged; any ordinary test-session files in
the temporary test root were removed afterward, rather than copied into evidence.
No private user request was used as a test fixture. Evidence files contain only
structural summaries and synthetic-test outcomes:

- `protocol-audit-evidence/qwen38-structure.txt`
- `protocol-audit-evidence/tests.txt`

## Validation and installation

42 tests passed in 5 files. Coverage includes byte-exact request forwarding,
system/developer roles, tool schemas/choice/history/results, reasoning preservation,
fragmented UTF-8 SSE/tool arguments, finish_reason, usage, DONE and interrupted SSE,
as well as existing lifecycle/chat/model-selector tests. TypeScript and targeted
ESLint passed. The staging desktop package built successfully and ran the real
Qwen3.8 test. Normal shutdown left zero isolated application/backend processes
and no GPU compute allocation.

The tested local app.asar has been installed into this development build. A running
user application was left untouched; its next restart loads the gateway fix.
Changed follow-up files: `ui/desktop/src/managedGguf.ts`, `preload.ts`,
`managedGguf.test.ts`, new `ggufProtocolAudit.ts`, this report and structural evidence.
No agent runtime, model identity, model weights, driver, reference checkout, tags
or releases were changed; no push was performed.
