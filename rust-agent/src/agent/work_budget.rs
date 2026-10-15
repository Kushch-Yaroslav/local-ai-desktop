//! Legacy journal compatibility and uncapped diagnostics. No execution limits.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkBudget {
    pub used: usize,
    pub limit: usize,
    pub extensions: usize,
    pub decision: String,
    pub reason: String,
    pub closed: bool,
    changed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetView {
    pub used: usize,
    pub limit: usize,
    pub maximum: usize,
    pub extensions: usize,
    pub decision: String,
    pub reason: String,
}
impl WorkBudget {
    pub fn view(&self) -> BudgetView {
        BudgetView {
            used: self.used,
            limit: 0,
            maximum: 0,
            extensions: 0,
            decision: "diagnostics".into(),
            reason: "unlimited".into(),
        }
    }
    pub fn start_turn(&mut self) {
        self.used = self.used.saturating_add(1);
    }
    pub fn has_changed_code(&self) -> bool {
        self.changed
    }
    pub fn changed_file(&mut self, _path: &str, _revision: &str) {
        self.changed = true;
    }
    pub fn observe_file(&mut self, _path: &str, _revision: &str) {}
    pub fn failed_edit(&mut self) {}
    pub fn checked(
        &mut self,
        _record: &super::verification::Evidence,
        _ledger: &super::verification::Verification,
        _items: &super::deliverables::Deliverables,
    ) {
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counters_are_uncapped_and_old_denials_are_only_data() {
        let mut old: WorkBudget = serde_json::from_value(serde_json::json!({"used":256,"limit":256,"decision":"denied","closed":false,"revisions":{}})).unwrap();
        for _ in 0..2000 {
            old.start_turn();
        }
        assert_eq!(old.used, 2256);
        assert_eq!(old.view().decision, "diagnostics");
    }
}
