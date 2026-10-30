#!/usr/bin/env python3
"""Aggregate saved benchmark records; never load models or change settings."""
import json
from pathlib import Path
import re
import statistics
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'docs/experiments/advanced-placement-moe')
results = []
for budget in (0, 8192, 12288, 16384):
    for file in sorted((root / f'qwen-ab-cache{budget}').glob('*.json')):
        data = json.loads(file.read_text())
        log = Path(data['server_log']).read_text()
        def stats(values):
            return {'median': statistics.median(values), 'min': min(values), 'max': max(values)} if values else None
        tasks = []
        for run in data['runs']:
            tasks.append({'task': run['task'], 'repeat': run['repeat'], 'phase': run['cache_phase'],
                'prompt_tokens': run['timings'].get('prompt_n'), 'output_tokens': run['timings'].get('predicted_n'),
                'prompt_cache_tokens': run['timings'].get('cache_n'),
                'decode_tps': run['timings'].get('predicted_per_second'),
                'prefill_tps': run['timings'].get('prompt_per_second'),
                'ttft_s': run['_ttft_seconds'], 'wall_s': run['_wall_seconds'], 'stop_type': run.get('stop_type')})
        from datetime import datetime
        results.append({'budget_mib': budget, 'file': str(file), 'status': data['status'], 'summary': data.get('summary'),
            'load_to_health_s': (datetime.fromisoformat(data['ready_utc'])-datetime.fromisoformat(data['started_utc'])).total_seconds() if data.get('ready_utc') else None,
            'resources': data['resources'], 'cache_allocations': re.findall(r'.*(?:MoE cache size|slots \().*',log),
            'cache_telemetry': re.findall(r'llama_moe_cache:.*',log),
            'kv_allocations': re.findall(r'.*KV buffer size.*',log), 'tasks': tasks,
            'cycles': {str(c): stats([t['decode_tps'] for t in tasks if t['repeat']==c]) for c in (1,2)}})
base = next((r for r in results if r['budget_mib']==0 and r['status']=='passed'), None)
if base:
    for r in results:
        ratios = []
        for t in r['tasks']:
            b = next((b for b in base['tasks'] if (b['task'],b['repeat']) == (t['task'],t['repeat'])), None)
            if b:
                t['paired_decode_change_percent'] = (t['decode_tps']/b['decode_tps']-1)*100
                ratios.append(t['paired_decode_change_percent'])
        r['paired_decode_change_percent'] = stats(ratios)
(root / 'qwen-ab-performance.json').write_text(json.dumps(results,indent=2)+'\n')
for r in results:
    print(r['budget_mib'], r['status'], r.get('summary'), r.get('paired_decode_change_percent'))
