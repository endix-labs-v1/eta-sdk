"""The HTTP client against the local mock: routes, errors, 429s and safe retries."""
from __future__ import annotations

import hashlib
import os
import re
import uuid
from typing import Any, Callable, Dict, Optional

import pytest
import requests
from mock_server import KEY, PNG, REQUEST_ID, Answer, MockHttp

from eta_api import UNSET, EtaClient, EtaError, RateLimit, __version__

FILE_ID = hashlib.sha256(PNG).hexdigest()
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

# (name, call, method, path, query, body). body None: no body. A body's "clientId": ANY means a fresh uuid.
ANY = object()
ROUTES = [
    # reads
    ("me", lambda c: c.me(), "GET", "/me", {}, None),
    ("bootstrap", lambda c: c.bootstrap(), "GET", "/bootstrap", {}, None),
    ("markets", lambda c: c.markets(), "GET", "/markets", {}, None),
    ("trades", lambda c: c.trades("BTC-PERP", n=5), "GET", "/trades/BTC-PERP", {"n": "5"}, None),
    ("trades default", lambda c: c.trades("HYPE"), "GET", "/trades/HYPE", {}, None),
    ("flows", lambda c: c.flows("HYPE"), "GET", "/flows/HYPE", {}, None),
    ("fills", lambda c: c.fills("mira.eth"), "GET", "/fills/mira.eth", {}, None),
    ("stats", lambda c: c.stats("yourhandle", days=7), "GET", "/stats/yourhandle", {"days": "7"}, None),
    ("board", lambda c: c.board(by="volume", days=1, n=10), "GET", "/board", {"by": "volume", "days": "1", "n": "10"}, None),
    ("narrative history", lambda c: c.narrative_history("PICKS", days=3), "GET", "/narrative/PICKS/history", {"days": "3"}, None),
    ("narrative versions", lambda c: c.narrative_versions("PICKS"), "GET", "/narrative/PICKS/versions", {}, None),
    ("follows", lambda c: c.follows("yourhandle"), "GET", "/follows/yourhandle", {}, None),
    ("file", lambda c: c.file("/files/" + FILE_ID), "GET", "/files/" + FILE_ID, {}, None),
    ("path segment encoded", lambda c: c.fills("a b/c"), "GET", "/fills/a%20b%2Fc", {}, None),
    # posts
    ("post", lambda c: c.post("Long $HYPE.", home="HYPE", thesis=True, id="pick-2026-11-13-hype"), "POST", "/act", {},
     {"type": "post", "text": "Long $HYPE.", "home": "HYPE", "thesis": True, "id": "pick-2026-11-13-hype"}),
    ("post with pictures", lambda c: c.post(images=["/files/" + FILE_ID], link="https://eta.cash"), "POST", "/act", {},
     {"type": "post", "images": ["/files/" + FILE_ID], "link": "https://eta.cash"}),
    ("reply", lambda c: c.reply("r:post:c2_g_um58aNl", "Adding on the dip.", to="sage"), "POST", "/act", {},
     {"type": "reply", "key": "r:post:c2_g_um58aNl", "text": "Adding on the dip.", "to": "sage"}),
    ("deletePost", lambda c: c.delete_post("YfIdGyGrcIRT"), "POST", "/act", {}, {"type": "deletePost", "id": "YfIdGyGrcIRT"}),
    # creator
    ("launch", lambda c: c.launch("PICKS", [("HYPE", 60), ("PURR", 40)], 70, name="Your picks", thesis="My picks.",
                                  vote_minutes=1440, veto_minutes=720, bounds={"HYPE": (55, 65), "PURR": (35, 45)}),
     "POST", "/act", {},
     {"type": "launch", "sym": "PICKS", "comps": [["HYPE", 60], ["PURR", 40]], "cap": 70, "name": "Your picks",
      "thesis": "My picks.", "bounds": {"HYPE": [55, 65], "PURR": [35, 45]}, "voteMinutes": 1440, "vetoMinutes": 720}),
    ("narrEdit", lambda c: c.edit("PICKS", thesis="Rebalanced on Sundays.", veto_minutes=480), "POST", "/act", {},
     {"type": "narrEdit", "sym": "PICKS", "thesis": "Rebalanced on Sundays.", "vetoMinutes": 480}),
    ("narrEdit null and empty", lambda c: c.edit("PICKS", pic="", vote_minutes=None), "POST", "/act", {},
     {"type": "narrEdit", "sym": "PICKS", "pic": "", "voteMinutes": None}),
    ("propose", lambda c: c.propose("PICKS", [("HYPE", 60, 63), ("PURR", 40, 37)], why="PURR volume thinned out."),
     "POST", "/act", {},
     {"type": "propose", "sym": "PICKS", "changes": [["HYPE", 60, 63], ["PURR", 40, 37]], "why": "PURR volume thinned out."}),
    ("propose a fee", lambda c: c.propose("PICKS", fee=1.5), "POST", "/act", {}, {"type": "propose", "sym": "PICKS", "fee": 1.5}),
    ("sim", lambda c: c.sim("PICKS", days=3, seed=1, volume_per_day=1000, referred_share=10), "POST", "/sim/PICKS", {},
     {"days": 3, "seed": 1, "volumePerDay": 1000, "referredShare": 10}),
    ("sim defaults", lambda c: c.sim("PICKS"), "POST", "/sim/PICKS", {}, {}),
    # trade
    ("quote", lambda c: c.quote("HYPE", "buy", 250), "POST", "/quote", {}, {"sym": "HYPE", "side": "buy", "usd": 250}),
    ("quote perp", lambda c: c.quote("BTC-PERP", "long", 100, lev=5), "POST", "/quote", {},
     {"sym": "BTC-PERP", "side": "long", "usd": 100, "lev": 5}),
    ("quote a close", lambda c: c.quote(close_id="UNNW5aZVXV63", frac=0.5), "POST", "/quote", {},
     {"closeId": "UNNW5aZVXV63", "frac": 0.5}),
    ("order", lambda c: c.order("HYPE", "buy", 250, quote_id="GdCdBVBb", max_slippage_pct=1), "POST", "/act", {},
     {"type": "order", "sym": "HYPE", "side": "buy", "usd": 250, "quoteId": "GdCdBVBb", "maxSlippagePct": 1, "clientId": ANY}),
    ("order with your clientId", lambda c: c.order("HYPE", "buy", 250, limit=38.2, client_id="hype-dip-0001"), "POST", "/act", {},
     {"type": "order", "sym": "HYPE", "side": "buy", "usd": 250, "limit": 38.2, "clientId": "hype-dip-0001"}),
    ("cancel", lambda c: c.cancel("P5weq-afPxzk"), "POST", "/act", {}, {"type": "cancel", "id": "P5weq-afPxzk"}),
    ("cancel by clientId", lambda c: c.cancel(client_id="hype-dip-0002"), "POST", "/act", {},
     {"type": "cancel", "clientId": "hype-dip-0002"}),
    ("cancelAll", lambda c: c.cancel_all(), "POST", "/act", {}, {"type": "cancelAll"}),
    ("cancelAll on one market", lambda c: c.cancel_all("HYPE"), "POST", "/act", {}, {"type": "cancelAll", "sym": "HYPE"}),
    ("close", lambda c: c.close("UNNW5aZVXV63", frac=0.5), "POST", "/act", {},
     {"type": "close", "id": "UNNW5aZVXV63", "frac": 0.5, "clientId": ANY}),
    ("act", lambda c: c.act({"type": "order", "sym": "HYPE", "side": "sell", "usd": 10}), "POST", "/act", {},
     {"type": "order", "sym": "HYPE", "side": "sell", "usd": 10, "clientId": ANY}),
]


