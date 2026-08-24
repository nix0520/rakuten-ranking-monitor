import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import vless_to_mihomo as converter  # noqa: E402


class VlessToMihomoTests(unittest.TestCase):
    def test_converts_reality_tcp_uri_without_exposing_uri(self):
        config = converter.build_config(
            "vless://00000000-0000-0000-0000-000000000001@example.com:443"
            "?encryption=none&security=reality&type=tcp&sni=cdn.example.com"
            "&fp=chrome&pbk=public-key&sid=abcd&flow=xtls-rprx-vision"
            "#Tokyo",
            7890,
        )

        proxy = config["proxies"][0]
        self.assertEqual(config["mixed-port"], 7890)
        self.assertEqual(config["mode"], "global")
        self.assertEqual(proxy["type"], "vless")
        self.assertEqual(proxy["server"], "example.com")
        self.assertEqual(proxy["encryption"], "")
        self.assertTrue(proxy["tls"])
        self.assertEqual(proxy["servername"], "cdn.example.com")
        self.assertEqual(proxy["reality-opts"], {"public-key": "public-key", "short-id": "abcd"})
        self.assertEqual(proxy["flow"], "xtls-rprx-vision")

    def test_converts_websocket_options(self):
        proxy = converter.vless_proxy(
            "vless://uuid@example.com:8443"
            "?security=tls&type=ws&path=%2Fsocket&host=edge.example.com"
            "#WebSocket"
        )

        self.assertEqual(proxy["network"], "ws")
        self.assertEqual(
            proxy["ws-opts"],
            {"path": "/socket", "headers": {"Host": "edge.example.com"}},
        )

    def test_rejects_missing_reality_public_key(self):
        with self.assertRaisesRegex(ValueError, "public key"):
            converter.vless_proxy(
                "vless://uuid@example.com:443?security=reality&type=tcp"
            )

    def test_rejects_non_vless_uri(self):
        with self.assertRaisesRegex(ValueError, "vless://"):
            converter.vless_proxy("https://example.com/subscription")


if __name__ == "__main__":
    unittest.main()
