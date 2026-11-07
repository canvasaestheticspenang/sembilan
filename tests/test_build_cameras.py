"""Tests for scripts/build_cameras.py using a mocked Overpass response (no network)."""
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import build_cameras as bc  # noqa: E402

FIX = os.path.join(HERE, "fixtures")
MOCK = json.load(open(os.path.join(FIX, "overpass-mock.json"), encoding="utf-8"))
EXPECTED = open(os.path.join(FIX, "cameras-expected.json"), encoding="utf-8").read()


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def ok_opener(req, timeout=0):
    return FakeResp(json.dumps(MOCK).encode())


class ParseTests(unittest.TestCase):
    def test_matches_hand_checked_expected_output(self):
        self.assertEqual(bc.dump(bc.build(MOCK)), EXPECTED)

    def test_rows(self):
        rows = bc.parse(MOCK)
        self.assertIn([5.301, 100.4, 0, None, 60], rows)        # numeric limit; near-duplicate merged
        self.assertIn([5.302, 100.401, 1, 270, 90], rows)       # "90 km/h", AES by name, direction
        self.assertIn([5.303, 100.402, 0, 45, None], rows)      # cardinal NE -> 45
        self.assertIn([5.304, 100.403, 0, None, None], rows)    # mph and "forward" dropped
        self.assertIn([5.305, 100.404, 0, None, None], rows)    # "signals" dropped
        self.assertEqual(len(rows), 6)
        self.assertFalse(any(r[0] > 40 for r in rows))          # London outside bbox
        self.assertEqual(sum(1 for r in rows if r[:2] == [5.301, 100.4]), 1)

    def test_limit_and_dir_parsers(self):
        self.assertEqual(bc.parse_limit("110"), 110)
        self.assertIsNone(bc.parse_limit("60 mph"))
        self.assertIsNone(bc.parse_limit("5"))
        self.assertIsNone(bc.parse_limit(None))
        self.assertEqual(bc.parse_dir("360"), 0)
        self.assertEqual(bc.parse_dir("sw"), 225)
        self.assertIsNone(bc.parse_dir("both"))

    def test_asof_from_osm_timestamp_else_today(self):
        self.assertEqual(bc.build(MOCK)["asof"], "2026-11-01")
        self.assertEqual(bc.build({"elements": []}, today="2026-12-24")["asof"], "2026-12-24")

    def test_query_mentions_tags_and_bbox(self):
        q = bc.build_query()
        for s in ('"highway"="speed_camera"', '"enforcement"="maxspeed"', "[bbox:0.8,99.5,7.5,119.5]", "out body"):
            self.assertIn(s, q)


class FetchTests(unittest.TestCase):
    def test_retries_then_succeeds(self):
        calls, waits = [], []

        def opener(req, timeout=0):
            calls.append(req.full_url)
            if len(calls) < 3:
                raise urllib.error.HTTPError(req.full_url, 429 if len(calls) == 1 else 504, "busy", {}, None)
            return ok_opener(req)

        out = bc.fetch("q", ["https://a/x", "https://b/x"], attempts=4, sleep=waits.append, opener=opener)
        self.assertEqual(out["elements"], MOCK["elements"])
        self.assertEqual(calls, ["https://a/x", "https://b/x", "https://a/x"])
        self.assertTrue(30 <= waits[0] <= 33)   # 429 -> 30 s pause
        self.assertEqual(len(waits), 2)

    def test_gives_up(self):
        def opener(req, timeout=0):
            raise urllib.error.URLError("blocked")

        with self.assertRaises(RuntimeError):
            bc.fetch("q", attempts=2, sleep=lambda s: None, opener=opener)


class MainTests(unittest.TestCase):
    def run_main(self, args, opener):
        orig = bc.urllib.request.urlopen
        bc.urllib.request.urlopen = opener
        bc.time.sleep, orig_sleep = (lambda s: None), bc.time.sleep
        try:
            return bc.main(args)
        finally:
            bc.urllib.request.urlopen = orig
            bc.time.sleep = orig_sleep

    def test_writes_file(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "cameras.json")
            self.assertEqual(self.run_main([out, "--min", "3"], ok_opener), 0)
            self.assertEqual(open(out, encoding="utf-8").read(), EXPECTED)

    def test_too_few_keeps_existing_file(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "cameras.json")
            open(out, "w").write("OLD")
            self.assertEqual(self.run_main([out, "--min", "50"], ok_opener), 1)
            self.assertEqual(open(out).read(), "OLD")


if __name__ == "__main__":
    unittest.main()
