#!/usr/bin/env python3
"""Read GGUF metadata and tensor descriptors only; never map/read weights.
Usage: python3 scripts/inventory-placement-gguf.py MODEL... > inventory.json
"""
import collections
import json
import math
import os
import struct
import sys


def inspect(path):
    with open(path, 'rb') as f:
        def read(n):
            if n < 0 or f.tell() + n > min(os.fstat(f.fileno()).st_size, 128 * 1024**2):
                raise ValueError('GGUF descriptor limit exceeded')
            b = f.read(n)
            if len(b) != n:
                raise ValueError('Truncated GGUF')
            return b

        def number(fmt):
            return struct.unpack('<' + fmt, read(struct.calcsize('<' + fmt)))[0]

        def string():
            return read(number('Q')).decode('utf-8')

        def value(t, keep=True, depth=0):
            if depth > 2:
                raise ValueError('Nested metadata limit exceeded')
            if t == 8:
                s = string()
                return s if keep else None
            if t == 9:
                et, count = number('I'), number('Q')
                if count > 2_000_000:
                    raise ValueError('Array limit exceeded')
                for _ in range(count):
                    value(et, False, depth + 1)
                return {'element_type': et, 'count': count}
            formats = {0:'B', 1:'b', 2:'H', 3:'h', 4:'I', 5:'i', 6:'f', 7:'?', 10:'Q', 11:'q', 12:'d'}
            return number(formats[t])

        if read(4) != b'GGUF':
            raise ValueError('Not GGUF')
        version, nt, nk = number('I'), number('Q'), number('Q')
        if version not in (2, 3) or max(nt, nk) > 1_000_000:
            raise ValueError('Unsupported GGUF header')
        metadata = {}
        for _ in range(nk):
            key = string()
            v = value(number('I'))
            # Keep structural metadata, omit tokenizer strings/templates.
            if not key.startswith('tokenizer.'):
                metadata[key] = v
        tensors = []
        counts = collections.Counter()
        parameters = 0
        for _ in range(nt):
            name, nd = string(), number('I')
            if nd > 8:
                raise ValueError('Tensor rank limit exceeded')
            dims = [number('Q') for _ in range(nd)]
            dtype, offset = number('I'), number('Q')
            parameters += math.prod(dims)
            counts[dtype] += 1
            tensors.append({'name': name, 'shape': dims, 'ggml_type': dtype, 'offset': offset})
        alignment = metadata.get('general.alignment', 32)
        start = (f.tell() + alignment - 1) // alignment * alignment
        ordered = sorted(tensors, key=lambda x: x['offset'])
        for i, tensor in enumerate(ordered):
            end = ordered[i+1]['offset'] if i+1 < len(ordered) else os.fstat(f.fileno()).st_size - start
            tensor['storage_span_bytes_including_padding'] = end - tensor['offset']
        return {'path': os.path.abspath(path), 'size_bytes': os.fstat(f.fileno()).st_size,
                'gguf_version': version, 'metadata': metadata, 'tensor_count': nt,
                'parameter_elements': parameters, 'tensor_type_counts': dict(counts),
                'descriptor_bytes_read': f.tell(), 'tensors': tensors}


if __name__ == '__main__':
    json.dump([inspect(p) for p in sys.argv[1:]], sys.stdout, indent=2, ensure_ascii=False)
    print()
