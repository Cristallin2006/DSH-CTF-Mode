#!/usr/bin/env python3
"""Black-box format contracts. No external model, target or user home."""
import json
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'skills/ghidra-core/scripts/crypto_sanity.py'


def invoke(*args):
    result = subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True, encoding='utf-8', timeout=10)
    return result.returncode, json.loads(result.stdout)


class FormatContracts(unittest.TestCase):
    def model_report(self, transform):
        spec = importlib.util.spec_from_file_location('knowledge_diff', ROOT / 'skills/ghidra-core/scripts/model_diff.py')
        tool = importlib.util.module_from_spec(spec); spec.loader.exec_module(tool)
        output = io.StringIO()
        def local_command(name, data):
            return 'ok', transform(data) if name == 'model' else data, b''
        with patch.object(sys, 'argv', ['model_diff.py', '--model', 'model', '--oracle', 'oracle', '--input-gen', 'hex:8', '--n', '4', '--json']), patch.object(tool, 'run_cmd', side_effect=local_command), contextlib.redirect_stdout(output):
            code = tool.main()
        return code, json.loads(output.getvalue())

    def test_regular_pattern_does_not_determine_root_cause(self):
        # An actual algorithm change can produce the same regular nibble/width patterns.
        code, value = self.model_report(lambda data: bytes(byte ^ 0x80 for byte in data))
        self.assertEqual((code, value['mismatches']), (2, 4))
        self.assertEqual(value['root_cause'], 'undetermined')
        self.assertTrue(value['fingerprint_histogram'])

    def test_matching_model_is_scoped_to_sampled_inputs(self):
        code, value = self.model_report(lambda data: data)
        self.assertEqual((code, value['mismatches']), (0, 0))
        self.assertIsNone(value['root_cause'])

    def test_legacy_default_is_padded_standard(self):
        code, value = invoke('check', '--algo', 'base64', '--constant', 'SGVsbG8=')
        self.assertEqual(code, 0)
        self.assertEqual((value['chars'], value['padding'], value['decoded_bytes']), (8, 1, 5))
        self.assertEqual(value['decoded_hex'], b'Hello'.hex())

    def test_unpadded_url_has_explicit_contract(self):
        code, value = invoke('check', '--algo', 'base64', '--constant=-_8', '--alphabet', 'url', '--padding', 'omitted')
        self.assertEqual(code, 0)
        self.assertEqual(value['decoded_hex'], 'fbff')

    def test_same_bytes_fail_required_padding(self):
        code, value = invoke('check', '--algo', 'base64', '--constant', 'SGVsbG8')
        self.assertEqual((code, value['status']), (2, 'invalid'))

    def test_unknown_padding_is_not_a_success(self):
        code, value = invoke('check', '--algo', 'base64', '--constant', 'SGVsbG8', '--padding', 'unknown')
        self.assertEqual((code, value['ok'], value['status']), (3, False, 'inconclusive'))

    def test_wrong_alphabet_is_not_silently_normalized(self):
        self.assertEqual(invoke('check', '--algo', 'base64', '--constant=-_8', '--padding', 'omitted')[0], 2)
        self.assertEqual(invoke('check', '--algo', 'base64', '--constant', '+/8', '--alphabet', 'url', '--padding', 'omitted')[0], 2)

    def test_invalid_padding_and_impossible_payloads(self):
        for text in ('A', 'A===', 'AA=', 'AAAA=', '=AAA', 'AA!!'):
            with self.subTest(text=text):
                self.assertEqual(invoke('check', '--algo', 'base64', '--constant', text)[0], 2)

    def test_custom_table_only_claims_shape(self):
        code, value = invoke('check', '--algo', 'base64', '--constant', '!!==', '--custom-table')
        self.assertEqual(code, 0)
        self.assertEqual(value['validation_scope'], 'shape_only')
        self.assertNotIn('decoded_hex', value)

    def test_binary_candidate_does_not_require_printable_text(self):
        code, value = invoke('check-result', '--hex', '00ff')
        self.assertEqual(code, 0)
        self.assertEqual(value['result_hex'], '00ff')
        self.assertIsNone(value['result'])

    def test_explicit_ascii_contract_and_binary_override(self):
        self.assertEqual(invoke('check-result', '--hex', '00', '--require-printable')[0], 2)
        self.assertEqual(invoke('check-result', '--hex', '00', '--require-printable', '--allow-binary')[0], 0)

    def test_no_lossy_utf8_match(self):
        self.assertEqual(invoke('check-result', '--hex', 'ff', '--expect-regex', '.')[0], 2)

    def test_terminal_newline_is_only_removed_explicitly(self):
        self.assertEqual(invoke('check-result', '--hex', '410a', '--expect-regex', 'A')[0], 2)
        code, value = invoke('check-result', '--hex', '410a', '--expect-regex', 'A', '--strip-final-newline')
        self.assertEqual(code, 0)
        self.assertEqual(value['result_hex'], '410a')

    def test_hex_and_stream_length_checks_remain(self):
        self.assertEqual(invoke('check', '--algo', 'hex', '--constant', 'abc')[0], 2)
        self.assertEqual(invoke('check', '--algo', 'rc4', '--constant', '0001', '--plain-len', '1')[0], 2)
        self.assertEqual(invoke('check', '--algo', 'xor', '--constant', '0001', '--plain-len', '2')[0], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
