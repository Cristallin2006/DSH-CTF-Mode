#!/usr/bin/env python3
"""Synthetic capture/CLI regressions; no network or external target."""
from collections import Counter
import contextlib
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'skills/traffic-analysis/scripts'
sys.path.insert(0, str(SCRIPTS))
import field_infer as field
import stream_reassemble as stream
from pcap_reader import iter_transport


def packet(payload, seq=100, src=b'\x0a\0\0\x01', udp=False, flags=0x10, fragmented=False):
    if udp:
        transport = struct.pack('>HHHH', 1234, 8443, 8+len(payload), 0) + payload
    else:
        header = bytearray(20)
        struct.pack_into('>HHI', header, 0, 1234, 8443, seq)
        header[12:14] = bytes([0x50, flags])
        transport = header + payload
    ip = bytearray(20)
    ip[0] = 0x45; ip[9] = 17 if udp else 6
    struct.pack_into('>H', ip, 2, 20+len(transport))
    if fragmented: struct.pack_into('>H', ip, 6, 0x2000)
    ip[12:16] = src; ip[16:20] = b'\x0a\0\0\x02'
    return ip+transport


def capture(path, packets, network=101):
    data = bytearray(b'\xd4\xc3\xb2\xa1' + struct.pack('<HHIIII', 2, 4, 0, 0, 65535, network))
    for value in packets:
        data += struct.pack('<IIII', 0, 0, len(value), len(value)) + value
    path.write_bytes(data)
    return path


def invoke(main, args):
    text = io.StringIO()
    with contextlib.redirect_stdout(text): code = main(args)
    return code, json.loads(text.getvalue())


class ParserTests(unittest.TestCase):
    def test_vlan_and_ethernet_padding(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            frame = bytes(12)+b'\x81\x00\0\x01\x08\x00'+packet(b'ABC')+b'PADDING'
            path = capture(Path(directory)/'test.pcap',[frame],network=1)
            rows = list(iter_transport(path))
            self.assertEqual(rows[0][2],b'ABC')

    def test_udp_length_and_syn_sequence(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = capture(Path(directory)/'test.pcap',[packet(b'U',udp=True),packet(b'T',seq=10,flags=2)])
            rows = list(iter_transport(path))
            self.assertEqual((rows[0][0][0],rows[0][2]),(17,b'U'))
            self.assertEqual(rows[1][1],11)

    def test_truncation_is_not_silent_eof(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = capture(Path(directory)/'test.pcap',[packet(b'A')])
            path.write_bytes(path.read_bytes()[:-1])
            with self.assertRaisesRegex(ValueError,'truncated'): list(iter_transport(path))

    def test_fragments_and_malformed_are_reported(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            bad = bytearray(packet(b'A')); bad[0] = 0x41
            path = capture(Path(directory)/'test.pcap',[bad,packet(b'B',fragmented=True),packet(b'C')])
            stats = Counter(); rows = list(iter_transport(path,stats))
            self.assertEqual(len(rows),1)
            self.assertEqual((stats['malformed'],stats['fragmented']),(1,1))


class ReassemblyTests(unittest.TestCase):
    def test_first_captured_not_lowest_sequence_wins(self):
        base,data,conflicts,gaps = stream.reassemble([(102,b'XY'),(100,b'abCD')])
        self.assertEqual((base,data,gaps),(100,b'abXY',[]))
        self.assertEqual(conflicts[2],{ord('X'),ord('C')})

    def test_wrap_and_gap(self):
        self.assertEqual(stream.reassemble([(0xfffffffe,b'AB'),(0,b'CD')])[1],b'ABCD')
        _,data,_,gaps = stream.reassemble([(100,b'A'),(103,b'B')])
        self.assertEqual(data,b'A\0\0B');self.assertEqual(gaps,[(1,2)])

    def test_span_guard_precedes_allocation(self):
        with self.assertRaisesRegex(ValueError,'max-span'):
            stream.reassemble([(1,b'A'),(100000000,b'B')],max_span=4096)

    def test_cli_partial_output_and_input_protection(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = capture(Path(directory)/'test.pcap',[packet(b'A'),packet(b'B',seq=103)])
            output = Path(directory)/'stream.bin'
            code,result = invoke(stream.main,[str(path),'--out',str(output)])
            self.assertEqual(code,2);self.assertTrue(result['partial'])
            self.assertEqual(output.read_bytes(),b'A\0\0B')
            original = path.read_bytes()
            code,result = invoke(stream.main,[str(path),'--out',str(path)])
            self.assertEqual(code,1);self.assertEqual(path.read_bytes(),original)

    def test_reused_connection_rejected(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = capture(Path(directory)/'test.pcap',[packet(b'',seq=1,flags=2),packet(b'A',seq=2),packet(b'',seq=200,flags=2)])
            code,result = invoke(stream.main,[str(path),'--out',str(Path(directory)/'stream.bin')])
            self.assertEqual(code,1);self.assertIn('connection instances',result['error'])


class FieldTests(unittest.TestCase):
    def test_same_ports_different_hosts_are_not_mixed(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = capture(Path(directory)/'test.pcap',[packet(b'A'),packet(b'B'),packet(b'X',src=b'\x0a\0\0\x03')])
            code,result = invoke(field.main,[str(path),'--dport','8443'])
            self.assertEqual(code,0);self.assertEqual(len(result['flows']),2)
            self.assertEqual([v['samples'] for v in result['flows']],[2,1])
            self.assertFalse(result['flows'][1]['sufficient_samples'])

    def test_invalid_limit_is_structured_error(self):
        code,result=invoke(field.main,['missing.pcap','--max-offset','0'])
        self.assertEqual(code,1);self.assertFalse(result['ok'])

    def test_describe_without_capture_or_dependencies(self):
        for name in ('field_infer','stream_reassemble'):
            proc=subprocess.run([sys.executable,str(SCRIPTS/(name+'.py')),'--describe'],capture_output=True,text=True)
            self.assertEqual(proc.returncode,0,proc.stderr)
            self.assertIsNone(json.loads(proc.stdout)['target_accepted'])


if __name__=='__main__':unittest.main()
