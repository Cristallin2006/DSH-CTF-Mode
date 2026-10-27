#!/usr/bin/env python3
"""Offline CRC calculation, equal-length deltas and finite candidate checks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat


def integer(value, field):
    if type(value) is int and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r'(?:0x[0-9a-fA-F]+|[0-9]+)', value):
        return int(value, 16 if value.startswith('0x') else 10)
    raise ValueError(field + ': expected a nonnegative integer or 0x-prefixed hex')


def reflect(value, bits):
    result = 0
    for _ in range(bits):
        result = (result << 1) | (value & 1)
        value >>= 1
    return result


def model(value):
    keys = {'width', 'poly', 'init', 'refin', 'refout', 'xorout', 'poly_representation'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('Model needs exactly width, poly, init, refin, refout, xorout, poly_representation')
    width = integer(value['width'], 'width')
    if not 1 <= width <= 64 or type(value['refin']) is not bool or type(value['refout']) is not bool:
        raise ValueError('Width must be 1..64; refin/refout must be booleans')
    result = dict(value, width=width)
    for key in ('poly', 'init', 'xorout'):
        result[key] = integer(value[key], key)
        if not 0 <= result[key] < 1 << width:
            raise ValueError(key + ': outside width; values are never truncated')
    if result['poly'] == 0 or result['poly_representation'] not in ('normal', 'reflected'):
        raise ValueError('Declare a nonzero polynomial and normal/reflected representation')
    return result


def crc(data, parameters):
    p = model(parameters)
    width, register = p['width'], p['init']
    mask = (1 << width) - 1
    poly = p['poly'] if p['poly_representation'] == 'normal' else reflect(p['poly'], width)
    for byte in data:
        byte = reflect(byte, 8) if p['refin'] else byte
        for shift in range(7, -1, -1):
            feedback = (register >> (width - 1)) ^ ((byte >> shift) & 1)
            register = (register << 1) & mask
            if feedback & 1:
                register ^= poly
    return (reflect(register, width) if p['refout'] else register) ^ p['xorout']


def unhex(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:[0-9a-fA-F]{2})*', value):
        raise ValueError('data_hex must contain complete byte pairs without implicit whitespace normalization')
    return bytes.fromhex(value)


def delta(left, right, parameters):
    if len(left) != len(right):
        raise ValueError('Delta requires equal input lengths and one declared CRC model')
    difference = bytes(a ^ b for a, b in zip(left, right))
    observed = crc(left, parameters) ^ crc(right, parameters)
    predicted = crc(difference, parameters) ^ crc(bytes(len(left)), parameters)
    return {'length': len(left), 'crc_xor': observed, 'affine_prediction': predicted,
            'equal': observed == predicted, 'authority': 'model identity only; no key recovery or target validation'}


def check_samples(document, max_candidates=4096, max_bytes=8 * 1024 * 1024, max_work_bits=100000000):
    if any(type(n) is not int or n <= 0 for n in (max_candidates, max_bytes, max_work_bits)):
        raise ValueError('Resource limits must be positive integers')
    if not isinstance(document, dict) or set(document) != {'samples', 'candidates'}:
        raise ValueError('Expected samples and candidates arrays')
    samples, candidates = document['samples'], document['candidates']
    if not isinstance(samples, list) or not samples or not isinstance(candidates, list) or not 1 <= len(candidates) <= max_candidates:
        raise ValueError('Supply samples and a finite candidate list within the configured limit')
    decoded, contracts, byte_count = [], set(), 0
    for i, sample in enumerate(samples):
        if not isinstance(sample, dict) or set(sample) != {'data_hex', 'crc', 'contract', 'partition'}:
            raise ValueError('Each sample needs data_hex, crc, contract and partition')
        if not isinstance(sample['contract'], str) or not sample['contract'] or sample['partition'] not in ('fit', 'holdout'):
            raise ValueError('Sample needs a nonempty comparable-context reference and fit/holdout partition')
        data = unhex(sample['data_hex'])
        expected = integer(sample['crc'], 'sample crc')
        contracts.add(sample['contract'])
        byte_count += len(data)
        decoded.append((i, data, expected, sample['partition']))
    if len(contracts) != 1:
        raise ValueError('Sample contracts differ; do not combine target generations or session/transform states')
    if byte_count > max_bytes or (byte_count * 8 + len(decoded)) * len(candidates) > max_work_bits:
        raise ValueError('Sample bytes or declared candidate work exceeds configured resource limit')
    if not any(partition == 'fit' for _, _, _, partition in decoded):
        raise ValueError('At least one fit sample is required')
    results, ids = [], set()
    for candidate in candidates:
        if not isinstance(candidate, dict) or set(candidate) != {'id', 'model', 'coverage'}:
            raise ValueError('Candidate needs id, model and explicit coverage')
        ident, coverage = candidate['id'], candidate['coverage']
        if not isinstance(ident, str) or not ident or len(ident) > 200 or ident in ids:
            raise ValueError('Candidate ids must be nonempty, unique and at most 200 characters')
        ids.add(ident)
        parameters = model(candidate['model'])
        if not isinstance(coverage, dict) or set(coverage) != {'offset', 'length'}:
            raise ValueError('Coverage needs offset and length (null means remaining bytes)')
        offset = integer(coverage['offset'], 'coverage offset')
        length = None if coverage['length'] is None else integer(coverage['length'], 'coverage length')
        if offset < 0 or (length is not None and length < 0):
            raise ValueError('Coverage values must be nonnegative')
        failures = {'fit': 0, 'holdout': 0}
        first = {}
        for index, data, expected, partition in decoded:
            end = len(data) if length is None else offset + length
            reason = None
            if offset > len(data) or end > len(data):
                reason = 'coverage_outside_sample'
            elif expected >= 1 << parameters['width']:
                reason = 'expected_crc_outside_width'
            elif crc(data[offset:end], parameters) != expected:
                reason = 'crc_mismatch'
            if reason:
                failures[partition] += 1
                first.setdefault(partition, {'sample_index': index, 'reason': reason})
        results.append({'id': ident, 'model': parameters, 'coverage': coverage, 'mismatches': failures,
                        'first_counterexamples': first, 'consistent': not any(failures.values())})
    fit_inputs = {hashlib.sha256(data).hexdigest() for _, data, _, partition in decoded if partition == 'fit'}
    return {'candidates': results, 'matches': [v['id'] for v in results if v['consistent']],
            'fit_samples': sum(v[3] == 'fit' for v in decoded), 'holdout_samples': sum(v[3] == 'holdout' for v in decoded),
            'holdout_reuses_fit_input': any(hashlib.sha256(data).hexdigest() in fit_inputs for _, data, _, part in decoded if part == 'holdout'),
            'authority': 'finite caller-declared hypotheses and context; matches are not unique parameter identification, independent execution or target acceptance'}


def read_json(file, limit):
    p = Path(file)
    if p.is_symlink():
        raise ValueError('Symlink input refused')
    fd = os.open(p, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError('JSON input must be a bounded regular file')
        body = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError('JSON input changed while reading')
    if len(body) > limit:
        raise ValueError('JSON input exceeds configured resource limit')
    return json.loads(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['calc', 'delta', 'check'])
    parser.add_argument('--model')
    parser.add_argument('--hex', default='')
    parser.add_argument('--right-hex')
    parser.add_argument('--input')
    parser.add_argument('--max-json', type=int, default=16 * 1024 * 1024)
    parser.add_argument('--max-bytes', type=int, default=8 * 1024 * 1024)
    parser.add_argument('--max-candidates', type=int, default=4096)
    parser.add_argument('--max-work-bits', type=int, default=100000000)
    args = parser.parse_args()
    try:
        if min(args.max_json, args.max_bytes, args.max_candidates, args.max_work_bits) <= 0:
            raise ValueError('Resource limits must be positive')
        if args.action == 'check':
            if not args.input:
                raise ValueError('check requires --input')
            value = check_samples(read_json(args.input, args.max_json), args.max_candidates, args.max_bytes, args.max_work_bits)
        else:
            if not args.model:
                raise ValueError('calc/delta requires --model')
            parameters, data = read_json(args.model, args.max_json), unhex(args.hex)
            if len(data) > args.max_bytes:
                raise ValueError('Input exceeds configured byte limit')
            work = (len(data) * 8 + 1) * (4 if args.action == 'delta' else 1)
            if work > args.max_work_bits:
                raise ValueError('Declared calculation exceeds configured work limit')
            if args.action == 'delta':
                if args.right_hex is None:
                    raise ValueError('delta requires --right-hex')
                right = unhex(args.right_hex)
                if len(right) > args.max_bytes:
                    raise ValueError('Right input exceeds configured byte limit')
                value = delta(data, right, parameters)
            else:
                value = {'crc': crc(data, parameters), 'model': model(parameters), 'length': len(data)}
        print(json.dumps({'ok': True, **value}, ensure_ascii=True))
        return 0
    except (ValueError, OSError, TypeError) as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
