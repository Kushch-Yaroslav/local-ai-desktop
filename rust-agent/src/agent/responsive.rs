//! Explainable planning advice, not an unconditional verification gate or a provider call.
use serde_json::Value;

pub fn viewport(value: &Value) -> Option<(u64,u64)> {
    if let Some(name)=value.as_str(){return match name {
        "small-mobile"=>Some((320,640)),"mobile"=>Some((390,844)),"large-mobile"=>Some((430,932)),"tablet"=>Some((768,1024)),"desktop"=>Some((1440,900)),_=>None
    };}
    let width=value["width"].as_u64()?;let height=value["height"].as_u64()?;
    ((280..=1920).contains(&width)&&(320..=1600).contains(&height)).then_some((width,height))
}

/// File tools supply a real edit span; color-only changes do not inherit unrelated layout in a full file.
pub fn edit_span(diff: &str) -> String {
    let body=diff.lines().skip(2).collect::<Vec<_>>().join("\n");
    if let Some((before,after))=body.strip_prefix('-').and_then(|s|s.split_once("\n+")) {
        let a=before.chars().collect::<Vec<_>>();let b=after.chars().collect::<Vec<_>>();
        let prefix=a.iter().zip(&b).take_while(|(x,y)|x==y).count();
        let suffix=a[prefix..].iter().rev().zip(b[prefix..].iter().rev()).take_while(|(x,y)|x==y).count();
        return a[prefix..a.len()-suffix].iter().chain(b[prefix..b.len()-suffix].iter()).take(2400).collect();
    }
    diff.lines().filter(|l|l.starts_with('+')||l.starts_with('-')).filter(|l|!l.starts_with("+++")&&!l.starts_with("---")).collect::<Vec<_>>().join(" ").chars().take(2400).collect()
}

pub fn advice(objective:&str,criteria:&str,plan:&str,changes:&[(String,String)],previous_issue:bool)->String {
    let requirement=format!("{objective} {criteria}").to_lowercase();
    let mobile=["responsive","mobile","мобильн","адаптивн","small screen","узком экран"].iter().any(|s|requirement.contains(s));
    let opt_out=["no mobile","without mobile","не проверять мобиль","без мобильной","не нужна адаптив"].iter().any(|s|requirement.contains(s));
    let ui_files=changes.iter().filter(|(p,_)|[".css",".scss",".sass",".less",".html",".htm",".tsx",".jsx",".vue",".svelte"].iter().any(|e|p.ends_with(e))).collect::<Vec<_>>();
    let signal=format!("{} {} {}",requirement,plan.to_lowercase(),ui_files.iter().map(|(_,s)|s.to_lowercase()).collect::<Vec<_>>().join(" "));
    let layout=["layout","flex","grid","min-width","max-width","@media","breakpoint","navigation","navbar","modal","dialog","<button","<form","<nav","<main","<section","classname","w-screen","min-w","max-w","overflow","макет","раскладк","навигац","модальн"].iter().any(|s|signal.contains(s));
    let page=["landing","лендинг","страницу","web page","website","сайт"].iter().any(|s|requirement.contains(s));
    let creates=["create","build","new ","созда","сделай","новую","новый"].iter().any(|s|requirement.contains(s));
    let new_page=page&&creates;
    let (decision,reason)=if mobile&&!opt_out {("required","User request or acceptance criteria explicitly mention responsive/mobile behaviour")}
        else if previous_issue {("recommended","Previous QA contains viewport-related findings")}
        else if new_page {("recommended","The task creates a web-facing page/landing")}
        else if layout&&!ui_files.is_empty() {("recommended","Real UI edits and task/plan context indicate layout or interactive components")}
        else {("not-indicated","No relevant viewport requirement or layout change is established; backend, types and color-only changes do not imply responsive QA")};
    let visual_relevant=previous_issue || ["canvas","webgl","full-screen","fullscreen","полноэкран","visual bug","визуальн","пустую полосу","нижнюю полосу","background","высоту","шов"].iter().any(|s|signal.contains(s)) && (!ui_files.is_empty() || page || requirement.contains("canvas") || requirement.contains("визуальн") || requirement.contains("полосу") || requirement.contains("шов"));
    let visual_advice=if visual_relevant {"Visual Layout QA recommended: task/criteria/UI edits indicate fullscreen, Canvas, backgrounds or a visual defect."}else{"Visual Layout QA not-indicated: no relevant visual requirement or UI edit is established."};
    format!("{visual_advice} <responsive_qa decision=\"{decision}\">{reason}. Consider the actual task, acceptance criteria, active plan, edit spans and previous evidence together. This is planning advice, not a universal QA requirement. At a meaningful UI checkpoint, use web_project action=qa responsive={{reason,viewports:[\"mobile\",\"desktop\"]}} for diagnostics, or register separate immutable scenarios with viewport for each relevant criterion and route, then use scenario_refs. Default to the smallest useful set; expand only to investigate a defect. Use assertion source=layout, operator=equals, expected=0 for DOM bounds, existing steps/assertions for mobile menus/forms/modals. For fullscreen Canvas, background/height fixes or prior visual defects consider a Visual Layout QA scenario at the same checkpoint: assertion source=visual_layout, path=coverage|backing|seams, selector, equals 0, explicit viewport; optional visual_layout resize (max two), baseline report/scenario and Vision. Coverage is only an explicit fullscreen requirement; seam candidates are Suspected, never automatic bugs. Do not certify aesthetics from DOM bounds. Canvas appearance requires qualified Vision evidence. Color-only or backend-only tasks can skip without adding an unfinished QA plan. Do not repeat unchanged evidence or infer all routes/viewports from one check. The agent may override this recommendation with a concrete contextual reason; no separate classifier model is needed.</responsive_qa>")
}

