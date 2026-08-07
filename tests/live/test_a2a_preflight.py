"""Focused checks for repeatable A2A card preflight."""

from types import SimpleNamespace
from unittest import TestCase, mock

from tests.live.a2a_preflight import enable_and_verify_card


class _Identity:
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.enable_calls = 0

    def a2a_enable(self):
        self.enable_calls += 1
        return SimpleNamespace(enabled=self.enabled)


class _A2A:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.fetch_calls = 0

    def fetch_card(self, _url):
        self.fetch_calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def _target(name: str):
    return SimpleNamespace(card=SimpleNamespace(name=name))


class A2APreflightTests(TestCase):
    @mock.patch("tests.live.a2a_preflight.time.sleep", return_value=None)
    def test_enables_once_and_retries_only_card_reads(self, _sleep):
        identity = _Identity()
        a2a = _A2A([RuntimeError("not ready"), _target("@test-agent")])

        target = enable_and_verify_card(
            identity,
            a2a,
            "https://example.test/a2a/test-agent/card",
            "test-agent",
            attempts=2,
            delay=0,
        )

        self.assertEqual(target.card.name, "@test-agent")
        self.assertEqual(identity.enable_calls, 1)
        self.assertEqual(a2a.fetch_calls, 2)

    def test_rejects_mismatched_identity_without_retry(self):
        identity = _Identity()
        a2a = _A2A([_target("@different-agent")])

        with self.assertRaisesRegex(AssertionError, "did not match"):
            enable_and_verify_card(
                identity,
                a2a,
                "https://example.test/a2a/test-agent/card",
                "test-agent",
            )

        self.assertEqual(identity.enable_calls, 1)
        self.assertEqual(a2a.fetch_calls, 1)

    def test_requires_enablement_postcondition(self):
        identity = _Identity(enabled=False)
        a2a = _A2A([_target("@test-agent")])

        with self.assertRaisesRegex(AssertionError, "did not persist"):
            enable_and_verify_card(
                identity,
                a2a,
                "https://example.test/a2a/test-agent/card",
                "test-agent",
            )

        self.assertEqual(a2a.fetch_calls, 0)
