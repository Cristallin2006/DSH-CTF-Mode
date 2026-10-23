#!/usr/bin/env python3
"""Per-directed-flow payload offset statistics; categories are hypotheses only."""
import argparse
from collections import Counter, defaultdict
import json
import math
from pcap_reader import iter_transport, coverage

def entropy(values):
    counts = Counter(values)
    return -sum((n / len(values) * math.log2(n / len(values)) for n in counts.values())) if values else 0.0

def classify(values):
    distinct = set(values)
    if not values:
        return 'SPARSE'
    if len(distinct) == 1:
        return 'CONST'
    if all((32 <= n < 127 for n in values)):
        return 'PRINTABLE'
    if len(distinct) <= max(4, len(values) // 8) and max(distinct) < 64:
        return 'INDEX?'
    if all((a <= b for (a, b) in zip(values, values[1:]))) or all((a >= b for (a, b) in zip(values, values[1:]))):
        return 'COUNTER?'
    if entropy(values) > 3.5 and len(distinct) > len(values) * 0.7:
        return 'HIGH-ENTROPY?'
    return 'MIXED'

def describe():
    return {'tool': 'field-infer', 'formats': ['classic pcap Ethernet/RAW-IP/Linux-SLL IPv4 TCP/UDP'], 'grouping': 'directed protocol/src IP/src port/dst IP/dst port', 'limitations': ['packet payload offsets, not application message boundaries', 'no TCP deduplication', 'empirical categories do not establish field semantics', 'reused tuples require separate captures'], 'target_accepted': None}

def summarize(payloads, max_offset):
    rows = []
    for offset in range(min(max_offset, max(map(len, payloads)))):
        values = [p[offset] for p in payloads if len(p) > offset]
        kind = 'SPARSE' if len(values) < max(2, (len(payloads) + 1) // 2) else classify(values)
        rows.append({'offset': offset, 'samples': len(values), 'distinct': len(set(values)), 'category': kind, 'entropy': entropy(values), 'examples': values[:6]})
    ranges = []
    for row in rows:
        if not ranges or ranges[-1]['category'] != row['category']:
            ranges.append({'start': row['offset'], 'end': row['offset'], 'category': row['category']})
        else:
            ranges[-1]['end'] = row['offset']
    return {'samples': len(payloads), 'min_length': min(map(len, payloads)), 'max_length': max(map(len, payloads)), 'offsets': rows, 'candidate_ranges': ranges}

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('pcap', nargs='?')
    ap.add_argument('--describe', action='store_true')
    ap.add_argument('--sport', type=int)
    ap.add_argument('--dport', type=int)
    ap.add_argument('--src')
    ap.add_argument('--dst')
    ap.add_argument('--min-len', type=int, default=1)
    ap.add_argument('--max-offset', type=int, default=64)
    ap.add_argument('--max-bytes', type=int, default=64 * 1024 * 1024)
    args = ap.parse_args(argv)
    if args.describe:
        print(json.dumps(describe()))
        return 0
    try:
        if not args.pcap or min(args.min_len, args.max_offset, args.max_bytes) <= 0:
            raise ValueError('pcap and positive limits required')
        if any((p is not None and (not 0 <= p <= 65535) for p in (args.sport, args.dport))):
            raise ValueError('invalid port')
        (flows, stats, total) = (defaultdict(list), Counter(), 0)
        for (key, seq, payload, flags) in iter_transport(args.pcap, stats):
            if any((v is not None and v != key[i] for (i, v) in ((1, args.src), (2, args.sport), (3, args.dst), (4, args.dport)))):
                continue
            if len(payload) < args.min_len:
                continue
            total += len(payload)
            if total > args.max_bytes:
                raise ValueError('selected payload exceeds --max-bytes')
            flows[key].append(payload)
        result = {'ok': bool(flows), 'target_accepted': None, 'coverage': coverage(stats), 'limitations': describe()['limitations'], 'flows': []}
        for (key, payloads) in sorted(flows.items()):
            result['flows'].append({'flow': list(key), 'sufficient_samples': len(payloads) >= 2, **summarize(payloads, args.max_offset)})
        print(json.dumps(result))
        return 0 if flows else 1
    except (ValueError, OSError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1
if __name__ == '__main__':
    raise SystemExit(main())
