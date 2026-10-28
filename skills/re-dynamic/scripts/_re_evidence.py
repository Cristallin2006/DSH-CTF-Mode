"""Offline image coordinates and immutable saved-evidence receipts; no target execution."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import tempfile
import time


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, maximum):
    if type(maximum) is not int or maximum <= 0:
        raise ValueError('Positive file-byte resource bound required')
    p = Path(path)
    if p.is_symlink():
        raise ValueError('Input symlink refused')
    fd = os.open(p, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    f = os.fdopen(fd, 'rb')
    info = os.fstat(f.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
        f.close()
        raise ValueError('Expected a bounded regular file')
    return f, info


def fingerprint(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def read_file(path, maximum=16 * 1024 * 1024):
    f, before = regular(path, maximum)
    with f:
        data = f.read(maximum + 1)
        after = os.fstat(f.fileno())
    if len(data) != before.st_size or fingerprint(before) != fingerprint(after):
        raise ValueError('Input changed while reading')
    return data


def read_json(path, maximum=1024 * 1024):
    return json.loads(read_file(path, maximum))


def number(value, name='address', signed=False):
    if isinstance(value, str) and re.fullmatch(r'-?(?:0x[0-9a-fA-F]+|[0-9]+)', value):
        negative = value.startswith('-')
        digits = value[1:] if negative else value
        value = int(digits, 16 if digits.startswith('0x') else 10) * (-1 if negative else 1)
    if type(value) is not int or not -(1 << 64) < value < 1 << 64 or not signed and value < 0:
        raise ValueError(name + ': expected an in-range integer; values are never masked')
    return value


def elf_segments(data):
    if data[:4] != b'\x7fELF' or len(data) < 16 or data[4] not in (1, 2) or data[5] not in (1, 2) or data[6] != 1:
        raise ValueError('Expected ELF32/ELF64 with declared byte order')
    bits, endian = (32 if data[4] == 1 else 64), ('<' if data[5] == 1 else '>')
    minimum, phsize = (52, 32) if bits == 32 else (64, 56)
    if len(data) < minimum:
        raise ValueError('Truncated ELF header')
    typ, machine = struct.unpack_from(endian+'HH', data, 16)
    offset = struct.unpack_from(endian+('I' if bits == 32 else 'Q'), data, 28 if bits == 32 else 32)[0]
    entry, count = struct.unpack_from(endian+'HH', data, 42 if bits == 32 else 54)
    if typ not in (2, 3) or entry != phsize or count in (0, 65535) or offset + entry * count > len(data):
        raise ValueError('Unsupported ELF type, extended numbering or invalid program headers')
    segments = []
    for index in range(count):
        fields = struct.unpack_from(endian+('IIIIIIII' if bits == 32 else 'IIQQQQQQ'), data, offset+index*entry)
        if fields[0] != 1:
            continue
        if bits == 32:
            _, file_offset, va, _, filesz, memsz, flags, align = fields
        else:
            _, flags, file_offset, va, _, filesz, memsz, align = fields
        if filesz > memsz or file_offset+filesz > len(data) or va+memsz > 1 << bits:
            raise ValueError('Invalid PT_LOAD bounds')
        if align not in (0, 1) and (align & (align-1) or (va-file_offset) % align):
            raise ValueError('Invalid PT_LOAD alignment')
        segments.append(dict(index=index, offset=file_offset, va=va, filesz=filesz, memsz=memsz, flags=flags))
    if not segments:
        raise ValueError('No supported PT_LOAD segment')
    return {'bits': bits, 'byte_order': 'little' if endian == '<' else 'big', 'machine': machine, 'segments': segments}


def text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(name + ': nonempty reference required')
    return value


def map_address(data, context, source, value):
    if not isinstance(context, dict):
        raise ValueError('Context must be an object')
    required = {'image_sha256', 'process_identity', 'load_instance_id', 'load_bias', 'ghidra_rebase_delta'}
    if not required <= set(context):
        raise ValueError('Context needs '+', '.join(sorted(required)))
    if context['image_sha256'] != sha(data):
        raise ValueError('Context image hash differs from the supplied file')
    for key in ('process_identity', 'load_instance_id'):
        text(context[key], key)
    image, value = elf_segments(data), number(value)
    bias, delta = number(context['load_bias'], 'load_bias'), number(context['ghidra_rebase_delta'], 'rebase delta', True)
    if source not in ('elf_va', 'runtime_addr', 'ghidra_va', 'file_offset'):
        raise ValueError('Unsupported source coordinate')
    va = value - (bias if source == 'runtime_addr' else delta if source == 'ghidra_va' else 0)
    candidates = []
    for segment in image['segments']:
        if source == 'file_offset':
            if not segment['offset'] <= value < segment['offset'] + segment['filesz']:
                continue
            current = segment['va'] + value-segment['offset']
        else:
            current = va
            if not segment['va'] <= current < segment['va']+segment['memsz']:
                continue
        runtime, ghidra = bias+current, delta+current
        if not 0 <= current < 1 << image['bits'] or not 0 <= runtime < 1 << image['bits'] or not 0 <= ghidra < 1 << image['bits']:
            raise ValueError('Translated coordinate exceeds image address width')
        offset = segment['offset'] + current-segment['va'] if current-segment['va'] < segment['filesz'] else None
        candidates.append({'segment_index': segment['index'], 'elf_va': hex(current), 'runtime_addr': hex(runtime),
                           'ghidra_va': hex(ghidra), 'file_offset': hex(offset) if offset is not None else None,
                           'file_backed': offset is not None})
    return {'schema': 'dsh-re-address-v1', 'image_sha256': sha(data), 'context_sha256': sha(canonical(context)),
            'process_identity': context['process_identity'], 'load_instance_id': context['load_instance_id'],
            'bits': image['bits'], 'byte_order': image['byte_order'], 'machine': image['machine'], 'source': source,
            'value': hex(value), 'state': 'unmapped' if not candidates else 'mapped' if len(candidates) == 1 else 'ambiguous',
            'candidates': candidates, 'runtime_identity_verified': False,
            'authority': 'file hash and coordinate arithmetic against caller-declared context; no attach, runtime mapping or program-identity proof',
            'limitations': ['Only PT_LOAD coordinates; no JIT, DEX or anonymous-region inference',
                            'No automatic Thumb, tag or PAC stripping; supply an explicitly normalized address and retain its raw source']}


def directory(path, create=False):
    p = Path(path).absolute()
    for item in [p, *p.parents]:
        if item.is_symlink():
            raise ValueError('Evidence directory symlink refused')
    if create:
        p.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not p.is_dir():
        raise ValueError('Evidence store directory does not exist')
    return p.resolve()


def publish(path, body):
    """Publish only a new content-addressed file; never overwrite a destination."""
    fd, temporary = tempfile.mkstemp(prefix='.re-pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            if read_file(path, len(body)) != body:
                raise ValueError('Existing immutable record differs')
    finally:
        Path(temporary).unlink(missing_ok=True)


def store_file(root, source, provenance, max_bytes=1024*1024*1024):
    """Seal an already saved artifact. Does not create/complete DSH tasks or jobs."""
    if not isinstance(provenance, dict):
        raise ValueError('Provenance must be an object')
    for key in ('backend', 'run_id'):
        text(provenance.get(key), key)
    if provenance.get('source_kind') not in ('original', 'derived', 'observed', 'synthetic'):
        raise ValueError('Declare source_kind=original/derived/observed/synthetic')
    # Validate before any directory creation; optional context remains flexible data.
    canonical(provenance)
    stream, before = regular(source, max_bytes)
    try:
        root = directory(root, create=True)
        objects, records = directory(root/'objects', True), directory(root/'records', True)
        fd, temporary = tempfile.mkstemp(prefix='.re-pending-', dir=objects)
    except BaseException:
        stream.close()
        raise
    h, size = hashlib.sha256(), 0
    try:
        with stream, os.fdopen(fd, 'wb') as out:
            while True:
                block = stream.read(1024*1024)
                if not block:
                    break
                size += len(block)
                if size > max_bytes:
                    raise ValueError('Artifact exceeds explicit resource bound')
                h.update(block)
                out.write(block)
            if fingerprint(before) != fingerprint(os.fstat(stream.fileno())) or size != before.st_size:
                raise ValueError('Source changed during artifact copy')
            out.flush()
            os.fsync(out.fileno())
        digest = h.hexdigest()
        dest = objects/digest
        try:
            os.link(temporary, dest)
        except FileExistsError:
            verify_object(dest, digest, size, max_bytes)
        record = {'schema': 'dsh-re-evidence-v1', 'sha256': digest, 'bytes': size, 'provenance': provenance,
                  'sealed_at_ns': time.time_ns(), 'local_copy_complete': True, 'stream_completeness': 'unknown',
                  'target_accepted': None, 'authority': 'stable local file copy; provenance is caller-declared; not a live job receipt'}
        record_id = sha(canonical(record))
        if len(canonical(record)) > 1024*1024:
            raise ValueError('Evidence metadata exceeds the per-record byte bound; use explicit artifact references for large notes')
        publish(records/(record_id+'.json'), canonical(record))
        return {'record_id': record_id, **record}
    finally:
        Path(temporary).unlink(missing_ok=True)
        if not stream.closed:
            stream.close()


def verify_object(path, expected, size, maximum):
    stream, before = regular(path, maximum)
    h, count = hashlib.sha256(), 0
    with stream:
        while True:
            block = stream.read(1024*1024)
            if not block:
                break
            h.update(block)
            count += len(block)
            if count > maximum:
                raise ValueError('Object exceeds configured limit')
        after = os.fstat(stream.fileno())
    if fingerprint(before) != fingerprint(after) or count != size or h.hexdigest() != expected:
        raise ValueError('Evidence object changed, is truncated or has a different hash')
    return count


def verify_record(root, record_id, max_bytes=1024*1024*1024):
    if not re.fullmatch('[a-f0-9]{64}', record_id):
        raise ValueError('Expected exact record digest')
    root = directory(root)
    records, objects = directory(root/'records'), directory(root/'objects')
    raw = read_file(records/(record_id+'.json'), 1024*1024)
    record = json.loads(raw)
    if not isinstance(record, dict) or sha(canonical(record)) != record_id or record.get('schema') != 'dsh-re-evidence-v1':
        raise ValueError('Evidence record identity changed')
    digest = record.get('sha256')
    if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest) or type(record.get('bytes')) is not int or record['bytes'] < 0:
        raise ValueError('Invalid evidence object locator')
    verify_object(objects/digest, digest, record['bytes'], max_bytes)
    return {'ok': True, 'record_id': record_id, 'verified_local_hash': True, **record}