@pytest.mark.parametrize("name,call,method,path,query,body", ROUTES, ids=[r[0] for r in ROUTES])
def test_each_route_sends_its_method_path_body_and_headers(
    client: EtaClient, api: MockHttp, name: str, call: Callable[[EtaClient], Any], method: str, path: str,
    query: Dict[str, str], body: Optional[Dict[str, Any]],
) -> None:
    call(client)
    assert len(api.seen) == 1
    seen = api.seen[0]
    assert (seen.method, seen.path, seen.query) == (method, path, query)
    assert seen.headers["authorization"] == "Bearer " + KEY, "the key goes in the Authorization header"
    assert seen.headers["user-agent"] == f"eta-api-python/{__version__}"
    if body is None:
        assert seen.body == b""
        return
    assert seen.headers["content-type"] == "application/json"
    sent = seen.json
    if body.get("clientId") is ANY:
        assert UUID.match(sent["clientId"]), "a fresh uuid clientId"
        body = {**body, "clientId": sent["clientId"]}
    assert sent == body


def test_answers_come_back_as_eta_sends_them(client: EtaClient) -> None:
    assert client.me()["user"]["handle"] == "yourhandle"
    assert client.quote("HYPE", "buy", 250)["quoteId"] == "GdCdBVBb"
    assert client.cancel_all()["cancelled"] == 2
    answer = client.order("HYPE", "buy", 250, client_id="mine-1")
    assert answer["fill"]["clientId"] == "mine-1"
    assert client.file(FILE_ID) == PNG


