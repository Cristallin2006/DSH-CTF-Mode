#!/usr/bin/env python3
"""Synthetic file/CRC contracts; no copied target, online oracle or real model."""
import binascii
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


beam = load('beam_inventory', 'skills/re-triage/scripts/beam_inventory.py')
crc = load('crc_candidates', 'skills/ctf-crypto/scripts/crc_candidates.py')
chunks = load('evidence_chunks', 'skills/re-triage/scripts/evidence_chunks.py')
u32 = lambda n: struct.pack('>I', n)


def container(parts):
    payload = b'BEAM' + b''.join(name.encode() + u32(len(body)) + body + bytes((-len(body)) % 4) for name, body in parts)
    return b'FOR1' + u32(len(payload)) + payload


def literals(values):
    raw = u32(len(values)) + b''.join(u32(len(v)) + v for v in values)
    return u32(len(raw)) + zlib.compress(raw)


def parameters(init=0, width=16, poly=0x8005, refin=True, refout=True, xorout=0):
    return dict(width=width, poly=poly, init=init, refin=refin, refout=refout, xorout=xorout, poly_representation='normal')


class BeamTests(unittest.TestCase):
    def test_chunk_offsets_tables_and_literal_locations(self):
        atoms = u32(3) + b'\x04demo\x06erlang\x06length'
        literal = b'\x83\x68\x02\x77\x02ok\x6d' + u32(3) + b'\x00/x'
        image = container([('AtU8', atoms), ('ImpT', u32(1) + u32(2) + u32(3) + u32(1)),
                           ('ExpT', u32(1) + u32(1) + u32(0) + u32(1)), ('LitT', literals([literal])), ('Dbgi', b'opaque')])
        r = beam.inspect(image)
        self.assertEqual(r['imports'][0]['function'], 'length')
        self.assertEqual(r['exports'][0]['function'], 'demo')
        self.assertEqual(r['literals'][0]['value']['items'][1]['hex_preview'], '002f78')
        self.assertIn('decompressed_entry_offset', r['literals'][0])
        self.assertNotIn('file_offset', r['literals'][0])
        self.assertEqual(r['debug_info'], 'present_uninterpreted')
        self.assertEqual(r['literal_coverage'], {'decoded': 1, 'unsupported': 0})

    def test_unknown_etf_keeps_entry_boundary(self):
        r = beam.inspect(container([('LitT', literals([b'\x83\x70unknown_fun', b'\x83\x61\x09']))]))
        self.assertEqual([v['state'] for v in r['literals']], ['unsupported', 'decoded_subset'])
        self.assertEqual(r['literals'][1]['value']['decimal'], '9')

    def test_duplicate_map_keys_are_not_silently_overwritten(self):
        term = b'\x83\x74' + u32(2) + b'\x61\x01\x61\x02\x61\x01\x61\x03'
        value = beam.inspect(container([('LitT', literals([term]))]))['literals'][0]['value']
        self.assertEqual(len(value['pairs']), 2)

    def test_invalid_containers(self):
        image = container([('StrT', b'x')])
        for bad in [b'', image[:-1], image + b'x', image[:4] + u32(1) + image[8:], container([('StrT', b''), ('StrT', b'')])]:
            with self.subTest(bad=bad[:16]), self.assertRaises(ValueError):
                beam.inspect(bad)

    def test_compression_size_tail_and_limits(self):
        good = literals([b'\x83\x6a'])
        for bad in [u32(1) + good[4:], good + b'tail', good[:-1], u32(100000000) + good[4:]]:
            with self.subTest(size=len(bad)), self.assertRaises((ValueError, zlib.error)):
                beam.inspect(container([('LitT', bad)]))
        with self.assertRaises(ValueError):
            beam.inspect(container([('LitT', literals([b'\x83\x6a']))]), beam.Limits(max_unpacked=2))

    def test_truncated_etf_and_depth(self):
        for term in [b'\x83\x6d' + u32(99) + b'a', b'\x83\x61\x01tail', b'\x00\x6a']:
            with self.assertRaises(ValueError):
                beam.inspect(container([('LitT', literals([term]))]))
        with self.assertRaises(ValueError):
            beam.inspect(container([('LitT', literals([b'\x83' + b'\x68\x01' * 5 + b'\x6a']))]), beam.Limits(max_depth=2))

    def test_zero_length_atoms_and_ambiguous_tables(self):
        r = beam.inspect(container([('AtU8', u32(1) + b'\x00')]))
        self.assertEqual(r['atoms'][0]['value'], '')
        with self.assertRaises(ValueError):
            beam.inspect(container([('Atom', u32(0)), ('AtU8', u32(0))]))

    def test_preview_is_explicit(self):
        term = b'\x83\x6d' + u32(6) + b'abcdef'
        r = beam.inspect(container([('LitT', literals([term]))]), beam.Limits(max_preview=2))
        value = r['literals'][0]['value']
        self.assertEqual(value['length'], 6)
        self.assertTrue(value['preview_truncated'])
        self.assertEqual(value['sha256'], hashlib.sha256(b'abcdef').hexdigest())

    def test_optional_system_compiler(self):
        compiler = shutil.which('erlc')
        if not compiler or not str(Path(compiler).resolve()).startswith('/usr/'):
            self.skipTest('No trusted system erlc; synthetic parsing does not imply native disassembly')
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p/'inventory_fixture.erl').write_text('-module(inventory_fixture).\n-export([value/0]).\nvalue()->{ok,<<"offline-vector">>}.\n')
            env = {'PATH': os.environ['PATH'], 'HOME': directory, 'LANG': 'C.UTF-8'}
            subprocess.run([compiler, '-o', directory, str(p/'inventory_fixture.erl')], env=env, check=True, capture_output=True, timeout=20)
            r = beam.inspect((p/'inventory_fixture.beam').read_bytes())
            self.assertIn('value', [v['function'] for v in r['exports']])
            self.assertGreater(r['literal_coverage']['decoded'], 0)


