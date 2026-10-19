#!/usr/bin/env python3
"""Run one isolated llama-server Qwen 80B benchmark profile, never touching app runtime."""
import argparse
import json
import os
import socket
import statistics
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


PROMPT = """Write a concise Python 3 function merge_intervals(intervals) that accepts a list of integer [start, end] pairs, merges overlapping or touching intervals, sorts the input regardless of order, and returns a new list. Include the function only, with a short docstring and type hints."""


def free_memory_gib():
    fields = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in ('MemAvailable', 'MemTotal'):
            fields[key] = int(value.split()[0]) / 1024 / 1024
    return fields


def proc_counters(pid):
    """Return process CPU ticks, system CPU ticks, and swap counters."""
    process_ticks = 0
    try:
        stat = Path(f'/proc/{pid}/stat').read_text()
        fields = stat[stat.rfind(')') + 2:].split()
        process_ticks = int(fields[11]) + int(fields[12])  # utime + stime
    except (OSError, ValueError, IndexError):
        pass
    cpu_line = [int(value) for value in Path('/proc/stat').read_text().splitlines()[0].split()[1:]]
    system_ticks = sum(cpu_line)
    idle_ticks = cpu_line[3] + (cpu_line[4] if len(cpu_line) > 4 else 0)
    swap = {}
    for line in Path('/proc/vmstat').read_text().splitlines():
        key, _, value = line.partition(' ')
        if key in ('pswpin', 'pswpout'):
            swap[key] = int(value)
    return process_ticks, system_ticks, idle_ticks, swap


def gpu_stats():
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
            check=True, capture_output=True, text=True, timeout=3,
        )
        used, total, utilization = (int(x.strip()) for x in result.stdout.splitlines()[0].split(','))
        return {'used_mib': used, 'total_mib': total, 'free_mib': total - used,
                'utilization_percent': utilization}
    except Exception as error:
        return {'error': str(error)}


