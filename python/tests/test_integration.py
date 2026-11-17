"""The quick start against a real eta API. Skipped unless ETA_API and ETA_KEY are set.

    ETA_API=https://staging.example ETA_KEY=eta_... pytest tests/test_integration.py

The key needs the post and trade scopes. It trades demo money: a few $1 buys of
ETA_SYM (HYPE by default; ETA_USD sets the dollars). The key is never printed.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any, Callable, Dict

import pytest

from eta_api import EtaClient, new_client_id

API = os.environ.get("ETA_API", "")
KEY = os.environ.get("ETA_KEY", "")
SYM = os.environ.get("ETA_SYM", "HYPE")
USD = float(os.environ.get("ETA_USD", "1"))

pytestmark = pytest.mark.skipif(not (API and KEY), reason="set ETA_API and ETA_KEY to run against a real eta API")


@pytest.fixture(scope="module")
def eta() -> EtaClient:
    return EtaClient(KEY, API)


def test_quick_start(eta: EtaClient) -> None:
    me = eta.me()
    assert me["user"]["handle"]
    assert eta.rate_limit is not None and eta.rate_limit.limit > 0
    assert eta.last_request_id

    post = eta.post(f"Testing the eta SDK on ${SYM}.", home=SYM, id=f"sdk-test-{uuid.uuid4().hex[:16]}")
    assert post["ok"] is True and post["id"]

    quote = eta.quote(SYM, "buy", USD)
    assert quote["quoteId"] and quote["price"] > 0

    client_id = new_client_id()
    first = eta.order(SYM, "buy", USD, quote_id=quote["quoteId"], max_slippage_pct=5, client_id=client_id)
    again = eta.order(SYM, "buy", USD, quote_id=quote["quoteId"], max_slippage_pct=5, client_id=client_id)
    assert "fill" in first and first["fill"]["clientId"] == client_id
    assert again.get("repeat") is True
    assert again["fill"]["id"] == first["fill"]["id"], "the same clientId twice is one fill"
    mine = [f for f in eta.me()["fills"] if f.get("clientId") == client_id]
    assert len(mine) == 1

    resting = eta.order(SYM, "buy", USD, limit=round(quote["mark"] * 0.5, 6))
    assert resting.get("open") is True
    assert eta.cancel_all(SYM)["cancelled"] >= 1
    assert not [o for o in eta.me()["orders"] if o["sym"] == SYM]


def test_the_stream_sees_its_own_fill(eta: EtaClient) -> None:
    async def main() -> None:
        client_id = new_client_id()
        async with eta.stream(["account"]) as stream:
            frames = stream.__aiter__()

            async def until(check: Callable[[Dict[str, Any]], bool]) -> Dict[str, Any]:
                while True:
                    frame = await frames.__anext__()
                    if check(frame):
                        return frame

            await until(lambda f: f["type"] == "me")  # subscribed, with the record as it is now
            await asyncio.to_thread(eta.order, SYM, "buy", USD, client_id=client_id)
            fill = await until(lambda f: f["type"] == "fill" and f["fill"].get("clientId") == client_id)
            assert fill["fill"]["sym"] == SYM

    asyncio.run(asyncio.wait_for(main(), timeout=60))