class CRCTests(unittest.TestCase):
    def test_independent_check_vectors(self):
        vectors = [(parameters(), 0xbb3d), (parameters(init=0xffff), 0x4b37),
                   (parameters(width=8, poly=0x07, refin=False, refout=False), 0xf4),
                   (parameters(width=7, poly=9, refin=False, refout=False), 0x75),
                   (parameters(init=0xffff, poly=0x1021, refin=False, refout=False), 0x29b1),
                   (parameters(init=0xb2aa, poly=0x1021), 0x63d0)]
        for p, expected in vectors:
            with self.subTest(p=p):
                self.assertEqual(crc.crc(b'123456789', p), expected)

    def test_crc32_against_stdlib(self):
        p = parameters(width=32, poly=0x04c11db7, init=0xffffffff, xorout=0xffffffff)
        for data in [b'', b'123456789', bytes(range(256)), b'\x00\xff\x80']:
            self.assertEqual(crc.crc(data, p), binascii.crc32(data))

    def test_explicit_reflected_polynomial(self):
        p = parameters(init=0xffff)
        reflected = dict(p, poly=0xa001, poly_representation='reflected')
        self.assertEqual(crc.crc(b'abc', p), crc.crc(b'abc', reflected))

    def test_affine_delta_and_length_guard(self):
        p = parameters(init=0xffff)
        r = crc.delta(b'abc', b'axc', p)
        self.assertTrue(r['equal'])
        self.assertNotEqual(r['crc_xor'], crc.crc(bytes(a ^ b for a, b in zip(b'abc', b'axc')), p))
        with self.assertRaises(ValueError):
            crc.delta(b'a', b'ab', p)

    def sample(self, data, p, partition='fit', contract='synthetic:g1:plain'):
        return {'data_hex': data.hex(), 'crc': crc.crc(data, p), 'partition': partition, 'contract': contract}

    def candidate(self, ident, p):
        return {'id': ident, 'model': p, 'coverage': {'offset': 0, 'length': None}}

    def test_fixed_length_ambiguity_and_holdout(self):
        a = parameters(init=0xffff)
        b = parameters(init=0)
        b['xorout'] = crc.crc(b'ab', a) ^ crc.crc(b'ab', b)
        candidates = [self.candidate('a', a), self.candidate('b', b)]
        doc = {'samples': [self.sample(b'ab', a), self.sample(b'cd', a)], 'candidates': candidates}
        self.assertEqual(crc.check_samples(doc)['matches'], ['a', 'b'])
        doc['samples'].append(self.sample(b'abc', a, 'holdout'))
        self.assertEqual(crc.check_samples(doc)['matches'], ['a'])
        self.assertEqual(crc.check_samples(doc)['candidates'][1]['mismatches']['holdout'], 1)

    def test_contract_mismatch_and_duplicate_holdout(self):
        p = parameters()
        doc = {'samples': [self.sample(b'ab', p), self.sample(b'ab', p, 'holdout')], 'candidates': [self.candidate('one', p)]}
        self.assertTrue(crc.check_samples(doc)['holdout_reuses_fit_input'])
        doc['samples'][1]['contract'] = 'synthetic:g2:plain'
        with self.assertRaises(ValueError):
            crc.check_samples(doc)

    def test_parameters_limits_and_bounds(self):
        with self.assertRaises(ValueError):
            crc.integer(-1, 'crc')
        for bad in [dict(parameters(), width=True), dict(parameters(), init=65536), dict(parameters(), refin=1), dict(parameters(), poly=0)]:
            with self.assertRaises(ValueError):
                crc.crc(b'a', bad)
        doc = {'samples': [self.sample(b'', parameters())], 'candidates': [self.candidate('x', parameters())]}
        doc['candidates'].append(self.candidate('y', parameters()))
        with self.assertRaises(ValueError):
            crc.check_samples(doc, max_work_bits=1)
        doc['candidates'][0]['coverage']['length'] = 1
        self.assertEqual(crc.check_samples(doc)['matches'], ['y'])
        with self.assertRaises(ValueError):
            crc.unhex('00 ff')


class ChunkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = {'identity': 'synthetic-artifact', 'generation': 3, 'version': None}

    def entry(self, name, data, offset, requested=None):
        (self.root/name).write_bytes(data)
        return {'path': name, 'offset': offset, 'length': len(data), 'requested_length': len(data) if requested is None else requested,
                'sha256': hashlib.sha256(data).hexdigest(), 'source': dict(self.source)}

    def manifest(self, items, size=6, digest=None):
        return {'version': 1, 'source': dict(self.source), 'size': size, 'source_sha256': digest, 'chunks': items}

    def test_out_of_order_short_read_and_equal_overlap(self):
        doc = self.manifest([self.entry('last', b'def', 3), self.entry('first', b'abc', 0, 6), self.entry('overlap', b'bc', 1)])
        result, data = chunks.assemble(doc, self.root)
        self.assertEqual(data, b'abcdef')
        self.assertTrue(result['chunks'][1]['short_read'])
        self.assertEqual(result['snapshot'], 'unknown')
        self.assertIsNone(result['matches_declared_source_digest'])

    def test_gaps_and_conflicts_do_not_create_partial_artifact(self):
        doc = self.manifest([self.entry('a', b'ab', 0)])
        result, data = chunks.assemble(doc, self.root)
        self.assertEqual(result['gap_ranges'], [[2, 6]])
        self.assertIsNone(data)
        doc['chunks'].append(self.entry('b', b'xx', 1))
        result, data = chunks.assemble(doc, self.root)
        self.assertEqual(result['status'], 'invalid')
        self.assertIsNone(data)

    def test_identity_digest_and_resume_revalidation(self):
        doc = self.manifest([self.entry('a', b'abcdef', 0)], digest='0' * 64)
        self.assertFalse(chunks.assemble(doc, self.root)[0]['complete'])
        doc['source_sha256'] = hashlib.sha256(b'abcdef').hexdigest()
        self.assertTrue(chunks.assemble(doc, self.root)[0]['matches_declared_source_digest'])
        doc['chunks'][0]['source']['generation'] = 4
        with self.assertRaises(ValueError):
            chunks.assemble(doc, self.root)
        doc['chunks'][0]['source'] = dict(self.source)
        (self.root/'a').write_bytes(b'ABCDEF')
        with self.assertRaises(ValueError):
            chunks.assemble(doc, self.root)

    def test_path_escape_limits_and_empty(self):
        doc = self.manifest([self.entry('a', b'abcdef', 0)])
        with self.assertRaises(ValueError):
            chunks.assemble(doc, self.root, max_size=5)
        with self.assertRaises(ValueError):
            chunks.assemble(doc, self.root, max_read=5)
        doc['chunks'][0]['path'] = '../a'
        with self.assertRaises(ValueError):
            chunks.assemble(doc, self.root)
        self.assertEqual(chunks.assemble(self.manifest([], size=0), self.root)[1], b'')

    def test_cli_no_partial_write_no_overwrite(self):
        doc = self.manifest([self.entry('a', b'abc', 0)])
        p = self.root/'manifest.json';p.write_text(json.dumps(doc))
        out = self.root/'out.bin';argv = [sys.executable, str(ROOT/'skills/re-triage/scripts/evidence_chunks.py'), str(p), '--out', str(out)]
        self.assertEqual(subprocess.run(argv, capture_output=True).returncode, 2)
        self.assertFalse(out.exists())
        doc['chunks'].append(self.entry('b', b'def', 3));p.write_text(json.dumps(doc))
        self.assertEqual(subprocess.run(argv, capture_output=True).returncode, 0)
        self.assertEqual(out.read_bytes(), b'abcdef')
        self.assertEqual(subprocess.run(argv, capture_output=True).returncode, 2)
        self.assertEqual(out.read_bytes(), b'abcdef')
        self.assertFalse(list(self.root.glob('.dsh-chunks-*')))

    @unittest.skipIf(sys.platform == 'win32', 'POSIX special file and symlink check')
    def test_symlinks_and_fifos(self):
        (self.root/'link').symlink_to(self.root/'regular')
        (self.root/'regular').write_bytes(b'abc')
        with self.assertRaises(ValueError):
            beam.read_local(self.root/'link', 100)
        os.mkfifo(self.root/'fifo')
        with self.assertRaises(ValueError):
            beam.read_local(self.root/'fifo', 100)
        with self.assertRaises(ValueError):
            crc.read_json(self.root/'fifo', 100)


if __name__ == '__main__':
    unittest.main(verbosity=2)