#[cfg(test)] mod tests {
 use super::*;
 #[test] fn contextual_relevance_not_file_extension_alone(){
   let c=|path:&str,span:&str|vec![(path.to_owned(),span.to_owned())];
   assert!(advice("Create a landing page","","",&[],false).contains("recommended"));
   assert!(advice("Improve layout","","",&c("app.css","display:grid"),false).contains("recommended"));
   assert!(advice("Add navigation","","",&c("Nav.tsx","<nav><button"),false).contains("recommended"));
   assert!(advice("Integrate backend API","","",&c("api.ts","fetch('/api')"),false).contains("not-indicated"));
   assert!(advice("Fix Rust Agent Runtime loop","","",&c("runtime.rs","loop guard"),false).contains("not-indicated"));
   assert!(advice("Change brand color","","",&c("theme.css","--brand: red; --brand: blue;"),false).contains("not-indicated"));
   assert!(advice("Change landing color","","",&c("theme.css","redblue"),false).contains("not-indicated"));
   assert!(advice("Change types","Mobile layout must fit","",&[],false).contains("required"));
   assert!(advice("Fix component","","",&[],true).contains("recommended"));
 }
 #[test] fn visual_layout_advice_is_contextual(){
   assert!(advice("Fix fullscreen Canvas bottom band","","",&[],false).contains("Visual Layout QA recommended"));
   assert!(advice("Integrate backend API","","",&[("api.ts".into(),"fetch".into())],false).contains("Visual Layout QA not-indicated"));
   assert!(advice("Fix Rust Agent Runtime","","",&[("runtime.rs".into(),"state".into())],false).contains("Visual Layout QA not-indicated"));
 }
 #[test] fn full_file_diff_is_narrowed(){assert_eq!(edit_span("--- a\n+++ a\n-layout grid red end\n+layout grid blue end"),"redblue");}
 #[test] fn viewport_validation(){assert_eq!(viewport(&serde_json::json!("mobile")),Some((390,844)));assert_eq!(viewport(&serde_json::json!({"width":10,"height":844})),None);}
}