def test_upload_sends_the_bytes_with_their_type(client: EtaClient, api: MockHttp, tmp_path: Any) -> None:
    picture = tmp_path / "chart.png"
    picture.write_bytes(PNG)
    for source in (PNG, str(picture), picture, open(picture, "rb")):
        answer = client.upload(source)
        assert answer["url"] == "/files/" + FILE_ID
    for seen in api.seen:
        assert (seen.method, seen.path, seen.body) == ("POST", "/files", PNG)
        assert seen.headers["content-type"] == "image/png"


def test_each_order_gets_a_new_client_id(client: EtaClient, api: MockHttp) -> None:
    client.order("HYPE", "buy", 25)
    client.order("HYPE", "buy", 25)
    first, second = (s.json["clientId"] for s in api.seen)
    assert first != second


def test_bad_arguments_are_refused_before_sending(client: EtaClient, api: MockHttp) -> None:
    with pytest.raises(ValueError):
        client.cancel()
    with pytest.raises(ValueError):
        client.cancel("a", client_id="b")
    with pytest.raises(ValueError):
        client.quote("HYPE", "buy")
    with pytest.raises(ValueError):
        client.quote("HYPE", close_id="x")
    with pytest.raises(ValueError):
        client.act({"sym": "HYPE"})
    with pytest.raises(ValueError):
        EtaClient("")
    assert api.seen == []


def test_unset_is_not_sent_and_none_is_null(client: EtaClient, api: MockHttp) -> None:
    client.edit("PICKS", thesis=UNSET, vote_minutes=None)
    assert api.seen[0].json == {"type": "narrEdit", "sym": "PICKS", "voteMinutes": None}


# ---------- errors ----------

def test_an_error_carries_status_err_fields_and_request_id(client: EtaClient, api: MockHttp) -> None:
    api.respond("POST", "/act", Answer(403, {"err": "scope", "need": "trade"}, headers={"X-Request-Id": "req-403"}))
    with pytest.raises(EtaError) as caught:
        client.cancel_all()
    e = caught.value
    assert (e.status, e.err, e.fields, e.request_id) == (403, "scope", {"need": "trade"}, "req-403")
    assert e.body == {"err": "scope", "need": "trade"}
    assert "403 scope" in str(e) and "req-403" in str(e)


def test_a_refused_order_carries_its_fields_and_client_id(client: EtaClient, api: MockHttp) -> None:
    api.respond("POST", "/act", Answer(400, {"err": "price moved", "price": 40.61, "quoted": 40.346224}))
    with pytest.raises(EtaError) as caught:
        client.order("HYPE", "buy", 250, quote_id="GdCdBVBb", client_id="hype-0007")
    e = caught.value
    assert (e.status, e.err, e.fields) == (400, "price moved", {"price": 40.61, "quoted": 40.346224})
    assert (e.client_id, e.request_id) == ("hype-0007", REQUEST_ID)
    assert len(api.seen) == 1, "a 400 is a refusal: nothing changed, nothing to retry"


