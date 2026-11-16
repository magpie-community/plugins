import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quota import normalize


class QuotaTests(unittest.TestCase):
    def test_pool_unknown_stale_and_coverage(self):
        result = normalize("tavily", {"scope": "enabled_pool", "service": "tavily", "unit": "credits",
            "remaining": None, "synced_keys": 0, "total_keys": 3, "stale": True, "secret": "discard"})
        self.assertIsNone(result["remaining"])
        self.assertTrue(result["stale"])
        self.assertEqual(result["totalKeys"], 3)
        self.assertNotIn("secret", result)

    def test_account_and_key_are_separate(self):
        result = normalize("tavily", {"account": {"plan_limit": 1000, "plan_usage": 250}, "key": {"limit": 200, "usage": 50}})
        self.assertEqual(result["remaining"], 750)
        self.assertEqual(result["keyRemaining"], 150)

    def test_invalid_and_firecrawl(self):
        with self.assertRaises(ValueError): normalize("tavily", {"account": {"plan_limit": "secret"}})
        result = normalize("firecrawl", {"data": {"remainingCredits": 50}})
        self.assertEqual(result["remaining"], 50)
        self.assertEqual(result["scope"], "team")


if __name__ == "__main__":
    unittest.main()
