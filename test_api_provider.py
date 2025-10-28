#!/usr/bin/env python3
"""
Test connection to Monetize.software API Provider Gateway.

This script sends a request to the gateway endpoint and prints the response
to help debug connectivity, auth, and parameter forwarding.

By default, it targets provider ID 220 at https://onlineapp.pro/api/v1/api-gateway/220
and uses GET. You can override the provider, method, headers, body, query params,
and append additional path segments.

Environment variables (optional):
  - MONETIZE_GATEWAY_BASE_URL: Base URL of the gateway (default: https://onlineapp.pro/api/v1/api-gateway)
  - MONETIZE_PROVIDER_ID: Provider ID or slug (default: 220)
  - MONETIZE_METHOD: HTTP method (GET, POST, PUT, PATCH, DELETE)
  - MONETIZE_EXTRA_PATH: Extra path to append to provider URL (e.g. "chat/completions")
  - MONETIZE_HEADERS_JSON: JSON object of headers to forward (e.g. '{"Authorization":"Bearer ..."}')
  - MONETIZE_BODY_JSON: JSON object for request body
  - MONETIZE_PARAMS_JSON: JSON object for query params
  - MONETIZE_TIMEOUT: Request timeout in seconds (float, default: 30)

Examples:
  # Simple connectivity test (GET)
  python test_api_provider.py --provider-id 220 --method GET

  # POST with JSON body
  python test_api_provider.py \
    --provider-id 220 \
    --method POST \
    --body '{"ping":"pong"}'

  # Advanced: forward auth header and call a sub-endpoint
  python test_api_provider.py \
    --provider-id openai-provider \
    --extra-path chat/completions \
    --method POST \
    --headers '{"Authorization":"Bearer sk-...","Content-Type":"application/json"}' \
    --body '{"model":"gpt-5o-mini","messages":[{"role":"user","content":"Hello"}]}'

  # If the gateway requires platform auth (401/403), include your session cookie (from logged-in browser)
  # NOTE: This is only for local testing. Do not hardcode secrets.
  python test_api_provider.py \
    --provider-id 220 \
    --extra-path chat/completions \
    --method POST \
    --headers '{"Cookie":"__Secure-session=...; other=...","Content-Type":"application/json"}' \
    --body '{"model":"openai/gpt-5o-mini","messages":[{"role":"user","content":"Hello"}]}'
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Optional, Tuple


def _import_requests_or_exit() -> Any:
    try:
        import requests  # type: ignore
        return requests
    except Exception:
        print(
            "The 'requests' package is required. Install it with: pip install requests",
            file=sys.stderr,
        )
        sys.exit(1)


def parse_json_argument(argument_name: str, raw_value: Optional[str]) -> Optional[Dict[str, Any]]:
    if raw_value is None or raw_value.strip() == "":
        return None
    try:
        parsed = json.loads(raw_value)
        if parsed is None:
            return None
        if not isinstance(parsed, dict):
            raise ValueError(f"{argument_name} must be a JSON object (e.g. '{{\"key\":\"value\"}}').")
        return parsed
    except json.JSONDecodeError as decode_error:
        raise ValueError(f"Invalid JSON for {argument_name}: {decode_error}") from decode_error


def build_gateway_url(base_url: str, provider_id_or_slug: str, extra_path: Optional[str]) -> str:
    cleaned_base = base_url.rstrip('/')
    cleaned_provider = str(provider_id_or_slug).strip('/')
    if extra_path and extra_path.strip('/'):
        cleaned_extra = extra_path.strip('/')
        return f"{cleaned_base}/{cleaned_provider}/{cleaned_extra}"
    return f"{cleaned_base}/{cleaned_provider}"


def redact_sensitive_headers(headers: Dict[str, Any]) -> Dict[str, Any]:
    if not headers:
        return headers
    sensitive_keywords = {"authorization", "api-key", "x-api-key", "cookie", "token", "x-auth-token"}
    redacted: Dict[str, Any] = {}
    for key, value in headers.items():
        lower_key = str(key).lower()
        if any(s in lower_key for s in sensitive_keywords):
            redacted[key] = "***"
        else:
            redacted[key] = value
    return redacted


def pretty_json(data: Any) -> str:
    try:
        return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)
    except Exception:
        return str(data)


def make_request(
    method: str,
    url: str,
    headers: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
    timeout: float = 30.0,
) -> Tuple[int, Dict[str, Any], str, Optional[Any]]:
    requests = _import_requests_or_exit()
    try:
        response = requests.request(
            method=method.upper(),
            url=url,
            headers=headers or {},
            params=params or {},
            json=body if body is not None else None,
            timeout=timeout,
        )

        status_code = response.status_code
        response_text = response.text
        response_json: Optional[Any] = None
        try:
            response_json = response.json()
        except ValueError:
            response_json = None

        # Convert response headers to a regular dict for consistent printing
        response_headers: Dict[str, Any] = {k: v for k, v in response.headers.items()}
        return status_code, response_headers, response_text, response_json

    except Exception as request_error:
        print(f"Request failed: {request_error}", file=sys.stderr)
        raise


def main() -> None:
    default_base_url = os.environ.get("MONETIZE_GATEWAY_BASE_URL", "https://onlineapp.pro/api/v1/api-gateway")
    default_provider_id = os.environ.get("MONETIZE_PROVIDER_ID", "220")
    default_method = os.environ.get("MONETIZE_METHOD", "GET")
    default_extra_path = os.environ.get("MONETIZE_EXTRA_PATH", "")
    default_timeout = float(os.environ.get("MONETIZE_TIMEOUT", "30"))

    env_headers = os.environ.get("MONETIZE_HEADERS_JSON")
    env_body = os.environ.get("MONETIZE_BODY_JSON")
    env_params = os.environ.get("MONETIZE_PARAMS_JSON")

    parser = argparse.ArgumentParser(
        description=(
            "Send a request to the Monetize.software API Provider Gateway and print a detailed response."
        )
    )
    parser.add_argument(
        "--base-url",
        dest="base_url",
        default=default_base_url,
        help=f"Gateway base URL (default: {default_base_url})",
    )
    parser.add_argument(
        "--provider-id",
        dest="provider_id",
        default=default_provider_id,
        help=f"Provider ID or slug (default: {default_provider_id})",
    )
    parser.add_argument(
        "--method",
        dest="method",
        default=default_method,
        choices=["GET", "POST", "PUT", "PATCH", "DELETE"],
        help=f"HTTP method (default: {default_method})",
    )
    parser.add_argument(
        "--extra-path",
        dest="extra_path",
        default=default_extra_path,
        help="Path appended to provider URL (e.g. 'chat/completions')",
    )
    parser.add_argument(
        "--headers",
        dest="headers",
        default=env_headers,
        help="JSON object of headers to forward (env: MONETIZE_HEADERS_JSON)",
    )
    parser.add_argument(
        "--body",
        dest="body",
        default=env_body,
        help="JSON object for request body (env: MONETIZE_BODY_JSON)",
    )
    parser.add_argument(
        "--params",
        dest="params",
        default=env_params,
        help="JSON object for query params (env: MONETIZE_PARAMS_JSON)",
    )
    parser.add_argument(
        "--timeout",
        dest="timeout",
        type=float,
        default=default_timeout,
        help=f"Request timeout in seconds (default: {default_timeout})",
    )

    args = parser.parse_args()

    try:
        headers = parse_json_argument("--headers", args.headers)
        body = parse_json_argument("--body", args.body)
        params = parse_json_argument("--params", args.params)
    except ValueError as ve:
        print(str(ve), file=sys.stderr)
        sys.exit(2)

    # Default Content-Type to application/json when a JSON body is provided
    if body is not None:
        if headers is None:
            headers = {"Content-Type": "application/json"}
        elif "Content-Type" not in headers and "content-type" not in {k.lower() for k in headers.keys()}:
            headers["Content-Type"] = "application/json"

    url = build_gateway_url(
        base_url=args.base_url,
        provider_id_or_slug=args.provider_id,
        extra_path=args.extra_path,
    )

    # Print request summary
    print("\n=== API Provider Gateway Request ===")
    print(f"URL:        {url}")
    print(f"Method:     {args.method}")
    print(f"Timeout:    {args.timeout}s")
    if params:
        print("Query Params:")
        print(pretty_json(params))
    if headers:
        print("Headers (redacted):")
        print(pretty_json(redact_sensitive_headers(headers)))
    if body is not None:
        print("Body:")
        print(pretty_json(body))

    try:
        status_code, response_headers, response_text, response_json = make_request(
            method=args.method,
            url=url,
            headers=headers,
            body=body,
            params=params,
            timeout=args.timeout,
        )
    except Exception:
        sys.exit(1)

    # Print response summary
    print("\n=== Response ===")
    print(f"Status: {status_code}")
    if response_headers:
        print("Headers:")
        print(pretty_json(response_headers))
    if response_json is not None:
        print("JSON Body:")
        print(pretty_json(response_json))
    else:
        print("Text Body:")
        # Avoid printing extremely long responses fully
        max_len = 50_000
        if len(response_text) > max_len:
            print(response_text[:max_len] + "\n... [truncated]")
        else:
            print(response_text)

    # Helpful hints for common auth issues
    if status_code in (401, 403):
        print("\nHint: Received 401/403 from gateway.")
        print("- If your API key is stored in the provider settings, do not send Authorization; the gateway forwards it.")
        print("- If the platform requires user/session auth, include your session cookie in --headers (Cookie: ...).")
        print("- Ensure the extra path and method match the target API (e.g., chat/completions with POST).")


if __name__ == "__main__":
    main()


