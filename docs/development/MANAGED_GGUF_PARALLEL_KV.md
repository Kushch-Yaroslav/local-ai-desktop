# Managed llama.cpp parallel KV policy

Source evidence is the vendored snapshot `5047748f114564fcf271e6a648f60e2d2eae6264` (see `runtime/integrated-llama/README.md`). No real inference was run for this change. Automated HTTP tests use a synthetic process, not GGUF weights.

## Actual server mechanisms

- `tools/server/server.cpp::server_prepare_params`: automatic slots select four sequences and unified KV. `--kv-unified-per-slot` is a global slot cap, not a request parameter; automatic pool expansion happens only without an explicit context. Desktop always supplies context and never multiplies it by agent count.
- `src/llama-context.cpp`: unified mode exposes the whole allocated context to each sequence; physical KV cells are shared. Non-unified mode divides allocation among sequences. `/props` exposes the effective slot context, not independent unified pools.
- `tools/server/server-context.cpp::post_apply_template` uses the same `oaicompat_chat_params_parse` as chat. `/tokenize` with `add_special=true, parse_special=true` matches text prompt tokenization in `handle_completions_impl`. Media embeddings cannot be accounted for with that text tokenizer.
- No arbitrary per-request `n_ctx` exists in the task schema. The server enforces `n_predict`; `server-common.cpp` explicitly lets incoming `n_predict` override `max_tokens`. Desktop bounds **both** fields for children. Speculative lookahead is bounded by `n_remaining()` in `server_slot::get_n_draft_max`.
- `get_available_slot` honors `id_slot`. `post_slots` requires `--slot-save-path`, including for erase. `SERVER_TASK_TYPE_SLOT_ERASE` defers while a slot is active, then `prompt_clear()` calls `mem.seq_rm(id, -1, -1)` and removes that sequence's KV. Ordinary chat `release()` alone can retain KV, so finishing HTTP alone is insufficient.

## Implemented admission

The full live slot context remains the main agent's logical window. A child advertises `floor(pool / slots / 256) * 256`, using the backend's 256-token context alignment. This is a stable worst-case share across the configured sequences; current reservations additionally control actual concurrent admission. No budget is derived from book bytes or a generic model default.

The managed-only request decorator transmits transient main/subagent role for both capability requests and inference. `run_machine` obtains role from the persisted session type. No session content or role data is added to external providers.

Unified concurrency is enabled only with explicit unified policy and slot-erase support. Startup verifies erase for every slot before publishing ready. Each admitted child reserves its whole budget, receives a unique slot, and has its fully templated text prompt counted by the server. Its output is limited to `budget - prompt_tokens - 1`; prompt overflow returns HTTP 413. Multiple completions and child media requests return explicit unsupported-budget errors. Caller slot selection and unlimited `n_predict` cannot bypass admission.

Three children really can generate concurrently. For 174080 tokens and four slots, each child's cap is 43520 tokens. The scheduler never reserves more than the common pool or more sequences than server slots. Main inference reserves the entire pool exclusively, preserving ordinary text/vision chat request semantics and its full logical context. It waits for active children; once queued it blocks admission of new children, preventing main starvation. This does **not** promise simultaneous full-size main inference plus three children. Four unequal simultaneously active budgets would need additional policy and exact main-request accounting.

Before and after a child, its slot is erased. Before and after main inference, all slots are erased while its exclusive reservation is held. Cleanup also runs after cancellation or failure, using a separate bounded signal so client cancellation does not skip cleanup. An unconfirmed cleanup stops the owned server rather than reusing uncertain capacity. Histories remain in Goose; their KV may be recomputed on the next request. This costs prefill time but does not shrink the main logical window. Prompt cache reuse is disabled for budgeted children.

Older runtimes without the required controls keep the compatible serialized policy; no false parallel guarantee is advertised. Non-unified profiles retain their actual independent slot limits and slot-count admission. Memory outside the KV pool (batch workspaces, model/draft weights, backend allocations) is not guaranteed by token reservations; runtime failures retain their diagnostics.

## Compaction and monitoring follow-up

Legacy managed Qwen configuration is recognized before registration refresh. Structured context/KV error frames now reach native Goose reactive compaction instead of being flattened into Other. Session metadata and ACP events expose logical usage and lifecycle; the gateway's separate JSONL diagnostics expose reservation and output receipt intervals. No physical KV occupancy is inferred from token history.