def post_json(url, endpoint, payload, timeout):
    request = urllib.request.Request(url + endpoint, data=json.dumps(payload).encode(),
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def post_completion(url, prompt, tokens, timeout):
    payload = json.dumps({
        'prompt': prompt, 'n_predict': tokens, 'temperature': 0,
        'top_k': 1, 'top_p': 1, 'seed': 42, 'cache_prompt': False, 'stream': True,
    }).encode()
    request = urllib.request.Request(url + '/completion', data=payload,
                                     headers={'Content-Type': 'application/json'})
    started = time.monotonic()
    content = []
    data = {}
    first_token_at = None
    with urllib.request.urlopen(request, timeout=timeout) as response:
        for raw_line in response:
            line = raw_line.decode('utf-8').strip()
            if not line.startswith('data: '):
                continue
            event = json.loads(line[6:])
            piece = event.get('content', '')
            if piece:
                content.append(piece)
                if first_token_at is None:
                    first_token_at = time.monotonic()
            data.update(event)
    data['content'] = ''.join(content)
    data['_wall_seconds'] = time.monotonic() - started
    data['_ttft_seconds'] = first_token_at - started if first_token_at is not None else None
    return data


def get_metrics(url):
    try:
        with urllib.request.urlopen(url + '/metrics', timeout=3) as response:
            return response.read().decode('utf-8')
    except Exception:
        return ''


def make_context_prompt(url, target_tokens, timeout):
    if target_tokens <= 0:
        return PROMPT, 0
    block = ('Context note: A reliable code review should preserve the public contract, '
             'handle edge cases explicitly, avoid mutating caller-owned input, and explain '
             'complexity with evidence.\n')
    count = len(post_json(url, '/tokenize', {'content': block}, timeout)['tokens'])
    repeated = block * (target_tokens // max(1, count) + 2)
    tokens = post_json(url, '/tokenize', {'content': repeated}, timeout)['tokens']
    # Use a complete textual prefix close to the requested size; record the actual
    # evaluated token count from each completion response rather than claiming exactness.
    target_count = min(target_tokens, len(tokens))
    prefix = post_json(url, '/detokenize', {'tokens': tokens[:target_count]}, timeout)['content']
    return prefix, target_count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--server', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--outdir', required=True)
    parser.add_argument('--ngl', type=int, default=48)
    parser.add_argument('--cpu-moe-layers', type=int, default=48)
    parser.add_argument('--threads', type=int, default=8)
    parser.add_argument('--threads-batch', type=int, default=8)
    parser.add_argument('--batch', type=int, default=512)
    parser.add_argument('--ubatch', type=int, default=128)
    parser.add_argument('--ctx', type=int, default=65536)
    parser.add_argument('--kv-k', default='q8_0')
    parser.add_argument('--kv-v', default='q8_0')
    parser.add_argument('--flash-attn', choices=('on', 'off', 'auto'), default='on')
    parser.add_argument('--load-mode', choices=('auto', 'mmap', 'none'), default='mmap')
    parser.add_argument('--tokens', type=int, default=64)
    parser.add_argument('--prompt-tokens', type=int, default=0,
                        help='approximate input prompt token count; 0 uses the fixed short prompt')
    parser.add_argument('--mtp-draft', help='separate MTP-only draft GGUF; enables draft-mtp')
    parser.add_argument('--mtp-nmax', type=int, default=2)
    parser.add_argument('--draft-ngl', default='auto')
    parser.add_argument('--verbosity', type=int, default=3)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--startup-timeout', type=int, default=1200)
    parser.add_argument('--request-timeout', type=int, default=600)
    parser.add_argument('--min-available-gib', type=float, default=4)
    parser.add_argument('--min-free-vram-mib', type=int, default=2048)
    args = parser.parse_args()

    output = Path(args.outdir)
    output.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    base = output / f'{stamp}-ngl{args.ngl}-ncmoe{args.cpu_moe_layers}-t{args.threads}-tb{args.threads_batch}-b{args.batch}-ub{args.ubatch}'
    log_path = base.with_suffix('.server.log')
    result_path = base.with_suffix('.json')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]

    command = [
        args.server, '--model', args.model, '--host', '127.0.0.1', '--port', str(port),
        '--ctx-size', str(args.ctx), '--cache-type-k', args.kv_k, '--cache-type-v', args.kv_v,
        '--kv-offload', '--n-gpu-layers', str(args.ngl), '--n-cpu-moe', str(args.cpu_moe_layers),
        '--threads', str(args.threads), '--threads-batch', str(args.threads_batch),
        '--batch-size', str(args.batch), '--ubatch-size', str(args.ubatch),
        '--flash-attn', args.flash_attn, '--load-mode', args.load_mode, '--fit', 'off',
        '--parallel', '1', '--no-webui', '--metrics', '--verbosity', str(args.verbosity),
    ]
    if args.mtp_draft:
        command.extend(['--spec-type', 'draft-mtp', '--spec-draft-model', args.mtp_draft,
                        '--spec-draft-n-max', str(args.mtp_nmax), '--gpu-layers-draft', str(args.draft_ngl)])
    else:
        command.extend(['--spec-type', 'none'])
    environment = os.environ.copy()
    server_dir = str(Path(args.server).resolve().parent)
    environment['LD_LIBRARY_PATH'] = server_dir + (':' + environment['LD_LIBRARY_PATH'] if environment.get('LD_LIBRARY_PATH') else '')

    baseline = {'system': free_memory_gib(), 'gpu': gpu_stats()}
    sampler = {'peak_used_mib': None, 'peak_utilization_percent': 0, 'peak_process_rss_gib': 0,
               'peak_process_cpu_percent': 0, 'peak_system_cpu_percent': 0,
               'min_available_gib': 1e9, 'min_free_vram_mib': 1e9,
               'swap_in_pages': 0, 'swap_out_pages': 0, 'samples': 0}
    stop_sampler = threading.Event()
    process = None
    samples = []
    previous_counters = None

    def sample_resources():
        nonlocal previous_counters
        while not stop_sampler.wait(2):
            system = free_memory_gib()
            gpu = gpu_stats()
            rss_gib = 0
            if process and process.poll() is None:
                try:
                    for line in Path(f'/proc/{process.pid}/status').read_text().splitlines():
                        if line.startswith('VmRSS:'):
                            rss_gib = int(line.split()[1]) / 1024 / 1024
                            break
                except OSError:
                    pass
            sampler['samples'] += 1
            sampler['min_available_gib'] = min(sampler['min_available_gib'], system['MemAvailable'])
            sampler['peak_process_rss_gib'] = max(sampler['peak_process_rss_gib'], rss_gib)
            if 'used_mib' in gpu:
                sampler['peak_used_mib'] = max(sampler['peak_used_mib'] or 0, gpu['used_mib'])
                sampler['peak_utilization_percent'] = max(sampler['peak_utilization_percent'], gpu['utilization_percent'])
                sampler['min_free_vram_mib'] = min(sampler['min_free_vram_mib'], gpu['free_mib'])
            cpu_percent = None
            system_cpu_percent = None
            swap_deltas = {'pswpin': 0, 'pswpout': 0}
            try:
                counters = proc_counters(process.pid if process else -1)
                if previous_counters:
                    previous_process, previous_system, previous_idle, previous_swap = previous_counters
                    process_delta = counters[0] - previous_process
                    system_delta = counters[1] - previous_system
                    elapsed_ticks = 2 * os.sysconf('SC_CLK_TCK')
                    cpu_percent = 100 * process_delta / max(1, elapsed_ticks)
                    idle_delta = counters[2] - previous_idle
                    system_cpu_percent = 100 * max(0, system_delta - idle_delta) / max(1, system_delta)
                    swap_deltas = {key: counters[3].get(key, 0) - previous_swap.get(key, 0) for key in swap_deltas}
                    sampler['peak_process_cpu_percent'] = max(sampler['peak_process_cpu_percent'], cpu_percent)
                    sampler['peak_system_cpu_percent'] = max(sampler['peak_system_cpu_percent'], system_cpu_percent)
                    sampler['swap_in_pages'] += max(0, swap_deltas['pswpin'])
                    sampler['swap_out_pages'] += max(0, swap_deltas['pswpout'])
                previous_counters = counters
            except (OSError, ValueError):
                pass
            samples.append({'time_utc': datetime.now(timezone.utc).isoformat(), 'system': system, 'gpu': gpu,
                            'process_rss_gib': rss_gib, 'process_cpu_percent_of_one_core': cpu_percent,
                            'system_cpu_percent': system_cpu_percent, 'swap_page_deltas': swap_deltas})

    result = {'started_utc': datetime.now(timezone.utc).isoformat(), 'baseline': baseline, 'args': vars(args), 'command': command, 'runs': [], 'status': 'starting'}
    try:
        if not Path(args.server).is_file() or not os.access(args.server, os.X_OK):
            raise RuntimeError('llama-server path is missing or not executable')
        if not Path(args.model).is_file():
            raise RuntimeError('GGUF path is missing')
        with log_path.open('w') as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=environment)
            sampler_thread = threading.Thread(target=sample_resources, daemon=True)
            sampler_thread.start()
            base_url = f'http://127.0.0.1:{port}'
            deadline = time.monotonic() + args.startup_timeout
            ready_at = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f'llama-server exited during load with status {process.returncode}')
                if free_memory_gib()['MemAvailable'] < args.min_available_gib:
                    raise RuntimeError(f'safety stop: available system RAM fell below {args.min_available_gib} GiB')
                gpu = gpu_stats()
                if 'free_mib' in gpu and gpu['free_mib'] < args.min_free_vram_mib:
                    raise RuntimeError(f'safety stop: free VRAM fell below {args.min_free_vram_mib} MiB')
                try:
                    with urllib.request.urlopen(base_url + '/health', timeout=2) as response:
                        if response.status == 200:
                            ready_at = datetime.now(timezone.utc).isoformat()
                            break
                except Exception:
                    pass
                time.sleep(2)
            if ready_at is None:
                raise TimeoutError(f'llama-server did not become healthy within {args.startup_timeout} seconds')

            result['status'] = 'ready'
            result['ready_utc'] = ready_at
            prompt, requested_prompt_tokens = make_context_prompt(base_url, args.prompt_tokens, args.request_timeout)
            result['requested_prompt_tokens'] = requested_prompt_tokens
            # One untimed request primes backend code paths and page mappings.
            post_completion(base_url, 'Reply with the word ready.', 4, args.request_timeout)
            metrics_before = get_metrics(base_url)
            for index in range(args.repeats):
                run = post_completion(base_url, prompt, args.tokens, args.request_timeout)
                run['repeat'] = index + 1
                run['timings'] = run.get('timings', {})
                result['runs'].append(run)
                if free_memory_gib()['MemAvailable'] < args.min_available_gib:
                    raise RuntimeError(f'safety stop: available system RAM fell below {args.min_available_gib} GiB during generation')
                gpu = gpu_stats()
                if 'free_mib' in gpu and gpu['free_mib'] < args.min_free_vram_mib:
                    raise RuntimeError(f'safety stop: free VRAM fell below {args.min_free_vram_mib} MiB during generation')
            result['summary'] = {}
            for key in ('prompt_per_second', 'predicted_per_second'):
                values = [run['timings'][key] for run in result['runs'] if key in run['timings']]
                if values:
                    result['summary'][key] = {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
            ttft = [run['_ttft_seconds'] for run in result['runs'] if run.get('_ttft_seconds') is not None]
            if ttft:
                result['summary']['ttft_seconds'] = {'median': statistics.median(ttft), 'min': min(ttft), 'max': max(ttft)}
            result['metrics_before'] = metrics_before
            result['metrics_after'] = get_metrics(base_url)
            result['status'] = 'passed'
    except Exception as error:
        result['status'] = 'failed'
        result['error'] = str(error)
    except KeyboardInterrupt:
        result['status'] = 'interrupted'
        result['error'] = 'Benchmark interrupted by operator; partial results are not a completed run.'
    finally:
        if process and process.poll() is None:
            process.terminate()  # Only the child PID created above is signaled.
            try:
                process.wait(timeout=25)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        stop_sampler.set()
        if process:
            result['server_exit_code'] = process.returncode
        result['resources'] = sampler
        result['resource_samples'] = samples
        result['ended_utc'] = datetime.now(timezone.utc).isoformat()
        result['server_log'] = str(log_path)
        result_path.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'result': str(result_path), 'log': str(log_path), 'error': result.get('error'), 'summary': result.get('summary'), 'resources': result.get('resources')}, indent=2))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
