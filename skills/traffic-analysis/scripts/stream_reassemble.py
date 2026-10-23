#!/usr/bin/env python3
"""Bounded IPv4 TCP reassembly. First-captured bytes win; conflicts/gaps remain evidence."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
import tempfile
from pathlib import Path
from pcap_reader import iter_transport, coverage

def describe():
    return {
        'tool': 'stream-reassemble',
        'formats': ['classic pcap Ethernet/RAW-IP/Linux-SLL IPv4 TCP'],
        'policy': 'first captured byte wins; zero-filled gaps explicitly reported',
        'limits': 'default span 16 MiB and selected payload 64 MiB; per direction; one connection instance',
        'limitations': [
            'not target OS overlap policy', 'no IPv6/fragments/application framing',
            'sequence unwrap assumes less than 2^31 bytes',
            'same-tuple reuse without SYN may be undetectable',
            'byte_complete applies only to observed sequence range; connection start/end may be missing',
        ],
        'exit_codes': {'0': 'no byte conflicts/gaps within parser coverage',
                       '2': 'conflicts/gaps/partial capture',
                       '1': 'invalid input/unsupported or oversized data'},
        'target_accepted': None,
    }

def reassemble(segments, max_span=16 * 1024 * 1024):
    if not segments or max_span <= 0:
        raise ValueError('nonempty segments and positive span required')
    anchor = segments[0][0]
    positions = [(anchor + ((seq - anchor + (1 << 31)) % (1 << 32) - (1 << 31)), data) for (seq, data) in segments]
    base = min((seq for (seq, data) in positions))
    end = max((seq + len(data) for (seq, data) in positions))
    if end - base > max_span:
        raise ValueError('TCP span exceeds --max-span; narrow connection/sequence range')
    (out, present, conflicts) = (bytearray(end - base), bytearray(end - base), defaultdict(set))
    for (seq, data) in positions:
        for (i, value) in enumerate(data):
            index = seq + i - base
            if present[index]:
                if out[index] != value:
                    conflicts[index].update((out[index], value))
            else:
                out[index] = value
                present[index] = 1
    (gaps, start) = ([], None)
    for (i, seen) in enumerate(present):
        if not seen and start is None:
            start = i
        if seen and start is not None:
            gaps.append((start, i - 1))
            start = None
    if start is not None:
        gaps.append((start, len(present) - 1))
    return (base & 4294967295, bytes(out), conflicts, gaps)

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('pcap', nargs='?')
    ap.add_argument('--describe', action='store_true')
    ap.add_argument('--sport', type=int)
    ap.add_argument('--dport', type=int)
    ap.add_argument('--src')
    ap.add_argument('--dst')
    ap.add_argument('--out', default='stream.bin')
    ap.add_argument('--max-span', type=int, default=16 * 1024 * 1024)
    ap.add_argument('--max-bytes', type=int, default=64 * 1024 * 1024)
    args = ap.parse_args(argv)
    if args.describe:
        print(json.dumps(describe()))
        return 0
    try:
        if not args.pcap or min(args.max_span, args.max_bytes) <= 0:
            raise ValueError('pcap and positive limits required')
        if any((p is not None and (not 0 <= p <= 65535) for p in (args.sport, args.dport))):
            raise ValueError('invalid port')
        (flows, syns, stats, total) = (defaultdict(list), defaultdict(set), Counter(), 0)
        for (key, seq, payload, flags) in iter_transport(args.pcap, stats):
            if key[0] != 6 or any((v is not None and v != key[i] for (i, v) in ((1, args.src), (2, args.sport), (3, args.dst), (4, args.dport)))):
                continue
            if flags & 2:
                syns[key].add(seq)
            if not payload:
                continue
            total += len(payload)
            if total > args.max_bytes:
                raise ValueError('selected payload exceeds --max-bytes')
            flows[key].append((seq, payload))
        if not flows:
            raise ValueError('no matching TCP payloads')
        prepared = []
        for (key, segments) in sorted(flows.items()):
            if len(syns[key]) > 1:
                raise ValueError('multiple connection instances share tuple; split capture first')
            (base, data, conflicts, gaps) = reassemble(segments, args.max_span)
            suffix = f'.{key[1]}_{key[2]}-{key[3]}_{key[4]}' if len(flows) > 1 else ''
            output = Path(args.out + suffix)
            if output.resolve() == Path(args.pcap).resolve() or output.exists() and os.path.samefile(output, args.pcap):
                raise ValueError('output cannot overwrite capture')
            prepared.append((key, base, data, conflicts, gaps, output))
        partial = not coverage(stats)['capture_complete'] or bool(stats['fragmented'])
        result = {'ok': True, 'target_accepted': None, 'coverage': coverage(stats), 'flows': [], 'limitations': describe()['limitations']}
        for (key, base, data, conflicts, gaps, output) in prepared:
            fd, temporary = tempfile.mkstemp(prefix='.stream-', dir=output.resolve().parent)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(data)
                os.replace(temporary, output)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            partial |= bool(conflicts or gaps)
            result['flows'].append({'flow': list(key), 'base_seq': base, 'path': str(output), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'gaps': gaps, 'conflicts': {str(k): sorted(v) for (k, v) in conflicts.items()}, 'byte_complete': not gaps, 'unambiguous': not conflicts, 'observed_range_only': True})
        result['partial'] = partial
        print(json.dumps(result))
        return 2 if partial else 0
    except (ValueError, OSError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1
if __name__ == '__main__':
    raise SystemExit(main())
