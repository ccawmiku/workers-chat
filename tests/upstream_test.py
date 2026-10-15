"""Offline regression for the live-check script's billing guard."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error

spec = importlib.util.spec_from_file_location('upstream', Path(__file__).parents[1] / 'scripts/test-upstream.py')
upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)


class Reply(io.BytesIO):
    status = 200

    def __init__(self, data):
        super().__init__(json.dumps(data).encode())


class FakeUpstream:
    def __init__(self, uncertain=False):
        self.posts = []
        self.uncertain = uncertain

    def open(self, request, timeout):
        if request.get_method() == 'GET':
            return Reply({'data': [{'id': 'Gemini3.8flash-low'}]})
        payload = json.loads(request.data)
        self.posts.append(payload)
        if self.uncertain and payload.get('reasoning_effort') == 'low':
            raise urllib.error.URLError('synthetic timeout with unknown outcome')
        return Reply({'choices': [{'message': {'content': 'synthetic-key'}}],
                      'usage': {'total_tokens': 1, 'unexpected': 'synthetic-key'}})


class UpstreamLedgerTest(unittest.TestCase):
    def test_completed_and_uncertain_calls_are_never_automatically_repeated(self):
        for uncertain in [False, True]:
            with self.subTest(uncertain=uncertain), tempfile.TemporaryDirectory() as directory:
                fake, output = FakeUpstream(uncertain), io.StringIO()
                with contextlib.redirect_stdout(output):
                    for _ in range(2):
                        status = upstream.run_checks('https://fixture.invalid/v1', 'synthetic-key',
                                                     'Gemini3.8flash-low', fake, Path(directory))
                        self.assertEqual(status, int(uncertain))
                self.assertEqual(len(fake.posts), 3)
                self.assertEqual(fake.posts[0]['reasoning_effort'], 'low')
                self.assertNotIn('reasoning_effort', fake.posts[2])
                self.assertNotIn('synthetic-key', output.getvalue())
                self.assertNotIn('synthetic-key', ''.join(p.read_text() for p in Path(directory).glob('*.json')))
                self.assertEqual(len(list(Path(directory).glob('*.json'))), 3)

    def test_blocked_model_list_makes_no_generation_claims(self):
        class Blocked:
            def open(self, request, timeout):
                raise urllib.error.HTTPError(request.full_url, 403, 'blocked', {}, io.BytesIO(b'Your request was blocked.'))

        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            ledger = Path(directory) / 'ledger'
            self.assertEqual(upstream.run_checks('https://fixture.invalid/v1', 'synthetic-key',
                                                 'Gemini3.8flash-low', Blocked(), ledger), 1)
            self.assertFalse(ledger.exists())


if __name__ == '__main__':
    unittest.main()