def test_an_answer_that_is_not_json_still_makes_an_eta_error(client: EtaClient) -> None:
    with pytest.raises(EtaError) as caught:
        client.file("nope")
    assert (caught.value.status, caught.value.err, caught.value.request_id) == (404, "404 Not Found", REQUEST_ID)


def test_a_bad_key_is_401_and_the_key_is_never_in_the_error(api: MockHttp, sleeps: Any) -> None:
    wrong = "eta_ea1d498e83b6_" + "W" * 43
    client = EtaClient(wrong, api.url, sleep=sleeps)
    with pytest.raises(EtaError) as caught:
        client.me()
    e = caught.value
    assert (e.status, e.err) == (401, "bad key")
    assert "W" * 43 not in str(e) and "W" * 43 not in repr(e)
    assert "W" * 43 not in repr(client), "repr masks the secret"
    assert repr(client) == f"EtaClient(key='eta_ea1d498e83b6_...', base_url='{api.url}')"


def test_a_network_error_is_an_eta_error_with_status_0(sleeps: Any) -> None:
    client = EtaClient(KEY, "http://127.0.0.1:9", sleep=sleeps, network_retries=0)
    with pytest.raises(EtaError) as caught:
        client.me()
    assert (caught.value.status, caught.value.err) == (0, "network")
    assert isinstance(caught.value.__cause__, requests.ConnectionError)


# ---------- rate limits ----------

def test_rate_limit_headers_are_kept(client: EtaClient, api: MockHttp) -> None:
    assert client.rate_limit is None
    client.me()
    assert client.rate_limit == RateLimit(limit=30, remaining=27, reset=8)
    assert client.last_request_id == REQUEST_ID
    api.rate = (30, 12, 3)
    client.markets()
    assert client.rate_limit == RateLimit(limit=30, remaining=12, reset=3)


def test_an_answer_without_rate_headers_keeps_the_last_values(client: EtaClient, api: MockHttp) -> None:
    client.me()
    api.respond("GET", "/me", Answer(401, {"err": "key revoked"}))
    with pytest.raises(EtaError):
        client.me()
    assert client.rate_limit == RateLimit(limit=30, remaining=27, reset=8)


def test_a_429_waits_retry_after_then_sends_again(client: EtaClient, api: MockHttp, sleeps: Any) -> None:
    api.respond("POST", "/act", Answer(429, {"err": "too fast", "retryAfter": 4}, headers={"Retry-After": "4"}))
    answer = client.order("HYPE", "buy", 25, client_id="hype-0429")
    assert answer["ok"] is True
    assert sleeps.waits == [4.0]
    bodies = [s.json for s in api.requests_to("POST", "/act")]
    assert len(bodies) == 2 and bodies[0] == bodies[1]


def test_a_429_with_only_the_header_waits_the_header(client: EtaClient, api: MockHttp, sleeps: Any) -> None:
    api.respond("GET", "/me", Answer(429, {"err": "too fast"}, headers={"Retry-After": "2"}))
    client.me()
    assert sleeps.waits == [2.0]


def test_429s_past_the_cap_raise(api: MockHttp, sleeps: Any) -> None:
    client = EtaClient(KEY, api.url, sleep=sleeps, rate_limit_retries=2)
    too_fast = Answer(429, {"err": "too fast", "retryAfter": 3}, headers={"Retry-After": "3"})
    api.respond("GET", "/me", too_fast, too_fast, too_fast)
    with pytest.raises(EtaError) as caught:
        client.me()
    assert (caught.value.status, caught.value.err, caught.value.retry_after) == (429, "too fast", 3.0)
    assert sleeps.waits == [3.0, 3.0]
    assert len(api.requests_to("GET", "/me")) == 3


def test_a_429_longer_than_the_max_wait_raises_at_once(client: EtaClient, api: MockHttp, sleeps: Any) -> None:
    api.respond("POST", "/act", Answer(429, {"err": "too fast", "retryAfter": 120}))
    with pytest.raises(EtaError) as caught:
        client.post("hello")
    assert caught.value.retry_after == 120.0
    assert sleeps.waits == []


# ---------- safe retries ----------

