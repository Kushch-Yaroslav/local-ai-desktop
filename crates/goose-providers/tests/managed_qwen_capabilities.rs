// Local AI Desktop: do not invent effort levels for a toggle-only GGUF template.
use goose_providers::api_client::{ApiClient, AuthMethod};
use goose_providers::base::Provider;
use goose_providers::openai::OpenAiProviderBuilder;
use goose_providers::thinking::ThinkingEffortSupport;
use std::collections::HashMap;

#[tokio::test]
async fn toggle_only_qwen_rejects_unadvertised_levels() {
    let client =
        ApiClient::new_with_tls("http://127.0.0.1".into(), AuthMethod::NoAuth, None).unwrap();
    let provider = OpenAiProviderBuilder::new(client)
        .custom_headers(Some(HashMap::from([(
            "X-Local-AI-Managed-Qwen".into(),
            "qwen35-toggle-v1".into(),
        )])))
        .build();
    let ThinkingEffortSupport::Options(cap) = provider.thinking_effort_support() else {
        panic!("missing capabilities")
    };
    assert_eq!(
        cap.values
            .iter()
            .map(|v| v.value.as_str())
            .collect::<Vec<_>>(),
        vec!["off", "high"]
    );
    assert!(provider
        .set_thinking_effort("isolated", "low")
        .await
        .is_err());
    assert!(!provider
        .set_thinking_effort("isolated", "high")
        .await
        .unwrap());
}
