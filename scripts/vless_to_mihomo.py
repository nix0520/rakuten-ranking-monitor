#!/usr/bin/env python3
"""Convert a VLESS URI from an environment variable into a Mihomo config."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


def _first(query: dict[str, list[str]], *names: str, default: str = "") -> str:
    for name in names:
        values = query.get(name)
        if values:
            return values[-1]
    return default


def _enabled(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes"}


def vless_proxy(uri: str) -> dict:
    parsed = urlsplit(uri.strip())
    if parsed.scheme.lower() != "vless":
        raise ValueError("VLESS_URI must start with vless://")
    if not parsed.username:
        raise ValueError("VLESS_URI is missing its UUID")
    if not parsed.hostname:
        raise ValueError("VLESS_URI is missing its server")
    try:
        server_port = parsed.port
    except ValueError as error:
        raise ValueError("VLESS_URI contains an invalid server port") from error
    if server_port is None:
        raise ValueError("VLESS_URI is missing its server port")

    query = parse_qs(parsed.query, keep_blank_values=True)
    network = _first(query, "type", default="tcp").lower()
    security = _first(query, "security", default="none").lower()
    name = "VLESS_NODE"
    encryption = _first(query, "encryption")
    if encryption.lower() == "none":
        encryption = ""

    proxy: dict = {
        "name": name,
        "type": "vless",
        "server": parsed.hostname,
        "port": server_port,
        "uuid": unquote(parsed.username),
        "udp": True,
        "network": network,
        "encryption": encryption,
    }

    flow = _first(query, "flow")
    if flow:
        proxy["flow"] = flow

    packet_encoding = _first(query, "packetEncoding", "packet-encoding")
    if packet_encoding:
        proxy["packet-encoding"] = packet_encoding

    servername = _first(query, "sni", "servername")
    if security in {"tls", "reality"}:
        proxy["tls"] = True
        proxy["servername"] = servername or parsed.hostname

    fingerprint = _first(query, "fp", "client-fingerprint")
    if fingerprint:
        proxy["client-fingerprint"] = fingerprint

    if _enabled(_first(query, "allowInsecure", "skip-cert-verify")):
        proxy["skip-cert-verify"] = True

    alpn = _first(query, "alpn")
    if alpn:
        proxy["alpn"] = [item for item in alpn.split(",") if item]

    if security == "reality":
        public_key = _first(query, "pbk", "public-key")
        if not public_key:
            raise ValueError("Reality VLESS_URI is missing its public key (pbk)")
        reality = {"public-key": public_key}
        short_id = _first(query, "sid", "short-id")
        if short_id:
            reality["short-id"] = short_id
        proxy["reality-opts"] = reality

    if network == "ws":
        ws: dict = {}
        path = _first(query, "path")
        if path:
            ws["path"] = path
        host = _first(query, "host")
        if host:
            ws["headers"] = {"Host": host}
        if ws:
            proxy["ws-opts"] = ws
    elif network == "grpc":
        service_name = _first(query, "serviceName", "service-name")
        if service_name:
            proxy["grpc-opts"] = {"grpc-service-name": service_name}

    return proxy


def build_config(uri: str, mixed_port: int) -> dict:
    if not 1 <= mixed_port <= 65535:
        raise ValueError("MIHOMO_PROXY_PORT must be between 1 and 65535")
    proxy = vless_proxy(uri)
    return {
        "mixed-port": mixed_port,
        "allow-lan": False,
        "mode": "rule",
        "log-level": "warning",
        "proxies": [proxy],
        "proxy-groups": [
            {
                "name": "VLESS_PROXY",
                "type": "select",
                "proxies": [proxy["name"]],
            }
        ],
        "rules": ["MATCH,VLESS_PROXY"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--uri-env", default="VLESS_URI")
    parser.add_argument("--port", type=int, default=7890)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    uri = os.environ.get(args.uri_env, "")
    if not uri:
        raise SystemExit(f"Required environment variable is empty: {args.uri_env}")

    try:
        config = build_config(uri, args.port)
    except ValueError as error:
        raise SystemExit(f"Invalid VLESS configuration: {error}") from error

    args.output.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(args.output, 0o600)
    print("Mihomo configuration created from VLESS_URI.")


if __name__ == "__main__":
    main()
