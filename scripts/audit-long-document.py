"""Read-only diagnostic export. No document text, notes or reasoning are exported."""
import argparse, csv, datetime, json, pathlib, sqlite3
p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--log',required=True);p.add_argument('--conversation',required=True);p.add_argument('--output',required=True);p.add_argument('--start');p.add_argument('--end');a=p.parse_args()
c=sqlite3.connect(pathlib.Path(a.database).resolve().as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
conversation=dict(c.execute('select * from conversations where id=?',(a.conversation,)).fetchone());telemetry=json.loads(conversation['chat_telemetry'] or '{}');start=a.start or telemetry.get('startedAt','');end=a.end or telemetry.get('finishedAt','z');rows=[];current=None;tools=[]
for line in open(a.log):
 if not start<=line[:24]<=end or '{' not in line:continue
 try:event=line[25:line.index('{')].strip();d=json.loads(line[line.index('{'):])
 except ValueError:continue
 if d.get('conversationId')==a.conversation and event in ['llama-cpp.agent.inference.started','llama-cpp.agent.stream.started']:
  current={'request':len(rows)+1,'time':line[:24],'kind':'chunk' if event.endswith('inference.started') else 'orchestration'};rows.append(current)
 if current and event=='llama-cpp.context.calibration':current.update(input_tokens=d.get('exactPromptTokens'),max_output=d.get('effectiveOutput'))
 if current and d.get('conversationId')==a.conversation:
  if event=='llama-cpp.agent.inference.response':current.update(duration_ms=d.get('elapsedMs'),completed_at=d.get('completedAt'))
  if event=='llama-cpp.agent.inference.raw-response':current.update(content_characters=d.get('content',{}).get('length'),reasoning_characters=d.get('reasoning',{}).get('length',0))
  if event=='llama-cpp.agent.stream.finished':current.update(duration_ms=d.get('generationDurationMs'),output_tokens=d.get('completionTokens'),reasoning_characters=d.get('reasoningChars'),content_characters=d.get('contentChars'))
  if d.get('stage')=='tool_completed':tools.append({k:d.get(k) for k in ['turn','tool','failed','code','durationMs']})
notes=[dict(r) for r in c.execute('select start,end,processed,length(summary) summary_characters,created_at from chat_document_notes where conversation_id=? order by start,end',(a.conversation,))];ranges=[]
for n in notes:
 if n['processed']:
  if ranges and n['start']<=ranges[-1][1]:ranges[-1][1]=max(ranges[-1][1],n['end'])
  else:ranges.append([n['start'],n['end']])
for row in rows:
 if row.get('completed_at'):
  completed=datetime.datetime.fromisoformat(row['completed_at'].replace('Z','+00:00'))
  matches=[n for n in notes if n['processed'] and 0 <= (datetime.datetime.fromisoformat(n['created_at'].replace('Z','+00:00'))-completed).total_seconds() < 1]
  if len(matches)==1:row.update(confirmed_start=matches[0]['start'],confirmed_end=matches[0]['end'],summary_characters=matches[0]['summary_characters'])
out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True)
(out/'metadata.json').write_text(json.dumps({'conversation':a.conversation,'model':conversation['model_id'],'telemetry':telemetry,'confirmed_ranges':ranges,'notes':notes,'tool_calls':tools,'requests':len(rows)},ensure_ascii=False,indent=2))
with (out/'requests.csv').open('w') as f:
 writer=csv.DictWriter(f,fieldnames=['request','time','kind','input_tokens','max_output','duration_ms','output_tokens','content_characters','reasoning_characters','completed_at','confirmed_start','confirmed_end','summary_characters']);writer.writeheader();writer.writerows(rows)
print(json.dumps({'requests':len(rows),'confirmed_ranges':ranges,'notes':len(notes),'duration_ms':sum(r.get('duration_ms',0) or 0 for r in rows),'input_tokens':sum(r.get('input_tokens',0) or 0 for r in rows),'tools':tools}))
