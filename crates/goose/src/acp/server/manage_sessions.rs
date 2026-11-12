// Modified for Local AI Desktop: retain explicit directory-selection provenance for visual tasks.
// Modified for Local AI Desktop: delete chat sessions without touching project directories.
use super::*;

fn session_tree_ids(root_id: &str, subagents: &[Session]) -> Vec<String> {
    let mut ids = vec![root_id.to_string()];
    let mut known = HashSet::from([root_id.to_string()]);
    let mut cursor = 0;
    while cursor < ids.len() {
        let parent_id = ids[cursor].clone();
        for child in subagents
            .iter()
            .filter(|child| child.parent_session_id.as_deref() == Some(parent_id.as_str()))
        {
            if known.insert(child.id.clone()) {
                ids.push(child.id.clone());
            }
        }
        cursor += 1;
    }
    ids
}

fn extension_data_has_active_subagent_monitor(extension_data: &ExtensionData) -> bool {
    extension_data
        .get_extension_state("subagent_monitor", "v1")
        .is_some_and(|state| {
            state["owner"].as_str() == Some(crate::agents::subagent_monitor::owner())
                && matches!(
                    state["status"].as_str(),
                    Some("waiting" | "running" | "compacting")
                )
        })
}

impl AcpConnection {
    pub(super) async fn on_update_working_dir(
        &self,
        req: UpdateWorkingDirRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        let working_dir = req.working_dir.trim().to_string();
        if working_dir.is_empty() {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("working directory cannot be empty"));
        }
        let path = std::path::PathBuf::from(&working_dir);
        validate_absolute_cwd(&path)?;
        let session_id = &req.session_id;

