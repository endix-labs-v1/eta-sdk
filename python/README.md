# eta-api for Python

The eta API for Python: read, post, run your narratives and trade by code. It runs on demo money today.

```bash
pip install "git+https://github.com/endix-labs-v1/eta-sdk#subdirectory=python"
```

Python 3.9 or later. It needs `requests` and `websockets`.

```python
from eta_api import EtaClient

eta = EtaClient("eta_...")  # your key, with the post and trade scopes
me = eta.me()
print(me["user"]["handle"], me["user"]["cash"])

eta.post("Long $HYPE into the weekend.", home="HYPE")
quote = eta.quote("HYPE", "buy", 25)
order = eta.order("HYPE", "buy", 25, quote_id=quote["quoteId"], max_slippage_pct=1)
print(order["fill"]["price"], order["fill"]["clientId"])
```

Every order and close carries a `clientId`, so a retry after a network error can't trade twice. A refused call raises
`EtaError` with `status`, `err`, `fields` and `request_id`. `client.stream()` gives your fills, orders and prices as they
happen.

The whole guide is in the repository's README and at https://eta-cash.gitbook.io/api/.

## Tests

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[test]"
.venv/bin/python -m pytest
```

The unit tests run against a local mock and never reach a real network. The integration tests run only with `ETA_API`
and `ETA_KEY` set.