def test_an_order_whose_answer_was_lost_is_sent_again_with_the_same_client_id(
    client: EtaClient, api: MockHttp, sleeps: Any
) -> None:
    api.respond("POST", "/act", Answer(drop=True, run=True))  # eta trades, then the connection drops
    answer = client.order("HYPE", "buy", 250)
    sent = [s.json for s in api.requests_to("POST", "/act")]
    assert len(sent) == 2
    assert sent[0]["clientId"] == sent[1]["clientId"]
    assert UUID.match(sent[0]["clientId"])
    assert answer.get("repeat") is True and answer["fill"]["clientId"] == sent[0]["clientId"]
    assert api.trades == 1, "one fill, not two"
    assert len(sleeps.waits) == 1


def test_an_order_that_got_a_5xx_is_sent_again_with_the_same_client_id(client: EtaClient, api: MockHttp) -> None:
    api.respond("POST", "/act", Answer(502, "<html>Bad Gateway</html>", headers={"Content-Type": "text/html"}))
    client.order("HYPE", "buy", 250, client_id="hype-0502")
    sent = [s.json["clientId"] for s in api.requests_to("POST", "/act")]
    assert sent == ["hype-0502", "hype-0502"]


def test_a_close_that_timed_out_is_sent_again_with_the_same_client_id(api: MockHttp, sleeps: Any) -> None:
    client = EtaClient(KEY, api.url, sleep=sleeps, timeout=0.3)
    api.respond("POST", "/act", Answer(delay=1.0))
    answer = client.close("UNNW5aZVXV63")
    sent = [s.json["clientId"] for s in api.requests_to("POST", "/act")]
    assert len(sent) == 2 and sent[0] == sent[1]
    assert answer["got"] == 123.75 and answer.get("repeat") is True
    assert api.trades == 1, "eta closed once: the slow first try, then the retry got its answer"



def test_an_order_that_never_got_an_answer_raises_with_its_client_id(client: EtaClient, api: MockHttp) -> None:
    api.respond("POST", "/act", Answer(drop=True), Answer(drop=True), Answer(drop=True))
    with pytest.raises(EtaError) as caught:
        client.order("HYPE", "buy", 250, client_id="hype-lost")
    assert (caught.value.status, caught.value.err, caught.value.client_id) == (0, "network", "hype-lost")
    assert len(api.requests_to("POST", "/act")) == 3, "the first try and 2 retries"


@pytest.mark.parametrize("call", [
    lambda c: c.cancel("P5weq-afPxzk"),
    lambda c: c.cancel_all(),
    lambda c: c.post("no id of my own"),
    lambda c: c.propose("PICKS", fee=2),
    lambda c: c.launch("PICKS", [("HYPE", 50), ("PURR", 50)], 60),
], ids=["cancel", "cancelAll", "post without id", "propose", "launch"])
def test_a_write_that_could_act_twice_is_not_retried(client: EtaClient, api: MockHttp, call: Any) -> None:
    api.respond("POST", "/act", Answer(drop=True))
    with pytest.raises(EtaError) as caught:
        call(client)
    assert caught.value.status == 0
    assert len(api.requests_to("POST", "/act")) == 1


def test_a_post_with_its_own_id_and_a_read_are_retried(client: EtaClient, api: MockHttp) -> None:
    api.respond("POST", "/act", Answer(drop=True, run=True))
    assert client.post("pick", id="pick-0001")["id"] == "pick-0001"
    assert len(api.requests_to("POST", "/act")) == 2
    api.respond("GET", "/me", Answer(503, {"err": "starting"}))
    assert client.me()["user"]["handle"] == "yourhandle"
    assert len(api.requests_to("GET", "/me")) == 2


@pytest.mark.skipif(bool(os.environ.get("ETA_API") and os.environ.get("ETA_KEY")), reason="the guard is off for integration runs")
def test_the_net_guard_refuses_a_real_host() -> None:
    with pytest.raises(requests.ConnectionError):
        requests.get("https://example.com", timeout=2)


def test_new_client_ids_are_uuids() -> None:
    from eta_api import new_client_id

    assert uuid.UUID(new_client_id()).version == 4