        let session = self
            .services
            .session_manager
            .get_session(session_id, false)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                    .data(format!("Session not found: {}", session_id))
            })?;

        self.open_session(session_id).await?;
        self.services
            .session_manager
            .update(&session.id)
            .working_dir(path.clone())
            .apply()
            .await
            .internal_err_ctx("Failed to update working directory")?;
        super::live_browser::bind_directory(&self.services.session_manager, &session.id, &path)
            .await?;

        let session = self
            .services
            .session_manager
            .get_session(session_id, false)
            .await
            .internal_err_ctx("Failed to reload session")?;
        self.services.providers.release(&session.id);
        self.services
            .restore_provider_from_session(&session)
            .await
            .internal_err_ctx("Failed to refresh provider from session")?;

        Ok(EmptyResponse {})
    }

    pub(super) async fn on_set_session_system_prompt(
        &self,
        req: SetSessionSystemPromptRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        let session_id = req.session_id.trim();
        if session_id.is_empty() {
            return Err(
                agent_client_protocol::Error::invalid_params().data("sessionId cannot be empty")
            );
        }

        let text = Some(req.text).filter(|text| !text.trim().is_empty());
        match req.mode {
            SessionSystemPromptMode::Set => self
                .services
                .session_manager
                .update(session_id)
                .system_prompt_override(text)
                .apply()
                .await
                .internal_err()?,
            SessionSystemPromptMode::Append => {
                let key = req
                    .key
                    .as_deref()
                    .map(str::trim)
                    .filter(|key| !key.is_empty())
                    .ok_or_else(|| {
                        agent_client_protocol::Error::invalid_params()
                            .data("key cannot be empty for append mode")
                    })?;
                self.services
                    .session_manager
                    .set_system_prompt_extra(session_id, key, text)
                    .await
                    .internal_err()?
            }
        }

        Ok(EmptyResponse {})
    }

    pub(super) async fn on_delete_session(
        &self,
        req: DeleteSessionRequest,
    ) -> Result<DeleteSessionResponse, agent_client_protocol::Error> {
        let session_id = req.session_id.0.to_string();
        let subagents = self
            .services
            .session_manager
            .list_sessions_by_types(&[SessionType::SubAgent])
            .await
            .internal_err()?;
        let tree_ids = session_tree_ids(&session_id, &subagents);
        let active_subagent_ids: HashSet<&str> = subagents
            .iter()
            .filter(|session| extension_data_has_active_subagent_monitor(&session.extension_data))
            .map(|session| session.id.as_str())
            .collect();
        let has_active_session = tree_ids
            .iter()
            .any(|id| self.runs().is_active(id) || active_subagent_ids.contains(id.as_str()));
        if has_active_session {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("Cannot delete an active chat or subagent session. Stop generation first."));
        }

        self.live_voice.stop_session_interaction(&session_id).await;
        self.services
            .session_manager
            .delete_session(&session_id)
            .await
            .internal_err()?;
        for id in tree_ids {
            self.services.release_session(&id).await;
        }
        Ok(DeleteSessionResponse::new())
    }

    pub(super) async fn on_export_session(
        &self,
        req: ExportSessionRequest,
    ) -> Result<ExportSessionResponse, agent_client_protocol::Error> {
        let data = match req.format {
            SessionExportFormat::Json => {
                self.services
                    .session_manager
                    .export_session(&req.session_id)
                    .await
            }
            SessionExportFormat::Markdown => {
                self.services
                    .session_manager
                    .export_session_markdown(&req.session_id)
                    .await
            }
        }
        .internal_err()?;
        Ok(ExportSessionResponse { data })
    }

    pub(super) async fn on_import_session(
        &self,
        req: ImportSessionRequest,
    ) -> Result<ImportSessionResponse, agent_client_protocol::Error> {
        let session = self
            .services
            .session_manager
            .import_session(&req.input, None)
            .await
            .internal_err()?;

        let msg_count = session.message_count as u64;

        Ok(ImportSessionResponse {
            session_id: session.id,
            title: Some(session.name),
            updated_at: Some(session.updated_at.to_rfc3339()),
            message_count: msg_count,
        })
    }

    pub(super) async fn on_get_session_info(
        &self,
        req: GetSessionInfoRequest,
    ) -> Result<GetSessionInfoResponse, agent_client_protocol::Error> {
        let session_id = req.session_id.trim();
        if session_id.is_empty() {
            return Err(
                agent_client_protocol::Error::invalid_params().data("sessionId cannot be empty")
            );
        }

        let session = self
            .services
            .session_manager
            .get_session(session_id, false)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                    .data(format!("Session not found: {}", session_id))
            })?;

        let mut info = build_session_info(session);
        let meta = info.meta.get_or_insert_with(Default::default);
        let goose_meta = meta
            .entry("goose".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !goose_meta.is_object() {
            *goose_meta = serde_json::json!({});
        }
        goose_meta["active"] = serde_json::Value::Bool(self.runs().is_active(session_id));
        let children = self
            .services
            .session_manager
            .list_sessions_by_types(&[crate::session::SessionType::SubAgent])
            .await
            .internal_err()?;
        let mut child_infos = Vec::new();
        for child in children
            .into_iter()
            .filter(|child| child.parent_session_id.as_deref() == Some(session_id))
        {
            let child = if child
                .extension_data
                .get_extension_state("subagent_monitor", "v1")
                .is_none()
            {
                self.services
                    .session_manager
                    .get_session(&child.id, true)
                    .await
                    .unwrap_or(child)
            } else {
                child
            };
            child_infos.push(build_session_info(child));
        }
        info.meta.get_or_insert_with(Default::default).insert(
            "children".to_string(),
            serde_json::to_value(child_infos).internal_err()?,
        );
        Ok(GetSessionInfoResponse { session: info })
    }

    pub(super) async fn on_truncate_session_conversation(
        &self,
        req: TruncateSessionConversationRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        let session_id = req.session_id.trim();
        if session_id.is_empty() {
            return Err(
                agent_client_protocol::Error::invalid_params().data("sessionId cannot be empty")
            );
        }

        self.services
            .session_manager
            .truncate_conversation(session_id, req.truncate_from)
            .await
            .internal_err()?;
        Ok(EmptyResponse {})
    }

    pub(super) async fn on_update_session_project(
        &self,
        req: UpdateSessionProjectRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        let session_id = &req.session_id;
        let session_not_found = || {
            agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                .data(format!("Session not found: {session_id}"))
        };
        let updated = self
            .services
            .session_manager
            .update_project_for_session_types(
                session_id,
                req.project_id,
                &ACP_VISIBLE_SESSION_TYPES,
            )
            .await
            .internal_err()?;
        if !updated {
            return Err(session_not_found());
        }
        Ok(EmptyResponse {})
    }

    pub(super) async fn on_rename_session(
        &self,
        req: RenameSessionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.services
            .session_manager
            .update(&req.session_id)
            .user_provided_name(req.title)
            .apply()
            .await
            .map_err(|e| agent_client_protocol::Error::internal_error().data(e.to_string()))?;
        Ok(EmptyResponse {})
    }

    pub(super) async fn on_archive_session(
        &self,
        req: ArchiveSessionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.services
            .session_manager
            .update(&req.session_id)
            .archived_at(Some(chrono::Utc::now()))
            .apply()
            .await
            .internal_err()?;
        self.services.release_session(&req.session_id).await;
        Ok(EmptyResponse {})
    }

    pub(super) async fn on_unarchive_session(
        &self,
        req: UnarchiveSessionRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.services
            .session_manager
            .update(&req.session_id)
            .archived_at(None)
            .apply()
            .await
            .internal_err()?;
        Ok(EmptyResponse {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_subagent_monitor_states_block_deletion() {
        for status in ["waiting", "running", "compacting"] {
            let mut extension_data = ExtensionData::new();
            extension_data.set_extension_state(
                "subagent_monitor",
                "v1",
                serde_json::json!({
                    "owner": crate::agents::subagent_monitor::owner(),
                    "status": status
                }),
            );
            assert!(extension_data_has_active_subagent_monitor(&extension_data));
        }

        let mut completed = ExtensionData::new();
        completed.set_extension_state(
            "subagent_monitor",
            "v1",
            serde_json::json!({
                "owner": crate::agents::subagent_monitor::owner(),
                "status": "completed"
            }),
        );
        assert!(!extension_data_has_active_subagent_monitor(&completed));

        let mut stale = ExtensionData::new();
        stale.set_extension_state(
            "subagent_monitor",
            "v1",
            serde_json::json!({ "owner": "previous-process", "status": "running" }),
        );
        assert!(!extension_data_has_active_subagent_monitor(&stale));
        assert!(!extension_data_has_active_subagent_monitor(
            &ExtensionData::new()
        ));
    }

    #[tokio::test]
    async fn session_tree_includes_nested_children_and_excludes_siblings() {
        let data_dir = tempfile::tempdir().unwrap();
        let manager = SessionManager::new(data_dir.path().to_path_buf());
        let parent = manager
            .create_session(
                std::env::temp_dir(),
                "parent".to_string(),
                SessionType::User,
                GooseMode::default(),
            )
            .await
            .unwrap();
        let child = manager
            .create_session(
                std::env::temp_dir(),
                "child".to_string(),
                SessionType::SubAgent,
                GooseMode::default(),
            )
            .await
            .unwrap();
        let grandchild = manager
            .create_session(
                std::env::temp_dir(),
                "grandchild".to_string(),
                SessionType::SubAgent,
                GooseMode::default(),
            )
            .await
            .unwrap();
        let sibling = manager
            .create_session(
                std::env::temp_dir(),
                "sibling".to_string(),
                SessionType::SubAgent,
                GooseMode::default(),
            )
            .await
            .unwrap();
        manager
            .update(&child.id)
            .parent_session_id(Some(parent.id.clone()))
            .apply()
            .await
            .unwrap();
        manager
            .update(&grandchild.id)
            .parent_session_id(Some(child.id.clone()))
            .apply()
            .await
            .unwrap();
        manager
            .update(&sibling.id)
            .parent_session_id(Some("different-parent".to_string()))
            .apply()
            .await
            .unwrap();

        let subagents = manager
            .list_sessions_by_types(&[SessionType::SubAgent])
            .await
            .unwrap();
        let ids = session_tree_ids(&parent.id, &subagents);

        assert_eq!(ids, vec![parent.id, child.id, grandchild.id]);
    }
}
