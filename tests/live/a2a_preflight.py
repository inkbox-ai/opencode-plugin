"""Repeatable A2A receiver setup for the live protocol driver."""

from __future__ import annotations

import time
from typing import Any


def retry_connection_read(read: Any, *, attempts: int = 3, delay: float = 1.0) -> Any:
    """Retry discovery reads after connection failures, never task submissions."""
    import httpx

    for attempt in range(attempts):
        try:
            return read()
        except (httpx.ConnectError, httpx.ConnectTimeout):
            if attempt + 1 == attempts:
                raise
            time.sleep(delay * (attempt + 1))


def enable_and_verify_card(
    identity: Any,
    a2a: Any,
    card_url: str,
    expected_handle: str,
    *,
    attempts: int = 6,
    delay: float = 2.0,
) -> Any:
    """Enable one receiver, then verify its exact card through the protocol."""
    settings = identity.a2a_enable()
    if not bool(getattr(settings, "enabled", False)):
        raise AssertionError("A2A receiver enablement did not persist")

    for attempt in range(1, attempts + 1):
        try:
            target = a2a.fetch_card(card_url)
        except Exception:
            if attempt == attempts:
                raise AssertionError(
                    "A2A card endpoint did not become available after enablement"
                ) from None
            time.sleep(delay)
            continue
        if target.card.name != f"@{expected_handle}":
            raise AssertionError(
                "A2A card identity did not match the configured test identity"
            )
        return target
    raise AssertionError("A2A card preflight exhausted its bounded attempts")
